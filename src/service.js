import { join, resolve } from 'node:path'

import { EquityError, isPlainObject, newId, semanticHash } from './util/json.js'
import { atomicWriteJson, readJson, readText } from './util/fs.js'
import { nowIso } from './util/time.js'
import { subjectIdFor } from './util/ids.js'
import { subjectIdForTarget } from './kernel/subjects.js'
import {
  ASSETS_DIR,
  defaultUserModulesDir,
  listPresets,
  loadLibrary,
  loadPreset,
  moduleSummary,
  parsePlaybook,
  playbookToText,
  readPlaybookFile,
  projectsIndexPath,
} from './kernel/registry.js'
import {
  archiveProject as archiveProjectFile,
  createProject,
  defaultProjectRoot,
  detectLegacyProject,
  listProjects,
  openProject,
  playbookFile,
  savePlaybook as savePlaybookFile,
  saveProject,
  upsertProjectIndex,
} from './kernel/project.js'
import {
  appendEvidence,
  getLineage,
  listArtifacts,
  listClaims,
  listEvidence,
  listVerifiedArtifacts,
  readArtifact,
  readEvidenceBlob,
  recordArtifact,
} from './kernel/artifacts.js'
import { compilePlaybook, formatCompileResult } from './kernel/playbook.js'
import { startRun as runPlan, loadRun, listRuns as listRunRecords, pauseRun, cancelRun, isActive, reconcileRuns } from './kernel/runner.js'
import { projectState } from './kernel/state.js'
import { createIssue, decideIssue, listIssues } from './kernel/issues.js'
import { createExecutor } from './engines/index.js'
import { buildDeliverable } from './builders/package.js'
import { validateDelivery } from './builders/check.js'

export class EquityService {
  constructor({ ctx, config = {} }) {
    this.ctx = ctx
    this.config = config
    this.library = null
    this.libraryError = null
    this.activeProjectRuns = new Map()
    this.startedAt = nowIso()
  }

  async init() {
    await this.reloadLibrary()
    return this
  }

  async reloadLibrary() {
    try {
      this.library = await loadLibrary({
        userModulesDir: this.config.userModulesDir ?? defaultUserModulesDir(),
        allowedTools: this.config.allowedTools,
        strict: false,
      })
      this.libraryError = null
    } catch (error) {
      this.libraryError = error
      this.library = null
      throw error
    }
    return this.library
  }

  requireLibrary() {
    if (!this.library) throw new EquityError('library_unavailable', this.libraryError?.message ?? '模块库不可用')
    return this.library
  }

  async resolveProject(projectIdOrRoot = undefined) {
    if (projectIdOrRoot && isPlainObject(projectIdOrRoot)) {
      if (projectIdOrRoot.root) return openProject(projectIdOrRoot.root)
      if (projectIdOrRoot.projectId) return this.resolveProject(projectIdOrRoot.projectId)
    }
    if (typeof projectIdOrRoot === 'string' && /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(projectIdOrRoot)) {
      const opened = await openProject(projectIdOrRoot)
      await reconcileRuns(opened.root)
      return opened
    }
    const projects = await listProjects()
    let entry
    if (projectIdOrRoot) entry = projects.find((project) => project.projectId === projectIdOrRoot)
    else entry = projects[0]
    if (!entry) throw new EquityError('project_missing', `找不到项目：${projectIdOrRoot ?? '（未指定）'}`)
    const opened = await openProject(entry.root)
    await reconcileRuns(opened.root)
    return opened
  }

  async listProjects() {
    return listProjects()
  }

  async createProject(options = {}) {
    const library = this.requireLibrary()
    const created = await createProject({
      ...options,
      library,
      root: (typeof options.root === 'string' && options.root.trim() ? options.root : undefined)
        ?? defaultProjectRoot(options.workspaceRoot ?? process.cwd(), options.name ?? options.target ?? options.targets?.[0]?.name ?? 'project'),
    })
    return this.projectSummary(created)
  }

  async openProject(projectIdOrRoot) {
    return this.projectSummary(await this.resolveProject(projectIdOrRoot))
  }

  async archiveProject(projectIdOrRoot) {
    const opened = await this.resolveProject(projectIdOrRoot)
    const project = await archiveProjectFile(opened.root)
    return { projectId: project.projectId, status: project.status }
  }

  async projectSummary(opened) {
    const { root, project, playbook } = opened
    const state = await projectState({ root, library: this.requireLibrary(), project, playbook })
    return {
      projectId: project.projectId,
      name: project.name,
      root,
      preset: project.preset,
      status: project.status,
      engagement: project.engagement,
      targets: project.targets,
      playbook: {
        id: playbook.id,
        name: playbook.name,
        version: playbook.version,
        preset: playbook.preset,
        moduleCount: playbook.modules.length,
      },
      readiness: state.readiness,
      counts: state.counts,
      nextActions: state.nextActions,
    }
  }

  async state(projectIdOrRoot) {
    const opened = await this.resolveProject(projectIdOrRoot)
    return projectState({ root: opened.root, library: this.requireLibrary(), project: opened.project, playbook: opened.playbook })
  }

  async playbook(projectIdOrRoot) {
    const opened = await this.resolveProject(projectIdOrRoot)
    const compiled = this.compileOpened(opened)
    return {
      projectId: opened.project.projectId,
      playbook: opened.playbook,
      compile: formatCompileResult(compiled),
      modules: this.requireLibrary().moduleList.map(moduleSummary),
      presets: await listPresets(),
    }
  }

  compileOpened(opened, playbook = opened.playbook) {
    return compilePlaybook({ library: this.requireLibrary(), project: opened.project, playbook })
  }

  async compile(projectIdOrRoot, playbook = undefined) {
    const opened = await this.resolveProject(projectIdOrRoot)
    const targetPlaybook = playbook ?? opened.playbook
    const parsed = typeof targetPlaybook === 'string' ? parsePlaybook(targetPlaybook) : targetPlaybook
    return formatCompileResult(this.compileOpened(opened, parsed))
  }

  async savePlaybook(projectIdOrRoot, playbook) {
    const opened = await this.resolveProject(projectIdOrRoot)
    const parsed = typeof playbook === 'string' ? parsePlaybook(playbook) : playbook
    const compiled = this.compileOpened(opened, parsed)
    if (!compiled.ok) {
      throw new EquityError('compile_failed', '方案未通过编译，未保存', { errors: compiled.errors })
    }
    await savePlaybookFile(opened.root, parsed)
    return { ok: true, compile: formatCompileResult(compiled) }
  }

  async applyPreset(projectIdOrRoot, preset) {
    const opened = await this.resolveProject(projectIdOrRoot)
    const playbook = await loadPreset(preset)
    const compiled = this.compileOpened(opened, playbook)
    if (!compiled.ok) throw new EquityError('compile_failed', '预设未通过编译', { errors: compiled.errors })
    await savePlaybookFile(opened.root, playbook)
    return { ok: true, playbook, compile: formatCompileResult(compiled) }
  }

  async run(projectIdOrRoot, options = {}) {
    const opened = await this.resolveProject(projectIdOrRoot)
    const library = this.requireLibrary()
    let playbook = opened.playbook
    if (options.mode === 'adhoc') {
      const question = options.question ?? '这家公司是谁、做什么、有什么值得关注的公开信息？'
      playbook = {
        apiVersion: 'equity.playbook/v1',
        id: 'adhoc',
        name: '自由调查',
        version: '1.0.0',
        preset: 'generic',
        targets: { scope: 'company', from: 'company.roster' },
        stages: [{ id: 'identity', name: '主体识别' }, { id: 'investigation', name: '自由调查' }],
        modules: [
          { id: 'entity-resolution', use: 'builtin/entity-resolution@^0.1', stage: 'identity' },
          { id: 'generic-investigation', use: 'builtin/generic-investigation@^0.1', stage: 'investigation', params: { question, depth: 'standard' } },
        ],
        budget: opened.playbook.budget,
      }
    }
    const compiled = this.compileOpened(opened, playbook)
    if (!compiled.ok) throw new EquityError('compile_failed', '方案编译失败，不能运行', { errors: compiled.errors })
    const executorMode = options.executor ?? opened.project.engine?.executor ?? this.config.executor ?? 'private-agent'
    const executor = createExecutor({
      ctx: this.ctx,
      root: opened.root,
      project: opened.project,
      library,
      playbook,
      plan: compiled.plan,
      agent: options.agent ?? null,
      config: {
        ...this.config,
        executor: executorMode,
        provider: options.provider ?? this.config.provider,
        model: options.model ?? this.config.model,
      },
    })
    return this.startPlan({
      opened,
      library,
      playbook,
      plan: compiled.plan,
      executor,
      options,
    })
  }

  async startPlan({ opened, library, playbook, plan, executor, options = {} }) {
    const wait = options.wait !== false
    const projectKey = opened.project.projectId
    if (this.activeProjectRuns.has(projectKey)) {
      throw new EquityError('run_conflict', `项目已有运行中的调查：${projectKey}`, { projectId: projectKey })
    }
    this.activeProjectRuns.set(projectKey, true)
    const releaseRun = () => this.activeProjectRuns.delete(projectKey)
    let resolveStarted
    const started = new Promise((resolve) => {
      resolveStarted = resolve
    })
    const runPromise = runPlan({
      root: opened.root,
      library,
      project: opened.project,
      playbook,
      plan,
      executor,
      resumeFrom: options.resumeFrom ?? null,
      signal: options.signal,
      concurrency: options.concurrency ?? 1,
      engine: { executor: executor.name, provider: options.provider, model: options.model },
      onEvent: options.onEvent,
      onStart: (run) => {
        resolveStarted(this.runSummary(run))
        options.onStart?.(run)
      },
    })
    runPromise.catch((error) => {
      // A background run failure is reported through the run file and the
      // next start call; keep the rejection visible in logs.
      console.error('[equity] run failed:', error)
    })
    runPromise.finally(releaseRun).catch(() => {})
    if (!wait) {
      const summary = await started
      return { ...summary, background: true }
    }
    return this.runSummary(await runPromise)
  }

  runSummary(run) {
    const units = Object.values(run.units ?? {})
    return {
      runId: run.runId,
      projectId: run.projectId,
      status: run.status,
      executor: run.executor,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      budget: run.budget,
      counts: {
        total: units.length,
        accepted: units.filter((unit) => ['accepted', 'accepted_with_exception'].includes(unit.status)).length,
        failed: units.filter((unit) => unit.status === 'failed').length,
        needsHuman: units.filter((unit) => unit.status === 'needs_human').length,
        blocked: units.filter((unit) => unit.status === 'blocked').length,
        running: units.filter((unit) => unit.status === 'running').length,
        todo: units.filter((unit) => unit.status === 'todo').length,
      },
    }
  }

  async resume(projectIdOrRoot, runId, options = {}) {
    const opened = await this.resolveProject(projectIdOrRoot)
    const previous = await loadRun(opened.root, runId)
    if (!previous) throw new EquityError('run_missing', `运行不存在：${runId}`)
    if (isActive(runId)) throw new EquityError('run_active', '运行仍在进行，不能 resume')
    const compiled = this.compileOpened(opened)
    if (!compiled.ok) throw new EquityError('compile_failed', '方案编译失败，不能 resume', { errors: compiled.errors })
    const executor = createExecutor({
      ctx: this.ctx,
      root: opened.root,
      project: opened.project,
      library: this.requireLibrary(),
      playbook: opened.playbook,
      plan: compiled.plan,
      agent: options.agent ?? null,
      config: {
        ...this.config,
        executor: options.executor ?? previous.executor?.replace(/^composite:/, '') ?? this.config.executor,
        provider: options.provider ?? this.config.provider,
        model: options.model ?? this.config.model,
      },
    })
    return this.startPlan({ opened, library: this.requireLibrary(), playbook: opened.playbook, plan: compiled.plan, executor, options: { resumeFrom: runId, wait: options.wait !== false } })
  }

  pause(runId) {
    return { ok: pauseRun(runId), runId }
  }

  cancel(runId) {
    return { ok: cancelRun(runId), runId }
  }

  async runs(projectIdOrRoot) {
    const opened = await this.resolveProject(projectIdOrRoot)
    return (await listRunRecords(opened.root)).map((run) => this.runSummary(run))
  }

  async runDetail(projectIdOrRoot, runId) {
    const opened = await this.resolveProject(projectIdOrRoot)
    const run = await loadRun(opened.root, runId)
    if (!run) throw new EquityError('run_missing', `运行不存在：${runId}`)
    return run
  }

  /**
   * Write an artifact or evidence.
   *
   * Trust boundary (A2): `payload.status`/`payload.actor` are ignored. The
   * agent tool path always writes `status=draft`, `actor=agent`; callers that
   * are trusted code (internal tests, migration, system bootstrap) must say so
   * explicitly through `options` — never through model-supplied payload.
   */
  async record(projectIdOrRoot, payload = {}, options = {}) {
    const opened = await this.resolveProject(projectIdOrRoot)
    const kind = payload.kind ?? 'artifact'
    if (kind === 'evidence') {
      const moduleId = payload.moduleId ?? 'manual'
      const evidence = await appendEvidence(opened.root, moduleId, Array.isArray(payload.evidence) ? payload.evidence : [payload.evidence ?? payload])
      return { kind: 'evidence', evidence }
    }
    if (kind !== 'artifact') throw new EquityError('bad_kind', 'kind 必须是 artifact/evidence')
    const type = payload.type
    if (!type) throw new EquityError('missing_type', '缺少底稿类型')
    const trusted = options.trusted === true
    const actor = trusted ? (options.actor ?? 'human') : 'agent'
    const status = trusted ? (options.status ?? 'draft') : 'draft'
    if (!['draft', 'verified', 'stale', 'rejected', 'running'].includes(status)) {
      throw new EquityError('bad_status', `不支持的状态：${status}`)
    }
    const data = payload.data ?? {}
    const output = payload.output ?? {
      asOf: payload.asOf ?? opened.project.engagement?.asOf,
      openQuestions: payload.openQuestions ?? [],
      flags: payload.flags ?? [],
      sourceCoverage: payload.sourceCoverage ?? {},
      claims: payload.claims ?? [],
      evidence: payload.evidence ?? [],
      data,
    }
    const record = await recordArtifact({
      root: opened.root,
      library: this.requireLibrary(),
      type,
      subjectId: payload.subjectId ?? 'project',
      partitionKey: payload.partitionKey ?? '_default',
      period: payload.period,
      output,
      producedBy: {
        moduleId: payload.moduleId ?? 'manual',
        moduleVersion: payload.moduleVersion ?? '0.0.0',
        instanceId: payload.instanceId ?? null,
        templateSha: payload.templateSha ?? null,
        actor,
      },
      derivedFrom: payload.derivedFrom ?? [],
      status,
      actor,
      expectedRev: options.expectedRev ?? payload.expectedRev,
      requestId: options.requestId ?? payload.requestId,
    })
    return { kind: 'artifact', artifact: this.artifactSummary(record) }
  }

  artifactSummary(record) {
    if (!record) return null
    return {
      id: record.id,
      type: record.type,
      subjectId: record.subjectId,
      partitionKey: record.partitionKey,
      status: record.status,
      revision: record.revision,
      contentHash: record.contentHash,
      asOf: record.asOf,
      updatedAt: record.updatedAt,
      producedBy: record.producedBy,
      flags: record.flags ?? [],
      openQuestions: record.openQuestions ?? [],
    }
  }

  async artifact(projectIdOrRoot, artifactId) {
    const opened = await this.resolveProject(projectIdOrRoot)
    let record = (await listArtifacts(opened.root)).find((artifact) => artifact.id === artifactId)
    if (!record && artifactId?.includes('/')) {
      const [type, subjectId, partitionKey] = artifactId.split('/')
      record = await readArtifact(opened.root, type, subjectId, partitionKey || '_default')
    }
    if (!record) throw new EquityError('artifact_missing', `底稿不存在：${artifactId}`)
    const claims = (await listClaims(opened.root, record.subjectId)).filter((claim) => record.claimIds?.includes(claim.claimId))
    const evidence = (await listEvidence(opened.root)).filter((item) => record.evidenceIds?.includes(item.evidenceId))
    const lineage = await getLineage(opened.root, record)
    return { artifact: record, claims, evidence, lineage }
  }

  async evidence(projectIdOrRoot, evidenceId) {
    const opened = await this.resolveProject(projectIdOrRoot)
    const evidence = (await listEvidence(opened.root)).find((item) => item.evidenceId === evidenceId)
    if (!evidence) throw new EquityError('evidence_missing', `证据不存在：${evidenceId}`)
    const raw = await readEvidenceBlob(opened.root, evidence)
    return { evidence, raw }
  }

  async modules() {
    const library = this.requireLibrary()
    return {
      modules: library.moduleList.map(moduleSummary),
      errors: library.errors,
      warnings: library.warnings,
      types: library.typeList.map((type) => ({
        type: type.type,
        title: type.title,
        scope: type.scope,
        cardinality: type.cardinality,
        status: type.status,
        requiredEvidence: type.requiredEvidence,
        freshness: type.freshness,
        summaryFields: type.summaryFields,
      })),
      presets: await listPresets(),
    }
  }

  async issues(projectIdOrRoot, filter = {}) {
    const opened = await this.resolveProject(projectIdOrRoot)
    return listIssues(opened.root, filter)
  }

  async proposeReview(projectIdOrRoot, payload = {}) {
    const opened = await this.resolveProject(projectIdOrRoot)
    return createIssue(opened.root, {
      projectId: opened.project.projectId,
      type: 'review_proposal',
      severity: payload.severity ?? 'medium',
      title: payload.title ?? '复核提议',
      detail: payload.detail ?? payload.reason ?? '',
      options: ['accept', 'dismiss', 'defer'],
    })
  }

  async decideIssue(projectIdOrRoot, issueId, decision, { actor = 'agent', reason = '' } = {}) {
    if (actor !== 'user') throw new EquityError('user_only', 'approve/waive/signoff 是用户专属动作；Agent 只能 proposeReview')
    const opened = await this.resolveProject(projectIdOrRoot)
    return decideIssue(opened.root, issueId, { decision, reason, decidedBy: 'user' })
  }

  /**
   * User-only sign-off (A2/D2).
   *
   * - requires an explicit user actor via `options.actor === 'user'`;
   * - re-reads the latest verified `report.deliverable` (pointer-verified);
   * - requires `data.qa.passed === true` and zero QA blocking items;
   * - verifies `contentHash === semanticHash(data)`;
   * - `signedAt` (and `proposedAt`) are generated server-side; caller-supplied
   *   timestamps are ignored so a signed report cannot be backdated/forged.
   */
  async signoff(projectIdOrRoot, payload = {}, options = {}) {
    if (options.actor !== 'user') {
      throw new EquityError('user_only', 'signoff 是用户专属动作；Agent 只能 proposeReview')
    }
    const opened = await this.resolveProject(projectIdOrRoot)
    const verified = await listVerifiedArtifacts(opened.root, { type: 'report.deliverable' })
    const pointer = verified[0]
    if (!pointer) {
      throw new EquityError('deliverable_unverified', '没有 pointer 有效且 verified 的交付物可签发；请先构建并通过 QA')
    }
    // Re-read the latest revision after the pointer check; a concurrent rebuild
    // must not be signed under an older hash.
    const latest = await readArtifact(opened.root, 'report.deliverable', pointer.subjectId, pointer.partitionKey, 'current')
    if (!latest || latest.revision !== pointer.revision || latest.contentHash !== pointer.contentHash) {
      throw new EquityError('revision_conflict', '交付物在签发过程中被更新，请重新构建后再签发', {
        expectedRev: pointer.revision,
        actualRev: latest?.revision ?? null,
      })
    }
    if (latest.data?.qa?.passed !== true) {
      throw new EquityError('qa_failed', '交付物 QA 未通过，不能签发')
    }
    const blocking = latest.data?.qa?.blocking
    const blockingCount = Array.isArray(blocking) ? blocking.length : typeof blocking === 'number' ? blocking : 0
    if (blockingCount > 0) {
      throw new EquityError('qa_failed', `交付物存在 ${blockingCount} 个 QA 阻断项，不能签发`, { blocking })
    }
    const actualHash = semanticHash(latest.data)
    if (latest.contentHash !== actualHash) {
      throw new EquityError('content_hash_mismatch', '交付物内容与 contentHash 不一致，不能签发', {
        expected: latest.contentHash,
        actual: actualHash,
      })
    }
    const approvedBy = String(payload.approvedBy ?? '').trim()
    if (!approvedBy) throw new EquityError('missing_approver', 'approvedBy（签发人）不能为空')

    const signedAt = nowIso()
    const signoff = {
      preparedBy: String(payload.preparedBy ?? 'equity-diligence'),
      reviewedBy: String(payload.reviewedBy ?? ''),
      approvedBy,
      proposedAt: nowIso(),
      signedAt,
      note: String(payload.note ?? ''),
    }
    const record = await recordArtifact({
      root: opened.root,
      library: this.requireLibrary(),
      type: 'report.deliverable',
      subjectId: latest.subjectId,
      partitionKey: latest.partitionKey,
      output: {
        asOf: latest.asOf,
        openQuestions: latest.openQuestions ?? [],
        flags: latest.flags ?? [],
        sourceCoverage: latest.sourceCoverage ?? {},
        claims: [],
        evidence: [],
        data: { ...latest.data, signoff },
      },
      producedBy: { ...latest.producedBy, actor: 'human' },
      derivedFrom: latest.derivedFrom,
      status: 'verified',
      actor: 'human',
      expectedRev: latest.revision,
      requestId: options.requestId,
    })
    const project = { ...opened.project, signoff, updatedAt: nowIso() }
    await saveProject(project)
    return { ok: true, signoff, artifact: this.artifactSummary(record) }
  }

  async deliver(projectIdOrRoot, action = 'build', options = {}) {
    if (action === 'verify') return this.verifyDelivery(projectIdOrRoot, options)
    const opened = await this.resolveProject(projectIdOrRoot)
    if (action === 'present') {
      const deliverable = (await listVerifiedArtifacts(opened.root, { type: 'report.deliverable' }))[0]
      if (!deliverable) {
        throw new EquityError('deliverable_unverified', '没有 pointer 有效的 verified 交付物可交付；请先构建并通过 QA')
      }
      return {
        ok: true,
        files: deliverable.data?.files ?? [],
        deliverableId: deliverable.id,
        revision: deliverable.revision,
        signed: Boolean(deliverable.data?.signoff?.signedAt),
        outDir: join(opened.root, '05_交付'),
        note: '由父 Agent 使用 present 工具把文件卡交给用户；本工具不复制文件内容。',
      }
    }
    const runs = await listRunRecords(opened.root)
    const run = runs[0] ?? null
    const compiledPlan = this.compileOpened(opened).plan
    const deliverableStep = compiledPlan?.steps?.find((step) => step.moduleId === 'builtin/deliverable') ?? null
    const plan = run ? null : compiledPlan
    const result = await buildDeliverable({
      root: opened.root,
      library: this.requireLibrary(),
      project: opened.project,
      playbook: opened.playbook,
      plan: plan ?? { snapshotHash: run?.snapshotHash ?? null },
      run,
      template: options.template ?? opened.project.preset ?? 'standard',
      // A rebuild is a new content hash: never inherit an earlier sign-off.
      // The deliverable stays unsigned and `deliveryReady` false until the user
      // signs this revision.
      signoff: {},
    })
    // Delivery consumes released revisions only (A1). Draft/stale/rejected
    // artifacts must not be pinned into the manifest lineage.
    const verifiedArtifacts = await listVerifiedArtifacts(opened.root)
    const pins = verifiedArtifacts
      .filter((artifact) => !['report.deliverable', 'dd.request_list'].includes(artifact.type))
      .map((artifact) => ({
        artifactId: artifact.id,
        type: artifact.type,
        kind: 'input',
        revision: artifact.revision,
        contentHash: artifact.contentHash,
        fieldPaths: [],
      }))
    const signoff = { ...(result.manifest.signoff ?? {}) }
    if (!signoff.signedAt) delete signoff.signedAt
    const findingsById = new Map((result.findings ?? []).map((finding) => [finding.findingId, finding]))
    const summaryFindings = (result.manifest.cellMap ?? []).map((cell, index) => {
      const findingId = cell.location?.split('#').pop() ?? `F${String(index + 1).padStart(2, '0')}`
      const source = findingsById.get(findingId)
      return {
        findingId,
        fact: source?.fact ?? cell.value ?? '',
        impact: source?.impact ?? '',
        evidenceStrength: source?.evidenceStrength ?? '',
        materiality: source?.materiality ?? 'attention',
        nextStep: source?.nextStep ?? '',
        claimId: cell.claimId ?? source?.claimId ?? null,
        artifactId: cell.artifactId ?? source?.artifactId ?? null,
      }
    })
    const reportOutput = {
      asOf: opened.project.engagement?.asOf ?? new Date().toISOString().slice(0, 10),
      openQuestions: [],
      flags: result.qa.warnings.map((warning) => ({ level: 'attention', rule: warning.id, desc: warning.message })),
      sourceCoverage: { queries: [], databases: [], retrievedAt: nowIso(), limitations: [] },
      claims: [],
      evidence: [],
      data: {
        generatedAt: result.manifest.generatedAt,
        files: result.manifest.files.map((file) => ({ path: file.path, sha256: file.sha256, kind: file.kind, size: file.size })),
        summaryFindings,
        cellMap: result.manifest.cellMap ?? [],
        qa: { blocking: result.qa.blocking, warnings: result.qa.warnings, passed: result.qa.passed },
        signoff,
      },
    }
    const buildProducedBy = {
      moduleId: 'builtin/deliverable',
      moduleVersion: deliverableStep?.moduleVersion ?? '0.1.0',
      instanceId: deliverableStep?.instanceId ?? null,
      templateSha: deliverableStep?.templateSha ?? null,
      actor: 'system',
    }
    const reportRecord = await recordArtifact({
      root: opened.root,
      library: this.requireLibrary(),
      type: 'report.deliverable',
      subjectId: 'project',
      partitionKey: '_default',
      output: reportOutput,
      derivedFrom: pins,
      producedBy: buildProducedBy,
      status: result.qa.passed ? 'verified' : 'draft',
      actor: 'system',
    })
    const ddItems = result.ddRequests ?? []
    if (ddItems.length > 0) {
      await recordArtifact({
        root: opened.root,
        library: this.requireLibrary(),
        type: 'dd.request_list',
        subjectId: subjectIdForTarget(opened.project.targets?.[0] ?? { name: opened.project.name }, opened.project),
        partitionKey: '_default',
        output: {
          asOf: reportOutput.asOf,
          openQuestions: [],
          flags: [],
          sourceCoverage: { queries: [], databases: [], retrievedAt: nowIso(), limitations: [] },
          claims: [],
          evidence: [],
          data: { items: ddItems },
        },
        derivedFrom: pins,
        producedBy: buildProducedBy,
        status: result.qa.passed ? 'verified' : 'draft',
        actor: 'system',
      })
    }
    return {
      ok: result.qa.passed,
      outDir: result.outDir,
      artifactId: reportRecord.id,
      manifest: {
        generatedAt: result.manifest.generatedAt,
        files: result.manifest.files,
        qa: result.manifest.qa,
        signoff: result.manifest.signoff,
      },
      qa: result.qa,
    }
  }

  /**
   * QA-only re-check of the existing delivery package (no rebuild).
   *
   * `validateDelivery` is re-run against `05_交付` using the build input snapshot
   * persisted by the builder (`.equity/delivery/build-input.json`) plus the
   * current verified-artifact view. If the package no longer matches the
   * released revisions, QA is forced to fail with `package_stale`; this method
   * never silently rebuilds (S wires /deliver action=verify to it).
   */
  async verifyDelivery(projectIdOrRoot, options = {}) {
    const opened = await this.resolveProject(projectIdOrRoot)
    const outDir = join(opened.root, '05_交付')
    const qaDir = join(opened.root, '.equity', 'delivery')
    const manifest = await readJson(join(outDir, 'manifest.json'), null)
    const buildInput = await readJson(join(qaDir, 'build-input.json'), null)
    if (!manifest || !buildInput) {
      throw new EquityError('delivery_missing', '尚未构建交付包；请先执行 build 再体检', { outDir })
    }
    const workbookMap = await readJson(join(outDir, 'workbook_map.json'), null)
    const allArtifacts = await listArtifacts(opened.root)
    const verifiedAll = (await listVerifiedArtifacts(opened.root)).filter((artifact) => artifact.status === 'verified')
    const verifiedById = new Map(verifiedAll.map((artifact) => [artifact.id, artifact]))
    // QA must judge the package as built: use the manifest's artifact set, but
    // re-read each record so tampering with current.json is visible.
    const buildArtifacts = (manifest.artifacts ?? []).map((artifact) => verifiedById.get(artifact.id)).filter(Boolean)
    const signoff = manifest.signoff ?? {}
    const qa = await validateDelivery({
      root: opened.root,
      outDir,
      qaDir,
      artifacts: buildArtifacts.length > 0 ? buildArtifacts : verifiedAll,
      verifiedArtifacts: verifiedAll,
      allArtifacts,
      claims: buildInput.claims ?? [],
      evidence: buildInput.evidence ?? [],
      findings: Array.isArray(buildInput.cellMap) ? buildInput.cellMap : [],
      comprehensive: buildInput.comprehensive?.sheets ?? [],
      workbookMap,
      meta: { partial: false, signoff },
      signoff,
    })

    // Freshness: the package must pin exactly the currently released inputs.
    // Bookkeeping/terminal system types are updated by the runner AFTER the
    // deliverable step (search ledger, coverage, trigger engine, the report
    // itself); they never invalidate an otherwise identical business package.
    const EXCLUDE = new Set(['report.deliverable', 'dd.request_list', 'search.ledger', 'source.coverage', 'risk.redflags'])
    const current = new Map(
      verifiedAll
        .filter((artifact) => !EXCLUDE.has(artifact.type))
        .map((artifact) => [`${artifact.id}@${artifact.revision}#${artifact.contentHash}`, artifact]),
    )
    const built = new Map(
      (manifest.artifacts ?? [])
        .filter((artifact) => !EXCLUDE.has(artifact.type))
        .map((artifact) => [`${artifact.id}@${artifact.revision}#${artifact.contentHash}`, artifact]),
    )
    const missing = [...built.keys()].filter((key) => !current.has(key))
    const added = [...current.keys()].filter((key) => !built.has(key))
    const packageStale = missing.length > 0 || added.length > 0 || (manifest.template ?? 'standard') !== (options.template ?? manifest.template ?? 'standard')
    let verdict = qa
    if (packageStale) {
      verdict = {
        ...qa,
        passed: false,
        blocking: [
          ...qa.blocking,
          {
            id: 'package_stale',
            message: '交付包与当前 verified 底稿不一致，请重新构建后再体检',
            missing,
            added,
          },
        ],
      }
    }
    return {
      ok: verdict.passed === true,
      qa: verdict,
      outDir,
      generatedAt: manifest.generatedAt ?? null,
      checkedAt: nowIso(),
      packageStale,
    }
  }

  async migrate(projectIdOrRoot, options = {}) {
    const root = typeof projectIdOrRoot === 'string' && !projectIdOrRoot.startsWith('eq_') ? resolve(projectIdOrRoot) : (await this.resolveProject(projectIdOrRoot)).root
    const { migrateLegacyProject } = await import('./kernel/migrate.js')
    return migrateLegacyProject({ root, library: this.requireLibrary(), ...options })
  }

  async doctor() {
    const checks = []
    const library = this.library
    checks.push({ id: 'library', ok: Boolean(library), detail: library ? `${library.moduleList.length} 个模块 / ${library.typeList.length} 类底稿` : this.libraryError?.message ?? '未加载' })
    if (library) {
      checks.push({ id: 'module_errors', ok: library.errors.length === 0, detail: `${library.errors.length} 个模块错误` })
      checks.push({ id: 'module_warnings', ok: true, detail: `${library.warnings.length} 个警告` })
    }
    const projects = await listProjects()
    checks.push({ id: 'projects', ok: true, detail: `${projects.length} 个项目` })
    checks.push({ id: 'web', ok: Boolean(this.ctx.web), detail: this.ctx.web ? '已配置' : '未配置搜索/抓取 provider' })
    checks.push({ id: 'llm', ok: Boolean(this.ctx.llm), detail: this.ctx.llm ? '可用' : '不可用' })
    checks.push({ id: 'subagents', ok: Boolean(this.ctx.subagents), detail: this.ctx.subagents ? '可用（private-agent）' : '不可用（回退 native-loop）' })
    checks.push({ id: 'python', ok: true, detail: process.env.EQUITY_PYTHON ?? process.env.PYTHON ?? 'python（构建时再验证）' })
    const optional = new Set(['web', 'llm', 'subagents'])
    const coreOk = checks.filter((check) => !optional.has(check.id)).every((check) => check.ok)
    const degraded = checks.some((check) => optional.has(check.id) && !check.ok)
    return { ok: coreOk, degraded, checks }
  }
}

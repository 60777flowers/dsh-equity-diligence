import { listArtifacts, artifactCounts } from './artifacts.js'
import { listIssues } from './issues.js'
import { listRuns, loadRun } from './runner.js'
import { compilePlaybook } from './playbook.js'
import { computeStale } from './stale.js'

function planFromRun(run) {
  return run?.snapshot?.plan ?? null
}

/** Assemble the read model used by the full-page workbench. */
export async function projectState({ root, library, project, playbook }) {
  const artifacts = await listArtifacts(root)
  const runs = await listRuns(root)
  const issues = await listIssues(root)
  const latestRun = runs[0] ?? null
  const counts = artifactCounts(artifacts)
  const compiled = playbook ? compilePlaybook({ library, project, playbook }) : { ok: false, errors: [], warnings: [], plan: null }
  const plan = compiled.plan
  const units = latestRun ? Object.values(latestRun.units ?? {}) : []
  const unitByModule = new Map()
  for (const unit of units) {
    const key = unit.instanceId
    const entry = unitByModule.get(key) ?? { total: 0, accepted: 0, failed: 0, running: 0, blocked: 0, needsHuman: 0, todo: 0 }
    entry.total += 1
    if (unit.status === 'accepted' || unit.status === 'accepted_with_exception') entry.accepted += 1
    else if (unit.status === 'failed') entry.failed += 1
    else if (unit.status === 'running') entry.running += 1
    else if (unit.status === 'blocked') entry.blocked += 1
    else if (unit.status === 'needs_human') entry.needsHuman += 1
    else entry.todo += 1
    unitByModule.set(key, entry)
  }
  const stale = []
  for (const artifact of artifacts) {
    const result = computeStale(artifact, { plan, library, project, artifacts })
    if (result.stale) stale.push({ artifactId: artifact.id, type: artifact.type, subjectId: artifact.subjectId, partitionKey: artifact.partitionKey, reasons: result.reasons })
  }
  const redflags = artifacts.find((artifact) => artifact.type === 'risk.redflags')
  const coverage = artifacts.filter((artifact) => artifact.type === 'source.coverage')
  const deliverable = artifacts.find((artifact) => artifact.type === 'report.deliverable')
  const issuesOpen = issues.filter((issue) => issue.status === 'open' || issue.status === 'deferred')
  const blockingIssues = issuesOpen.filter((issue) => ['gate_failed', 'blocked', 'schema_invalid', 'delivery_qa_failed'].includes(issue.type))
  const nextActions = []
  if (!latestRun) nextActions.push({ action: 'compile', label: '编译方案' })
  if (compiled.ok && (!latestRun || latestRun.status === 'failed')) nextActions.push({ action: 'run', label: '开始运行' })
  if (stale.length > 0) nextActions.push({ action: 'rerun_stale', label: `重跑 ${stale.length} 份 stale 底稿` })
  if (issuesOpen.length > 0) nextActions.push({ action: 'issues', label: `处理 ${issuesOpen.length} 个议题` })
  if (!deliverable) nextActions.push({ action: 'build', label: '构建交付包' })
  if (deliverable && deliverable.status !== 'verified') nextActions.push({ action: 'verify', label: '完成交付体检' })
  if (deliverable?.status === 'verified' && deliverable.data?.qa?.passed) nextActions.push({ action: 'present', label: '交付并签发' })

  return {
    project: {
      projectId: project.projectId,
      name: project.name,
      preset: project.preset,
      status: project.status,
      engagement: project.engagement,
      targets: project.targets,
      root: project.root,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    plan: plan
      ? {
          ok: compiled.ok,
          playbookId: plan.playbookId,
          playbookVersion: plan.playbookVersion,
          snapshotHash: plan.snapshotHash,
          steps: plan.steps.map((step, index) => ({
            index,
            instanceId: step.instanceId,
            moduleId: step.moduleId,
            name: step.name,
            kind: step.kind,
            stage: step.stage,
            scope: step.scope,
            inputs: step.inputs,
            references: step.references,
            outputs: step.outputs,
            params: step.params,
            gates: step.gates,
            review: step.review,
            status: unitByModule.get(step.instanceId) ?? { total: 0, accepted: 0, failed: 0, running: 0, blocked: 0, needsHuman: 0, todo: 0 },
          })),
          errors: compiled.errors,
          warnings: compiled.warnings,
        }
      : null,
    counts,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      subjectId: artifact.subjectId,
      partitionKey: artifact.partitionKey,
      status: artifact.status,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
      asOf: artifact.asOf,
      updatedAt: artifact.updatedAt,
      producedBy: artifact.producedBy,
      flags: artifact.flags ?? [],
      openQuestions: artifact.openQuestions ?? [],
    })),
    runs: runs.slice(0, 20).map((run) => ({
      runId: run.runId,
      status: run.status,
      executor: run.executor,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      counts: summarizeUnits(run.units),
      budget: run.budget,
    })),
    latestRun: latestRun
      ? {
          runId: latestRun.runId,
          status: latestRun.status,
          executor: latestRun.executor,
          startedAt: latestRun.startedAt,
          finishedAt: latestRun.finishedAt,
          budget: latestRun.budget,
          units: Object.values(latestRun.units ?? {}).map((unit) => ({
            unitId: unit.unitId,
            instanceId: unit.instanceId,
            moduleId: unit.moduleId,
            subjectId: unit.subjectId,
            subjectName: unit.subjectName,
            status: unit.status,
            error: unit.error,
            artifactIds: unit.artifactIds,
            attempts: unit.attempts,
            tokens: unit.tokens,
            toolCalls: unit.toolCalls,
            startedAt: unit.startedAt,
            finishedAt: unit.finishedAt,
          })),
        }
      : null,
    issues: issuesOpen,
    blockingIssues,
    stale,
    redflags: redflags?.data?.flags ?? [],
    coverage: coverage.map((artifact) => ({
      subjectId: artifact.subjectId,
      status: artifact.status,
      dimensions: artifact.data?.dimensions ?? [],
      limitations: artifact.data?.limitations ?? [],
    })),
    deliverable: deliverable
      ? {
          artifactId: deliverable.id,
          status: deliverable.status,
          revision: deliverable.revision,
          data: deliverable.data,
        }
      : null,
    nextActions,
    readiness: {
      artifactVerified: artifacts.length > 0 && artifacts.every((artifact) => ['verified', 'stale', 'rejected'].includes(artifact.status)),
      investigationComplete: (() => {
        const targetCount = Math.max(1, project.targets?.length ?? 1)
        const expectedUnits = plan
          ? plan.steps.reduce((sum, step) => sum + (step.scope === 'company' ? targetCount : 1), 0)
          : 0
        const acceptedUnits = units.filter((unit) => ['accepted', 'accepted_with_exception'].includes(unit.status)).length
        const hasBusinessArtifact = artifacts.some((artifact) =>
          !['company.roster', 'search.ledger', 'source.coverage'].includes(artifact.type),
        )
        return Boolean(latestRun && latestRun.status === 'completed' && expectedUnits > 0 && acceptedUnits >= expectedUnits && stale.length === 0 && hasBusinessArtifact)
      })(),
      deliveryReady: Boolean(deliverable && deliverable.status === 'verified' && deliverable.data?.qa?.passed && blockingIssues.length === 0),
    },
  }
}

function summarizeUnits(units) {
  const list = Object.values(units ?? {})
  const out = { total: list.length, accepted: 0, failed: 0, needsHuman: 0, blocked: 0, running: 0, todo: 0 }
  for (const unit of list) {
    if (unit.status === 'accepted' || unit.status === 'accepted_with_exception') out.accepted += 1
    else if (unit.status === 'failed') out.failed += 1
    else if (unit.status === 'needs_human') out.needsHuman += 1
    else if (unit.status === 'blocked') out.blocked += 1
    else if (unit.status === 'running') out.running += 1
    else out.todo += 1
  }
  return out
}

/** Load one run's detail for the run board. */
export async function runDetail({ root, runId }) {
  const run = await loadRun(root, runId)
  if (!run) return null
  return run
}

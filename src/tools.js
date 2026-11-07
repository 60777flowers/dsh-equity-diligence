import { EquityError } from './util/json.js'

function textResult(value) {
  return [{ type: 'text', text: String(value?.summary ?? JSON.stringify(value, null, 2)).slice(0, 12_000) }]
}

const output = {
  schema: {
    type: 'object',
    additionalProperties: true,
    required: ['ok'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
    },
  },
  render: (_args, value) => textResult(value),
}

function jsonSafe(value) {
  // Tool outputs cross a strict JSON boundary. Service snapshots legitimately
  // contain undefined/Date/NaN values; normalize them instead of failing the
  // whole tool call with "value is not lossless JSON".
  return JSON.parse(JSON.stringify(value))
}

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters: { type: 'object', additionalProperties: false, properties: parameters.properties ?? {}, required: parameters.required ?? [] },
    output,
    async execute(args, exec) {
      const value = await execute(args, exec)
      return jsonSafe({ ok: true, ...value })
    },
  }
}

function requireProjectId(args) {
  return args.projectId ?? args.root ?? undefined
}

/**
 * Register the six coarse-grained tools. They all call EquityService; the UI
 * calls the same methods, so there is no second business implementation.
 */
export function registerTools({ ctx, service }) {
  const disposers = []
  disposers.push(ctx.tools.register(tool(
    'equity_project',
    '一级市场调查项目：创建/打开/状态/列表/归档/迁移旧项目。创建时至少给 target（公司名），可选 targets 数组、preset、asOf、clientName。',
    {
      properties: {
        action: { type: 'string', enum: ['create', 'open', 'status', 'list', 'archive', 'migrate'], description: '动作' },
        target: { type: 'string', description: '目标公司名称；create 时必填（或用 targets）' },
        code: { type: 'string', description: '统一社会信用代码/注册号/证券代码（只作标识符，不推断上市状态）' },
        identifiers: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              scheme: { type: 'string' },
              value: { type: 'string' },
              issuer: { type: 'string' },
              jurisdiction: { type: 'string' },
              verificationStatus: { type: 'string' },
            },
            required: ['value'],
          },
          description: '类型化标识符（scheme/value/issuer/jurisdiction/verificationStatus）',
        },
        listingStatus: {
          type: 'string',
          enum: ['unknown', 'unlisted', 'ipo_applied', 'listed', 'suspended', 'delisted', 'not_applicable'],
          description: '上市状态；默认 unknown，不得由代码推断',
        },
        targets: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '多个目标公司' },
        root: { type: 'string', description: '项目目录绝对路径；不填则放到 workspace/equity-projects/<slug>' },
        projectId: { type: 'string', description: '项目 id 或项目目录' },
        preset: { type: 'string', enum: ['skill-only', 'quick', 'standard', 'deep', 'generic'], description: '预设方案' },
        clientName: { type: 'string', description: '委托方名称' },
        asOf: { type: 'string', description: '调查截止日 YYYY-MM-DD' },
        currency: { type: 'string', description: '币种，默认 CNY' },
        executor: { type: 'string', enum: ['private-agent', 'native-loop', 'fixture'], description: '项目默认执行器（可在 equity_run 覆盖）' },
        dryRun: { type: 'boolean', description: '迁移时只预览' },
      },
      required: ['action'],
    },
    async (args) => {
      const action = args.action
      if (action === 'list') return { projects: await service.listProjects() }
      if (action === 'create') {
        const result = await service.createProject({
          target: args.target,
          targets: args.targets,
          code: args.code,
          identifiers: args.identifiers,
          listingStatus: args.listingStatus,
          root: args.root,
          preset: args.preset ?? 'standard',
          asOf: args.asOf,
          currency: args.currency,
          clientName: args.clientName,
          executor: args.executor,
          workspaceRoot: process.cwd(),
        })
        return { ...result, summary: `已创建项目 ${result.projectId}（${result.name}），方案 ${result.playbook.name}，${result.playbook.moduleCount} 个模块。` }
      }
      if (action === 'open') {
        const result = await service.openProject(requireProjectId(args))
        return { ...result, summary: `已打开 ${result.projectId}：${result.counts.total} 份底稿，交付就绪=${result.readiness.deliveryReady}` }
      }
      if (action === 'status') {
        const result = await service.state(requireProjectId(args))
        return { ...result, summary: `项目 ${result.project.projectId}：底稿 ${result.counts.total}，stale ${result.stale.length}，议题 ${result.issues.length}，交付就绪=${result.readiness.deliveryReady}` }
      }
      if (action === 'archive') return service.archiveProject(requireProjectId(args))
      if (action === 'migrate') {
        const result = await service.migrate(requireProjectId(args) ?? args.root, { targetName: args.target, dryRun: args.dryRun })
        return { ...result, summary: result.dryRun ? `迁移预览：${result.markers.join(', ')}` : `已迁移：平台 ${result.imported.platforms}，结果 ${result.imported.results}，交付 ${result.imported.deliverables}` }
      }
      throw new EquityError('bad_action', `不支持的 action：${action}`)
    },
  )))

  disposers.push(ctx.tools.register(tool(
    'equity_playbook',
    '方案读写、编译、预设：list/get/save/compile/apply/presets。编译返回 missing_producer/cycle/order_violation 等错误。',
    {
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'save', 'compile', 'apply', 'presets'], description: '动作' },
        projectId: { type: 'string' },
        root: { type: 'string' },
        playbook: { type: 'string', description: 'YAML 或 JSON 文本；save 时必填' },
        preset: { type: 'string', enum: ['skill-only', 'quick', 'standard', 'deep', 'generic'] },
      },
      required: ['action'],
    },
    async (args) => {
      const id = requireProjectId(args)
      if (args.action === 'presets') return { presets: (await service.modules()).presets }
      if (args.action === 'list') return { modules: (await service.modules()).modules, presets: (await service.modules()).presets }
      if (args.action === 'get') return service.playbook(id)
      if (args.action === 'compile') return service.compile(id, args.playbook)
      if (args.action === 'save') {
        if (!args.playbook) throw new EquityError('missing_playbook', 'save 需要 playbook 文本')
        return service.savePlaybook(id, args.playbook)
      }
      if (args.action === 'apply') {
        if (!args.preset) throw new EquityError('missing_preset', 'apply 需要 preset')
        return service.applyPreset(id, args.preset)
      }
      throw new EquityError('bad_action', `不支持的 action：${args.action}`)
    },
  )))

  disposers.push(ctx.tools.register(tool(
    'equity_run',
    '运行控制：start/status/pause/resume/retry/cancel。start 默认 wait=true；wait=false 时返回 runId 后台运行。mode=adhoc 时用 question 做自由调查。',
    {
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'pause', 'resume', 'retry', 'cancel'], description: '动作' },
        projectId: { type: 'string' },
        root: { type: 'string' },
        runId: { type: 'string' },
        mode: { type: 'string', enum: ['playbook', 'adhoc'] },
        question: { type: 'string' },
        scope: { type: 'string', enum: ['company', 'project'] },
        executor: { type: 'string', enum: ['private-agent', 'native-loop', 'fixture'] },
        wait: { type: 'boolean' },
      },
      required: ['action'],
    },
    async (args, exec) => {
      const id = requireProjectId(args)
      if (args.action === 'status') {
        const run = args.runId
          ? await service.runDetail(id, args.runId)
          : (await service.state(id)).latestRun
        if (!run) return { summary: '还没有运行记录' }
        const units = Array.isArray(run.units) ? run.units : Object.values(run.units ?? {})
        const unitDetails = units.map((unit) => ({
          unitId: unit.unitId,
          instanceId: unit.instanceId ?? null,
          moduleId: unit.moduleId,
          subjectId: unit.subjectId,
          status: unit.status,
          error: unit.error ?? null,
          attempts: unit.attempts,
          artifactIds: unit.artifactIds,
          inputPinsHash: unit.inputPinsHash ?? null,
        }))
        const unitStatuses = Object.fromEntries(unitDetails.map((unit) => [unit.unitId, {
          moduleId: unit.moduleId,
          subjectId: unit.subjectId,
          status: unit.status,
          error: unit.error,
        }]))
        const detail = unitDetails.map((unit) => `${unit.moduleId}=${unit.status}${unit.error ? `(${unit.error})` : ''}`).join('，')
        return { ...run, unitDetails, unitStatuses, summary: `运行 ${run.runId}：${run.status}${detail ? `；${detail}` : ''}` }
      }
      if (args.action === 'pause') return { ...service.pause(args.runId), summary: `已请求暂停 ${args.runId}` }
      if (args.action === 'cancel') return { ...service.cancel(args.runId), summary: `已请求取消 ${args.runId}` }
      if (args.action === 'resume' || args.action === 'retry') {
        const result = await service.resume(id, args.runId, {
          agent: exec?.agent ?? null,
          executor: args.executor,
          provider: exec?.agent?.options?.provider,
          model: exec?.agent?.options?.model,
        })
        return { ...result, summary: `已恢复运行 ${result.runId}：${result.status}（${result.executor}）` }
      }
      if (args.action === 'start') {
        const result = await service.run(id, {
          mode: args.mode ?? 'playbook',
          question: args.question,
          executor: args.executor,
          wait: args.wait !== false,
          agent: exec?.agent ?? null,
          provider: exec?.agent?.options?.provider,
          model: exec?.agent?.options?.model,
        })
        return { ...result, summary: `运行 ${result.runId} 已启动（${result.executor}），状态 ${result.status}` }
      }
      throw new EquityError('bad_action', `不支持的 action：${args.action}`)
    },
  )))

  disposers.push(ctx.tools.register(tool(
    'equity_record',
    '底稿/证据写入：kind=artifact 写入类型化底稿（需 type、subjectId、data，可选 claims/evidence）；kind=evidence 只写证据。Agent 写入固定为 draft/agent，不能自报 verified/human。',
    {
      properties: {
        kind: { type: 'string', enum: ['artifact', 'evidence'], description: '写入类型' },
        projectId: { type: 'string' },
        root: { type: 'string' },
        type: { type: 'string', description: '底稿类型，如 company.identity' },
        subjectId: { type: 'string' },
        partitionKey: { type: 'string' },
        data: { description: '类型化 data 对象' },
        output: { description: '完整 envelope；提供后忽略 data/claims/evidence 顶层' },
        claims: { type: 'array', items: { type: 'object', additionalProperties: true } },
        evidence: { description: '证据对象或数组' },
        derivedFrom: { type: 'array', items: { type: 'object', additionalProperties: true } },
        asOf: { type: 'string' },
        moduleId: { type: 'string' },
        expectedRev: { type: 'integer', description: 'CAS：当前 revision（>=0）；不匹配则 revision_conflict' },
        requestId: { type: 'string', description: '幂等键：同一 requestId 重放返回既有 revision' },
      },
      required: ['kind'],
    },
    async (args) => {
      const id = requireProjectId(args)
      if (args.kind === 'evidence') {
        const result = await service.record(id, { kind: 'evidence', evidence: args.evidence, moduleId: args.moduleId })
        return { ...result, summary: `已写入 ${result.evidence.length} 条证据` }
      }
      const result = await service.record(id, args)
      return { ...result, summary: `已写入底稿 ${result.artifact.type}/${result.artifact.subjectId}/${result.artifact.partitionKey} rev${result.artifact.revision}（${result.artifact.status}）` }
    },
  )))

  disposers.push(ctx.tools.register(tool(
    'equity_review',
    '审核与复核：list 列议题，propose 提议复核。裁决/签发（decide/signoff）是用户专属动作，工具层不暴露。',
    {
      properties: {
        action: { type: 'string', enum: ['list', 'propose'], description: '动作' },
        projectId: { type: 'string' },
        root: { type: 'string' },
        issueId: { type: 'string' },
        reason: { type: 'string' },
        title: { type: 'string' },
        detail: { type: 'string' },
      },
      required: ['action'],
    },
    async (args) => {
      const id = requireProjectId(args)
      if (args.action === 'list') return { issues: await service.issues(id) }
      if (args.action === 'propose') return service.proposeReview(id, args)
      if (args.action === 'decide') {
        // Kept as an explicit deny (not a supported action) so a schema
        // bypass cannot turn into an agent-side decision.
        throw new EquityError('user_only', 'decide/signoff 是用户专属动作；Agent 只能 proposeReview')
      }
      throw new EquityError('bad_action', `不支持的 action：${args.action}`)
    },
  )))

  disposers.push(ctx.tools.register(tool(
    'equity_deliver',
    '交付：build 生成摘要+综合工作簿+7+N+底稿包+QA；verify 只对现有包重新体检（不重建）；present 返回文件清单给父 Agent 调用 present 工具。',
    {
      properties: {
        action: { type: 'string', enum: ['build', 'verify', 'present'], description: '动作' },
        projectId: { type: 'string' },
        root: { type: 'string' },
        template: { type: 'string', enum: ['quick', 'standard', 'deep'] },
        format: { type: 'string', enum: ['md', 'xlsx', 'all'] },
      },
      required: ['action'],
    },
    async (args) => {
      const id = requireProjectId(args)
      if (args.action === 'verify') {
        const result = await service.verifyDelivery(id, args)
        return {
          ...result,
          summary: `交付体检${result.ok ? '通过' : '未通过'}：${result.qa.blocking.length} 个阻断项`,
        }
      }
      const result = await service.deliver(id, args.action, args)
      return { ...result, summary: args.action === 'present' ? `可交付文件 ${result.files.length} 个：${result.outDir}` : `交付构建 ${result.ok ? '通过' : '未通过'}：${result.outDir}` }
    },
  )))

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // ignore teardown errors
      }
    }
  }
}

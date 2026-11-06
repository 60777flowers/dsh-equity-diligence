function parseArgs(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { command: 'help', args: [], flags: {} }
  const tokens = text.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, '')) ?? []
  const command = tokens.shift() ?? 'help'
  const flags = {}
  const args = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=')
      if (inline !== undefined) flags[key] = inline
      else if (tokens[index + 1] && !tokens[index + 1].startsWith('--')) flags[key] = tokens[++index]
      else flags[key] = true
    } else {
      args.push(token)
    }
  }
  return { command, args, flags }
}

/**
 * Register the `/equity` command. Commands never create a model message.
 */
export function registerCommands({ ctx, service }) {
  return ctx.commands.register({
    name: 'equity',
    description: '一级市场调查工作台：项目、方案、运行、交付',
    input: { hint: 'new <公司> | status | compile | run | deliver | doctor | projects' },
    async handler({ agent, rawInput }) {
      const { command, args, flags } = parseArgs(rawInput)
      const projectId = flags.project ?? args[0]
      try {
        if (command === 'help' || command === '') {
          return {
            kind: 'success',
            text: [
              '一级市场调查工作台命令：',
              '/equity projects            列出项目',
              '/equity new <公司名>        新建项目（默认 standard）',
              '/equity status [projectId]  项目状态',
              '/equity compile [projectId] 编译方案',
              '/equity run [projectId]     后台运行（private-agent 优先）',
              '/equity deliver [projectId] 构建交付包',
              '/equity doctor              环境自检',
            ].join('\n'),
          }
        }
        if (command === 'projects') {
          const projects = await service.listProjects()
          return { kind: 'success', text: projects.map((project) => `${project.projectId}  ${project.name}  ${project.root}`).join('\n') || '暂无项目' }
        }
        if (command === 'new') {
          const name = args.join(' ') || flags.name
          if (!name) return { kind: 'error', text: '用法：/equity new <公司名>' }
          const result = await service.createProject({ target: name, preset: flags.preset ?? 'standard', workspaceRoot: process.cwd() })
          return { kind: 'success', text: `已创建 ${result.projectId}\n${result.root}\n方案：${result.playbook.name}` }
        }
        if (command === 'status') {
          const state = await service.state(projectId)
          return {
            kind: 'success',
            text: [
              `${state.project.name}（${state.project.projectId}）`,
              `底稿 ${state.counts.total} ｜ stale ${state.stale.length} ｜ 议题 ${state.issues.length}`,
              `最近运行：${state.latestRun ? `${state.latestRun.runId} ${state.latestRun.status}` : '无'}`,
              `交付就绪：${state.readiness.deliveryReady ? '是' : '否'}`,
              ...state.nextActions.map((action) => `下一步：${action.label}`),
            ].join('\n'),
          }
        }
        if (command === 'compile') {
          const result = await service.compile(projectId)
          return {
            kind: result.ok ? 'success' : 'error',
            text: result.ok
              ? `编译通过：${result.plan.steps.length} 步，${result.plan.edges.length} 条硬依赖，hash ${result.plan.snapshotHash}`
              : `编译失败：\n${result.errors.map((error) => `- [${error.code}] ${error.message}`).join('\n')}`,
          }
        }
        if (command === 'run') {
          const result = await service.run(projectId, {
            mode: flags.mode === 'adhoc' ? 'adhoc' : 'playbook',
            question: flags.question,
            executor: flags.executor,
            wait: false,
            agent,
            provider: agent?.options?.provider,
            model: agent?.options?.model,
          })
          return { kind: 'success', text: `已启动运行 ${result.runId}（${result.executor}）。用 /equity status 查看进度。` }
        }
        if (command === 'deliver') {
          const result = await service.deliver(projectId, 'build', { template: flags.template })
          return {
            kind: result.ok ? 'success' : 'error',
            text: `交付${result.ok ? '通过' : '未通过'}：${result.outDir}\n阻断 ${result.qa.blocking.length} 项，警告 ${result.qa.warnings.length} 项。`,
          }
        }
        if (command === 'doctor') {
          const result = await service.doctor()
          return { kind: result.ok ? 'success' : 'error', text: result.checks.map((check) => `${check.ok ? '✓' : '✗'} ${check.id}: ${check.detail}`).join('\n') }
        }
        return { kind: 'error', text: `未知命令：${command}。用 /equity help 查看。` }
      } catch (error) {
        return { kind: 'error', text: `${error.code ?? 'error'}: ${error.message}` }
      }
    },
  })
}

import { join } from 'node:path'

import { PACKAGE_ROOT } from '../kernel/registry.js'
import { SourceAcquisition } from './source.js'
import { NativeResearchExecutor } from './native-loop.js'
import { PrivateAgentExecutor } from './private-agent.js'
import { FixtureExecutor } from './fixture.js'
import { CompositeExecutor } from './composite.js'

/**
 * Build the executor chain for one run.
 * Mode precedence: project.engine.executor > config.executor > 'private-agent'.
 * private-agent falls back to native-loop only when no agent/subagent service.
 */
export function createExecutor({
  ctx,
  root,
  project,
  library,
  playbook,
  plan,
  agent = null,
  config = {},
  fixtureDir = undefined,
}) {
  const mode = config.executor ?? project?.engine?.executor ?? 'private-agent'
  let primary
  if (mode === 'fixture') {
    primary = new FixtureExecutor({
      fixtureDir: fixtureDir ?? join(PACKAGE_ROOT, 'tests', 'fixtures', 'golden-zhongji'),
      library,
    })
  } else {
    const source = new SourceAcquisition({ ctx, root, projectId: project?.projectId, signal: undefined })
    const modelConfig = {
      provider: project?.engine?.provider ?? config.provider ?? 'deepseek-official',
      model: project?.engine?.model ?? config.model ?? 'deepseek-flash',
      reasoningEffort: config.reasoningEffort,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      modelTimeoutMs: config.modelTimeoutMs,
      agentTimeoutMs: config.agentTimeoutMs,
      library,
      cwd: root,
    }
    const native = new NativeResearchExecutor({ ctx, source, config: modelConfig })
    const privateAgent = new PrivateAgentExecutor({ ctx, source, agent, config: modelConfig })
    const usePrivate = (mode === 'private-agent' || mode === 'auto') && Boolean(ctx.subagents) && Boolean(agent)
    primary = usePrivate ? privateAgent : native
    primary.source = source
  }
  return new CompositeExecutor({
    primary,
    library,
    root,
    project,
    playbook,
    plan,
    run: null,
    signoff: config.signoff ?? {},
  })
}

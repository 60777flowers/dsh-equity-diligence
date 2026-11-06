import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { EquityService } from './service.js'
import { registerTools } from './tools.js'
import { registerCommands } from './commands.js'
import { registerWebApi } from './web-api.js'
import { ASSETS_DIR } from './kernel/registry.js'

export const name = 'equity-diligence'
// Web profile services used directly by the workbench. Declaring them keeps
// the plugin inactive (instead of crashing) in profiles without the Web stack.
export const inject = ['tools', 'commands', 'skills', 'connection', 'web', 'llm', 'subagents']

const SKILL_NAME = 'equity-diligence'

export async function registerSkill(ctx) {
  if (!ctx.skills) return null
  const file = join(ASSETS_DIR, 'skills', SKILL_NAME, 'SKILL.md')
  let content
  try {
    content = await readFile(file, 'utf8')
  } catch {
    content = `# 一级市场调查\n\n使用 equity_project / equity_playbook / equity_run / equity_record / equity_review / equity_deliver 完成公开信息调查。\n`
  }
  return ctx.skills.register({
    name: SKILL_NAME,
    description: '一级市场尽调前的公开信息调查：项目、方案、底稿、证据、运行、交付。用户要求调查某家公司/基金/平台的股权、投资版图、业务、风险或合作可能时使用。',
    content,
    // SkillSource is required by the runtime registry; 'runtime' marks a
    // plugin-contributed skill rather than a project/user directory skill.
    source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
  })
}

/**
 * Host plugin entry. The service is the single operation layer shared by all
 * six tools, the /equity command and the authenticated Web API.
 */
export async function apply(ctx, config = {}) {
  const service = new EquityService({ ctx, config })
  try {
    await service.init()
  } catch (error) {
    ctx.logger?.error?.('[equity] library init failed:', error)
  }
  const disposers = []
  try {
    disposers.push(registerTools({ ctx, service }))
  } catch (error) {
    ctx.logger?.error?.('[equity] tool registration failed:', error)
  }
  if (ctx.commands) {
    try {
      disposers.push(registerCommands({ ctx, service }))
    } catch (error) {
      ctx.logger?.error?.('[equity] command registration failed:', error)
    }
  }
  try {
    disposers.push(registerWebApi({ ctx, service }))
  } catch (error) {
    ctx.logger?.error?.('[equity] web api registration failed:', error)
  }
  if (ctx.skills) {
    try {
      const dispose = await registerSkill(ctx)
      if (dispose) disposers.push(dispose)
    } catch (error) {
      ctx.logger?.warn?.('[equity] skill registration failed:', error)
    }
  }
  ctx.logger?.info?.(`[equity] ready: ${service.library?.moduleList?.length ?? 0} modules, ${service.library?.typeList?.length ?? 0} types`)
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        const result = dispose()
        if (result && typeof result.then === 'function') result.catch(() => {})
      } catch {
        // ignore teardown errors
      }
    }
  }
}

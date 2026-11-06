import { sha256 } from '../util/json.js'

function text(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function truncate(value, max = 6000) {
  const output = text(value)
  return output.length > max ? `${output.slice(0, max)}\n…（截断）` : output
}

/** Pick the most useful artifact for a type: summary partition first. */
export function pickArtifact(records = []) {
  if (records.length === 0) return null
  return (
    records.find((record) => record.partitionKey === '_summary') ??
    records.find((record) => record.partitionKey === '_default') ??
    records[0]
  )
}

/** Render a compact artifact summary for prompt variables. */
export function artifactPromptSummary(record) {
  if (!record) return '（缺失）'
  const lines = [
    `type: ${record.type}`,
    `subject: ${record.subjectId}`,
    `partition: ${record.partitionKey}`,
    `status: ${record.status}`,
    `asOf: ${record.asOf}`,
    `revision: ${record.revision}`,
    `flags: ${(record.flags ?? []).map((flag) => flag.desc).join('; ') || '无'}`,
    `openQuestions: ${(record.openQuestions ?? []).map((item) => (typeof item === 'string' ? item : item.question)).join('; ') || '无'}`,
    'data:',
    truncate(record.data, 5000),
  ]
  return lines.join('\n')
}

/** Build the variable table for one unit. */
export function buildVars({ module, project, step, params, inputArtifacts = [], budget = undefined }) {
  const target = project?.targets?.[0] ?? { name: project?.name ?? '目标公司', code: '' }
  const vars = {
    'company.name': target.name,
    'company.code': target.code ?? '',
    'company.market': target.market ?? '',
    'project.name': project?.name ?? '',
    'project.client': project?.engagement?.clientName ?? project?.engagement?.client ?? '',
    'project.asOf': project?.engagement?.asOf ?? '',
    'project.currency': project?.engagement?.currency ?? '',
    'module.name': module?.manifest?.name ?? step?.name ?? '',
    'module.id': module?.id ?? step?.moduleId ?? '',
    'unit.partition': step?.partitionKey ?? '_default',
    'budget.remaining': budget ? JSON.stringify(budget) : '',
    'common_tail': module?.prompts?.tail ?? '',
  }
  for (const [key, value] of Object.entries(params ?? {})) vars[`params.${key}`] = value
  for (const [key, value] of Object.entries(module?.gates ?? {})) vars[`rules.${key}`] = value
  const byType = new Map()
  for (const record of inputArtifacts) {
    const list = byType.get(record.type) ?? []
    list.push(record)
    byType.set(record.type, list)
  }
  for (const [type, records] of byType) {
    vars[`artifact:${type}`] = artifactPromptSummary(pickArtifact(records))
  }
  return vars
}

function replaceVars(template, vars) {
  const missing = []
  const output = String(template ?? '').replaceAll(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, key) => {
    if (Object.hasOwn(vars, key)) return text(vars[key])
    missing.push(key)
    return ''
  })
  return { output, missing }
}

/**
 * Render the module prompt from code, never from model transcription.
 * @returns {{system: string, task: string, tail: string, text: string, templateSha: string, vars: object, missing: string[]}}
 */
export function renderPrompt({ module, project, step, params, inputArtifacts = [], budget = undefined }) {
  const vars = buildVars({ module, project, step, params, inputArtifacts, budget })
  const system = replaceVars(module?.prompts?.system ?? '', vars)
  const task = replaceVars(module?.prompts?.task ?? '', vars)
  const tail = replaceVars(module?.prompts?.tail ?? '', vars)
  const text = [
    system.output.trim(),
    task.output.trim(),
    tail.output.trim(),
  ].filter(Boolean).join('\n\n---\n\n')
  return {
    system: system.output,
    task: task.output,
    tail: tail.output,
    text,
    templateSha: sha256(text),
    vars,
    missing: [...new Set([...system.missing, ...task.missing, ...tail.missing])],
  }
}

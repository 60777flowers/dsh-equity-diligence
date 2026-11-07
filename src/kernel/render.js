import { sha256 } from '../util/json.js'
import {
  entityIdFor,
  formatIdentifiers,
  matchesSubjectId,
  normalizeListingStatus,
  primaryIdentifier,
  subjectIdForTarget,
} from './subjects.js'

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

function pseudoTarget(name) {
  const inputName = String(name ?? '').trim() || '目标公司'
  return { name: inputName, inputName, entityId: entityIdFor({ name: inputName }) }
}

/**
 * Resolve the target a unit is about.
 *
 * A unit must render *its own* target: falling back to `targets[0]` for a
 * multi-target project is how company B's prompt ends up asking about company A
 * (review B2 / kimi P0-02). `targets[0]` is only used for project-scope units
 * and for legacy callers that pass no unit at all.
 */
export function resolveUnitTarget({ project, unit = undefined, target = undefined, step = undefined } = {}) {
  if (target && typeof target === 'object' && target.name) return target
  if (unit?.target && typeof unit.target === 'object' && unit.target.name) return unit.target
  const targets = Array.isArray(project?.targets) ? project.targets : []
  const scope = unit?.scope ?? step?.scope ?? null
  if (scope === 'project') return targets[0] ?? pseudoTarget(project?.name)
  const subjectId = unit?.subjectId ?? step?.subjectId ?? null
  const subjectName = unit?.subjectName ?? step?.subjectName ?? null
  if (subjectId) {
    const matched = targets.find((item) => matchesSubjectId(item, subjectId))
    if (matched) return matched
    // Unit is specific and unmatched: do not substitute another target's identity.
    if (subjectName) return pseudoTarget(subjectName)
    const fromId = String(subjectId).replace(/^co_/, '')
    return pseudoTarget(fromId || project?.name)
  }
  if (subjectName) {
    const matched = targets.find((item) => item.name === subjectName || item.inputName === subjectName)
    return matched ?? pseudoTarget(subjectName)
  }
  // Legacy path: renderPrompt({module, project, step}) without a unit keeps the
  // historical `targets[0]` behaviour for single-target projects.
  return targets[0] ?? pseudoTarget(project?.name)
}

/** A verified identity may contribute a legal name (same threshold as writeback). */
function isVerifiedIdentityRecord(record) {
  const data = record?.data ?? {}
  const actor = record?.producedBy?.actor ?? record?.actor ?? null
  if (actor === 'human') return true
  if (record?.status !== 'verified' && data.verificationStatus !== 'verified') return false
  const ids = new Set((record?.evidence ?? []).map((item) => item?.evidenceId).filter(Boolean))
  for (const id of Array.isArray(record?.evidenceIds) ? record.evidenceIds : []) if (id) ids.add(String(id))
  for (const id of Array.isArray(data.evidenceIds) ? data.evidenceIds : []) if (id) ids.add(String(id))
  return ids.size >= 2
}

function identityMatchesTarget(record, target) {
  const data = record?.data ?? {}
  if (data.entityId && target.entityId && data.entityId === target.entityId) return true
  if (record?.subjectId && matchesSubjectId(target, record.subjectId)) return true
  const inputName = data.inputName ?? data.name
  if (inputName && (inputName === target.name || inputName === target.inputName)) return true
  return false
}

function rosterKeyMatchesTarget(key, target) {
  if (!key) return false
  const text = String(key)
  return text === target.entityId || text === target.name || text === target.inputName || matchesSubjectId(target, text)
}

function pickVerifiedLegalName({ target, inputArtifacts = [] }) {
  if (target?.legalName) return String(target.legalName).trim() || null
  const rosterNames = []
  const identityNames = []
  for (const record of inputArtifacts ?? []) {
    if (record?.type === 'company.roster') {
      for (const item of record.data?.targets ?? []) {
        if (item?.legalName && rosterKeyMatchesTarget(item.entityId ?? item.name, target)) {
          rosterNames.push(String(item.legalName).trim())
        }
      }
      for (const item of record.data?.resolution ?? []) {
        if (item?.legalName && item.applied === true && rosterKeyMatchesTarget(item.entityId ?? item.inputName, target)) {
          rosterNames.push(String(item.legalName).trim())
        }
      }
    } else if (record?.type === 'company.identity') {
      if (record.data?.legalName && identityMatchesTarget(record, target) && isVerifiedIdentityRecord(record)) {
        identityNames.push(String(record.data.legalName).trim())
      }
    }
  }
  return [...rosterNames, ...identityNames].find(Boolean) ?? null
}

/** Build the variable table for one unit. */
export function buildVars({
  module,
  project,
  step,
  params,
  unit = undefined,
  target = undefined,
  inputArtifacts = [],
  budget = undefined,
}) {
  const unitTarget = resolveUnitTarget({ project, unit, target, step })
  const identifiers = Array.isArray(unitTarget?.identifiers) ? unitTarget.identifiers : []
  const listingStatus = normalizeListingStatus(unitTarget?.listingStatus ?? project?.engagement?.listingStatus)
  const jurisdiction = String(unitTarget?.jurisdiction ?? project?.engagement?.jurisdiction ?? 'CN').toUpperCase()
  const primary = primaryIdentifier(identifiers)
  const legacyCode = unitTarget?.code ?? ''
  const identifierText = identifiers.length > 0
    ? formatIdentifiers(identifiers)
    : legacyCode
      ? `未分类外部标识 ${legacyCode}（未做类型推断）`
      : ''
  const legalName = pickVerifiedLegalName({ target: unitTarget, inputArtifacts })
  const vars = {
    // `company.name` prefers the verified legal name; `company.input_name` is
    // what the user typed and is never overwritten.
    'company.name': legalName ?? unitTarget?.name ?? project?.name ?? '',
    'company.input_name': unitTarget?.inputName ?? unitTarget?.name ?? '',
    'company.id': unitTarget?.entityId ?? subjectIdForTarget(unitTarget, project),
    'company.identifiers': identifierText,
    'company.listing_status': listingStatus,
    'company.jurisdiction': jurisdiction,
    // Legacy mirror kept for existing templates: primary identifier value, else
    // the untyped `code` the user typed. It never implies a listing status.
    'company.code': primary?.value ?? legacyCode,
    'company.market': unitTarget?.market ?? '',
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
  for (const [key, value] of Object.entries(module?.gates ?? {})) {
    // Variant dispatch is gate machinery, not a prompt variable.
    if (key === 'variants' || key === 'variantBy') continue
    vars[`rules.${key}`] = value
  }
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
export function renderPrompt({ module, project, step, params, unit = undefined, target = undefined, inputArtifacts = [], budget = undefined }) {
  const vars = buildVars({ module, project, step, params, unit, target, inputArtifacts, budget })
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

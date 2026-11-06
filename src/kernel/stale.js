import { daysBetween, today } from '../util/time.js'

function stepForRecord(record, plan) {
  if (!plan?.steps) return null
  const byUnit = plan.steps.find((step) => step.instanceId === record.producedBy?.unitId)
  if (byUnit) return byUnit
  return plan.steps.find((step) => step.moduleId === record.producedBy?.moduleId) ?? null
}

/**
 * Compute stale reasons for one artifact. Stale is computed from this
 * artifact's own direct inputs and code version; it never propagates.
 */
export function computeStale(record, { plan, library, project, artifacts, referenceDate = undefined }) {
  const reasons = []
  if (!record || record.status === 'rejected') return { stale: false, reasons }
  const byId = new Map((artifacts ?? []).map((artifact) => [artifact.id, artifact]))
  for (const edge of record.derivedFrom ?? []) {
    if (edge.kind !== 'input') continue
    const upstream = byId.get(edge.artifactId)
    if (!upstream) {
      reasons.push({ code: 'upstream_missing', artifactId: edge.artifactId })
      continue
    }
    if (upstream.status === 'rejected') {
      reasons.push({ code: 'rejected_upstream', artifactId: edge.artifactId })
      continue
    }
    if (upstream.status === 'stale') {
      reasons.push({ code: 'upstream_stale', artifactId: edge.artifactId })
    }
    if (edge.contentHash && upstream.contentHash !== edge.contentHash) {
      reasons.push({
        code: 'upstream_changed',
        artifactId: edge.artifactId,
        expected: edge.contentHash,
        actual: upstream.contentHash,
      })
    }
  }

  const step = stepForRecord(record, plan)
  if (step) {
    if (record.producedBy?.moduleVersion && record.producedBy.moduleVersion !== step.moduleVersion) {
      reasons.push({ code: 'code_changed', field: 'moduleVersion', expected: step.moduleVersion, actual: record.producedBy.moduleVersion })
    }
    if (record.producedBy?.templateSha && step.templateSha && record.producedBy.templateSha !== step.templateSha) {
      reasons.push({ code: 'code_changed', field: 'templateSha' })
    }
    const expectedTypes = new Set((step.inputs ?? []).map((input) => input.type))
    const actualTypes = new Set((record.derivedFrom ?? []).filter((edge) => edge.kind === 'input').map((edge) => edge.type))
    const missing = [...expectedTypes].filter((type) => !actualTypes.has(type))
    if (missing.length > 0) {
      reasons.push({ code: 'deps_changed', missing, extra: [] })
    }
  }

  const meta = library?.types?.get(record.type)
  const maxAgeDays = meta?.freshness?.maxAgeDays
  if (typeof maxAgeDays === 'number' && record.asOf) {
    const reference = referenceDate ?? project?.engagement?.asOf ?? today()
    const age = daysBetween(record.asOf, reference)
    if (age !== null && age > maxAgeDays) {
      reasons.push({ code: 'expired', asOf: record.asOf, maxAgeDays, age })
    }
  }

  return { stale: reasons.length > 0, reasons }
}

/** Downstream closure of affected artifacts (UI hint only, not status). */
export function affectedClosure(artifacts, rootIds) {
  const roots = new Set(Array.isArray(rootIds) ? rootIds : [rootIds])
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const downstream = new Map()
  for (const artifact of artifacts) {
    for (const edge of artifact.derivedFrom ?? []) {
      if (edge.kind !== 'input') continue
      const list = downstream.get(edge.artifactId) ?? []
      list.push(artifact.id)
      downstream.set(edge.artifactId, list)
    }
  }
  const out = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const id = queue.shift()
    for (const child of downstream.get(id) ?? []) {
      if (out.has(child)) continue
      out.add(child)
      queue.push(child)
    }
  }
  return [...out].map((id) => byId.get(id)).filter(Boolean)
}

/** Summarize stale artifacts for the dashboard. */
export function staleSummary(artifacts, context) {
  const stale = []
  for (const artifact of artifacts) {
    const result = computeStale(artifact, { ...context, artifacts })
    if (result.stale) stale.push({ artifactId: artifact.id, type: artifact.type, subjectId: artifact.subjectId, partitionKey: artifact.partitionKey, reasons: result.reasons })
  }
  return stale
}

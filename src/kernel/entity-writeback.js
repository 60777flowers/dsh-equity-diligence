/**
 * Entity-resolution → roster writeback (review B2).
 *
 * The resolution step ("this input name is legal entity X with USCC Y") must
 * reach the artifact layer, otherwise downstream modules keep searching the
 * user's typed name. This module is a *pure* function: it takes the current
 * roster and the identity record(s) and returns the next roster payload.
 * Persisting it (a `company.roster` artifact with partition `_resolution`) is
 * the caller's job — no runner hook is installed yet.
 *
 * Safety rules:
 *  - `target.name` (the immutable input name) is never overwritten;
 *  - `legalName`/`identifiers`/`listingStatus` are applied to targets only from
 *    a verified identity with >=2 evidence, or when a human confirms;
 *  - every candidate is still recorded in `resolution[]` with its own
 *    verification status, so "not applied yet" is visible instead of silent;
 *  - `contentHash` makes repeated writes idempotent.
 */

import { semanticHash } from '../util/json.js'
import { normalizeIdentifiers, normalizeListingStatus, primaryIdentifier } from './subjects.js'

export const ROSTER_RESOLUTION_PARTITION = '_resolution'
export const LEGAL_NAME_MIN_EVIDENCE = 2

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asIdentityList(input) {
  const list = []
  if (Array.isArray(input.identities)) list.push(...input.identities)
  if (input.identity !== undefined && input.identity !== null) list.push(input.identity)
  return list.filter((item) => item !== null && item !== undefined)
}

function viewOf(item) {
  // An artifact record carries `data`; a bare identity payload does not.
  const isRecord = plainObject(item) && plainObject(item.data)
  const record = isRecord ? item : { data: plainObject(item) ? item : {}, status: undefined, evidence: [] }
  return { record, data: record.data ?? {} }
}

export function identityEvidenceCount(record) {
  const data = record?.data ?? {}
  const ids = new Set((record?.evidence ?? []).map((item) => item?.evidenceId).filter(Boolean))
  for (const id of Array.isArray(record?.evidenceIds) ? record.evidenceIds : []) if (id) ids.add(String(id))
  for (const id of Array.isArray(data.evidenceIds) ? data.evidenceIds : []) if (id) ids.add(String(id))
  return ids.size
}

/** Verified = artifact status verified (or data.verificationStatus) or human actor. */
export function isVerifiedIdentity(record, { actor = undefined } = {}) {
  if (actor === 'human') return true
  const data = record?.data ?? {}
  const producedBy = record?.producedBy?.actor ?? record?.actor ?? null
  if (producedBy === 'human') return true
  return record?.status === 'verified' || data.verificationStatus === 'verified'
}

/** A legal name may be written when a human confirms, or when verified with >=2 evidence. */
export function canApplyLegalName(record, { actor = 'agent' } = {}) {
  if (actor === 'human') return true
  return isVerifiedIdentity(record, { actor }) && identityEvidenceCount(record) >= LEGAL_NAME_MIN_EVIDENCE
}

/** Deterministic hash of what an identity claims — the idempotency key. */
export function identityContentHash(item) {
  const { record, data } = viewOf(item)
  return semanticHash({
    entityId: data.entityId ?? record?.subjectId ?? null,
    inputName: data.inputName ?? data.name ?? null,
    legalName: data.legalName ?? null,
    identifiers: normalizeIdentifiers(data.identifiers),
    listingStatus: data.listingStatus ? normalizeListingStatus(data.listingStatus) : null,
    jurisdiction: data.jurisdiction ?? null,
    verificationStatus: data.verificationStatus ?? record?.status ?? null,
    evidence: identityEvidenceCount(record),
  })
}

function mergeIdentifiers(existing, incoming) {
  const out = []
  const index = new Map()
  const rank = { verified: 4, partial: 3, unreachable: 1, conflict: 2, unverified: 0 }
  for (const identifier of [...(existing ?? []), ...(incoming ?? [])]) {
    if (!identifier?.value) continue
    const key = `${identifier.scheme ?? ''}:${identifier.value}`.toUpperCase()
    const current = index.get(key)
    if (current === undefined) {
      index.set(key, out.length)
      out.push({ ...identifier })
      continue
    }
    const previous = out[current]
    if ((rank[identifier.verificationStatus] ?? 0) > (rank[previous.verificationStatus] ?? 0)) out[current] = { ...identifier }
  }
  return out
}

function matchesTarget(target, { data, record }) {
  const entityId = data.entityId ?? null
  const subjectId = record?.subjectId ?? null
  const inputName = data.inputName ?? data.name ?? null
  if (entityId && target.entityId && String(entityId) === String(target.entityId)) return true
  if (subjectId && (subjectId === target.entityId || subjectId === target.name || subjectId === target.inputName)) return true
  if (inputName && (inputName === target.name || inputName === target.inputName)) return true
  if (entityId && !target.entityId && String(entityId) === String(target.name)) return true
  return false
}

function resolutionEntry({ target, record, data, applied, appliedFields, note }) {
  const identifiers = normalizeIdentifiers(data.identifiers, { jurisdiction: data.jurisdiction ?? target?.jurisdiction ?? 'CN' })
  const verificationStatus = isVerifiedIdentity(record) ? 'verified' : 'unverified'
  const entry = {
    inputName: target?.inputName ?? target?.name ?? String(data.inputName ?? data.name ?? ''),
    legalName: String(data.legalName ?? '').trim(),
    entityId: String(target?.entityId ?? data.entityId ?? ''),
    identifiers,
    listingStatus: normalizeListingStatus(data.listingStatus),
    code: primaryIdentifier(identifiers)?.value ?? '',
    verificationStatus,
    evidenceCount: identityEvidenceCount(record),
    contentHash: identityContentHash({ ...record, data }),
    applied: applied === true,
    appliedFields: appliedFields ?? [],
    candidates: [],
  }
  const confidence = String(data.confidence ?? data.resolutionConfidence ?? '')
  if (['high', 'medium', 'low'].includes(confidence)) entry.confidence = confidence
  if (note) entry.note = note
  return entry
}

/**
 * Apply identity records to a roster.
 *
 * @param {object} options
 * @param {object} options.roster - `company.roster` artifact record or its `data`
 * @param {object|object[]} options.identity - identity record(s) or bare `data` payloads
 * @param {object[]} [options.identities] - additional identity records
 * @param {object|null} [options.existingResolution] - current `_resolution` partition data
 * @param {'agent'|'human'|'system'|'import'} [options.actor='agent']
 * @param {string|null} [options.identityArtifactId]
 * @param {string|null} [options.at] - caller-supplied timestamp (kept out of the pure function)
 * @returns {{partition: string, changed: boolean, contentHash: string, data: object, targets: object[], resolution: object[], applied: object[], skipped: object[]}}
 */
export function applyIdentityToRoster({
  roster = {},
  identity = undefined,
  identities = undefined,
  existingResolution = null,
  actor = 'agent',
  identityArtifactId = null,
  at = null,
} = {}) {
  const rosterData = plainObject(roster?.data) ? roster.data : (plainObject(roster) ? roster : {})
  const baseTargets = Array.isArray(rosterData.targets) ? rosterData.targets.map((item) => ({ ...item })) : []
  const items = asIdentityList({ identity, identities })

  const resolution = []
  const applied = []
  const skipped = []

  for (const item of items) {
    const { record, data } = viewOf(item)
    const targetIndex = baseTargets.findIndex((candidate) => matchesTarget(candidate, { data, record }))
    if (targetIndex < 0) {
      skipped.push({ reason: 'target_not_found', inputName: String(data.inputName ?? data.name ?? ''), contentHash: identityContentHash(item) })
      continue
    }
    const target = baseTargets[targetIndex]
    const next = { ...target }
    if (!next.inputName) next.inputName = target.name
    const appliedFields = []
    let note = null

    const allowed = canApplyLegalName(record, { actor })
    const legalName = String(data.legalName ?? '').trim()
    if (legalName && allowed && legalName !== target.legalName) {
      next.legalName = legalName
      appliedFields.push('legalName')
    } else if (legalName && !allowed) {
      note = '主体名称为候选：需 verified 且 >=2 条证据，或人工确认后才写入 target.legalName'
    }

    const identifiers = normalizeIdentifiers(data.identifiers, { jurisdiction: data.jurisdiction ?? target.jurisdiction ?? 'CN' })
    if (identifiers.length > 0 && allowed) {
      const merged = mergeIdentifiers(next.identifiers, identifiers)
      if (semanticHash(merged) !== semanticHash(next.identifiers ?? [])) {
        next.identifiers = merged
        appliedFields.push('identifiers')
      }
    }

    const listingStatus = data.listingStatus === undefined || data.listingStatus === null
      ? null
      : normalizeListingStatus(data.listingStatus)
    if (listingStatus && listingStatus !== 'unknown' && allowed && listingStatus !== target.listingStatus) {
      next.listingStatus = listingStatus
      appliedFields.push('listingStatus')
    }

    const incomingEntityId = String(data.entityId ?? '').trim()
    if (incomingEntityId && !next.entityId) {
      next.entityId = incomingEntityId
      appliedFields.push('entityId')
    } else if (incomingEntityId && next.entityId && incomingEntityId !== String(next.entityId)) {
      note = note
        ? `${note}；身份记录 entityId ${incomingEntityId} 与 target ${next.entityId} 冲突，未改写`
        : `身份记录 entityId ${incomingEntityId} 与 target ${next.entityId} 冲突，未改写`
      skipped.push({ reason: 'entity_id_conflict', targetEntityId: next.entityId, identityEntityId: incomingEntityId })
    }

    baseTargets[targetIndex] = next
    const entry = resolutionEntry({ target: next, record, data, applied: appliedFields.length > 0, appliedFields, note })
    resolution.push(entry)
    if (appliedFields.length > 0) applied.push({ target: next.entityId ?? next.name, fields: appliedFields })
  }

  const contentHash = semanticHash({
    resolution: resolution.map((entry) => ({
      entityId: entry.entityId,
      inputName: entry.inputName,
      legalName: entry.legalName,
      identifiers: entry.identifiers,
      listingStatus: entry.listingStatus,
      verificationStatus: entry.verificationStatus,
      applied: entry.applied,
      appliedFields: entry.appliedFields,
    })),
    skipped,
  })

  const existingHash = existingResolution?.contentHash ?? null
  if (existingHash && existingHash === contentHash) {
    return {
      partition: ROSTER_RESOLUTION_PARTITION,
      changed: false,
      contentHash,
      data: existingResolution,
      targets: baseTargets,
      resolution: existingResolution?.resolution ?? resolution,
      applied: [],
      skipped: [],
    }
  }

  const data = {
    targets: baseTargets,
    resolution,
    targetCount: baseTargets.length,
    resolvedCount: resolution.filter((entry) => entry.applied).length,
    contentHash,
    ...(at ? { appliedAt: at } : {}),
    ...(identityArtifactId ? { identityArtifactId } : {}),
    actor,
  }

  return {
    partition: ROSTER_RESOLUTION_PARTITION,
    changed: true,
    contentHash,
    data,
    targets: baseTargets,
    resolution,
    applied,
    skipped,
  }
}

/** Read the current `_resolution` partition out of a roster artifact list. */
export function findResolutionPartition(records = []) {
  return (records ?? []).find(
    (record) => record?.type === 'company.roster' && record.partitionKey === ROSTER_RESOLUTION_PARTITION,
  ) ?? null
}

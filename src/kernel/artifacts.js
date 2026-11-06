import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  EquityError,
  canonicalJson,
  isPlainObject,
  newId,
  semanticHash,
  sha256,
} from '../util/json.js'
import {
  appendJsonLine,
  atomicWriteJson,
  atomicWriteText,
  ensureDir,
  portableJoin,
  readJson,
  readJsonLines,
  readText,
  safeSegment,
} from '../util/fs.js'
import { nowIso } from '../util/time.js'
import { validate } from '../util/schema.js'

const POINTERS = new Set(['current', 'verified', 'running', 'rejected'])

export function artifactDir(root, type, subjectId, partitionKey = '_default') {
  return join(
    root,
    '.equity',
    'artifacts',
    safeSegment(type),
    safeSegment(subjectId),
    safeSegment(partitionKey),
  )
}

export function artifactKey({ type, scope, subjectId, partitionKey, period }) {
  return canonicalJson({
    type,
    scope,
    subjectId: subjectId ?? null,
    partitionKey: partitionKey ?? '_default',
    asOf: period?.asOf ?? null,
    start: period?.start ?? null,
    end: period?.end ?? null,
  })
}

function evidenceFile(root, moduleId) {
  const slug = String(moduleId ?? 'system').split('/').pop() || 'system'
  return join(root, '.equity', 'evidence', `${safeSegment(slug)}.jsonl`)
}

function claimsFile(root, subjectId) {
  return join(root, '.equity', 'claims', `${safeSegment(subjectId)}.jsonl`)
}

function blobFile(root, rawHash) {
  const hex = String(rawHash).replace(/^sha256:/, '')
  return join(root, '.equity', 'evidence', 'blobs', `${hex}.txt`)
}

/** Normalize one evidence item and persist its immutable raw snapshot. */
export async function normalizeEvidence(root, item) {
  if (!isPlainObject(item)) throw new EquityError('bad_evidence', 'evidence 必须是对象')
  const evidence = { ...item }
  evidence.evidenceId = evidence.evidenceId || newId('ev')
  evidence.retrievedAt = evidence.retrievedAt || nowIso()
  evidence.sourceTier = evidence.sourceTier || 'database'
  evidence.sourceAuthority = evidence.sourceAuthority || 'C'
  evidence.sourceIndependence = evidence.sourceIndependence || 'unknown'
  evidence.verificationStatus = evidence.verificationStatus || 'unverified'
  evidence.claimConfidence = evidence.claimConfidence || 'low'
  evidence.verification = evidence.verification || { method: 'import', checkedAt: nowIso(), matches: evidence.verificationStatus === 'verified' }

  const rawText = typeof evidence.rawText === 'string' ? evidence.rawText : null
  delete evidence.rawText
  if (rawText !== null) {
    const rawHash = sha256(rawText)
    await ensureDir(join(root, '.equity', 'evidence', 'blobs'))
    const textFile = portableJoin(root, `.equity/evidence/blobs/${rawHash.replace(/^sha256:/, '')}.txt`)
    const previous = await readText(textFile, null)
    if (previous === null) await atomicWriteText(textFile, rawText)
    evidence.rawHash = rawHash
    evidence.snapshotPath = `.equity/evidence/blobs/${rawHash.replace(/^sha256:/, '')}.txt`
  }
  if (!evidence.rawHash && evidence.snapshotPath) {
    const text = await readText(portableJoin(root, evidence.snapshotPath), null)
    if (text !== null) evidence.rawHash = sha256(text)
  }
  return evidence
}

/** Normalize a claim and its links. */
export function normalizeClaim(claim, { subjectId, asOf, evidenceIds }) {
  if (!isPlainObject(claim)) throw new EquityError('bad_claim', 'claim 必须是对象')
  const out = { ...claim }
  out.claimId = out.claimId || newId('cl')
  out.subjectId = out.subjectId || subjectId
  out.predicate = out.predicate || 'unspecified'
  out.status = out.status || 'found'
  out.materiality = out.materiality || 'context'
  out.period = out.period || { asOf }
  out.evidenceLinks = Array.isArray(out.evidenceLinks) ? out.evidenceLinks : []
  for (const link of out.evidenceLinks) {
    if (!link.evidenceId || !['supports', 'contradicts', 'contextual'].includes(link.role)) {
      throw new EquityError('bad_claim', `claim ${out.claimId} 的 evidenceLink 缺少 evidenceId/role`)
    }
    if (evidenceIds && !evidenceIds.has(link.evidenceId)) {
      throw new EquityError('bad_claim', `claim ${out.claimId} 引用了未提交的证据 ${link.evidenceId}`)
    }
  }
  if (out.materiality === 'material' && !out.evidenceLinks.some((link) => link.role === 'supports')) {
    out._materialWithoutEvidence = true
  }
  return out
}

/** Append evidence records to the ledger and return normalized records. */
export async function appendEvidence(root, moduleId, items) {
  const out = []
  for (const item of items ?? []) {
    const evidence = await normalizeEvidence(root, item)
    const file = evidenceFile(root, moduleId)
    await ensureDir(join(root, '.equity', 'evidence'))
    await appendJsonLine(file, evidence)
    out.push(evidence)
  }
  return out
}

/** Append claims to the subject claim ledger. */
export async function appendClaims(root, subjectId, claims) {
  const file = claimsFile(root, subjectId)
  for (const claim of claims ?? []) {
    await ensureDir(join(root, '.equity', 'claims'))
    await appendJsonLine(file, claim)
  }
}

/** Load all evidence, last record per evidenceId wins. */
export async function listEvidence(root, { evidenceId, moduleId } = {}) {
  const dir = join(root, '.equity', 'evidence')
  let files = []
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const map = new Map()
  for (const file of files) {
    if (moduleId && file !== `${safeSegment(moduleId.split('/').pop())}.jsonl`) continue
    const { lines } = await readJsonLines(join(dir, file))
    for (const line of lines) map.set(line.evidenceId, line)
  }
  const all = [...map.values()]
  if (evidenceId) return all.filter((item) => item.evidenceId === evidenceId)
  return all
}

/** Load all claims for a subject, last record per claimId wins. */
export async function listClaims(root, subjectId) {
  const file = claimsFile(root, subjectId)
  const { lines } = await readJsonLines(file)
  const map = new Map()
  for (const line of lines) map.set(line.claimId, line)
  return [...map.values()]
}

/** Validate the full output envelope against the registered type schema. */
export function validateOutput(library, type, output) {
  const meta = library.types.get(type)
  if (!meta) throw new EquityError('unknown_artifact_type', `未注册的类型：${type}`)
  const result = validate(meta.schema, output)
  if (!result.valid) {
    throw new EquityError('schema_mismatch', `${type} 输出不符合 schema`, {
      type,
      errors: result.errors,
    })
  }
  return meta
}

function normalizeDerivedFrom(list, typeLookup) {
  return (list ?? []).map((edge) => ({
    artifactId: edge.artifactId,
    type: edge.type ?? typeLookup?.(edge.artifactId) ?? 'unknown',
    kind: edge.kind ?? 'input',
    revision: edge.revision ?? 1,
    contentHash: edge.contentHash ?? null,
    fieldPaths: Array.isArray(edge.fieldPaths) ? edge.fieldPaths : [],
  }))
}

/**
 * Record one artifact revision.
 * The output is the module envelope `{asOf, openQuestions, flags, sourceCoverage, claims, evidence, data}`.
 */
export async function recordArtifact({
  root,
  library,
  type,
  subjectId,
  partitionKey = '_default',
  period = undefined,
  output,
  producedBy = {},
  derivedFrom = [],
  status = 'draft',
  actor = 'agent',
  expectedRev = undefined,
  checks = [],
  id = undefined,
  typeLookup = undefined,
}) {
  const meta = validateOutput(library, type, output)
  const existing = await readJson(join(artifactDir(root, type, subjectId, partitionKey), 'current.json'), null)
  if (existing && expectedRev !== undefined && existing.revision !== expectedRev) {
    throw new EquityError('revision_conflict', `底稿 ${type}/${subjectId}/${partitionKey} 已被更新`, {
      expectedRev,
      actualRev: existing.revision,
    })
  }
  const effectivePeriod = period ?? { asOf: output.asOf, start: null, end: null }
  const evidence = await appendEvidence(root, producedBy.moduleId ?? 'system', output.evidence ?? [])
  const evidenceIds = new Set(evidence.map((item) => item.evidenceId))
  const claims = (output.claims ?? []).map((claim) =>
    normalizeClaim(claim, { subjectId, asOf: output.asOf, evidenceIds }),
  )
  for (const claim of claims) {
    if (claim._materialWithoutEvidence && status === 'verified') {
      throw new EquityError('missing_evidence', `material claim ${claim.claimId} 没有 supports 证据`)
    }
    delete claim._materialWithoutEvidence
  }
  await appendClaims(root, subjectId, claims)

  const data = output.data
  const contentHash = semanticHash(data)
  const presentationHash = sha256(JSON.stringify(data))
  const revision = (existing?.revision ?? 0) + 1
  const codeVersion = `${producedBy.moduleId ?? 'unknown'}@${producedBy.moduleVersion ?? '0.0.0'}${producedBy.templateSha ? `+tmpl:${String(producedBy.templateSha).replace(/^sha256:/, '').slice(0, 12)}` : ''}`
  const timestamp = nowIso()
  const record = {
    schemaVersion: 1,
    id: id ?? existing?.id ?? newId('art'),
    type,
    typeVersion: meta.version,
    scope: meta.scope,
    subjectId,
    partitionKey,
    period: effectivePeriod,
    status,
    revision,
    contentHash,
    presentationHash,
    codeVersion,
    data,
    claimIds: claims.map((claim) => claim.claimId),
    evidenceIds: [...new Set([...(existing?.evidenceIds ?? []), ...evidenceIds])],
    derivedFrom: normalizeDerivedFrom(derivedFrom, typeLookup),
    checks: checks.length ? checks : [{ id: 'schema', status: 'pass', detail: '' }],
    producedBy: {
      moduleId: producedBy.moduleId ?? 'unknown',
      moduleVersion: producedBy.moduleVersion ?? '0.0.0',
      runId: producedBy.runId ?? null,
      unitId: producedBy.unitId ?? null,
      actor,
    },
    asOf: output.asOf,
    openQuestions: output.openQuestions ?? [],
    flags: output.flags ?? [],
    sourceCoverage: output.sourceCoverage ?? {},
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  }
  if (status === 'verified') record.verifiedAt = timestamp
  if (status === 'stale') record.staleAt = timestamp

  const dir = artifactDir(root, type, subjectId, partitionKey)
  await ensureDir(dir)
  const revFile = join(dir, `rev-${String(revision).padStart(4, '0')}.json`)
  await atomicWriteJson(revFile, record)
  await atomicWriteJson(join(dir, 'current.json'), record)
  if (status === 'verified') await atomicWriteJson(join(dir, 'verified.json'), record)
  if (status === 'running') await atomicWriteJson(join(dir, 'running.json'), record)
  if (status === 'rejected') await atomicWriteJson(join(dir, 'rejected.json'), record)
  return record
}

/** Convenience for project bootstrap / system artifacts. */
export async function recordSystemArtifact({ root, library, type, subjectId, partitionKey = '_default', data, moduleId, status = 'verified', asOf }) {
  const meta = library.types.get(type)
  if (!meta) throw new EquityError('unknown_artifact_type', `未注册的类型：${type}`)
  return recordArtifact({
    root,
    library,
    type,
    subjectId,
    partitionKey,
    output: {
      asOf: asOf ?? new Date().toISOString().slice(0, 10),
      openQuestions: [],
      flags: [],
      sourceCoverage: { queries: [], databases: [], retrievedAt: nowIso(), limitations: [] },
      claims: [],
      evidence: [],
      data,
    },
    producedBy: { moduleId, moduleVersion: '1.0.0', actor: 'system', templateSha: null },
    status,
    actor: 'system',
  })
}

/** Read one artifact pointer. */
export async function readArtifact(root, type, subjectId, partitionKey = '_default', pointer = 'current') {
  if (!POINTERS.has(pointer)) throw new EquityError('bad_pointer', `未知指针：${pointer}`)
  return readJson(join(artifactDir(root, type, subjectId, partitionKey), `${pointer}.json`), null)
}

/** Read the newest revision file. */
export async function readRevision(root, type, subjectId, partitionKey, revision) {
  const file = join(artifactDir(root, type, subjectId, partitionKey), `rev-${String(revision).padStart(4, '0')}.json`)
  return readJson(file, null)
}

/** List current artifacts, optionally filtered. */
export async function listArtifacts(root, filter = {}) {
  const base = join(root, '.equity', 'artifacts')
  let typeDirs = []
  try {
    typeDirs = await readdir(base, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const typeDir of typeDirs) {
    if (!typeDir.isDirectory()) continue
    if (filter.type && typeDir.name !== safeSegment(filter.type)) continue
    const typePath = join(base, typeDir.name)
    const subjectDirs = await readdir(typePath, { withFileTypes: true })
    for (const subjectDir of subjectDirs) {
      if (!subjectDir.isDirectory()) continue
      if (filter.subjectId && subjectDir.name !== safeSegment(filter.subjectId)) continue
      const subjectPath = join(typePath, subjectDir.name)
      const partitionDirs = await readdir(subjectPath, { withFileTypes: true })
      for (const partitionDir of partitionDirs) {
        if (!partitionDir.isDirectory()) continue
        if (filter.partitionKey && partitionDir.name !== safeSegment(filter.partitionKey)) continue
        const record = await readJson(join(subjectPath, partitionDir.name, 'current.json'), null)
        if (!record) continue
        if (filter.status && record.status !== filter.status) continue
        out.push(record)
      }
    }
  }
  return out.sort((a, b) =>
    `${a.type}/${a.subjectId}/${a.partitionKey}`.localeCompare(`${b.type}/${b.subjectId}/${b.partitionKey}`),
  )
}

/** Read a rendered/compact output envelope back from an artifact record. */
export function artifactToOutput(record) {
  return {
    asOf: record.asOf,
    openQuestions: record.openQuestions ?? [],
    flags: record.flags ?? [],
    sourceCoverage: record.sourceCoverage ?? {},
    claims: [],
    evidence: [],
    data: record.data,
  }
}

/** Update artifact status without changing data. */
export async function setArtifactStatus(root, record, status, checks = undefined) {
  const dir = artifactDir(root, record.type, record.subjectId, record.partitionKey)
  const next = {
    ...record,
    status,
    updatedAt: nowIso(),
    ...(checks ? { checks } : {}),
  }
  if (status === 'verified') next.verifiedAt = next.updatedAt
  if (status === 'stale') next.staleAt = next.updatedAt
  await atomicWriteJson(join(dir, 'current.json'), next)
  if (status === 'verified') await atomicWriteJson(join(dir, 'verified.json'), next)
  if (status === 'rejected') await atomicWriteJson(join(dir, 'rejected.json'), next)
  return next
}

/** Lineage for one artifact: upstream and downstream. */
export async function getLineage(root, record, all = undefined) {
  const artifacts = all ?? (await listArtifacts(root))
  const upstream = (record.derivedFrom ?? []).map((edge) => {
    const target = artifacts.find((candidate) => candidate.id === edge.artifactId)
    return {
      ...edge,
      artifact: target
        ? {
            id: target.id,
            type: target.type,
            revision: target.revision,
            contentHash: target.contentHash,
            status: target.status,
            subjectId: target.subjectId,
            partitionKey: target.partitionKey,
          }
        : null,
      dangling: !target,
    }
  })
  const downstream = artifacts
    .filter((candidate) => (candidate.derivedFrom ?? []).some((edge) => edge.artifactId === record.id))
    .map((candidate) => ({
      artifactId: candidate.id,
      type: candidate.type,
      subjectId: candidate.subjectId,
      partitionKey: candidate.partitionKey,
      status: candidate.status,
    }))
  return { upstream, downstream }
}

/** Count artifacts by status/type for the UI. */
export function artifactCounts(artifacts) {
  const byStatus = {}
  const byType = {}
  for (const artifact of artifacts) {
    byStatus[artifact.status] = (byStatus[artifact.status] ?? 0) + 1
    byType[artifact.type] = (byType[artifact.type] ?? 0) + 1
  }
  return { total: artifacts.length, byStatus, byType }
}

/** Read a raw evidence blob. */
export async function readEvidenceBlob(root, evidence) {
  if (!evidence?.snapshotPath) return null
  return readFile(portableJoin(root, evidence.snapshotPath), 'utf8')
}

/** Resolve an artifact id to its current record. */
export async function findArtifactById(root, artifactId) {
  const all = await listArtifacts(root)
  return all.find((artifact) => artifact.id === artifactId) ?? null
}

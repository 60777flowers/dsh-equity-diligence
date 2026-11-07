import { open, readdir, readFile, rm, stat } from 'node:fs/promises'
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
const WRITE_STATUSES = new Set(['draft', 'verified', 'running', 'rejected', 'stale'])

// Cross-process write lock. `open(..., 'wx')` is atomic on both Windows and
// POSIX; a stale file (dead pid or older than LOCK_STALE_MS) is reclaimed.
const LOCK_TIMEOUT_MS = 30_000
const LOCK_STALE_MS = 60_000
const processQueues = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Serialize async work per key inside this process. A file lock alone is not
 * enough: two concurrent calls in the same process would busy-wait on each
 * other and can exceed the lock timeout, so queue them first.
 */
function withProcessQueue(key, fn) {
  const previous = processQueues.get(key) ?? Promise.resolve()
  const result = previous.then(fn)
  const tail = result.catch(() => {})
  processQueues.set(key, tail)
  tail.finally(() => {
    if (processQueues.get(key) === tail) processQueues.delete(key)
  })
  return result
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function lockIsStale(file) {
  try {
    const info = await stat(file)
    const age = Date.now() - info.mtimeMs
    if (age > LOCK_STALE_MS) return true
    const text = await readText(file, '')
    try {
      const data = JSON.parse(text)
      if (Number.isInteger(data.pid) && !pidAlive(data.pid)) return age > 1_000
    } catch {
      return age > 5_000
    }
    return false
  } catch (error) {
    return error?.code === 'ENOENT'
  }
}

async function acquireFileLock(file) {
  const token = newId('lock')
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await open(file, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, at: nowIso() }), 'utf8')
      } finally {
        await handle.close()
      }
      return token
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (await lockIsStale(file)) {
        await rm(file, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new EquityError('write_locked', '底稿写入被占用，等待锁超时', { file, timeoutMs: LOCK_TIMEOUT_MS })
      }
      await sleep(20 + Math.floor(Math.random() * 40))
    }
  }
}

async function releaseFileLock(file, token) {
  try {
    const text = await readText(file, '')
    const data = JSON.parse(text)
    if (data?.token === token) await rm(file, { force: true })
  } catch {
    // Releasing is best-effort; a stale lock is reclaimed by the next writer.
  }
}

/**
 * Run `fn` while holding the project-wide artifact write lock.
 * Every revision/CAS/idempotency write goes through here so two runs (or two
 * processes) cannot both read `current.revision` and both append `rev-N`.
 */
export async function withArtifactWriteLock(root, fn) {
  const file = join(root, '.equity', 'locks', 'artifacts.lock')
  return withProcessQueue(file, async () => {
    await ensureDir(join(root, '.equity', 'locks'))
    const token = await acquireFileLock(file)
    try {
      return await fn()
    } finally {
      await releaseFileLock(file, token)
    }
  })
}

/** Stable identity of one materialized revision; used for verified-pointer checks. */
export function artifactVersionKey(record) {
  return `${record?.id}@${record?.revision}#${record?.contentHash}`
}

/**
 * Derive the single code fingerprint used by both writers and `stale.js`.
 * `templateSha` is the MODULE TEMPLATE hash from the compiled plan step, never
 * the hash of a rendered prompt.
 */
export function codeVersionOf({ moduleId, moduleVersion, templateSha } = {}) {
  const base = `${moduleId ?? 'unknown'}@${moduleVersion ?? '0.0.0'}`
  if (!templateSha) return base
  return `${base}+tmpl:${String(templateSha).replace(/^sha256:/, '').slice(0, 12)}`
}

function idempotencyFile(root) {
  return join(root, '.equity', 'idempotency.json')
}

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

/**
 * Evidence is an audit ledger, not a mutable record: an already-recorded
 * evidenceId may not be rewritten with a different quote/source behind an
 * artifact that already points at it. Status-only edits are also ignored so a
 * verified artifact cannot silently inherit a later "verified" upgrade.
 */
function evidenceContentKey(item) {
  return semanticHash({
    evidenceId: item?.evidenceId ?? null,
    quote: item?.quote ?? '',
    rawHash: item?.rawHash ?? '',
    sourceUrl: item?.sourceUrl ?? item?.url ?? '',
    sourceTitle: item?.sourceTitle ?? item?.title ?? '',
    publishedAt: item?.publishedAt ?? '',
    sourceTier: item?.sourceTier ?? '',
    sourceAuthority: item?.sourceAuthority ?? '',
  })
}

async function stabilizeEvidence(root, items) {
  if (!items || items.length === 0) return items ?? []
  const existing = await listEvidence(root)
  const byId = new Map(existing.map((item) => [item.evidenceId, item]))
  const out = []
  for (const item of items) {
    const prior = byId.get(item.evidenceId)
    if (!prior) {
      out.push(item)
      continue
    }
    if (evidenceContentKey(prior) !== evidenceContentKey(item)) {
      throw new EquityError(
        'evidence_immutable',
        `证据 ${item.evidenceId} 已存在且内容不同；不得改写已归档证据`,
        { evidenceId: item.evidenceId },
      )
    }
    // Keep the original line (including its original verification status).
    out.push(prior)
  }
  return out
}

/** Append already-normalized evidence records to a module ledger. */
async function appendNormalizedEvidence(root, moduleId, items) {
  if (!items || items.length === 0) return items ?? []
  const stable = await stabilizeEvidence(root, items)
  const file = evidenceFile(root, moduleId)
  await ensureDir(join(root, '.equity', 'evidence'))
  const existing = new Set((await listEvidence(root)).map((item) => item.evidenceId))
  for (const evidence of stable) {
    if (existing.has(evidence.evidenceId)) continue
    await appendJsonLine(file, evidence)
    existing.add(evidence.evidenceId)
  }
  return stable
}

/** Append evidence records to the ledger and return normalized records. */
export async function appendEvidence(root, moduleId, items) {
  const out = []
  for (const item of items ?? []) {
    out.push(await normalizeEvidence(root, item))
  }
  // `service.record(kind=evidence)` calls this path directly; hold the same
  // artifact lock as recordArtifact so two concurrent first-writes of one
  // evidenceId cannot both pass the immutability check.
  return withArtifactWriteLock(root, () => appendNormalizedEvidence(root, moduleId, out))
}

/**
 * E1/E2: a verified business artifact declared with `requiredEvidence` must
 * carry claims and evidence, and every material claim's supports links must
 * point at evidence whose verificationStatus is `verified`.
 *
 * Deterministic system engines (the trigger engine's `risk.redflags`) pass
 * `allowEmptyEvidence` explicitly from trusted code; there is no implicit
 * actor-based bypass, so an agent write can never reach this state.
 */
function enforceVerifiedEvidence({ meta, claims, evidence, type }) {
  if (meta?.requiredEvidence !== true) return
  if (claims.length === 0 || evidence.length === 0) {
    throw new EquityError(
      'missing_evidence',
      `${type} 声明必须提供 claim 与 evidence；空 claim/证据的底稿不能 verified`,
      { type, claims: claims.length, evidence: evidence.length },
    )
  }
  const byId = new Map(evidence.map((item) => [item.evidenceId, item]))
  for (const claim of claims) {
    if (claim.materiality !== 'material') continue
    const supports = (claim.evidenceLinks ?? []).filter((link) => link.role === 'supports')
    if (supports.length === 0) {
      throw new EquityError('missing_evidence', `material claim ${claim.claimId} 缺少 supports 证据`, {
        claimId: claim.claimId,
      })
    }
    for (const link of supports) {
      const target = byId.get(link.evidenceId)
      const method = target?.verification?.method
      const methodOk = ['quote-exact', 'manual', 'provider'].includes(method)
      const matched = target?.verification?.matches === true
      if (!target || target.verificationStatus !== 'verified' || !methodOk || !matched) {
        throw new EquityError(
          'unverified_evidence',
          !target
            ? `material claim ${claim.claimId} 的 supports 证据 ${link.evidenceId} 缺失`
            : !methodOk || target.verificationStatus !== 'verified'
              ? `material claim ${claim.claimId} 的 supports 证据 ${link.evidenceId} 未经核验（${target.verificationStatus}；method=${method ?? 'missing'}）`
              : `material claim ${claim.claimId} 的 supports 证据 ${link.evidenceId} 的核验结果为不匹配`,
          {
            claimId: claim.claimId,
            evidenceId: link.evidenceId,
            verificationStatus: target?.verificationStatus ?? null,
            method: method ?? null,
            matches: target?.verification?.matches ?? null,
          },
        )
      }
    }
  }
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
 *
 * Write contract:
 * - all revision/CAS/idempotency writes hold the project-wide file lock;
 * - `expectedRev` is a compare-and-swap over `current.revision` (0 = must not exist);
 * - `requestId` is idempotent: a replay returns the earlier revision and never
 *   appends a second revision/claim/evidence batch;
 * - a non-verified write invalidates `verified.json` so a draft/stale/rejected
 *   revision can never be mistaken for the released one.
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
  requestId = undefined,
  attemptId = undefined,
  allowEmptyEvidence = false,
  checks = [],
  id = undefined,
  typeLookup = undefined,
}) {
  if (!WRITE_STATUSES.has(status)) {
    throw new EquityError('bad_status', `不支持的底稿状态：${status}`, { status })
  }
  const meta = validateOutput(library, type, output)
  const effectivePeriod = period ?? { asOf: output.asOf, start: null, end: null }
  const moduleId = producedBy.moduleId ?? 'system'
  const incomingContentHash = semanticHash(output.data)
  const dir = artifactDir(root, type, subjectId, partitionKey)

  return withArtifactWriteLock(root, async () => {
    const existing = await readJson(join(dir, 'current.json'), null)

    // Idempotent replay wins over CAS: a network retry of the same request must
    // return the original record even though its expectedRev has advanced.
    if (requestId) {
      const store = (await readJson(idempotencyFile(root), {})) ?? {}
      const prior = store[requestId]
      if (prior) {
        const priorKey = `${prior.type}\u0000${prior.subjectId}\u0000${prior.partitionKey}`
        const incomingKey = `${type}\u0000${subjectId}\u0000${partitionKey}`
        if (prior.type && priorKey !== incomingKey) {
          throw new EquityError('request_conflict', `requestId ${requestId} 已用于另一份底稿`, {
            requestId,
            expectedArtifact: priorKey,
            actualArtifact: incomingKey,
          })
        }
        if (prior.contentHash && prior.contentHash !== incomingContentHash) {
          throw new EquityError('request_conflict', `requestId ${requestId} 已用于不同内容`, {
            requestId,
            expectedContentHash: prior.contentHash,
            actualContentHash: incomingContentHash,
          })
        }
        const priorRecord = await revisionFileRecord(root, prior)
        if (priorRecord) return priorRecord
        throw new EquityError('idempotent_missing', `requestId ${requestId} 的既有 revision 不可读`, { requestId, prior })
      }
    }

    const actualRev = existing?.revision ?? 0
    if (expectedRev !== undefined && actualRev !== expectedRev) {
      throw new EquityError('revision_conflict', `底稿 ${type}/${subjectId}/${partitionKey} 已被更新`, {
        expectedRev,
        actualRev,
      })
    }

    const normalizedEvidence = []
    for (const item of output.evidence ?? []) {
      normalizedEvidence.push(await normalizeEvidence(root, item))
    }
    const evidenceIds = new Set(normalizedEvidence.map((item) => item.evidenceId))
    const claims = (output.claims ?? []).map((claim) =>
      normalizeClaim(claim, { subjectId, asOf: output.asOf, evidenceIds }),
    )
    for (const claim of claims) {
      if (claim._materialWithoutEvidence && status === 'verified') {
        throw new EquityError('missing_evidence', `material claim ${claim.claimId} 没有 supports 证据`)
      }
      delete claim._materialWithoutEvidence
    }
    if (status === 'verified' && !allowEmptyEvidence) {
      enforceVerifiedEvidence({ meta, claims, evidence: normalizedEvidence, type })
    }

    await appendNormalizedEvidence(root, moduleId, normalizedEvidence)
    await appendClaims(root, subjectId, claims)

    const data = output.data
    const contentHash = incomingContentHash
    const presentationHash = sha256(JSON.stringify(data))
    const revision = actualRev + 1
    const codeVersion = codeVersionOf(producedBy)
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
        moduleId,
        moduleVersion: producedBy.moduleVersion ?? '0.0.0',
        instanceId: producedBy.instanceId ?? null,
        templateSha: producedBy.templateSha ?? null,
        renderedPromptSha: producedBy.renderedPromptSha ?? null,
        runId: producedBy.runId ?? null,
        unitId: producedBy.unitId ?? null,
        attemptId: attemptId ?? producedBy.attemptId ?? null,
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

    await ensureDir(dir)
    const revFile = join(dir, `rev-${String(revision).padStart(4, '0')}.json`)
    await atomicWriteJson(revFile, record)
    await atomicWriteJson(join(dir, 'current.json'), record)
    await syncPointers(dir, record)

    if (requestId) {
      const store = (await readJson(idempotencyFile(root), {})) ?? {}
      store[requestId] = {
        artifactId: record.id,
        type: record.type,
        subjectId: record.subjectId,
        partitionKey: record.partitionKey,
        revision: record.revision,
        contentHash: record.contentHash,
        status: record.status,
        recordedAt: timestamp,
      }
      await atomicWriteJson(idempotencyFile(root), store)
    }
    return record
  })
}

async function revisionFileRecord(root, prior) {
  const byRevision = await readJson(
    join(
      artifactDir(root, prior.type, prior.subjectId, prior.partitionKey),
      `rev-${String(prior.revision).padStart(4, '0')}.json`,
    ),
    null,
  )
  if (byRevision) return byRevision
  const current = await readJson(
    join(artifactDir(root, prior.type, prior.subjectId, prior.partitionKey), 'current.json'),
    null,
  )
  if (current && current.revision === prior.revision) return current
  return null
}

/**
 * Keep the three+one pointers consistent: only a verified revision may leave a
 * `verified.json`; stale/draft/rejected/running explicitly clear it.
 */
async function syncPointers(dir, record) {
  if (record.status === 'verified') {
    await atomicWriteJson(join(dir, 'verified.json'), record)
  } else {
    await rm(join(dir, 'verified.json'), { force: true })
  }
  if (record.status === 'running') {
    await atomicWriteJson(join(dir, 'running.json'), record)
  } else {
    await rm(join(dir, 'running.json'), { force: true })
  }
  if (record.status === 'rejected') await atomicWriteJson(join(dir, 'rejected.json'), record)
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

/**
 * List only artifacts whose CURRENT revision is genuinely released:
 * `current.status === 'verified'` AND `verified.json` carries the same
 * revision + contentHash. This is the delivery/input read path; `listArtifacts`
 * only exposes the latest materialized revision (draft included).
 */
export async function listVerifiedArtifacts(root, filter = {}) {
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
        const dir = join(subjectPath, partitionDir.name)
        const current = await readJson(join(dir, 'current.json'), null)
        if (!current || current.status !== 'verified') continue
        const verified = await readJson(join(dir, 'verified.json'), null)
        if (!verified) continue
        if (verified.revision !== current.revision || verified.contentHash !== current.contentHash) continue
        if (filter.status && current.status !== filter.status) continue
        out.push(current)
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

/**
 * Update artifact status without changing data.
 * Takes the same write lock as `recordArtifact` and refuses to clobber a newer
 * revision. Any non-verified status invalidates `verified.json`.
 */
export async function setArtifactStatus(root, record, status, checks = undefined) {
  if (!WRITE_STATUSES.has(status)) {
    throw new EquityError('bad_status', `不支持的底稿状态：${status}`, { status })
  }
  return withArtifactWriteLock(root, async () => {
    const dir = artifactDir(root, record.type, record.subjectId, record.partitionKey)
    const latest = await readJson(join(dir, 'current.json'), null)
    if (latest && record?.revision !== undefined && latest.revision !== record.revision) {
      throw new EquityError('revision_conflict', `底稿 ${record.type}/${record.subjectId}/${record.partitionKey} 已被更新`, {
        expectedRev: record.revision,
        actualRev: latest.revision,
      })
    }
    const base = latest ?? record
    const next = {
      ...base,
      status,
      updatedAt: nowIso(),
      ...(checks ? { checks } : {}),
    }
    if (status === 'verified') next.verifiedAt = next.updatedAt
    if (status === 'stale') next.staleAt = next.updatedAt
    await ensureDir(dir)
    await atomicWriteJson(join(dir, 'current.json'), next)
    await syncPointers(dir, next)
    return next
  })
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

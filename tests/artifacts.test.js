import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  artifactDir,
  codeVersionOf,
  listArtifacts,
  listClaims,
  listEvidence,
  listVerifiedArtifacts,
  readArtifact,
  recordArtifact,
  setArtifactStatus,
} from '../src/kernel/artifacts.js'
import { computeStale, affectedClosure, stepForRecord } from '../src/kernel/stale.js'
import { unitKeyOf } from '../src/kernel/runner.js'
import { atomicWriteJson, resolveInside, atomicWriteText } from '../src/util/fs.js'
import { EquityError, semanticHash } from '../src/util/json.js'
import { freshProject, readFixture, cleanup } from './helpers/common.js'

test('artifacts: revision, hash, evidence and claims are persisted atomically', async (t) => {
  const opened = await freshProject('artifact')
  t.after(() => cleanup(opened.root))
  const output = await readFixture('golden-zhongji/module-outputs/entity-resolution.json')
  const roster = await readArtifact(opened.root, 'company.roster', 'project')
  const first = await recordArtifact({
    root: opened.root,
    library: opened.library,
    type: 'company.identity',
    subjectId: 'co_示例科技',
    output,
    producedBy: { moduleId: 'builtin/entity-resolution', moduleVersion: '0.1.0', actor: 'agent', templateSha: 'sha256:test' },
    derivedFrom: [{ artifactId: roster.id, type: roster.type, kind: 'input', revision: roster.revision, contentHash: roster.contentHash }],
    status: 'verified',
  })
  assert.equal(first.revision, 1)
  assert.equal(first.status, 'verified')
  assert.ok(first.contentHash.startsWith('sha256:'))
  assert.equal(first.claimIds.length, output.claims.length)
  assert.equal(first.evidenceIds.length, output.evidence.length)
  assert.ok(await readArtifact(opened.root, 'company.identity', 'co_示例科技', '_default', 'verified'))
  assert.equal((await listClaims(opened.root, 'co_示例科技')).length, output.claims.length)
  assert.equal((await listEvidence(opened.root)).length, output.evidence.length)

  const changed = JSON.parse(JSON.stringify(output))
  changed.data.legalRepresentative = '李四'
  const second = await recordArtifact({
    root: opened.root,
    library: opened.library,
    type: 'company.identity',
    subjectId: 'co_示例科技',
    output: changed,
    producedBy: { moduleId: 'builtin/entity-resolution', moduleVersion: '0.1.0', actor: 'agent', templateSha: 'sha256:test' },
    derivedFrom: [{ artifactId: roster.id, type: roster.type, kind: 'input', revision: roster.revision, contentHash: roster.contentHash }],
    status: 'draft',
    expectedRev: 1,
  })
  assert.equal(second.revision, 2)
  assert.notEqual(second.contentHash, first.contentHash)
  assert.equal(second.id, first.id)
  const stale = await computeStale(second, {
    plan: { steps: [{ instanceId: 'entity-resolution', moduleId: 'builtin/entity-resolution', moduleVersion: '0.1.0', templateSha: 'sha256:test', inputs: [{ type: 'company.roster' }] }] },
    library: opened.library,
    project: opened.project,
    artifacts: await listArtifacts(opened.root),
  })
  assert.equal(stale.stale, false)

  await assert.rejects(
    () => recordArtifact({
      root: opened.root,
      library: opened.library,
      type: 'company.identity',
      subjectId: 'co_示例科技',
      output: changed,
      producedBy: { moduleId: 'builtin/entity-resolution', moduleVersion: '0.1.0', actor: 'agent' },
      expectedRev: 1,
    }),
    (error) => error.code === 'revision_conflict',
  )

  const staleRecord = await setArtifactStatus(opened.root, second, 'stale')
  assert.equal(staleRecord.status, 'stale')
  const rejected = await setArtifactStatus(opened.root, staleRecord, 'rejected')
  assert.equal(rejected.status, 'rejected')
})

test('stale: five reasons are reported without propagating status', async () => {
  const upstream = {
    id: 'art_up',
    type: 'company.identity',
    subjectId: 'co_x',
    partitionKey: '_default',
    revision: 1,
    contentHash: 'sha256:old',
    status: 'verified',
    asOf: '2025-01-01',
    derivedFrom: [],
  }
  const record = {
    id: 'art_down',
    type: 'ownership.chain',
    subjectId: 'co_x',
    partitionKey: '_default',
    revision: 1,
    status: 'verified',
    asOf: '2025-01-01',
    producedBy: { moduleId: 'builtin/ownership-chain', moduleVersion: '0.1.0', templateSha: 'sha256:old' },
    derivedFrom: [{ artifactId: 'art_up', type: 'company.identity', kind: 'input', revision: 1, contentHash: 'sha256:old' }],
  }
  const changed = { ...upstream, revision: 2, contentHash: 'sha256:new' }
  const plan = { steps: [{ instanceId: 'ownership-chain', moduleId: 'builtin/ownership-chain', moduleVersion: '0.2.0', templateSha: 'sha256:new', inputs: [{ type: 'company.identity' }, { type: 'company.history' }] }] }
  const result = computeStale(record, {
    plan,
    library: { types: new Map([['ownership.chain', { freshness: { maxAgeDays: 30 } }]]) },
    project: { engagement: { asOf: '2026-01-01' } },
    artifacts: [changed, record],
  })
  const codes = result.reasons.map((reason) => reason.code)
  assert.ok(codes.includes('upstream_changed'))
  assert.ok(codes.includes('code_changed'))
  assert.ok(codes.includes('deps_changed'))
  assert.ok(codes.includes('expired'))
  assert.equal(record.status, 'verified')
})

test('stale: affected closure walks direct inputs only', () => {
  const a = { id: 'a', derivedFrom: [] }
  const b = { id: 'b', derivedFrom: [{ artifactId: 'a', kind: 'input' }] }
  const c = { id: 'c', derivedFrom: [{ artifactId: 'b', kind: 'reference' }] }
  const d = { id: 'd', derivedFrom: [{ artifactId: 'b', kind: 'input' }] }
  const affected = affectedClosure([a, b, c, d], ['a']).map((item) => item.id)
  assert.deepEqual(affected.sort(), ['b', 'd'])
})

test('paths: traversal is rejected and BOM JSON is accepted', async (t) => {
  const dir = await freshProject('paths')
  t.after(() => cleanup(dir.root))
  assert.throws(() => resolveInside(dir.root, '..\\outside'), (error) => error.code === 'path_escape')
  const file = join(dir.root, 'bom.json')
  await atomicWriteText(file, '\uFEFF{"ok":true}')
  const { readJson } = await import('../src/util/fs.js')
  assert.deepEqual(await readJson(file), { ok: true })
  assert.throws(() => resolveInside(dir.root, 'C:\\Windows\\system.ini'), (error) => error.code === 'path_escape')
})

function producedBy(overrides = {}) {
  return {
    moduleId: 'builtin/entity-resolution',
    moduleVersion: '0.1.0',
    instanceId: 'entity-resolution',
    templateSha: 'sha256:tmpl-entity',
    actor: 'agent',
    ...overrides,
  }
}

async function verifiedIdentity(opened, overrides = {}) {
  const output = await readFixture('golden-zhongji/module-outputs/entity-resolution.json')
  return recordArtifact({
    root: opened.root,
    library: opened.library,
    type: 'company.identity',
    subjectId: 'co_示例科技',
    output,
    producedBy: producedBy(),
    status: 'verified',
    ...overrides,
  })
}

test('A1: non-verified revisions invalidate verified.json; listVerifiedArtifacts requires revision+hash match', async (t) => {
  const opened = await freshProject('verified-pointer')
  t.after(() => cleanup(opened.root))
  const dir = artifactDir(opened.root, 'company.identity', 'co_示例科技', '_default')
  const identityVerified = async () => listVerifiedArtifacts(opened.root, { type: 'company.identity' })

  const first = await verifiedIdentity(opened)
  assert.equal(first.status, 'verified')
  assert.equal((await identityVerified()).length, 1)

  const changed = await readFixture('golden-zhongji/module-outputs/entity-resolution.json')
  changed.data.legalRepresentative = '李四'
  const draft = await recordArtifact({
    root: opened.root,
    library: opened.library,
    type: 'company.identity',
    subjectId: 'co_示例科技',
    output: changed,
    producedBy: producedBy(),
    status: 'draft',
    expectedRev: first.revision,
  })
  assert.equal(draft.revision, first.revision + 1)
  assert.equal(await readArtifact(opened.root, 'company.identity', 'co_示例科技', '_default', 'verified'), null)
  assert.equal((await identityVerified()).length, 0)

  // Simulate a legacy/stale verified pointer that survived a draft write: the
  // revision no longer matches current, so it must not be treated as released.
  await atomicWriteJson(join(dir, 'verified.json'), first)
  assert.equal((await identityVerified()).length, 0)

  // verified -> stale must clear the pointer as well.
  const verifiedAgain = await verifiedIdentity(opened, { expectedRev: draft.revision })
  assert.equal((await identityVerified()).length, 1)
  const stale = await setArtifactStatus(opened.root, verifiedAgain, 'stale')
  assert.equal(stale.status, 'stale')
  assert.equal(await readArtifact(opened.root, 'company.identity', 'co_示例科技', '_default', 'verified'), null)
  assert.equal((await identityVerified()).length, 0)

  // Same revision but a forged contentHash is not a valid verified pointer.
  const fresh = await verifiedIdentity(opened, { expectedRev: stale.revision })
  assert.equal((await identityVerified()).length, 1)
  await atomicWriteJson(join(dir, 'verified.json'), { ...fresh, contentHash: 'sha256:forged' })
  assert.equal((await identityVerified()).length, 0)
})

test('A3: requestId replays the same revision and expectedRev serializes concurrent writers', async (t) => {
  const opened = await freshProject('cas-idempotency')
  t.after(() => cleanup(opened.root))
  const output = await readFixture('golden-zhongji/module-outputs/entity-resolution.json')
  const base = await recordArtifact({
    root: opened.root,
    library: opened.library,
    type: 'company.identity',
    subjectId: 'co_示例科技',
    output,
    producedBy: producedBy(),
    status: 'draft',
    requestId: 'req-fixed-1',
  })
  const replay = await recordArtifact({
    root: opened.root,
    library: opened.library,
    type: 'company.identity',
    subjectId: 'co_示例科技',
    output,
    producedBy: producedBy(),
    status: 'draft',
    requestId: 'req-fixed-1',
  })
  assert.equal(replay.revision, base.revision)
  assert.equal(replay.id, base.id)
  const dir = artifactDir(opened.root, 'company.identity', 'co_示例科技', '_default')
  assert.equal((await readdir(dir)).filter((name) => /^rev-\d+\.json$/.test(name)).length, 1)

  const changed = await readFixture('golden-zhongji/module-outputs/entity-resolution.json')
  changed.data.legalRepresentative = '王五'
  await assert.rejects(
    () => recordArtifact({
      root: opened.root,
      library: opened.library,
      type: 'company.identity',
      subjectId: 'co_示例科技',
      output: changed,
      producedBy: producedBy(),
      status: 'draft',
      requestId: 'req-fixed-1',
    }),
    (error) => error.code === 'request_conflict',
  )

  const writers = await Promise.allSettled([
    recordArtifact({
      root: opened.root,
      library: opened.library,
      type: 'company.identity',
      subjectId: 'co_示例科技',
      output: changed,
      producedBy: producedBy(),
      status: 'draft',
      expectedRev: base.revision,
    }),
    recordArtifact({
      root: opened.root,
      library: opened.library,
      type: 'company.identity',
      subjectId: 'co_示例科技',
      output,
      producedBy: producedBy(),
      status: 'draft',
      expectedRev: base.revision,
    }),
  ])
  const fulfilled = writers.filter((item) => item.status === 'fulfilled')
  const rejected = writers.filter((item) => item.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.code, 'revision_conflict')
  const current = await readArtifact(opened.root, 'company.identity', 'co_示例科技', '_default')
  assert.equal(current.revision, base.revision + 1)
})

test('E1/E2: verified required-evidence types need claims+evidence with verified supports', async (t) => {
  const opened = await freshProject('evidence-gates')
  t.after(() => cleanup(opened.root))
  const output = await readFixture('golden-zhongji/module-outputs/entity-resolution.json')

  const partial = JSON.parse(JSON.stringify(output))
  for (const item of partial.evidence) {
    item.verificationStatus = 'partial'
    item.verification = { method: 'manual', checkedAt: '2026-11-07T00:00:00+08:00', matches: false }
  }
  await assert.rejects(
    () => recordArtifact({
      root: opened.root,
      library: opened.library,
      type: 'company.identity',
      subjectId: 'co_示例科技',
      output: partial,
      producedBy: producedBy(),
      status: 'verified',
    }),
    (error) => error.code === 'unverified_evidence',
  )

  const empty = { ...JSON.parse(JSON.stringify(output)), claims: [], evidence: [] }
  await assert.rejects(
    () => recordArtifact({
      root: opened.root,
      library: opened.library,
      type: 'company.identity',
      subjectId: 'co_示例科技',
      output: empty,
      producedBy: producedBy(),
      status: 'verified',
    }),
    (error) => error.code === 'missing_evidence',
  )

  // There is no implicit actor-based bypass: even a system actor must opt in
  // explicitly for deterministic empty-evidence outputs.
  const systemOutput = {
    asOf: '2026-09-30',
    openQuestions: [],
    flags: [],
    sourceCoverage: { queries: [], databases: [], retrievedAt: '2026-11-07T00:00:00+08:00', limitations: [] },
    claims: [],
    evidence: [],
    data: {},
  }
  await assert.rejects(
    () => recordArtifact({
      root: opened.root,
      library: opened.library,
      type: 'risk.redflags',
      subjectId: 'co_示例科技',
      output: systemOutput,
      producedBy: { moduleId: 'system/trigger-engine', moduleVersion: '1.0.0', actor: 'system' },
      status: 'verified',
      actor: 'system',
    }),
    (error) => error.code === 'missing_evidence',
  )
  const system = await recordArtifact({
    root: opened.root,
    library: opened.library,
    type: 'risk.redflags',
    subjectId: 'co_示例科技',
    output: systemOutput,
    producedBy: { moduleId: 'system/trigger-engine', moduleVersion: '1.0.0', actor: 'system' },
    status: 'verified',
    actor: 'system',
    allowEmptyEvidence: true,
  })
  assert.equal(system.status, 'verified')
})

test('A4: stale compares instanceId-first codeVersion; template change is code_changed', () => {
  const step = {
    instanceId: 'investment-map',
    moduleId: 'builtin/investment-map',
    moduleVersion: '0.2.0',
    templateSha: 'sha256:tmpl-1',
    inputs: [{ type: 'ownership.chain' }],
  }
  const produced = {
    moduleId: 'builtin/investment-map',
    moduleVersion: '0.2.0',
    instanceId: 'investment-map',
    templateSha: 'sha256:tmpl-1',
  }
  const record = {
    id: 'art_imap',
    type: 'investment.map',
    subjectId: 'co_x',
    partitionKey: '_default',
    revision: 1,
    status: 'verified',
    asOf: '2026-09-30',
    codeVersion: codeVersionOf(produced),
    producedBy: produced,
    derivedFrom: [{ artifactId: 'art_up', type: 'ownership.chain', kind: 'input', revision: 1, contentHash: 'sha256:up' }],
  }
  const upstream = {
    id: 'art_up',
    type: 'ownership.chain',
    subjectId: 'co_x',
    partitionKey: '_default',
    revision: 1,
    status: 'verified',
    contentHash: 'sha256:up',
    asOf: '2026-09-30',
    derivedFrom: [],
  }
  const context = {
    plan: { steps: [step] },
    library: { types: new Map() },
    project: { engagement: { asOf: '2026-09-30' } },
    artifacts: [upstream, record],
  }
  assert.deepEqual(computeStale(record, context).reasons, [])
  const changed = computeStale(record, { ...context, plan: { steps: [{ ...step, templateSha: 'sha256:tmpl-2' }] } })
  assert.ok(changed.reasons.some((reason) => reason.code === 'code_changed'))

  // instanceId wins even when another step shares the moduleId.
  const sibling = { ...step, instanceId: 'investment-map-2', templateSha: 'sha256:tmpl-2' }
  assert.equal(stepForRecord(record, { steps: [sibling, step] }).instanceId, 'investment-map')
  assert.ok(!computeStale(record, { ...context, plan: { steps: [sibling, step] } }).reasons.some((reason) => reason.code === 'code_changed'))

  // Ambiguous moduleId fallback (no instanceId) must not guess a step.
  const legacy = { ...record, codeVersion: undefined, producedBy: { ...produced, instanceId: undefined } }
  assert.equal(stepForRecord(legacy, { steps: [sibling, step] }), null)
})

test('A3: UnitKey includes resolved input pins', () => {
  const unit = { instanceId: 'entity-resolution', moduleId: 'builtin/entity-resolution', subjectId: 'co_x', partitionKey: '_default', params: { a: 1 } }
  const empty = unitKeyOf(unit, [])
  const pinned = unitKeyOf(unit, [{ artifactId: 'art_1', type: 'company.roster', kind: 'input', revision: 1, contentHash: 'sha256:1' }])
  assert.notEqual(empty, pinned)
  const reordered = unitKeyOf(unit, [{ contentHash: 'sha256:1', revision: 1, kind: 'input', type: 'company.roster', artifactId: 'art_1' }])
  assert.equal(pinned, reordered)
})

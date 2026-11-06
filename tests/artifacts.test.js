import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  listArtifacts,
  listClaims,
  listEvidence,
  readArtifact,
  recordArtifact,
  setArtifactStatus,
} from '../src/kernel/artifacts.js'
import { computeStale, affectedClosure } from '../src/kernel/stale.js'
import { resolveInside, atomicWriteText } from '../src/util/fs.js'
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

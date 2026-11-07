import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ROSTER_RESOLUTION_PARTITION,
  applyIdentityToRoster,
  canApplyLegalName,
  findResolutionPartition,
  identityContentHash,
  identityEvidenceCount,
  isVerifiedIdentity,
} from '../src/kernel/entity-writeback.js'
import { usccCheckChar } from '../src/kernel/subjects.js'
import { validateOutput } from '../src/kernel/artifacts.js'
import { freshLibrary } from './helpers/common.js'

const USCC = `91310000MA1FL0000${usccCheckChar('91310000MA1FL0000')}`

function rosterOf() {
  return {
    type: 'company.roster',
    data: {
      targets: [
        {
          name: '示例科技',
          inputName: '示例科技',
          entityId: 'co_示例科技',
          jurisdiction: 'CN',
          listingStatus: 'unknown',
          identifiers: [],
        },
      ],
      resolution: [],
      targetCount: 1,
      resolvedCount: 0,
    },
  }
}

function identityOf(overrides = {}) {
  return {
    type: 'company.identity',
    status: 'verified',
    subjectId: 'co_示例科技',
    evidence: [{ evidenceId: 'ev_1' }, { evidenceId: 'ev_2' }],
    data: {
      inputName: '示例科技',
      entityId: 'co_示例科技',
      legalName: '示例科技（上海）有限公司',
      listingStatus: 'unlisted',
      identifiers: [{ scheme: 'CN_USCC', value: USCC, verificationStatus: 'verified' }],
      ...overrides,
    },
  }
}

test('writeback: verified identity with two evidence writes legalName but never the input name', () => {
  const result = applyIdentityToRoster({
    roster: rosterOf(),
    identity: identityOf(),
    actor: 'agent',
    at: '2026-11-07T00:00:00+08:00',
    identityArtifactId: 'art_1',
  })
  assert.equal(result.changed, true)
  assert.equal(result.partition, ROSTER_RESOLUTION_PARTITION)
  assert.equal(result.contentHash.startsWith('sha256:'), true)
  assert.equal(result.data.appliedAt, '2026-11-07T00:00:00+08:00')
  assert.equal(result.data.identityArtifactId, 'art_1')

  const target = result.data.targets[0]
  assert.equal(target.name, '示例科技', 'input name must never be overwritten')
  assert.equal(target.inputName, '示例科技')
  assert.equal(target.entityId, 'co_示例科技')
  assert.equal(target.legalName, '示例科技（上海）有限公司')
  assert.equal(target.listingStatus, 'unlisted')
  assert.equal(target.identifiers.length, 1)
  assert.equal(target.identifiers[0].scheme, 'CN_USCC')

  const entry = result.data.resolution[0]
  assert.equal(entry.inputName, '示例科技')
  assert.equal(entry.legalName, '示例科技（上海）有限公司')
  assert.equal(entry.verificationStatus, 'verified')
  assert.equal(entry.evidenceCount, 2)
  assert.equal(entry.applied, true)
  assert.deepEqual(entry.appliedFields.sort(), ['identifiers', 'legalName', 'listingStatus'])
  assert.equal(entry.code, USCC, 'legacy code mirror = primary identifier')

  assert.equal(result.data.resolvedCount, 1)
  assert.equal(result.data.targetCount, 1)
  assert.deepEqual(result.applied, [{ target: 'co_示例科技', fields: entry.appliedFields }])
})

test('writeback: replaying the same identity is idempotent', () => {
  const first = applyIdentityToRoster({ roster: rosterOf(), identity: identityOf(), at: '2026-11-07T00:00:00+08:00' })
  const existing = first.data
  const second = applyIdentityToRoster({ roster: rosterOf(), identity: identityOf(), existingResolution: existing, at: '2027-01-01T00:00:00+08:00' })
  assert.equal(second.changed, false)
  assert.equal(second.contentHash, first.contentHash)
  assert.deepEqual(second.data, existing)
  assert.deepEqual(second.applied, [])
})

test('writeback: non-verified or under-evidenced identities do not rewrite target fields', () => {
  const unverified = identityOf()
  unverified.status = 'draft'
  const draft = applyIdentityToRoster({ roster: rosterOf(), identity: unverified, actor: 'agent' })
  const draftTarget = draft.data.targets[0]
  assert.equal(draftTarget.legalName, undefined)
  assert.equal(draftTarget.listingStatus, 'unknown')
  assert.deepEqual(draftTarget.identifiers, [])
  assert.equal(draft.data.resolution[0].applied, false)
  assert.equal(draft.data.resolution[0].verificationStatus, 'unverified')
  assert.match(draft.data.resolution[0].note, /verified/)

  const oneEvidence = identityOf()
  oneEvidence.evidence = [{ evidenceId: 'ev_1' }]
  assert.equal(canApplyLegalName(oneEvidence, { actor: 'agent' }), false)
  const thin = applyIdentityToRoster({ roster: rosterOf(), identity: oneEvidence, actor: 'agent' })
  assert.equal(thin.data.targets[0].legalName, undefined)
  assert.equal(thin.data.resolution[0].applied, false)

  // ...but the candidate is still recorded, not silently dropped.
  assert.equal(thin.data.resolution[0].legalName, '示例科技（上海）有限公司')
})

test('writeback: human confirmation bypasses the evidence threshold', () => {
  const human = identityOf()
  human.status = 'draft'
  human.evidence = []
  assert.equal(canApplyLegalName(human, { actor: 'human' }), true)
  const result = applyIdentityToRoster({ roster: rosterOf(), identity: human, actor: 'human' })
  assert.equal(result.data.targets[0].legalName, '示例科技（上海）有限公司')
  assert.equal(result.data.resolution[0].applied, true)
})

test('writeback: a conflicting entityId is reported, never silently rewritten', () => {
  const conflict = identityOf({ entityId: 'co_other_entity' })
  const result = applyIdentityToRoster({ roster: rosterOf(), identity: conflict, actor: 'agent' })
  assert.equal(result.data.targets[0].entityId, 'co_示例科技')
  assert.ok(result.skipped.some((entry) => entry.reason === 'entity_id_conflict'))
  assert.match(result.data.resolution[0].note, /冲突/)
})

test('writeback: unknown targets are skipped instead of creating fake ones', () => {
  const stray = {
    type: 'company.identity',
    status: 'verified',
    subjectId: 'co_不存在的公司',
    evidence: [{ evidenceId: 'ev_1' }, { evidenceId: 'ev_2' }],
    data: { inputName: '不存在的公司', legalName: '不存在的公司有限公司' },
  }
  const result = applyIdentityToRoster({ roster: rosterOf(), identity: stray, actor: 'agent' })
  assert.equal(result.data.targets.length, 1)
  assert.equal(result.data.targets[0].legalName, undefined)
  assert.equal(result.data.resolution.length, 0)
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['target_not_found'])
})

test('writeback: multiple identities map to their own targets; contentHash ignores key order', () => {
  const roster = {
    data: {
      targets: [
        { name: '甲公司', inputName: '甲公司', entityId: 'co_甲公司', listingStatus: 'unknown' },
        { name: '乙公司', inputName: '乙公司', entityId: 'co_乙公司', listingStatus: 'unknown' },
      ],
    },
  }
  const a = {
    type: 'company.identity',
    status: 'verified',
    subjectId: 'co_甲公司',
    evidence: [{ evidenceId: 'ev_1' }, { evidenceId: 'ev_2' }],
    data: { entityId: 'co_甲公司', legalName: '甲公司有限公司' },
  }
  const b = {
    type: 'company.identity',
    status: 'verified',
    subjectId: 'co_乙公司',
    evidence: [{ evidenceId: 'ev_3' }, { evidenceId: 'ev_4' }],
    data: { entityId: 'co_乙公司', legalName: '乙公司有限公司', listingStatus: 'listed' },
  }
  const result = applyIdentityToRoster({ roster, identities: [a, b] })
  assert.equal(result.data.targets[0].legalName, '甲公司有限公司')
  assert.equal(result.data.targets[1].legalName, '乙公司有限公司')
  assert.equal(result.data.targets[1].listingStatus, 'listed')
  assert.equal(result.data.resolvedCount, 2)

  const reordered = {
    data: { legalName: '甲公司有限公司', entityId: 'co_甲公司' },
    evidence: [{ evidenceId: 'ev_2' }, { evidenceId: 'ev_1' }],
    subjectId: 'co_甲公司',
    status: 'verified',
    type: 'company.identity',
  }
  assert.equal(identityContentHash(reordered), identityContentHash(a))
  assert.equal(identityEvidenceCount(a), 2)
  assert.equal(isVerifiedIdentity(a), true)
})

test('writeback: resolution partition helper finds the _resolution artifact', () => {
  const records = [
    { type: 'company.roster', partitionKey: '_default' },
    { type: 'company.roster', partitionKey: '_resolution' },
  ]
  assert.equal(findResolutionPartition(records).partitionKey, '_resolution')
  assert.equal(findResolutionPartition([]), null)
})

test('writeback: the _resolution payload validates against the roster schema', async () => {
  const library = await freshLibrary()
  const result = applyIdentityToRoster({
    roster: rosterOf(),
    identity: identityOf(),
    actor: 'agent',
    at: '2026-11-07T00:00:00+08:00',
    identityArtifactId: 'art_1',
  })
  const envelope = {
    asOf: '2026-11-07',
    openQuestions: [],
    flags: [],
    sourceCoverage: { queries: [], databases: [], retrievedAt: '2026-11-07T00:00:00+08:00', limitations: [] },
    claims: [],
    evidence: [],
    data: result.data,
  }
  const meta = validateOutput(library, 'company.roster', envelope)
  assert.equal(meta.type, 'company.roster')
  assert.equal(meta.scope, 'project')
})

import test from 'node:test'
import assert from 'node:assert/strict'

import { appendEvidence, listEvidence, recordArtifact } from '../src/kernel/artifacts.js'
import { freshLibrary, freshProject, cleanup } from './helpers/common.js'

function identityOutput(data = {}) {
  return {
    asOf: '2026-09-30',
    openQuestions: [],
    flags: [],
    sourceCoverage: { queries: [], databases: [], retrievedAt: '2026-09-30T00:00:00.000Z', limitations: [] },
    claims: [],
    evidence: [],
    data: { legalName: '示例科技有限公司', ...data },
  }
}

test('evidence: an existing evidenceId cannot be rewritten with a forged quote', async (t) => {
  const opened = await freshProject('evidence-immutable')
  t.after(() => cleanup(opened.root))
  await appendEvidence(opened.root, 'builtin/test', [{
    evidenceId: 'ev_immutable_1',
    quote: 'REAL QUOTE',
    sourceUrl: 'https://example.com/real',
    verificationStatus: 'unverified',
  }])
  await assert.rejects(
    appendEvidence(opened.root, 'builtin/test', [{
      evidenceId: 'ev_immutable_1',
      quote: 'FORGED QUOTE',
      sourceUrl: 'https://evil.example/forged',
      verificationStatus: 'verified',
    }]),
    (error) => error?.code === 'evidence_immutable',
  )
  const evidence = await listEvidence(opened.root, { evidenceId: 'ev_immutable_1' })
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].quote, 'REAL QUOTE')
  assert.equal(evidence[0].sourceUrl, 'https://example.com/real')
})

test('evidence: concurrent first writes of one evidenceId are serialized', async (t) => {
  const opened = await freshProject('evidence-race')
  t.after(() => cleanup(opened.root))
  const results = await Promise.allSettled([
    appendEvidence(opened.root, 'builtin/race', [{ evidenceId: 'ev_race', quote: 'RACE A', sourceUrl: 'https://a.example' }]),
    appendEvidence(opened.root, 'builtin/race', [{ evidenceId: 'ev_race', quote: 'RACE B', sourceUrl: 'https://b.example' }]),
  ])
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason?.code, 'evidence_immutable')
  const evidence = await listEvidence(opened.root, { evidenceId: 'ev_race' })
  assert.equal(evidence.length, 1)
})

test('requestId: replay is scoped to one artifact, not a global alias', async (t) => {
  const opened = await freshProject('request-scope')
  t.after(() => cleanup(opened.root))
  const base = {
    root: opened.root,
    library: opened.library,
    type: 'company.identity',
    partitionKey: '_default',
    producedBy: { moduleId: 'builtin/test', moduleVersion: '1.0.0', actor: 'agent' },
    status: 'draft',
    actor: 'agent',
    requestId: 'req-same-id',
  }
  const first = await recordArtifact({ ...base, subjectId: 'co_first', output: identityOutput({ legalName: '甲公司' }) })
  assert.equal(first.subjectId, 'co_first')
  await assert.rejects(
    recordArtifact({ ...base, subjectId: 'co_second', output: identityOutput({ legalName: '乙公司' }) }),
    (error) => error?.code === 'request_conflict',
  )
  await assert.rejects(
    recordArtifact({ ...base, subjectId: 'co_second', output: identityOutput({ legalName: '乙公司' }) }),
    (error) => error?.code === 'request_conflict',
  )
})

test('E1: a self-declared verified support without an explicit verification method is rejected', async (t) => {
  const opened = await freshProject('verification-missing')
  t.after(() => cleanup(opened.root))
  const output = identityOutput()
  output.evidence = [{
    evidenceId: 'ev_missing_verification',
    quote: 'QUOTE',
    sourceTier: 'registry',
    verificationStatus: 'verified',
  }]
  output.claims = [{
    claimId: 'cl_missing_verification',
    predicate: 'legalName',
    subjectId: 'co_示例科技',
    status: 'found',
    materiality: 'material',
    evidenceLinks: [{ evidenceId: 'ev_missing_verification', role: 'supports' }],
  }]
  await assert.rejects(
    recordArtifact({
      root: opened.root,
      library: opened.library,
      type: 'company.identity',
      subjectId: 'co_示例科技',
      output,
      producedBy: { moduleId: 'builtin/test', moduleVersion: '1.0.0', actor: 'agent' },
      status: 'verified',
      actor: 'agent',
    }),
    (error) => error?.code === 'unverified_evidence',
  )
})

test('E1: verification.matches=false is rejected even when verificationStatus says verified', async (t) => {
  const opened = await freshProject('verification-mismatch')
  t.after(() => cleanup(opened.root))
  const output = identityOutput()
  output.evidence = [{
    evidenceId: 'ev_mismatch',
    quote: 'QUOTE',
    sourceTier: 'registry',
    verificationStatus: 'verified',
    verification: { matches: false, method: 'manual', checkedAt: '2026-09-30T00:00:00.000Z' },
  }]
  output.claims = [{
    claimId: 'cl_mismatch',
    predicate: 'legalName',
    subjectId: 'co_示例科技',
    status: 'found',
    materiality: 'material',
    evidenceLinks: [{ evidenceId: 'ev_mismatch', role: 'supports' }],
  }]
  await assert.rejects(
    recordArtifact({
      root: opened.root,
      library: opened.library,
      type: 'company.identity',
      subjectId: 'co_示例科技',
      output,
      producedBy: { moduleId: 'builtin/test', moduleVersion: '1.0.0', actor: 'agent' },
      status: 'verified',
      actor: 'agent',
    }),
    (error) => error?.code === 'unverified_evidence',
  )
})

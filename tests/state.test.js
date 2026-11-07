import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { EquityService } from '../src/service.js'
import { registerTools } from '../src/tools.js'
import {
  artifactDir,
  codeVersionOf,
  listVerifiedArtifacts,
  readArtifact,
  setArtifactStatus,
} from '../src/kernel/artifacts.js'
import { compilePlaybook } from '../src/kernel/playbook.js'
import { atomicWriteJson } from '../src/util/fs.js'
import { repoRoot, tempDir, cleanup, readFixture } from './helpers/common.js'

// Isolate this file's project index from the other test files (the project
// index is a shared read-modify-write file; see kernel review P1-11).
const testHome = join(repoRoot, 'tests', '.tmp', `home-state-${process.pid}`)
process.env.DSH_HOME = testHome
await mkdir(join(testHome, 'modules'), { recursive: true })
after(() => cleanup(testHome))

async function makeService() {
  const svc = new EquityService({ ctx: { web: null, llm: null, subagents: null }, config: { executor: 'fixture' } })
  await svc.init()
  return svc
}

async function newProject(svc, name) {
  const root = tempDir(name)
  const created = await svc.createProject({
    target: '示例科技',
    root,
    preset: 'skill-only',
    asOf: '2026-09-30',
    executor: 'fixture',
  })
  return { root, projectId: created.projectId }
}

test('state: readiness.artifactVerified only counts pointer-verified current revisions', async (t) => {
  const svc = await makeService()
  const { root, projectId } = await newProject(svc, 'state-pointer')
  t.after(() => cleanup(root))
  const output = await readFixture('golden-zhongji/module-outputs/entity-resolution.json')

  const first = await svc.record(projectId, {
    kind: 'artifact',
    type: 'company.identity',
    subjectId: 'co_示例科技',
    output,
  }, { trusted: true, actor: 'human', status: 'verified' })
  assert.equal(first.artifact.status, 'verified')
  const opened = await svc.resolveProject(projectId)
  const dir = artifactDir(opened.root, 'company.identity', 'co_示例科技', '_default')
  const verifiedFull = await readArtifact(opened.root, 'company.identity', 'co_示例科技', '_default', 'verified')
  assert.ok(verifiedFull)

  let state = await svc.state(projectId)
  assert.equal(state.readiness.artifactVerified, true)
  assert.equal(state.readiness.deliveryReady, false)
  assert.equal((await listVerifiedArtifacts(opened.root, { type: 'company.identity' })).length, 1)

  const changed = JSON.parse(JSON.stringify(output))
  changed.data.legalRepresentative = '李四'
  const draft = await svc.record(projectId, {
    kind: 'artifact',
    type: 'company.identity',
    subjectId: 'co_示例科技',
    output: changed,
  })
  assert.equal(draft.artifact.status, 'draft')
  assert.equal(await readArtifact(opened.root, 'company.identity', 'co_示例科技', '_default', 'verified'), null)
  assert.equal((await listVerifiedArtifacts(opened.root, { type: 'company.identity' })).length, 0)
  state = await svc.state(projectId)
  assert.equal(state.readiness.artifactVerified, false)

  // A legacy verified.json from an older revision must not resurrect the
  // artifact while current is a draft.
  await atomicWriteJson(join(dir, 'verified.json'), verifiedFull)
  assert.equal((await listVerifiedArtifacts(opened.root, { type: 'company.identity' })).length, 0)

  // verified -> stale clears the pointer too.
  const current = await readArtifact(opened.root, 'company.identity', 'co_示例科技', '_default')
  const again = await svc.record(projectId, {
    kind: 'artifact',
    type: 'company.identity',
    subjectId: 'co_示例科技',
    output,
  }, { trusted: true, actor: 'human', status: 'verified', expectedRev: current.revision })
  assert.equal(again.artifact.status, 'verified')
  assert.equal((await listVerifiedArtifacts(opened.root, { type: 'company.identity' })).length, 1)
  const staleRecord = await readArtifact(opened.root, 'company.identity', 'co_示例科技', '_default')
  const stale = await setArtifactStatus(opened.root, staleRecord, 'stale')
  assert.equal(stale.status, 'stale')
  assert.equal(await readArtifact(opened.root, 'company.identity', 'co_示例科技', '_default', 'verified'), null)
  state = await svc.state(projectId)
  assert.equal(state.readiness.artifactVerified, false)
})

test('tools: equity_record cannot self-report status/actor; equity_review cannot decide', async (t) => {
  const svc = await makeService()
  const defs = []
  registerTools({ ctx: { tools: { register: (definition) => { defs.push(definition); return () => {} } } }, service: svc })
  const tools = Object.fromEntries(defs.map((definition) => [definition.name, definition]))

  assert.equal(Object.hasOwn(tools.equity_record.parameters.properties, 'status'), false)
  assert.equal(Object.hasOwn(tools.equity_record.parameters.properties, 'actor'), false)
  assert.deepEqual(tools.equity_review.parameters.properties.action.enum, ['list', 'propose'])
  await assert.rejects(
    () => tools.equity_review.execute({ action: 'decide', issueId: 'iss_x', decision: 'accept' }, {}),
    (error) => error.code === 'user_only',
  )

  const { root, projectId } = await newProject(svc, 'state-record')
  t.after(() => cleanup(root))
  const output = await readFixture('golden-zhongji/module-outputs/entity-resolution.json')

  // Even if a caller bypasses the tool schema, the service forces agent/draft.
  const viaTool = await tools.equity_record.execute({
    kind: 'artifact',
    projectId,
    type: 'company.identity',
    subjectId: 'co_示例科技',
    output,
    status: 'verified',
    actor: 'human',
  }, {})
  assert.equal(viaTool.artifact.status, 'draft')
  assert.equal(viaTool.artifact.producedBy.actor, 'agent')
  const opened = await svc.resolveProject(projectId)
  assert.equal(await readArtifact(opened.root, 'company.identity', 'co_示例科技', '_default', 'verified'), null)

  // Internal trusted callers can still write verified when explicitly opted in.
  const trusted = await svc.record(projectId, {
    kind: 'artifact',
    type: 'company.identity',
    subjectId: 'co_示例科技',
    output,
  }, { trusted: true, actor: 'human', status: 'verified', expectedRev: viaTool.artifact.revision })
  assert.equal(trusted.artifact.status, 'verified')
})

test('pipeline: golden run is not stale, signoff is user-only/server-timed, verify is QA-only', async (t) => {
  const svc = await makeService()
  const { root, projectId } = await newProject(svc, 'state-golden')
  t.after(() => cleanup(root))
  const run = await svc.run(projectId, { executor: 'fixture' })
  assert.equal(run.status, 'completed')

  let state = await svc.state(projectId)
  assert.equal(state.stale.length, 0, JSON.stringify(state.stale))
  assert.equal(state.readiness.artifactVerified, true)
  assert.equal(state.readiness.investigationComplete, true)
  assert.equal(state.readiness.deliveryReady, false)
  const deliverable = state.artifacts.find((artifact) => artifact.type === 'report.deliverable')
  assert.equal(deliverable.status, 'verified')

  // producedBy records the plan step's instance + module-template hash (not
  // the rendered prompt hash), and codeVersion derives from the same source.
  const opened = await svc.resolveProject(projectId)
  const compiled = compilePlaybook({ library: svc.library, project: opened.project, playbook: opened.playbook })
  assert.equal(compiled.ok, true)
  const stepByModule = new Map(compiled.plan.steps.map((step) => [step.moduleId, step]))
  const identityStep = stepByModule.get('builtin/entity-resolution')
  const identity = await readArtifact(opened.root, 'company.identity', 'co_示例科技', '_default')
  assert.equal(identity.producedBy.instanceId, identityStep.instanceId)
  assert.equal(identity.producedBy.templateSha, identityStep.templateSha)
  assert.equal(identity.codeVersion, codeVersionOf({
    moduleId: identityStep.moduleId,
    moduleVersion: identityStep.moduleVersion,
    templateSha: identityStep.templateSha,
  }))

  await assert.rejects(() => svc.signoff(projectId, {}, {}), (error) => error.code === 'user_only')
  await assert.rejects(() => svc.signoff(projectId, { approvedBy: '张三' }, {}), (error) => error.code === 'user_only')
  await assert.rejects(() => svc.signoff(projectId, { approvedBy: '' }, { actor: 'user' }), (error) => error.code === 'missing_approver')

  const beforeSignoff = (await svc.state(projectId)).deliverable
  const signed = await svc.signoff(projectId, {
    preparedBy: 'tester',
    reviewedBy: 'reviewer',
    approvedBy: '张三',
    signedAt: '1999-01-01T00:00:00.000Z',
    proposedAt: '1999-01-01T00:00:00.000Z',
  }, { actor: 'user' })
  assert.equal(signed.ok, true)
  assert.notEqual(signed.signoff.signedAt, '1999-01-01T00:00:00.000Z')
  assert.notEqual(signed.signoff.proposedAt, '1999-01-01T00:00:00.000Z')
  assert.ok(signed.signoff.signedAt.startsWith('20'))
  assert.equal(signed.artifact.status, 'verified')
  assert.ok(signed.artifact.revision > beforeSignoff.revision)

  state = await svc.state(projectId)
  assert.equal(state.readiness.deliveryReady, true, JSON.stringify(state.stale))
  assert.equal(state.deliverable.data.signoff.signedAt, signed.signoff.signedAt)
  assert.equal(state.deliverable.verified, true)

  // verify = QA-only re-check of the existing package; it returns arrays.
  const verify = await svc.verifyDelivery(projectId)
  assert.equal(verify.ok, true, JSON.stringify(verify.qa?.blocking))
  assert.ok(Array.isArray(verify.qa.blocking))
  assert.ok(Array.isArray(verify.qa.warnings))

  // A new verified upstream revision makes the built package stale; the
  // readiness signal must drop and verify must fail with package_stale.
  const ownership = await readFixture('golden-zhongji/module-outputs/ownership-chain.json')
  ownership.data.capTable[0].holder = '示例控股有限公司（更名）'
  const oldOwnership = state.artifacts.find((artifact) => artifact.type === 'ownership.chain')
  await svc.record(projectId, {
    kind: 'artifact',
    type: 'ownership.chain',
    subjectId: oldOwnership.subjectId,
    output: ownership,
  }, { trusted: true, actor: 'human', status: 'verified' })
  const afterChange = await svc.state(projectId)
  assert.ok(afterChange.stale.length > 0, 'upstream change must make dependent artifacts stale')
  assert.equal(afterChange.readiness.deliveryReady, false)
  const verifyStale = await svc.verifyDelivery(projectId)
  assert.equal(verifyStale.ok, false)
  assert.ok(verifyStale.qa.blocking.some((item) => item.id === 'package_stale'))
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { compilePlaybook } from '../src/kernel/playbook.js'
import { startRun } from '../src/kernel/runner.js'
import { createExecutor } from '../src/engines/index.js'
import { listArtifacts } from '../src/kernel/artifacts.js'
import { buildDeliverable } from '../src/builders/package.js'
import { projectState } from '../src/kernel/state.js'
import { freshProject, cleanup, playbook } from './helpers/common.js'

async function runSkillOnly(opened, options = {}) {
  const pb = playbook([
    { id: 'entity-resolution', use: 'builtin/entity-resolution@^0.1', stage: 'identity' },
    { id: 'ownership-chain', use: 'builtin/ownership-chain@^0.1', stage: 'ownership' },
    { id: 'investment-map', use: 'builtin/investment-map@^0.2', stage: 'ownership' },
    { id: 'deliverable', use: 'builtin/deliverable@^0.1', stage: 'delivery' },
  ])
  const compiled = compilePlaybook({ library: opened.library, project: opened.project, playbook: pb })
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors))
  const executor = createExecutor({
    ctx: {},
    root: opened.root,
    project: opened.project,
    library: opened.library,
    playbook: pb,
    plan: compiled.plan,
    agent: null,
    config: { executor: 'fixture' },
    fixtureDir: join(import.meta.dirname, 'fixtures', 'golden-zhongji'),
  })
  const run = await startRun({
    root: opened.root,
    library: opened.library,
    project: opened.project,
    playbook: pb,
    plan: compiled.plan,
    executor,
    ...options,
  })
  return { pb, compiled, run }
}

test('pipeline: skill-only completes with evidence, report and DD requests', async (t) => {
  const opened = await freshProject('pipeline')
  t.after(() => cleanup(opened.root))
  const { run } = await runSkillOnly(opened)
  assert.equal(run.status, 'completed')
  assert.equal(Object.values(run.units).filter((unit) => unit.status === 'accepted').length, 4)
  const artifacts = await listArtifacts(opened.root)
  const types = artifacts.map((artifact) => artifact.type)
  assert.ok(types.includes('company.identity'))
  assert.ok(types.includes('ownership.chain'))
  assert.ok(types.includes('investment.map'))
  assert.ok(types.includes('search.ledger'))
  assert.ok(types.includes('source.coverage'))
  assert.ok(types.includes('report.deliverable'))
  assert.ok(types.includes('dd.request_list'))
  const report = artifacts.find((artifact) => artifact.type === 'report.deliverable')
  assert.equal(report.status, 'verified')
  assert.ok(report.data.files.length >= 2)
  assert.ok(report.data.summaryFindings.length >= 5)
  assert.ok(report.data.cellMap.length >= 1)
  assert.equal(report.data.qa.passed, true)

  // A4: after a completed fixture run nothing is stale and completeness is reachable.
  const state = await projectState({ root: opened.root, library: opened.library, project: opened.project, playbook: opened.playbook })
  assert.equal(state.stale.length, 0, JSON.stringify(state.stale))
  assert.equal(state.readiness.artifactVerified, true)
  assert.equal(state.readiness.investigationComplete, true)
  assert.equal(state.readiness.deliveryReady, false) // requires user signoff
  const identity = artifacts.find((artifact) => artifact.type === 'company.identity')
  assert.ok(identity.producedBy.instanceId)
  assert.ok(identity.producedBy.templateSha)
  assert.equal(identity.codeVersion.includes('+tmpl:'), true)
})

test('pipeline: resume skips accepted units and stays idempotent', async (t) => {
  const opened = await freshProject('resume')
  t.after(() => cleanup(opened.root))
  const { pb, compiled, run } = await runSkillOnly(opened)
  const before = await listArtifacts(opened.root)
  const executor = createExecutor({
    ctx: {},
    root: opened.root,
    project: opened.project,
    library: opened.library,
    playbook: pb,
    plan: compiled.plan,
    agent: null,
    config: { executor: 'fixture' },
    fixtureDir: join(import.meta.dirname, 'fixtures', 'golden-zhongji'),
  })
  const resumed = await startRun({
    root: opened.root,
    library: opened.library,
    project: opened.project,
    playbook: pb,
    plan: compiled.plan,
    executor,
    resumeFrom: run.runId,
  })
  assert.equal(resumed.status, 'completed')
  assert.ok(Object.values(resumed.units).every((unit) => unit.status === 'accepted'))
  const after = await listArtifacts(opened.root)
  assert.equal(after.length, before.length)
})

test('pipeline: deliverable package has the 11-sheet workbook and clean 20-column 7N', async (t) => {
  const opened = await freshProject('deliverable')
  t.after(() => cleanup(opened.root))
  await runSkillOnly(opened)
  const result = await buildDeliverable({
    root: opened.root,
    library: opened.library,
    project: opened.project,
    playbook: opened.playbook,
    plan: { snapshotHash: 'sha256:test' },
    run: null,
    template: 'standard',
    signoff: {},
  })
  assert.equal(result.qa.passed, true, JSON.stringify(result.qa.blocking))
  const names = result.files.map((file) => file.path)
  assert.ok(names.includes('01_管理层摘要.md'))
  assert.ok(names.includes('02_综合尽调工作簿.xlsx'))
  assert.ok(names.includes('03_专项_投资版图_7+N.xlsx'))
  // The manifest hashes every deliverable file but cannot hash itself, so the
  // builder writes it without listing it in `files` (D's delivery contract).
  assert.ok(existsSync(join(result.outDir, 'manifest.json')))
  assert.ok(!names.includes('manifest.json'))
  const map = JSON.parse(await readFile(join(result.outDir, 'workbook_map.json'), 'utf8'))
  assert.equal(map.sheets.filter((sheet) => sheet.file === '02').length, 11)
  assert.equal(map.sevenN.columnCount, 20)
  assert.equal(map.sevenN.headers[6], '最新融资轮次和情况')
  assert.equal(map.sevenN.headers[7], '第一大股东持股比例(%)')
  assert.ok(map.files.some((file) => file.key === '03'))
})

test('state: a changed upstream marks only the direct dependent stale', async (t) => {
  const opened = await freshProject('stale-state')
  t.after(() => cleanup(opened.root))
  await runSkillOnly(opened)
  const before = await projectState({ root: opened.root, library: opened.library, project: opened.project, playbook: opened.playbook })
  assert.equal(before.stale.length, 0)
  // Mutate the ownership fixture data and record a new revision with the same
  // input pin; the direct dependent (investment-map) should become stale.
  const ownership = JSON.parse(await readFile(join(import.meta.dirname, 'fixtures', 'golden-zhongji', 'module-outputs', 'ownership-chain.json'), 'utf8'))
  ownership.data.capTable[0].holder = '示例控股有限公司（更名）'
  const { recordArtifact } = await import('../src/kernel/artifacts.js')
  const old = (await listArtifacts(opened.root)).find((artifact) => artifact.type === 'ownership.chain')
  await recordArtifact({
    root: opened.root,
    library: opened.library,
    type: 'ownership.chain',
    subjectId: old.subjectId,
    output: ownership,
    producedBy: { moduleId: 'builtin/ownership-chain', moduleVersion: '0.1.0', actor: 'agent', templateSha: old.producedBy.templateSha },
    derivedFrom: old.derivedFrom,
    status: 'verified',
  })
  const after = await projectState({ root: opened.root, library: opened.library, project: opened.project, playbook: opened.playbook })
  assert.ok(after.stale.some((item) => item.type === 'investment.map'))
  assert.ok(!after.stale.some((item) => item.type === 'company.identity'))
})

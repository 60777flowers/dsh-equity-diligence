import test from 'node:test'
import assert from 'node:assert/strict'

import { compilePlaybook } from '../src/kernel/playbook.js'
import { createProject } from '../src/kernel/project.js'
import { generateUnits, startRun } from '../src/kernel/runner.js'
import { readArtifact } from '../src/kernel/artifacts.js'
import { cleanup, freshLibrary, playbook, readFixture, tempDir } from './helpers/common.js'

test('identity integration: each target has its own stable subject and unit target', async (t) => {
  const library = await freshLibrary()
  const root = tempDir('identity-units')
  t.after(() => cleanup(root))
  const opened = await createProject({
    targets: [
      { name: '甲公司', identifiers: [{ scheme: 'CN_USCC', value: '91320100MA1FL00000' }] },
      { name: '乙公司' },
    ],
    root,
    preset: 'skill-only',
    asOf: '2026-09-30',
    library,
  })
  const compiled = compilePlaybook({
    library,
    project: opened.project,
    playbook: playbook([{ id: 'entity-resolution', use: 'builtin/entity-resolution@^0.1', stage: 'identity' }]),
  })
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors))
  const units = generateUnits({ plan: compiled.plan, project: opened.project })
  assert.equal(units.length, 2)
  assert.notEqual(units[0].subjectId, units[1].subjectId)
  assert.equal(units[0].subjectId, opened.project.targets[0].entityId)
  assert.equal(units[0].target.name, '甲公司')
  assert.equal(units[1].target.name, '乙公司')
  assert.equal(units[0].subjectId, units[0].target.entityId)
})

test('identity integration: accepted identity writes roster _resolution and refreshes downstream target', async (t) => {
  const library = await freshLibrary()
  const root = tempDir('identity-writeback')
  t.after(() => cleanup(root))
  const opened = await createProject({
    target: '示例科技',
    root,
    preset: 'skill-only',
    asOf: '2026-09-30',
    library,
  })
  const fixture = await readFixture('golden-zhongji/module-outputs/entity-resolution.json')
  const planBook = playbook([{ id: 'entity-resolution', use: 'builtin/entity-resolution@^0.1', stage: 'identity' }])
  const compiled = compilePlaybook({ library, project: opened.project, playbook: planBook })
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors))
  const executor = {
    name: 'test-identity',
    async execute() {
      return { artifacts: [{ type: 'company.identity', output: fixture }], tokens: 0, toolCalls: 0, searches: [] }
    },
  }
  const run = await startRun({
    root,
    library,
    project: opened.project,
    playbook: planBook,
    plan: compiled.plan,
    executor,
  })
  assert.equal(run.status, 'completed', JSON.stringify(Object.values(run.units).map((unit) => unit.error)))
  const resolution = await readArtifact(root, 'company.roster', 'project', '_resolution')
  assert.ok(resolution, 'roster _resolution artifact missing')
  assert.equal(resolution.data.targets[0].legalName, fixture.data.legalName)
  assert.equal(resolution.data.targets[0].name, '示例科技', 'input name must never be overwritten')
  assert.equal(opened.project.targets[0].legalName, fixture.data.legalName)
  const after = await readArtifact(root, 'company.identity', opened.project.targets[0].entityId)
  assert.ok(after)
  assert.equal(after.status, 'verified')
})

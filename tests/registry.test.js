import test from 'node:test'
import assert from 'node:assert/strict'

import { loadPreset, moduleSummary, validateModule } from '../src/kernel/registry.js'
import { compilePlaybook } from '../src/kernel/playbook.js'
import { freshLibrary } from './helpers/common.js'

test('registry: 32 artifact types and 25 modules load without errors', async () => {
  const library = await freshLibrary()
  assert.equal(library.typeList.length, 32)
  assert.equal(library.moduleList.length, 25)
  assert.deepEqual(library.errors, [])
  assert.ok(library.modules.has('builtin/entity-resolution'))
  assert.ok(library.modules.has('builtin/generic-investigation'))
  assert.equal(library.types.get('policy.exposure').status, 'draft')
  assert.equal(library.types.get('report.deliverable').scope, 'project')
  assert.equal(library.producers.get('company.roster'), 'system/project-bootstrap')
})

test('registry: five presets compile with the documented module counts', async () => {
  const library = await freshLibrary()
  const expected = { 'skill-only': 4, quick: 10, standard: 18, deep: 24, generic: 3 }
  for (const [name, count] of Object.entries(expected)) {
    const playbook = await loadPreset(name)
    const result = compilePlaybook({ library, project: { projectId: 'eq_test', budget: {} }, playbook })
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.errors)}`)
    assert.equal(result.plan.steps.length, count, name)
  }
})

test('registry: every module has a skill, a task template and a valid gate file', async () => {
  const library = await freshLibrary()
  for (const module of library.moduleList) {
    assert.ok(module.skill.length > 500, `${module.id} skill too short`)
    assert.ok(module.prompts.task.length > 300, `${module.id} task too short`)
    assert.equal(module.validation.valid, true, `${module.id}: ${JSON.stringify(module.validation.errors)}`)
    assert.ok(module.templateSha.startsWith('sha256:'))
  }
})

test('registry: every module declares provenance so authors can be told apart', async () => {
  const library = await freshLibrary()
  for (const module of library.moduleList) {
    const provenance = module.provenance
    assert.ok(provenance, `${module.id} 缺少 provenance`)
    assert.ok(typeof provenance.author === 'string' && provenance.author.trim(), `${module.id} author 为空`)
    assert.ok(['human', 'agent'].includes(provenance.origin), `${module.id} origin 非法：${provenance.origin}`)
  }
  // 人工实现版本：可追溯到人，且写明方法论来源
  const map = library.modules.get('builtin/investment-map')
  assert.equal(map.provenance.origin, 'human')
  assert.equal(map.provenance.author, '60777flowers')
  assert.ok(map.provenance.derivedFrom, 'investment-map 应写明 derivedFrom')
  // 其余模块是 AI 初稿，不得冒充人工实现
  const others = library.moduleList.filter((module) => module.id !== 'builtin/investment-map')
  assert.equal(others.filter((module) => module.provenance.origin === 'human').length, 0)
  // 该字段要能被 UI 与外部脚本读到
  assert.equal(moduleSummary(map).provenance.origin, 'human')
})

test('registry: missing provenance only warns; malformed provenance is an error', async () => {
  const library = await freshLibrary()
  const base = library.modules.get('builtin/entity-resolution')
  const missing = { ...base, manifest: { ...base.manifest, provenance: undefined } }
  const warnResult = validateModule(missing, library)
  assert.equal(warnResult.valid, true, '缺 provenance 不应阻断加载')
  assert.ok(warnResult.warnings.some((item) => item.code === 'missing_provenance'))
  for (const provenance of [{ author: '', origin: 'agent' }, { author: 'someone', origin: 'robot' }]) {
    const bad = { ...base, manifest: { ...base.manifest, provenance } }
    const badResult = validateModule(bad, library)
    assert.equal(badResult.valid, false, JSON.stringify(provenance))
    assert.ok(badResult.errors.some((item) => item.code === 'bad_provenance'))
  }
})

test('playbook: duplicate producer is rejected', async () => {
  const library = await freshLibrary()
  const pb = {
    apiVersion: 'equity.playbook/v1',
    id: 'dup',
    name: 'dup',
    version: '1.0.0',
    modules: [
      { id: 'a', use: 'builtin/entity-resolution@^0.1', stage: 'identity' },
      { id: 'b', use: 'builtin/entity-resolution@^0.1', stage: 'identity' },
    ],
  }
  const result = compilePlaybook({ library, project: { projectId: 'eq_test' }, playbook: pb })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.code === 'duplicate_producer'))
})

test('playbook: missing producer is rejected for block inputs', async () => {
  const library = await freshLibrary()
  const pb = {
    apiVersion: 'equity.playbook/v1',
    id: 'missing',
    name: 'missing',
    version: '1.0.0',
    modules: [{ id: 'ownership', use: 'builtin/ownership-chain@^0.1', stage: 'ownership' }],
  }
  const result = compilePlaybook({ library, project: { projectId: 'eq_test' }, playbook: pb })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.code === 'missing_producer' && error.type === 'company.identity'))
})

test('playbook: order violation is reported when a consumer precedes its producer', async () => {
  const library = await freshLibrary()
  const pb = {
    apiVersion: 'equity.playbook/v1',
    id: 'order',
    name: 'order',
    version: '1.0.0',
    modules: [
      { id: 'ownership', use: 'builtin/ownership-chain@^0.1', stage: 'ownership' },
      { id: 'entity', use: 'builtin/entity-resolution@^0.1', stage: 'identity' },
    ],
  }
  const result = compilePlaybook({ library, project: { projectId: 'eq_test' }, playbook: pb })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.code === 'order_violation'))
})

test('playbook: hard-input cycle is rejected', async () => {
  const library = await freshLibrary()
  const base = library.modules.get('builtin/entity-resolution')
  const own = library.modules.get('builtin/ownership-chain')
  const a = {
    ...base,
    id: 'builtin/cyc-a',
    manifest: { ...base.manifest, id: 'builtin/cyc-a', name: 'cycle a', inputs: [{ type: 'ownership.chain', onMissing: 'block' }] },
    validation: { valid: true, errors: [], warnings: [] },
  }
  const b = {
    ...own,
    id: 'builtin/cyc-b',
    manifest: { ...own.manifest, id: 'builtin/cyc-b', name: 'cycle b', inputs: [{ type: 'company.identity', onMissing: 'block' }] },
    validation: { valid: true, errors: [], warnings: [] },
  }
  a.hash = 'sha256:a'
  b.hash = 'sha256:b'
  a.templateSha = 'sha256:ta'
  b.templateSha = 'sha256:tb'
  const fake = { ...library, modules: new Map(library.modules) }
  fake.modules.set(a.id, a)
  fake.modules.set(b.id, b)
  const pb = {
    apiVersion: 'equity.playbook/v1',
    id: 'cycle',
    name: 'cycle',
    version: '1.0.0',
    modules: [
      { id: 'a', use: 'builtin/cyc-a@^0.1', stage: 'identity' },
      { id: 'b', use: 'builtin/cyc-b@^0.1', stage: 'ownership' },
    ],
  }
  const result = compilePlaybook({ library: fake, project: { projectId: 'eq_test' }, playbook: pb })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.code === 'cycle_detected'))
})

test('playbook: version range mismatch is rejected', async () => {
  const library = await freshLibrary()
  const pb = {
    apiVersion: 'equity.playbook/v1',
    id: 'ver',
    name: 'ver',
    version: '1.0.0',
    modules: [{ id: 'entity', use: 'builtin/entity-resolution@^9.0', stage: 'identity' }],
  }
  const result = compilePlaybook({ library, project: { projectId: 'eq_test' }, playbook: pb })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.code === 'version_unsatisfied'))
})

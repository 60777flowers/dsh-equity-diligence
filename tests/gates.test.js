import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateGates, computeCoverage } from '../src/kernel/gates.js'
import { freshLibrary, readFixture } from './helpers/common.js'

async function fixtureOutput(file) {
  return readFixture(`golden-zhongji/module-outputs/${file}`)
}

test('gates: fixture outputs pass their declared gates', async () => {
  const library = await freshLibrary()
  const entity = await fixtureOutput('entity-resolution.json')
  const ownership = await fixtureOutput('ownership-chain.json')
  const investment = await readFixture('golden-zhongji/module-outputs/investment-map.json')
  const checks = [
    ['builtin/entity-resolution', entity],
    ['builtin/ownership-chain', ownership],
    ['builtin/investment-map', investment.artifacts[0].output],
    ['builtin/investment-map', investment.artifacts[1].output],
  ]
  for (const [moduleId, output] of checks) {
    const result = evaluateGates({ module: library.modules.get(moduleId), output })
    assert.equal(result.passed, true, `${moduleId}: ${JSON.stringify(result.checks.filter((check) => check.status === 'fail'))}`)
  }
})

test('gates: required fields and six-state fields are enforced', async () => {
  const library = await freshLibrary()
  const entity = await fixtureOutput('entity-resolution.json')
  delete entity.data.legalName
  const result = evaluateGates({ module: library.modules.get('builtin/entity-resolution'), output: entity })
  assert.equal(result.passed, false)
  assert.ok(result.checks.some((check) => check.id.startsWith('required:data.legalName')))

  const fit = {
    asOf: '2026-09-30',
    openQuestions: [],
    flags: [],
    sourceCoverage: { queries: [{ query: 'x', outcome: 'ok' }], databases: [], retrievedAt: '2026-11-07T00:00:00+08:00', limitations: [] },
    claims: [],
    evidence: [],
    data: {
      technologyFit: { value: '高' },
      commercialFit: { status: 'found', value: '中' },
      equityView: { status: 'pending_dd', value: '待核' },
      approach: [],
      conclusion: {},
    },
  }
  const fitResult = evaluateGates({ module: library.modules.get('builtin/assessment-fit'), output: fit })
  assert.equal(fitResult.passed, false)
  assert.ok(fitResult.checks.some((check) => check.id.startsWith('sixState:data.technologyFit')))
})

test('gates: ownership cap table sum and range consistency are enforced', async () => {
  const library = await freshLibrary()
  const ownership = await fixtureOutput('ownership-chain.json')
  ownership.data.capTable[0].totalPct = 100
  const result = evaluateGates({ module: library.modules.get('builtin/ownership-chain'), output: ownership })
  assert.equal(result.passed, false)
  assert.ok(result.checks.some((check) => check.id === 'consistency:capTableSumTo100' || check.id === 'consistency:totalEqDirectPlusIndirect'))
})

test('gates: coverage counts search attempts when no explicit dimensions exist', () => {
  const output = {
    sourceCoverage: { queries: [{ outcome: 'ok' }, { outcome: 'empty' }] },
    data: {},
    claims: [],
    evidence: [],
  }
  assert.equal(computeCoverage(output), 1)
  const half = { ...output, sourceCoverage: { queries: [{ outcome: 'ok' }, { outcome: 'error' }] } }
  assert.equal(computeCoverage(half), 0.5)
})

test('gates: dimension results count as coverage without a status field', () => {
  const output = {
    sourceCoverage: {
      dimensions: [
        { dimension: '基准覆盖', result: '覆盖 8 家子公司', gaps: '' },
        { dimension: '境外', result: '覆盖 7 家境外实体', gaps: '' },
        { dimension: '分类', result: '未覆盖第 9 类', gaps: '缺数据' },
      ],
    },
    data: {},
    claims: [],
    evidence: [],
  }
  assert.equal(computeCoverage(output), 2 / 3)
})

test('gates: estimated ratio is bounded', async () => {
  const library = await freshLibrary()
  const business = {
    asOf: '2026-09-30',
    openQuestions: [],
    flags: [],
    sourceCoverage: { queries: [{ outcome: 'ok' }], databases: [], retrievedAt: '2026-11-07T00:00:00+08:00', limitations: [] },
    claims: [],
    evidence: [],
    data: {
      products: [{ name: 'A', generation: { status: 'estimated', value: 'x', note: '方法' } }],
      segments: [],
      revenueMix: [],
      techRoute: [],
    },
  }
  const result = evaluateGates({ module: library.modules.get('builtin/business-segment'), output: business })
  assert.equal(result.passed, false)
  assert.ok(result.checks.some((check) => check.id === 'estimatedRatio' || check.id.startsWith('required:') || check.id.startsWith('minItems:')))
})

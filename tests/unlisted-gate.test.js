import test from 'node:test'
import assert from 'node:assert/strict'

import { buildVars, renderPrompt } from '../src/kernel/render.js'
import { evaluateGates } from '../src/kernel/gates.js'
import { usccCheckChar } from '../src/kernel/subjects.js'
import { recordArtifact } from '../src/kernel/artifacts.js'
import { cleanup, freshLibrary, freshProject, readFixture } from './helpers/common.js'

const USCC = `91310000MA1FL0000${usccCheckChar('91310000MA1FL0000')}`

function multiTargetProject() {
  return {
    schemaVersion: 2,
    name: '多目标项目',
    engagement: { clientName: '委托方', asOf: '2026-09-30', currency: 'CNY', listingStatus: 'unknown', jurisdiction: 'CN' },
    targets: [
      {
        name: '甲公司',
        inputName: '甲公司',
        entityId: 'co_甲公司',
        jurisdiction: 'CN',
        listingStatus: 'unlisted',
        identifiers: [],
      },
      {
        name: '乙公司',
        inputName: '乙公司',
        entityId: 'co_乙公司',
        jurisdiction: 'CN',
        listingStatus: 'unknown',
        identifiers: [{ scheme: 'CN_USCC', value: USCC, issuer: '国家企业信用信息公示系统', jurisdiction: 'CN', verificationStatus: 'verified' }],
      },
    ],
  }
}

test('render: a unit renders its own target, never targets[0]', () => {
  const project = multiTargetProject()
  const module = { id: 'builtin/financials-public', gates: {} }
  const step = { partitionKey: '_default', scope: 'company' }

  const varsB = buildVars({
    module,
    project,
    step,
    unit: { subjectId: 'co_乙公司', subjectName: '乙公司', scope: 'company' },
  })
  assert.equal(varsB['company.name'], '乙公司')
  assert.notEqual(varsB['company.name'], '甲公司')
  assert.equal(varsB['company.input_name'], '乙公司')
  assert.equal(varsB['company.id'], 'co_乙公司')
  assert.equal(varsB['company.listing_status'], 'unknown')
  assert.equal(varsB['company.jurisdiction'], 'CN')
  assert.equal(varsB['company.code'], USCC, 'company.code mirrors the primary identifier')
  assert.match(varsB['company.identifiers'], /统一社会信用代码/)
  assert.ok(varsB['company.identifiers'].includes(USCC))

  const varsA = buildVars({
    module,
    project,
    step,
    unit: { subjectId: 'co_甲公司', subjectName: '甲公司', scope: 'company' },
  })
  assert.equal(varsA['company.name'], '甲公司')
  assert.equal(varsA['company.listing_status'], 'unlisted')
  assert.equal(varsA['company.identifiers'], '')

  // Unmatched specific unit: no substitution of another subject's identity.
  const unknown = buildVars({
    module,
    project,
    step,
    unit: { subjectId: 'co_丙公司', subjectName: '丙公司', scope: 'company' },
  })
  assert.equal(unknown['company.name'], '丙公司')

  // Project-scope units deliberately keep the historical targets[0] header.
  const projectScope = buildVars({
    module,
    project,
    step: { partitionKey: '_default', scope: 'project' },
    unit: { subjectId: 'project', subjectName: '多目标项目', scope: 'project' },
  })
  assert.equal(projectScope['company.name'], '甲公司')

  // Explicit target wins over everything.
  const explicit = buildVars({ module, project, step, target: project.targets[1] })
  assert.equal(explicit['company.name'], '乙公司')

  // Legacy caller (no unit) keeps the old targets[0] behaviour.
  const legacy = buildVars({ module, project, step })
  assert.equal(legacy['company.name'], '甲公司')

  // A v1 project (targets without entityId/identifiers) still renders: the id
  // falls back to the legacy subject key and the code stays an untyped mirror.
  const v1Project = {
    schemaVersion: 1,
    name: 'v1 项目',
    engagement: { clientName: '委托方', asOf: '2026-09-30', currency: 'CNY', listingStatus: 'unknown', jurisdiction: 'CN' },
    targets: [{ name: '甲公司', code: '300308' }],
  }
  const v1Vars = buildVars({ module, project: v1Project, step })
  assert.equal(v1Vars['company.id'], 'co_甲公司')
  assert.equal(v1Vars['company.code'], '300308')
  assert.equal(v1Vars['company.listing_status'], 'unknown')
  assert.equal(v1Vars['company.identifiers'], '未分类外部标识 300308（未做类型推断）')
})

test('render: company.name prefers a verified legal name, input_name never moves', () => {
  const project = multiTargetProject()
  const module = { id: 'builtin/entity-resolution', gates: {} }
  const step = { partitionKey: '_default', scope: 'company' }
  const unit = { subjectId: 'co_乙公司', subjectName: '乙公司', scope: 'company' }

  // Target-level legalName (set by a future writeback hook).
  const patched = {
    ...project,
    targets: [{ ...project.targets[0], legalName: '甲公司（上海）有限公司' }, project.targets[1]],
  }
  const vars = buildVars({ module, project: patched, step, unit: { ...unit, subjectId: 'co_甲公司', subjectName: '甲公司' } })
  assert.equal(vars['company.name'], '甲公司（上海）有限公司')
  assert.equal(vars['company.input_name'], '甲公司')
  assert.equal(vars['company.id'], 'co_甲公司')

  // Verified identity artifact is enough even before a writeback is persisted.
  const identity = {
    type: 'company.identity',
    status: 'verified',
    subjectId: 'co_乙公司',
    evidence: [{ evidenceId: 'ev_1' }, { evidenceId: 'ev_2' }],
    data: { legalName: '乙公司有限公司', entityId: 'co_乙公司', inputName: '乙公司' },
  }
  const withIdentity = buildVars({ module, project, step, unit, inputArtifacts: [identity] })
  assert.equal(withIdentity['company.name'], '乙公司有限公司')
  assert.equal(withIdentity['company.input_name'], '乙公司')

  // Draft identity must not leak a candidate name into the prompt.
  const draft = { ...identity, status: 'draft' }
  const withDraft = buildVars({ module, project, step, unit, inputArtifacts: [draft] })
  assert.equal(withDraft['company.name'], '乙公司')

  // renderPrompt threads the unit through to the rendered text.
  const rendered = renderPrompt({
    module: { id: 'm', prompts: { system: '', task: '目标：{{company.name}} / {{company.input_name}} / {{company.listing_status}}', tail: '' }, gates: {} },
    project,
    step,
    unit,
  })
  assert.match(rendered.text, /目标：乙公司 \/ 乙公司 \/ unknown/)
})

test('render: gate variants are not exposed as prompt variables', () => {
  const project = multiTargetProject()
  const vars = buildVars({
    module: { id: 'm', gates: { minEvidence: 6, variants: [{ id: 'x', rules: {} }] } },
    project,
    step: { partitionKey: '_default', scope: 'company' },
    unit: { subjectId: 'co_乙公司', subjectName: '乙公司', scope: 'company' },
  })
  assert.equal(vars['rules.variants'], undefined)
  assert.equal(vars['rules.minEvidence'], 6)
})

/* ------------------------------------------------------------------ */
/* B3: financials-public gate variants                                 */
/* ------------------------------------------------------------------ */

function financialOutput({ availability = true } = {}) {
  return {
    asOf: '2026-09-30',
    openQuestions: [],
    flags: [],
    sourceCoverage: {
      queries: [
        { query: '巨潮 示例科技 年报', engine: 'web_search', outcome: 'ok' },
        { query: '国家企业信用信息公示系统 示例科技', engine: 'web_search', outcome: 'ok' },
      ],
      databases: [],
      retrievedAt: '2026-11-07T00:00:00+08:00',
      limitations: [],
    },
    claims: [],
    evidence: [
      { evidenceId: 'ev_1', sourceTier: 'registry', verificationStatus: 'verified', verification: { method: 'manual', matches: true } },
      { evidenceId: 'ev_2', sourceTier: 'regulator', verificationStatus: 'verified', verification: { method: 'manual', matches: true } },
    ],
    data: availability
      ? { availability: { status: 'not_disclosed_after_search', checkedSources: ['gsxt', 'creditchina'], note: '查过公示系统与信用中国，无公开财报' } }
      : {},
  }
}

function listedOutput() {
  const output = financialOutput({ availability: false })
  output.evidence = Array.from({ length: 6 }, (_item, index) => ({
    evidenceId: `ev_${index + 1}`,
    sourceTier: 'announcement',
    verificationStatus: 'verified',
  }))
  output.data = {
    fiscalYear: 'FY2025',
    revenue: { amount: 1000, currency: 'CNY' },
    netProfit: { amount: 100, currency: 'CNY' },
    grossMargin: 0.3,
    recon: [
      { check: '资产=负债+权益', left: 1000, right: 1000, status: 'pass' },
      { check: '收入-成本=毛利', left: 1000, right: 1000, status: 'pass' },
      { check: '净利勾稽', left: 100, right: 100, status: 'pass' },
    ],
  }
  return output
}

function failIds(result) {
  return result.checks.filter((check) => check.status === 'fail').map((check) => check.id)
}

test('gates: non-public subject passes with a terminal not_disclosed_after_search + 2 sources', async () => {
  const library = await freshLibrary()
  const module = library.modules.get('builtin/financials-public')

  for (const listingStatus of ['unlisted', 'ipo_applied', 'unknown', 'not_applicable']) {
    const result = evaluateGates({
      module,
      output: financialOutput(),
      context: { target: { listingStatus } },
    })
    assert.equal(result.passed, true, `${listingStatus}: ${JSON.stringify(failIds(result))}`)
    assert.equal(result.variant, 'non_public')
  }
})

test('gates: non-public without availability, note or >=2 sources is blocked', async () => {
  const library = await freshLibrary()
  const module = library.modules.get('builtin/financials-public')
  const context = { target: { listingStatus: 'unlisted' } }

  const missing = evaluateGates({ module, output: financialOutput({ availability: false }), context })
  assert.equal(missing.passed, false)
  assert.ok(failIds(missing).includes('required:data.availability'))

  const noNote = financialOutput()
  delete noNote.data.availability.note
  const noteResult = evaluateGates({ module, output: noNote, context })
  assert.equal(noteResult.passed, false)
  assert.ok(failIds(noteResult).includes('sixStateNote:data.availability'))

  const oneSource = financialOutput()
  oneSource.data.availability.checkedSources = ['gsxt']
  const sourceResult = evaluateGates({ module, output: oneSource, context })
  assert.equal(sourceResult.passed, false)
  assert.ok(failIds(sourceResult).includes('minItems:data.availability.checkedSources'))

  const badStatus = financialOutput()
  badStatus.data.availability.status = 'not_found'
  const statusResult = evaluateGates({ module, output: badStatus, context })
  assert.equal(statusResult.passed, false)
  assert.ok(failIds(statusResult).includes('sixState:data.availability'))

  // A structurally valid six-state is not enough: pending_dd/not_reviewed are
  // not terminal delivery conclusions for a non-public subject.
  const pending = financialOutput()
  pending.data.availability.status = 'pending_dd'
  pending.data.availability.note = '还在等访谈'
  const pendingResult = evaluateGates({ module, output: pending, context })
  assert.equal(pendingResult.passed, false)
  assert.ok(failIds(pendingResult).includes('consistency:availabilityTerminalStatus'))
})

test('gates: listed issuer still needs revenue/netProfit/recon; availability alone is not enough', async () => {
  const library = await freshLibrary()
  const module = library.modules.get('builtin/financials-public')
  const listed = { target: { listingStatus: 'listed' } }

  const incomplete = evaluateGates({ module, output: financialOutput(), context: listed })
  assert.equal(incomplete.passed, false)
  assert.equal(incomplete.variant, 'public')
  assert.ok(failIds(incomplete).includes('required:data.revenue'))
  assert.ok(failIds(incomplete).includes('required:data.netProfit'))
  assert.ok(failIds(incomplete).includes('required:data.recon'))
  assert.ok(failIds(incomplete).includes('minItems:data.recon'))

  const complete = evaluateGates({ module, output: listedOutput(), context: listed })
  assert.equal(complete.passed, true, JSON.stringify(failIds(complete)))
  assert.equal(complete.variant, 'public')

  // A recon row without a legal status now blocks instead of silently passing.
  const brokenRecon = listedOutput()
  delete brokenRecon.data.recon[0].status
  const reconResult = evaluateGates({ module, output: brokenRecon, context: listed })
  assert.equal(reconResult.passed, false)
  assert.ok(failIds(reconResult).includes('consistency:reconComplete'))
})

test('gates: project-scope and bare-string context also select a variant', async () => {
  const library = await freshLibrary()
  const module = library.modules.get('builtin/financials-public')

  const projectScope = evaluateGates({ module, output: financialOutput(), context: { project: { listingStatus: 'listed' } } })
  assert.equal(projectScope.variant, 'public')
  assert.equal(projectScope.passed, false)

  const bare = evaluateGates({ module, output: financialOutput(), context: 'unlisted' })
  assert.equal(bare.variant, 'non_public')
  assert.equal(bare.passed, true)
})

test('gates: absent context keeps the legacy (public) behaviour, other modules are unaffected', async () => {
  const library = await freshLibrary()
  const module = library.modules.get('builtin/financials-public')

  const legacy = evaluateGates({ module, output: financialOutput() })
  assert.equal(legacy.passed, false)
  assert.equal(legacy.variant, 'public')
  assert.ok(failIds(legacy).includes('required:data.revenue'))

  const ownership = await readFixture('golden-zhongji/module-outputs/ownership-chain.json')
  const withContext = evaluateGates({
    module: library.modules.get('builtin/ownership-chain'),
    output: ownership,
    context: { target: { listingStatus: 'unlisted', entityId: 'co_示例科技' } },
  })
  assert.equal(withContext.passed, true, JSON.stringify(failIds(withContext)))
  assert.equal(withContext.variant, null)
})

test('prompt: non-public financials expose the availability contract', async () => {
  const library = await freshLibrary()
  const module = library.modules.get('builtin/financials-public')
  const project = multiTargetProject()
  const unit = { subjectId: project.targets[0].entityId, subjectName: '甲公司', scope: 'company', target: project.targets[0] }
  const rendered = renderPrompt({
    module,
    project,
    step: { scope: 'company', partitionKey: '_default', params: {} },
    unit,
    inputArtifacts: [],
  })
  assert.match(rendered.text, /data\.availability/)
  assert.match(rendered.text, /checkedSources/)
  assert.match(rendered.text, /not_disclosed_after_search/)
  // The prompt tells a non-public model what to output; it must not tell it
  // that fiscalYear is unconditionally mandatory.
  assert.match(rendered.text, /非公众主体可省略/)
})

test('gates: legacy target without listingStatus falls back to project engagement', async () => {
  const library = await freshLibrary()
  const module = library.modules.get('builtin/financials-public')
  const result = evaluateGates({
    module,
    output: financialOutput(),
    context: { target: { name: '旧项目公司' }, project: { engagement: { listingStatus: 'unlisted' } } },
  })
  assert.equal(result.variant, 'non_public')
  assert.equal(result.passed, true, JSON.stringify(failIds(result)))
})

test('gates: a non-public financial workpaper can actually be recorded end to end', async (t) => {
  const opened = await freshProject('unlisted-financials', { target: '示例科技' })
  t.after(() => cleanup(opened.root))
  const { library, project, root } = opened
  const target = project.targets[0]
  const output = financialOutput()
  output.evidence[0].url = 'https://example.com/registry'
  output.evidence[1].url = 'https://example.com/credit'

  const record = await recordArtifact({
    root,
    library,
    type: 'financials.public',
    subjectId: target.entityId,
    partitionKey: '_default',
    output,
    producedBy: { moduleId: 'builtin/financials-public', moduleVersion: '0.1.0', actor: 'agent' },
    status: 'draft',
    actor: 'agent',
  })
  assert.ok(record.id)
  assert.equal(record.data.availability.status, 'not_disclosed_after_search')

  const gate = evaluateGates({
    module: library.modules.get('builtin/financials-public'),
    output: { ...output, data: record.data },
    context: { target },
  })
  assert.equal(gate.passed, true, JSON.stringify(failIds(gate)))
  assert.equal(gate.variant, 'non_public')
})

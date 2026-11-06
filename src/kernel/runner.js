import { join } from 'node:path'

import {
  EquityError,
  canonicalJson,
  newId,
  semanticHash,
} from '../util/json.js'
import {
  appendJsonLine,
  atomicWriteJson,
  ensureDir,
  readJson,
  readJsonLines,
  readText,
  statOrNull,
} from '../util/fs.js'
import { nowIso } from '../util/time.js'
import { subjectIdFor, unitIdFor } from '../util/ids.js'
import {
  artifactToOutput,
  listArtifacts,
  readArtifact,
  recordArtifact,
  recordSystemArtifact,
} from './artifacts.js'
import { evaluateGates } from './gates.js'
import { createIssue } from './issues.js'
import { runTriggers, triggerFlags, ddRequestsFrom } from './triggers.js'
import { renderPrompt } from './render.js'
import { buildSnapshot, writeSnapshot } from './snapshot.js'

const activeRuns = new Map()

export function runDir(root, runId) {
  return join(root, '.equity', 'runs', runId)
}

function unitKeyOf(unit) {
  return semanticHash({
    instanceId: unit.instanceId,
    moduleId: unit.moduleId,
    subjectId: unit.subjectId,
    partitionKey: unit.partitionKey,
    params: unit.params ?? {},
  })
}

/** Generate all units for a compiled plan. */
export function generateUnits({ plan, project }) {
  const units = []
  for (const step of plan.steps) {
    const subjects =
      step.scope === 'project'
        ? [{ subjectId: 'project', name: project.name, target: null }]
        : (project.targets ?? []).map((target) => ({
            subjectId: subjectIdFor('co', target.name),
            name: target.name,
            target,
          }))
    for (const subject of subjects) {
      const unit = {
        unitId: null,
        instanceId: step.instanceId,
        moduleId: step.moduleId,
        moduleVersion: step.moduleVersion,
        scope: step.scope,
        subjectId: subject.subjectId,
        subjectName: subject.name,
        partitionKey: '_default',
        params: step.params ?? {},
        status: 'todo',
        attempts: 0,
        artifactIds: [],
        error: null,
        gates: null,
        tokens: 0,
        toolCalls: 0,
        startedAt: null,
        finishedAt: null,
      }
      unit.unitKey = unitKeyOf(unit)
      unit.unitId = unitIdFor(unit.unitKey)
      units.push(unit)
    }
  }
  return units
}

function unitOrder(plan) {
  const order = new Map(plan.steps.map((step, index) => [step.instanceId, index]))
  return (a, b) => (order.get(a.instanceId) ?? 0) - (order.get(b.instanceId) ?? 0) || a.subjectName.localeCompare(b.subjectName, 'zh-Hans-CN')
}

async function writeUnits(root, runId, units, order) {
  const dir = runDir(root, runId)
  await ensureDir(dir)
  await atomicWriteJson(join(dir, 'units.json'), { version: 1, updatedAt: nowIso(), order, units })
}

async function appendEvent(root, runId, event) {
  const dir = runDir(root, runId)
  await ensureDir(dir)
  await appendJsonLine(join(dir, 'events.jsonl'), { at: nowIso(), ...event })
}

function budgetUsed(units) {
  return units.reduce(
    (acc, unit) => ({
      tokens: acc.tokens + (unit.tokens ?? 0),
      toolCalls: acc.toolCalls + (unit.toolCalls ?? 0),
    }),
    { tokens: 0, toolCalls: 0 },
  )
}

function findInputRecords(artifacts, type, subjectId, projectScope = false) {
  const list = artifacts.filter((artifact) => artifact.type === type)
  if (list.length === 0) return []
  if (projectScope) {
    const verified = list.filter((artifact) => artifact.status === 'verified')
    return (verified.length > 0 ? verified : list).sort((a, b) =>
      `${a.subjectId}/${a.partitionKey}`.localeCompare(`${b.subjectId}/${b.partitionKey}`),
    )
  }
  const bySubject = list.filter((artifact) => artifact.subjectId === subjectId)
  const pool = bySubject.length > 0 ? bySubject : list.filter((artifact) => artifact.subjectId === 'project')
  const summary = pool.find((artifact) => artifact.partitionKey === '_summary')
  const defaults = pool.find((artifact) => artifact.partitionKey === '_default')
  return summary ? [summary, ...pool.filter((item) => item !== summary)] : defaults ? [defaults, ...pool.filter((item) => item !== defaults)] : pool
}

function pinOf(record) {
  return {
    artifactId: record.id,
    type: record.type,
    kind: 'input',
    revision: record.revision,
    contentHash: record.contentHash,
    fieldPaths: [],
  }
}

async function resolveInputs(root, step, unit) {
  const artifacts = await listArtifacts(root)
  const inputs = []
  const missing = []
  for (const input of step.inputs ?? []) {
    const records = findInputRecords(artifacts, input.type, unit.subjectId, step.scope === 'project')
    const verifiedList = records.filter((record) => record.status === 'verified')
    const selected = verifiedList.length > 0 ? verifiedList : records
    if (selected.length === 0) {
      if (input.onMissing === 'block') missing.push(input.type)
      inputs.push({ ...input, record: null, records: [], pinned: [] })
      continue
    }
    if (input.onMissing === 'block' && verifiedList.length === 0) {
      missing.push(`${input.type}（${selected[0].status}）`)
    }
    inputs.push({
      ...input,
      record: selected[0],
      records: selected,
      pinned: selected.map((record) => pinOf(record)),
    })
  }
  return { inputs, missing }
}

async function updateSearchLedger(root, library, { project, step, unit, searches, asOf }) {
  const partition = unit.instanceId
  const existing = await readArtifact(root, 'search.ledger', unit.subjectId, partition)
  const attempts = [...(existing?.data?.attempts ?? []), ...searches.map((search) => ({
    query: search.query ?? '',
    engine: search.engine ?? 'web',
    at: search.at ?? nowIso(),
    resultCount: search.resultCount ?? 0,
    outcome: search.outcome ?? 'ok',
    note: search.note ?? '',
  }))]
  await recordArtifact({
    root,
    library,
    type: 'search.ledger',
    subjectId: unit.subjectId,
    partitionKey: partition,
    output: {
      asOf,
      openQuestions: [],
      flags: [],
      sourceCoverage: { queries: [], databases: [], retrievedAt: nowIso(), limitations: [] },
      claims: [],
      evidence: [],
      data: {
        moduleId: step.moduleId,
        unitId: unit.unitId,
        attempts,
        notFound: (existing?.data?.notFound ?? []),
        limitations: [],
      },
    },
    producedBy: { moduleId: 'system/source-acquisition', moduleVersion: '1.0.0', runId: unit.runId, unitId: unit.unitId, actor: 'system' },
    status: 'verified',
    actor: 'system',
    id: existing?.id,
  })
}

async function updateCoverage(root, library, { project, units, asOf }) {
  const artifacts = await listArtifacts(root)
  for (const target of project.targets ?? []) {
    const subjectId = subjectIdFor('co', target.name)
    const related = units.filter((unit) => unit.subjectId === subjectId)
    const total = related.length || 1
    const accepted = related.filter((unit) => ['accepted', 'accepted_with_exception'].includes(unit.status)).length
    const needsHuman = related.filter((unit) => ['needs_human', 'failed', 'blocked'].includes(unit.status)).length
    const dimensions = related.map((unit) => ({
      key: unit.instanceId,
      label: unit.moduleId,
      status: ['accepted', 'accepted_with_exception'].includes(unit.status) ? 'covered' : needsHuman > 0 ? 'partial' : 'missing',
      note: unit.error ?? '',
    }))
    const existing = artifacts.find((artifact) => artifact.type === 'source.coverage' && artifact.subjectId === subjectId)
    await recordArtifact({
      root,
      library,
      type: 'source.coverage',
      subjectId,
      partitionKey: '_default',
      output: {
        asOf,
        openQuestions: [],
        flags: [],
        sourceCoverage: { queries: [], databases: [], retrievedAt: nowIso(), limitations: [] },
        claims: [],
        evidence: [],
        data: {
          dimensions,
          databases: [],
          limitations: needsHuman > 0 ? [`${needsHuman} 个单元未完成，覆盖受限`] : [],
          accepted,
          total,
        },
      },
      producedBy: { moduleId: 'system/source-acquisition', moduleVersion: '1.0.0', actor: 'system' },
      status: accepted === total && total > 0 ? 'verified' : 'draft',
      actor: 'system',
      id: existing?.id,
    })
  }
}

async function recordTriggerArtifact(root, library, { project, artifacts, asOf }) {
  const existing = artifacts.find((artifact) => artifact.type === 'risk.redflags')
  if (existing) return existing
  const triggers = runTriggers(artifacts)
  const hits = triggers.filter((item) => item.status === 'hit')
  if (hits.length === 0 && triggers.every((item) => item.status === 'miss')) return null
  const openQuestions = artifacts.flatMap((artifact) => artifact.openQuestions ?? [])
  const flags = triggerFlags(triggers)
  return recordArtifact({
    root,
    library,
    type: 'risk.redflags',
    subjectId: subjectIdFor('co', project.targets?.[0]?.name ?? project.name),
    partitionKey: '_default',
    output: {
      asOf,
      openQuestions,
      flags,
      sourceCoverage: { queries: [], databases: [], retrievedAt: nowIso(), limitations: [] },
      claims: [],
      evidence: [],
      data: {
        flags,
        claimMatrix: [],
        ddRequests: ddRequestsFrom({ triggers, openQuestions }),
        triggerResults: triggers,
      },
    },
    producedBy: { moduleId: 'system/trigger-engine', moduleVersion: '1.0.0', actor: 'system' },
    status: 'verified',
    actor: 'system',
  })
}

/**
 * Execute a compiled plan.
 * @param {object} options
 * @param {object} options.executor - { name, execute(input) }
 */
export async function startRun({
  root,
  library,
  project,
  playbook,
  plan,
  executor,
  resumeFrom = null,
  signal = undefined,
  concurrency = 1,
  engine = {},
  sourceProviders = {},
  onEvent = undefined,
  onStart = undefined,
}) {
  if (!executor) throw new EquityError('missing_executor', '缺少执行器')
  const runId = newId('run')
  const dir = runDir(root, runId)
  await ensureDir(dir)
  const snapshot = buildSnapshot({ project, playbook, plan, library, engine, sourceProviders })
  await writeSnapshot(dir, snapshot)

  const previous = resumeFrom ? await readJson(join(runDir(root, resumeFrom), 'units.json'), null) : null
  const previousAccepted = new Set(
    (previous?.units ?? []).filter((unit) => unit.status === 'accepted').map((unit) => unit.unitId),
  )
  const units = generateUnits({ plan, project })
  for (const unit of units) {
    unit.runId = runId
    if (previousAccepted.has(unit.unitId)) {
      unit.status = 'accepted'
      unit.skipped = true
    }
  }
  const order = units.map((unit) => unit.unitId)
  await writeUnits(root, runId, units, order)

  const controller = new AbortController()
  const externalAbort = () => controller.abort(signal?.reason ?? 'cancelled')
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', externalAbort, { once: true })
  }
  const control = { runId, pauseRequested: false, cancelRequested: false, controller, startedAt: Date.now() }
  activeRuns.set(runId, control)

  if (executor && !executor.run) executor.run = null
  const run = {
    runId,
    projectId: project.projectId,
    playbookId: playbook.id,
    status: 'running',
    executor: executor.name,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: null,
    snapshotHash: snapshot.snapshotHash,
    units: Object.fromEntries(units.map((unit) => [unit.unitId, unit])),
    order,
    budget: {
      maxTokens: plan.budget?.maxTokens ?? project.budget?.maxTokens ?? null,
      maxWallClockMin: plan.budget?.maxWallClockMin ?? project.budget?.maxWallClockMin ?? null,
      usedTokens: 0,
      usedToolCalls: 0,
    },
  }
  const persist = async () => {
    run.updatedAt = nowIso()
    run.units = Object.fromEntries(units.map((unit) => [unit.unitId, unit]))
    const used = budgetUsed(units)
    run.budget.usedTokens = used.tokens
    run.budget.usedToolCalls = used.toolCalls
    await atomicWriteJson(join(dir, 'run.json'), run)
    await writeUnits(root, runId, units, order)
  }
  const emit = async (event) => {
    await appendEvent(root, runId, event)
    if (onEvent) {
      try {
        await onEvent(event)
      } catch {
        // observers must not break the run
      }
    }
  }

  if (executor) executor.run = run
  if (onStart) await onStart(run)
  await emit({ type: 'run/start', runId, executor: executor.name, snapshotHash: snapshot.snapshotHash })
  try {
    for (const unit of units.sort(unitOrder(plan))) {
      if (control.pauseRequested) {
        run.status = 'paused'
        break
      }
      if (control.cancelRequested) {
        run.status = 'cancelled'
        break
      }
      if (controller.signal.aborted) {
        run.status = control.pauseRequested ? 'paused' : 'cancelled'
        break
      }
      if (run.budget.maxWallClockMin) {
        const elapsedMin = (Date.now() - control.startedAt) / 60_000
        if (elapsedMin > run.budget.maxWallClockMin) {
          run.status = 'budget_exhausted'
          break
        }
      }
      if (run.budget.maxTokens && run.budget.usedTokens >= run.budget.maxTokens) {
        run.status = 'budget_exhausted'
        break
      }
      if (unit.status === 'accepted') continue
      const step = plan.steps.find((candidate) => candidate.instanceId === unit.instanceId)
      const module = library.modules.get(step.moduleId)
      if (!module) {
        unit.status = 'failed'
        unit.error = `模块不存在：${step.moduleId}`
        continue
      }
      unit.status = 'running'
      unit.startedAt = nowIso()
      await persist()
      await emit({ type: 'unit/start', unitId: unit.unitId, instanceId: unit.instanceId, subjectId: unit.subjectId })

      if (step.scope === 'project' || step.moduleId === 'builtin/deliverable') {
        await updateCoverage(root, library, { project, units, asOf: project.engagement?.asOf })
      }
      const { inputs, missing } = await resolveInputs(root, step, unit)
      if (missing.length > 0) {
        unit.status = 'blocked'
        unit.error = `上游未 verified：${missing.join(', ')}`
        unit.finishedAt = nowIso()
        await createIssue(root, {
          projectId: project.projectId,
          runId,
          unitId: unit.unitId,
          type: 'blocked',
          severity: 'high',
          title: `${step.name} 被上游阻断`,
          detail: unit.error,
          options: ['修复上游并重跑', '降级输入'],
        })
        await persist()
        await emit({ type: 'unit/blocked', unitId: unit.unitId, missing })
        continue
      }
      const inputArtifacts = inputs.flatMap((input) => input.records ?? [input.record]).filter(Boolean)
      const rendered = renderPrompt({
        module,
        project,
        step,
        params: step.params,
        inputArtifacts,
        budget: { remaining: null },
      })
      unit.attempts += 1
      try {
        const result = await executor.execute({
          root,
          library,
          project,
          playbook,
          plan,
          run,
          step,
          unit,
          module,
          prompt: rendered,
          inputs,
          inputArtifacts,
          signal: controller.signal,
          onEvent: emit,
        })
        const artifacts = normalizeExecutorArtifacts(result, step)
        if (artifacts.length === 0) throw new EquityError('empty_result', '执行器没有返回底稿')
        unit.tokens = result.tokens ?? estimateTokens(rendered.text, artifacts)
        unit.toolCalls = result.toolCalls ?? (result.searches?.length ?? 0)
        const pins = inputs.flatMap((input) => input.pinned ?? []).filter(Boolean)
        const evaluated = []
        for (const item of artifacts) {
          const output = item.output
          const gateResult = evaluateGates({ module, output, outputType: item.type })
          evaluated.push({ ...item, gateResult })
        }
        const blocking = evaluated.filter((item) => item.gateResult.blocking)
        if (blocking.length > 0) {
          // Record the draft so the analyst can inspect what failed, then ask a human.
          const recorded = []
          for (const item of evaluated) {
            const record = await recordArtifact({
              root,
              library,
              type: item.type,
              subjectId: item.subjectId ?? unit.subjectId,
              partitionKey: item.partitionKey ?? unit.partitionKey,
              period: item.period,
              output: item.output,
              producedBy: {
                moduleId: step.moduleId,
                moduleVersion: step.moduleVersion,
                runId,
                unitId: unit.unitId,
                templateSha: rendered.templateSha,
                actor: 'agent',
              },
              derivedFrom: pins,
              status: 'draft',
              checks: item.gateResult.checks,
              actor: 'agent',
            })
            recorded.push(record.id)
          }
          unit.artifactIds = recorded
          unit.status = 'needs_human'
          unit.gates = blocking.map((item) => item.gateResult)
          unit.error = `门未通过：${blocking.flatMap((item) => item.gateResult.checks.filter((check) => check.status === 'fail').map((check) => check.id)).join(', ')}`
          unit.finishedAt = nowIso()
          await createIssue(root, {
            projectId: project.projectId,
            runId,
            unitId: unit.unitId,
            artifactId: recorded[0] ?? null,
            type: 'gate_failed',
            severity: 'high',
            title: `${step.name} 门未通过`,
            detail: unit.error,
            options: ['修复后重跑', '人工豁免（需用户）', '改口径'],
          })
        } else {
          const recorded = []
          for (const item of evaluated) {
            const record = await recordArtifact({
              root,
              library,
              type: item.type,
              subjectId: item.subjectId ?? unit.subjectId,
              partitionKey: item.partitionKey ?? unit.partitionKey,
              period: item.period,
              output: item.output,
              producedBy: {
                moduleId: step.moduleId,
                moduleVersion: step.moduleVersion,
                runId,
                unitId: unit.unitId,
                templateSha: rendered.templateSha,
                actor: 'agent',
              },
              derivedFrom: pins,
              status: 'verified',
              checks: item.gateResult.checks,
              actor: 'agent',
            })
            recorded.push(record.id)
          }
          unit.artifactIds = recorded
          unit.status = 'accepted'
          unit.gates = evaluated.map((item) => item.gateResult)
          unit.error = null
          unit.finishedAt = nowIso()
          await emit({ type: 'artifact/record', unitId: unit.unitId, artifactIds: recorded })
        }
        await updateSearchLedger(root, library, {
          project,
          step,
          unit,
          searches: result.searches ?? [],
          asOf: project.engagement?.asOf,
        })
        await persist()
        await emit({
          type: 'unit/end',
          unitId: unit.unitId,
          status: unit.status,
          artifactIds: unit.artifactIds,
          error: unit.error,
        })
      } catch (error) {
        if (controller.signal.aborted) {
          unit.status = control.pauseRequested ? 'todo' : 'cancelled'
          unit.error = control.pauseRequested ? 'paused' : 'cancelled'
        } else {
          unit.status = 'failed'
          unit.error = error?.message ?? String(error)
          await createIssue(root, {
            projectId: project.projectId,
            runId,
            unitId: unit.unitId,
            type: error?.code ?? 'unit_failed',
            severity: 'high',
            title: `${step.name} 执行失败`,
            detail: unit.error,
            options: ['重试', '减小范围', '人工处理'],
          })
        }
        unit.finishedAt = nowIso()
        await persist()
        await emit({ type: 'unit/error', unitId: unit.unitId, status: unit.status, error: unit.error })
      }
    }

    if (run.status === 'running') {
      await updateCoverage(root, library, { project, units, asOf: project.engagement?.asOf })
      const all = await listArtifacts(root)
      await recordTriggerArtifact(root, library, { project, artifacts: all, asOf: project.engagement?.asOf })
      const statuses = units.map((unit) => unit.status)
      const accepted = statuses.filter((status) => status === 'accepted').length
      const incomplete = statuses.filter((status) => ['needs_human', 'failed', 'blocked'].includes(status)).length
      run.status = accepted === units.length ? 'completed' : incomplete > 0 ? 'partial' : 'completed'
    }
  } catch (error) {
    run.status = 'failed'
    run.error = error?.message ?? String(error)
    await emit({ type: 'run/error', error: run.error })
  } finally {
    if (signal) signal.removeEventListener('abort', externalAbort)
    run.finishedAt = nowIso()
    run.units = Object.fromEntries(units.map((unit) => [unit.unitId, unit]))
    const used = budgetUsed(units)
    run.budget.usedTokens = used.tokens
    run.budget.usedToolCalls = used.toolCalls
    await atomicWriteJson(join(dir, 'run.json'), run)
    await writeUnits(root, runId, units, order)
    await emit({ type: 'run/end', status: run.status, used })
    activeRuns.delete(runId)
  }
  return run
}

function normalizeExecutorArtifacts(result, step) {
  const items = result?.artifacts ?? (result?.data ? [result] : [])
  const fallbackType = step?.outputs?.length === 1 ? step.outputs[0].type : undefined
  return items
    .filter(Boolean)
    .map((item) => {
      if (item.output) return { ...item, output: item.output }
      return { type: item.data?.type ?? item._type ?? undefined, output: item }
    })
    .filter((item) => item.output && item.output.data !== undefined)
    .map((item, index) => ({
      type: item.type ?? result.type ?? fallbackType,
      subjectId: item.subjectId,
      partitionKey: item.partitionKey ?? '_default',
      period: item.period,
      output: item.output,
      index,
    }))
}

function estimateTokens(prompt, artifacts) {
  return Math.ceil((String(prompt).length + JSON.stringify(artifacts).length) / 4)
}

/** Load one run. */
export async function loadRun(root, runId) {
  return readJson(join(runDir(root, runId), 'run.json'), null)
}

/** List runs, newest first. */
export async function listRuns(root) {
  const dir = join(root, '.equity', 'runs')
  let entries = []
  try {
    const { readdir } = await import('node:fs/promises')
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const runs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const run = await readJson(join(dir, entry.name, 'run.json'), null)
    if (run) runs.push(run)
  }
  return runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
}

/** Pause a live run. */
export function pauseRun(runId) {
  const control = activeRuns.get(runId)
  if (!control) return false
  control.pauseRequested = true
  control.controller.abort('paused')
  return true
}

/** Cancel a live run. */
export function cancelRun(runId) {
  const control = activeRuns.get(runId)
  if (!control) return false
  control.cancelRequested = true
  control.controller.abort('cancelled')
  return true
}

/** Whether a run is active in this process. */
export function isActive(runId) {
  return activeRuns.has(runId)
}

/**
 * Startup reconciliation: a run file that still says `running` but has no live
 * activation in this process was interrupted. Mark it paused so the analyst can
 * resume; never fabricate completion.
 */
export async function reconcileRuns(root) {
  const runs = await listRuns(root)
  const reconciled = []
  for (const run of runs) {
    if (run.status !== 'running' || isActive(run.runId)) continue
    const next = {
      ...run,
      status: 'paused',
      error: 'reconciled: process restarted while run was running',
      reconciledAt: nowIso(),
      updatedAt: nowIso(),
    }
    await atomicWriteJson(join(runDir(root, run.runId), 'run.json'), next)
    await appendEvent(root, run.runId, { type: 'run/reconciled', status: 'paused' })
    reconciled.push(run.runId)
  }
  return reconciled
}

import { EquityError, canonicalJson, isPlainObject, semanticHash } from '../util/json.js'
import { resolveModule, satisfies } from './registry.js'

const SYSTEM_TYPES = ['search.ledger', 'source.coverage']

function error(code, message, details = {}) {
  return { code, message, level: 'error', ...details }
}

function warning(code, message, details = {}) {
  return { code, message, level: 'warn', ...details }
}

function coerceParam(param, value) {
  if (value === undefined || value === null) return param.default
  if (param.type === 'integer') {
    const number = Number(value)
    if (!Number.isInteger(number)) throw new EquityError('bad_param', `参数 ${param.key} 必须是整数`)
    return number
  }
  if (param.type === 'number') {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new EquityError('bad_param', `参数 ${param.key} 必须是数字`)
    return number
  }
  if (param.type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    throw new EquityError('bad_param', `参数 ${param.key} 必须是布尔值`)
  }
  return String(value)
}

export function resolveParams(module, instance) {
  const values = {}
  const warnings = []
  const known = new Set()
  for (const param of module.manifest.params ?? []) {
    known.add(param.key)
    let value
    try {
      value = coerceParam(param, instance.params?.[param.key])
    } catch (err) {
      throw new EquityError('bad_param', `${module.id}: ${err.message}`, { moduleId: module.id, param: param.key })
    }
    if (value === undefined) value = param.default
    if (param.enum && value !== undefined && !param.enum.includes(value)) {
      throw new EquityError('bad_param', `${module.id}: 参数 ${param.key} 不在枚举内`, { moduleId: module.id, param: param.key })
    }
    if (param.type === 'integer' && value !== undefined) {
      if (typeof param.min === 'number' && value < param.min) {
        throw new EquityError('bad_param', `${module.id}: 参数 ${param.key} < ${param.min}`, { moduleId: module.id, param: param.key })
      }
      if (typeof param.max === 'number' && value > param.max) {
        throw new EquityError('bad_param', `${module.id}: 参数 ${param.key} > ${param.max}`, { moduleId: module.id, param: param.key })
      }
    }
    if (value !== undefined) values[param.key] = value
  }
  for (const key of Object.keys(instance.params ?? {})) {
    if (!known.has(key)) warnings.push(warning('unused_param', `模块 ${module.id} 没有参数 ${key}`, { moduleId: module.id, param: key }))
  }
  return { params: values, warnings }
}

/** Types produced by module instances in this playbook. */
export function expandAll(library, instances, selfInstance) {
  const produced = new Set()
  for (const instance of instances) {
    if (!instance.module) continue
    for (const output of instance.module.manifest.outputs ?? []) produced.add(output.type)
  }
  const types = new Set()
  for (const type of library.typeList) {
    if (type.status === 'legacy') continue
    if (type.type === 'report.deliverable') continue
    if (type.type === 'company.roster') continue
    if (produced.has(type.type)) types.add(type.type)
  }
  for (const type of SYSTEM_TYPES) types.add(type)
  for (const output of selfInstance.module.manifest.outputs ?? []) types.delete(output.type)
  types.delete('report.deliverable')
  return [...types].sort()
}

function buildProducerIndex(instances) {
  const map = new Map()
  for (const instance of instances) {
    for (const output of instance.module.manifest.outputs ?? []) {
      const list = map.get(output.type) ?? []
      list.push(instance)
      map.set(output.type, list)
    }
  }
  return map
}

function instanceLabel(instance) {
  return instance.instanceId || instance.id
}

/**
 * Compile a playbook into an ordered, frozen plan.
 * @returns {{ok: boolean, plan: object|null, errors: object[], warnings: object[]}}
 */
export function compilePlaybook({ library, project, playbook }) {
  const errors = []
  const warnings = []
  const instances = []
  const stageIds = new Set((playbook.stages ?? []).map((stage) => stage.id))

  for (const [index, raw] of (playbook.modules ?? []).entries()) {
    if (raw.enabled === false) continue
    const instanceId = raw.id
    let module
    try {
      module = resolveModule(library, raw.use)
    } catch (err) {
      errors.push(error(err.code ?? 'unknown_module', err.message, { moduleIndex: index, instanceId, field: 'use' }))
      continue
    }
    let params
    try {
      const resolved = resolveParams(module, raw)
      params = resolved.params
      warnings.push(...resolved.warnings.map((item) => ({ ...item, moduleIndex: index, instanceId })))
    } catch (err) {
      errors.push(error(err.code ?? 'bad_param', err.message, { moduleIndex: index, instanceId, field: 'params' }))
      params = {}
    }
    if (module.validation && !module.validation.valid) {
      for (const item of module.validation.errors) {
        errors.push(error(item.code, `${module.id}: ${item.message}`, { moduleIndex: index, instanceId, field: item.field }))
      }
    }
    const stage = raw.stage ?? module.manifest.stageHint ?? 'investigation'
    if (stageIds.size > 0 && !stageIds.has(stage)) {
      warnings.push(warning('unknown_stage', `实例 ${instanceId} 使用了未声明的 stage ${stage}`, { moduleIndex: index, instanceId }))
    }
    instances.push({
      order: index,
      instanceId,
      module,
      moduleId: module.id,
      moduleVersion: module.manifest.version,
      moduleHash: module.hash,
      templateSha: module.templateSha,
      stage,
      scope: module.manifest.scope,
      params,
      raw,
      inputs: Array.isArray(raw.inputs) ? raw.inputs : module.manifest.inputs ?? [],
      references: Array.isArray(raw.references)
        ? raw.references
        : [
            ...(module.manifest.references ?? []),
            ...((raw.references ?? []).filter((item) => typeof item === 'string').map((type) => ({ type }))),
          ],
      outputs: module.manifest.outputs ?? [],
      gates: module.manifest.gates ?? [],
      review: raw.review ?? module.manifest.review ?? { mode: 'none', maxRounds: 0 },
      budget: { ...(module.manifest.budget ?? {}), ...(raw.budget ?? {}) },
      tools: module.manifest.tools ?? [],
    })
  }

  // Duplicate producer: R1 unique producer per type.
  const producers = buildProducerIndex(instances)
  // Project bootstrap and source acquisition are system producers, not playbook
  // modules. Their artifacts are materialized before or alongside the run.
  const systemProducerMap = new Map([
    ['company.roster', { instanceId: 'system/project-bootstrap', order: -2, system: true, moduleId: 'system/project-bootstrap' }],
    ['search.ledger', { instanceId: 'system/source-acquisition', order: -1, system: true, moduleId: 'system/source-acquisition' }],
    ['source.coverage', { instanceId: 'system/source-acquisition', order: -1, system: true, moduleId: 'system/source-acquisition' }],
  ])
  for (const [type, producer] of systemProducerMap) {
    if (!producers.has(type)) producers.set(type, [producer])
  }
  for (const [type, list] of producers) {
    if (list.length > 1) {
      errors.push(error('duplicate_producer', `类型 ${type} 有多个生产者：${list.map(instanceLabel).join(', ')}`, {
        type,
        instances: list.map(instanceLabel),
      }))
    }
  }

  const edges = []
  const outgoing = new Map()
  const incoming = new Map()
  for (const instance of instances) {
    incoming.set(instance.instanceId, [])
    outgoing.set(instance.instanceId, [])
  }

  const resolveTypeProducer = (type, instance) => {
    const list = producers.get(type) ?? []
    if (list.length === 0) return null
    if (list.length === 1) return list[0]
    const chosen = list.find((candidate) => candidate.instanceId === instance.instanceId)
    return chosen ?? list[0]
  }

  const steps = []
  for (const instance of instances) {
    const resolvedInputs = []
    const seenTypes = new Set()
    for (const input of instance.inputs ?? []) {
      const types = input.type === 'all' ? expandAll(library, instances, instance) : [input.type]
      for (const type of types) {
        if (seenTypes.has(type)) continue
        seenTypes.add(type)
        const onMissing = input.onMissing ?? 'block'
        if (!library.types.has(type) && !SYSTEM_TYPES.includes(type)) {
          errors.push(error('unknown_artifact_type', `实例 ${instanceLabel(instance)} 的输入类型未注册：${type}`, {
            instanceId: instance.instanceId,
            field: 'inputs',
          }))
          continue
        }
        const producer = resolveTypeProducer(type, instance)
        if (!producer) {
          if (onMissing === 'block') {
            errors.push(error('missing_producer', `实例 ${instanceLabel(instance)} 的输入 ${type} 没有生产者`, {
              instanceId: instance.instanceId,
              type,
              field: 'inputs',
            }))
          } else {
            warnings.push(warning('missing_producer', `实例 ${instanceLabel(instance)} 的输入 ${type} 缺失，将降级`, {
              instanceId: instance.instanceId,
              type,
            }))
          }
          resolvedInputs.push({ type, onMissing, from: null, kind: 'input' })
          continue
        }
        resolvedInputs.push({ type, onMissing, from: producer.instanceId, kind: 'input' })
        if (onMissing === 'block') {
          if (producer.system) {
            // Project bootstrap / source acquisition are materialized before the
            // run and are not playbook steps; they do not participate in the DAG.
            continue
          }
          const fromOrder = producer.order
          if (fromOrder > instance.order) {
            errors.push(error('order_violation', `实例 ${instanceLabel(instance)} 排在输入生产者 ${instanceLabel(producer)} 之前`, {
              instanceId: instance.instanceId,
              type,
              producer: producer.instanceId,
              suggestedOrder: fromOrder,
              field: 'order',
            }))
          }
          edges.push({
            from: producer.instanceId,
            to: instance.instanceId,
            type,
            kind: 'input',
          })
          outgoing.get(producer.instanceId)?.push(instance.instanceId)
          incoming.get(instance.instanceId)?.push(producer.instanceId)
        }
      }
    }
    const resolvedReferences = []
    for (const reference of instance.references ?? []) {
      const type = typeof reference === 'string' ? reference : reference.type
      if (!type) continue
      if (!library.types.has(type)) {
        errors.push(error('unknown_artifact_type', `实例 ${instanceLabel(instance)} 的引用类型未注册：${type}`, {
          instanceId: instance.instanceId,
          field: 'references',
        }))
        continue
      }
      const producer = resolveTypeProducer(type, instance)
      if (!producer) {
        warnings.push(warning('dangling_reference', `实例 ${instanceLabel(instance)} 的软引用 ${type} 没有生产者`, {
          instanceId: instance.instanceId,
          type,
        }))
        resolvedReferences.push({ type, from: null, kind: 'reference' })
      } else {
        resolvedReferences.push({ type, from: producer.instanceId, kind: 'reference' })
      }
    }
    steps.push({
      instanceId: instance.instanceId,
      moduleId: instance.moduleId,
      moduleVersion: instance.moduleVersion,
      moduleHash: instance.moduleHash,
      templateSha: instance.templateSha,
      name: instance.module.manifest.name,
      kind: instance.module.manifest.kind,
      stage: instance.stage,
      scope: instance.scope,
      subjectMode: instance.scope,
      params: instance.params,
      inputs: resolvedInputs,
      references: resolvedReferences,
      outputs: instance.outputs,
      gates: instance.gates,
      review: instance.review,
      budget: instance.budget,
      tools: instance.tools,
      order: instance.order,
    })
  }

  // Cycle detection over hard input edges only.
  const inDegree = new Map(steps.map((step) => [step.instanceId, incoming.get(step.instanceId)?.length ?? 0]))
  const queue = steps.filter((step) => inDegree.get(step.instanceId) === 0).map((step) => step.instanceId)
  const ordered = []
  while (queue.length > 0) {
    const id = queue.shift()
    ordered.push(id)
    for (const next of outgoing.get(id) ?? []) {
      inDegree.set(next, (inDegree.get(next) ?? 0) - 1)
      if (inDegree.get(next) === 0) queue.push(next)
    }
  }
  if (ordered.length !== steps.length) {
    const cycleIds = steps.filter((step) => !ordered.includes(step.instanceId)).map((step) => step.instanceId)
    errors.push(error('cycle_detected', `依赖成环：${cycleIds.join(' → ')}`, { cycle: cycleIds }))
  }
  const orderIndex = new Map(ordered.map((id, index) => [id, index]))
  const orderedSteps = steps
    .slice()
    .sort((a, b) => (orderIndex.get(a.instanceId) ?? 1e9) - (orderIndex.get(b.instanceId) ?? 1e9))

  const plan = {
    apiVersion: 'equity.plan/v1',
    playbookId: playbook.id,
    playbookVersion: playbook.version,
    playbookName: playbook.name,
    preset: playbook.preset ?? null,
    projectId: project?.projectId ?? null,
    compiledAt: new Date().toISOString(),
    kernelVersion: library.kernelVersion,
    stages: playbook.stages ?? [],
    steps: orderedSteps,
    edges,
    systemSteps: [
      { instanceId: 'system-source-acquisition', moduleId: 'system/source-acquisition', kind: 'system', outputs: SYSTEM_TYPES },
    ],
    budget: { ...(playbook.budget ?? {}), ...(project?.budget ?? {}) },
    warnings,
    errors,
  }
  plan.snapshotHash = semanticHash({
    playbook: { id: playbook.id, version: playbook.version, preset: playbook.preset },
    steps: plan.steps,
    edges: plan.edges,
    budget: plan.budget,
  })
  return { ok: errors.length === 0, plan, errors, warnings }
}

/** Format compile errors for tool output. */
export function formatCompileResult(result) {
  return {
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings,
    plan: result.plan
      ? {
          playbookId: result.plan.playbookId,
          playbookVersion: result.plan.playbookVersion,
          snapshotHash: result.plan.snapshotHash,
          steps: result.plan.steps.map((step, index) => ({
            index,
            instanceId: step.instanceId,
            moduleId: step.moduleId,
            moduleVersion: step.moduleVersion,
            name: step.name,
            kind: step.kind,
            stage: step.stage,
            scope: step.scope,
            inputs: step.inputs,
            outputs: step.outputs,
            params: step.params,
            review: step.review,
          })),
          edges: result.plan.edges,
          warnings: result.plan.warnings,
        }
      : null,
  }
}

/** Compile with a stable error when invalid. */
export function compileOrThrow(options) {
  const result = compilePlaybook(options)
  if (!result.ok) {
    throw new EquityError('compile_failed', `方案编译失败（${result.errors.length} 个错误）`, {
      errors: result.errors,
      warnings: result.warnings,
    })
  }
  return result.plan
}

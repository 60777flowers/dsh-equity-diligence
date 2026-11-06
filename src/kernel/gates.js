import { getByPath, getByPathValues, getPathArray } from '../util/paths.js'
import { canonicalJson, isPlainObject } from '../util/json.js'

const SIX_STATES = new Set([
  'found',
  'not_disclosed_after_search',
  'lower_bound',
  'pending_dd',
  'conflict',
  'not_applicable',
  'not_reviewed',
  'estimated',
])

function pass(id, detail = '') {
  return { id, status: 'pass', detail }
}

function fail(id, detail) {
  return { id, status: 'fail', detail }
}

function countEvidence(output) {
  return new Set((output.evidence ?? []).map((item) => item.evidenceId)).size
}

function countMaterialClaims(output) {
  return (output.claims ?? []).filter((claim) => claim.materiality === 'material')
}

function materialEvidenceCoverage(output) {
  const material = countMaterialClaims(output)
  if (material.length === 0) return 1
  const supported = material.filter((claim) => (claim.evidenceLinks ?? []).some((link) => link.role === 'supports'))
  return supported.length / material.length
}

/** Coverage is "reviewed dimensions / declared dimensions". */
export function computeCoverage(output) {
  const dimensions = output?.sourceCoverage?.dimensions
  if (Array.isArray(dimensions) && dimensions.length > 0) {
    const covered = dimensions.filter((dimension) => ['covered', 'partial'].includes(dimension.status)).length
    return covered / dimensions.length
  }
  const queries = output?.sourceCoverage?.queries
  if (Array.isArray(queries) && queries.length > 0) {
    const successful = queries.filter((query) => ['ok', 'empty'].includes(query.outcome ?? 'ok')).length
    return successful / queries.length
  }
  const fields = []
  const walk = (value, path) => {
    if (!isPlainObject(value)) return
    if (value.status && SIX_STATES.has(value.status)) {
      fields.push({ path, status: value.status })
      return
    }
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`)
  }
  walk(output?.data ?? {}, 'data')
  if (fields.length > 0) {
    const reviewed = fields.filter((field) => field.status !== 'not_reviewed').length
    return reviewed / fields.length
  }
  return (output?.claims ?? []).length > 0 ? 1 : 0
}

function averageAuthority(output) {
  const map = { A: 5, B: 4, C: 3, D: 2 }
  const scores = (output.evidence ?? [])
    .map((evidence) => map[evidence.sourceAuthority])
    .filter((score) => typeof score === 'number')
  if (scores.length === 0) return 3
  return scores.reduce((sum, score) => sum + score, 0) / scores.length
}

function scoreCompleteness(coverage) {
  if (coverage >= 0.9) return 5
  if (coverage >= 0.75) return 4
  if (coverage >= 0.6) return 3
  if (coverage >= 0.4) return 2
  return 1
}

function isFilled(value) {
  return value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)
}

function relativeAfterWildcard(path) {
  const index = String(path).indexOf('[]')
  if (index < 0) return String(path)
  return String(path).slice(index + 2).replace(/^\./, '')
}

function consistencyCheck(rule, output) {
  const kind = rule.kind ?? rule.rule
  const id = `consistency:${rule.id ?? kind ?? 'check'}`
  // `block` and `issue` require a human before acceptance; `warn`/`attention`
  // remain advisory. Missing onFail defaults to blocking for consistency rules.
  const blocking = !['warn', 'attention'].includes(rule.onFail)
  const fail = (message) => ({ id, status: 'fail', detail: message, blocking })
  const advisory = (message) => ({ id, status: 'warn', detail: message, blocking: false })
  if (!kind) return fail('缺少 consistency.kind/rule')
  if (rule.when && !['requiredWhen', 'requiredFieldsWhen', 'crossRef', 'requiresLedger'].includes(kind)) {
    const match = /^(.+?)\s*==\s*(['"]?)(.*?)\2$/.exec(String(rule.when))
    if (match) {
      const candidates = getByPathValues(output, match[1].trim())
      if (!candidates.some((value) => String(value) === match[3])) return null
    } else if (!getByPath(output, rule.when)) {
      return null
    }
  }
  const path = rule.field ?? rule.path
  const values = path && !String(path).includes('[') ? getByPathValues(output, path) : path ? getByPathValues(output, path) : []
  const numeric = () => values.map((value) => Number(value)).filter((value) => Number.isFinite(value))
  // Consistency rules apply when the field is present. A summary artifact of a
  // partitioned type legitimately lacks platform-level fields; absence is
  // handled by requiredFields/minItems, not by every consistency rule.
  if (values.length === 0 && !['requiredWhen', 'requiredFieldsWhen', 'requiresLedger', 'coverage', 'crossRef', 'setCovers', 'setEquals', 'countMatches'].includes(kind)) {
    return null
  }

  if (kind === 'range' || kind === 'in_range') {
    const min = rule.min ?? -Infinity
    const max = rule.max ?? Infinity
    const ok = values.length > 0 && values.every((value) => {
      if (Array.isArray(value)) return value.length >= min && value.length <= max
      if (typeof value === 'number') return value >= min && value <= max
      return Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max
    })
    return ok ? null : fail(`${path} 存在超出 [${min}, ${max}] 的值`)
  }
  if (kind === 'enum' || kind === 'enumMember') {
    const allowed = new Set(rule.allowed ?? rule.values ?? [])
    const ok = values.length > 0 && values.every((value) => allowed.has(value))
    return ok ? null : fail(`${path} 存在不在枚举内的值`)
  }
  if (kind === 'unique') {
    const seen = new Set()
    const ok = values.every((value) => {
      const key = canonicalJson(value)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return ok ? null : fail(`${path} 存在重复值`)
  }
  if (kind === 'min_distinct') {
    const distinct = new Set(values.map((value) => canonicalJson(value))).size
    return distinct >= (rule.min ?? 1) ? null : fail(`${path} 去重后仅 ${distinct} 个，少于 ${rule.min ?? 1}`)
  }
  if (kind === 'sum' || kind === 'sumTo100' || kind === 'sum_max') {
    const total = numeric().reduce((sum, value) => sum + value, 0)
    if (kind === 'sum_max') return rule.max === undefined || total <= rule.max ? null : fail(`${path} 合计 ${total} > ${rule.max}`)
    const target = kind === 'sumTo100' ? 100 : rule.target ?? rule.expected
    const tolerance = rule.tolerance ?? 0.01
    return target === undefined || Math.abs(total - target) <= tolerance ? null : fail(`${path} 合计 ${total}，目标 ${target} ± ${tolerance}`)
  }
  if (kind === 'crossFieldEqual') {
    if (String(rule.expr ?? '').includes('qa.passed') && String(rule.expr ?? '').includes('qa.blocking')) {
      const passed = getByPath(output, 'data.qa.passed')
      const blockingCount = Number(getByPath(output, 'data.qa.blocking'))
      const ok = Boolean(passed) === (blockingCount === 0)
      return ok ? null : fail('qa.passed 与 qa.blocking 不一致')
    }
    const fields = rule.fields ?? []
    if (fields.length < 2) return advisory('crossFieldEqual 缺少 fields')
    const lists = fields.map((field) => getByPathValues(output, field))
    const length = Math.min(...lists.map((list) => list.length))
    const tolerance = rule.tolerance ?? 0.05
    for (let index = 0; index < length; index += 1) {
      const numbers = lists.map((list) => Number(list[index]))
      if (numbers.some((value) => !Number.isFinite(value))) continue
      const left = numbers[0]
      const right = numbers.slice(1).reduce((sum, value) => sum + value, 0)
      if (Math.abs(left - right) > tolerance) return fail(`${fields.join(' / ')} 第 ${index + 1} 行不相等`)
    }
    return null
  }
  if (kind === 'cross_check') {
    const left = getByPathValues(output, rule.left)
    const right = getByPathValues(output, rule.right)
    const length = Math.min(left.length, right.length)
    const tolerance = rule.tolerance ?? 0.01
    for (let index = 0; index < length; index += 1) {
      const a = Number(left[index])
      const b = Number(right[index])
      if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > tolerance) return fail(`${rule.left} 与 ${rule.right} 第 ${index + 1} 项不一致`)
    }
    return null
  }
  if (kind === 'requiredWhen' || kind === 'requiredFieldsWhen') {
    const base = String(path ?? '').split('[]')[0]
    const list = getPathArray(output, path ?? '')
    const sub = relativeAfterWildcard(path ?? '')
    const condition = rule.when ?? ''
    const whenPath = relativeAfterWildcard(String(condition).split('==')[0])
    const whenValueText = String(condition).includes('==') ? String(condition).split('==')[1].trim().replace(/^['"]|['"]$/g, '') : null
    const checkOne = (item) => {
      const whenValue = whenPath ? getByPath(item, whenPath) : true
      const conditionMet = whenValueText === null ? Boolean(whenValue) : String(whenValue) === whenValueText
      if (!conditionMet) return true
      const fieldValue = sub ? getByPath(item, sub) : item
      if (Array.isArray(rule.required)) return rule.required.every((key) => isFilled(getByPath(fieldValue, key)))
      if (rule.minItems !== undefined) return Array.isArray(fieldValue) && fieldValue.length >= rule.minItems
      return isFilled(fieldValue)
    }
    if (list.length > 0) {
      const ok = list.every(checkOne)
      return ok ? null : fail(`${path} 在条件满足时缺少必填值`)
    }
    // Scalar path: check the top-level field against the condition.
    const whenValue = whenPath ? getByPath(output, whenPath) : true
    const conditionMet = whenValueText === null ? Boolean(whenValue) : String(whenValue) === whenValueText
    if (!conditionMet) return null
    const fieldValue = sub ? getByPath(output, sub) : getByPath(output, path)
    if (Array.isArray(rule.required)) return rule.required.every((key) => isFilled(getByPath(fieldValue, key))) ? null : fail(`${path} 缺少 ${rule.required.join('/')}`)
    return isFilled(fieldValue) ? null : fail(`${path} 在条件满足时为空`)
  }
  if (kind === 'setEquals' || kind === 'setCovers') {
    const expected = new Set(rule.expected ?? [])
    const leftValues = rule.left ? getByPathValues(output, rule.left) : values
    if (kind === 'setCovers' && leftValues.length === 0) return null
    const left = new Set(leftValues)
    const right = new Set(getByPathValues(output, rule.right))
    const ok = kind === 'setEquals'
      ? expected.size === left.size && [...expected].every((value) => left.has(value))
      : [...right].every((value) => left.has(value))
    return ok ? null : fail(`${rule.left ?? path} 集合不满足 ${kind}`)
  }
  if (kind === 'subset_of') {
    const right = new Set(getByPathValues(output, rule.right))
    const ok = values.every((value) => right.has(value))
    return ok ? null : fail(`${path} 存在不在 ${rule.right} 中的值`)
  }
  if (kind === 'uniquePair') {
    const fields = rule.fields ?? []
    if (fields.length < 2) return advisory('uniquePair 缺少 fields')
    const pairs = new Set()
    const lists = fields.map((field) => getByPathValues(output, field))
    const length = Math.max(...lists.map((list) => list.length))
    for (let index = 0; index < length; index += 1) {
      const key = canonicalJson(lists.map((list) => list[index] ?? null))
      if (pairs.has(key)) return fail(`${fields.join(' / ')} 存在重复组合`)
      pairs.add(key)
    }
    return null
  }
  if (kind === 'prefixEnum') {
    const prefixes = rule.prefixes ?? []
    const ok = values.every((value) => typeof value === 'string' && prefixes.some((prefix) => value.startsWith(prefix)))
    return ok ? null : fail(`${path} 未带类型前缀`)
  }
  if (kind === 'refExists') {
    const target = new Set(getByPathValues(output, rule.target ?? 'claims[].claimId').map((value) => String(value)))
    const fields = rule.fields ?? (rule.field ? [rule.field] : [])
    const refs = []
    for (const field of fields) {
      const list = getByPathValues(output, field)
      for (const value of list) {
        if (Array.isArray(value)) refs.push(...value)
        else if (typeof value === 'string') refs.push(...(value.match(new RegExp(rule.pattern ?? '[A-Za-z0-9_:-]+', 'g')) ?? []))
      }
    }
    const dangling = refs.filter((ref) => !target.has(String(ref)))
    return dangling.length === 0 ? null : fail(`${path} 存在悬空引用：${dangling.slice(0, 5).join(', ')}`)
  }
  if (kind === 'forbiddenText' || kind === 'banned_terms') {
    const terms = rule.forbidden ?? rule.terms ?? []
    const fields = rule.fields ?? (rule.path ? [rule.path] : [])
    const texts = fields.flatMap((field) => getByPathValues(output, field)).filter((value) => typeof value === 'string')
    const hit = texts.find((text) => terms.some((term) => text.includes(term)))
    return hit ? fail(`出现禁用定性词：${terms.join('/')}`) : null
  }
  if (kind === 'coverage') {
    const material = (output.claims ?? []).filter((claim) => claim.materiality === 'material')
    const supported = material.filter((claim) => (claim.evidenceLinks ?? []).some((link) => link.role === 'supports'))
    const ratio = material.length === 0 ? 1 : supported.length / material.length
    return ratio >= (rule.minRatio ?? 1) ? null : fail(`material claim 证据覆盖 ${(ratio * 100).toFixed(0)}% < ${(rule.minRatio ?? 1) * 100}%`)
  }
  if (kind === 'requiresLedger') {
    const notFound = (output.claims ?? []).filter((claim) => claim.status === 'not_disclosed_after_search')
    if (notFound.length === 0) return null
    const attempts = output.sourceCoverage?.queries ?? []
    return attempts.length > 0 ? null : fail('not_disclosed_after_search 缺少 search.ledger 检索记录')
  }
  if (kind === 'countMatches') {
    const fields = rule.fields ?? []
    const counts = fields.map((field) => getByPathValues(output, field).length)
    const diff = Math.max(...counts) - Math.min(...counts)
    return diff <= (rule.tolerance ?? 3) ? null : fail(`${fields.join(' / ')} 数量差异 ${diff}`)
  }
  if (kind === 'crossRef') {
    const when = String(rule.when ?? '')
    const require = String(rule.require ?? '')
    const conditionMet = (() => {
      if (!when.includes('==')) return false
      const [left, right] = when.split('==').map((item) => item.trim())
      const leftValues = getByPathValues(output, left.replace(/\[\]$/, ''))
      const wanted = right.replace(/^['"]|['"]$/g, '')
      return leftValues.some((value) => String(value) === wanted)
    })()
    if (!conditionMet) return null
    const match = /^([\w.]+)\.length\s*(>=|>|==)\s*(\d+)$/.exec(require)
    if (!match) return advisory(`crossRef 表达式未实现：${require}`)
    const length = getByPathValues(output, match[1]).length
    const target = Number(match[3])
    const ok = match[2] === '>=' ? length >= target : match[2] === '>' ? length > target : length === target
    return ok ? null : fail(`${require} 不满足（实际 ${length}）`)
  }
  if (kind === 'contains') {
    const needle = rule.value ?? rule.needle ?? rule.mustContain ?? ''
    const targetValues = typeof needle === 'string' && needle.startsWith('data.') ? getByPathValues(output, needle) : [needle]
    const ok = values.every((value) => targetValues.some((target) => String(value).includes(String(target))))
    return ok ? null : fail(`${path} 未包含 ${needle}`)
  }
  if (kind === 'regex') {
    const regex = new RegExp(rule.pattern ?? '.*')
    const ok = values.every((value) => regex.test(String(value)))
    return ok ? null : fail(`${path} 不匹配 ${rule.pattern}`)
  }
  if (kind === 'mustBeEmpty') {
    const ok = values.every((value) => !isFilled(value))
    return ok ? null : fail(`${path} 必须为空`)
  }
  if (kind === 'order' || kind === 'date_ascending') {
    const numbers = values.map((value) => {
      if (typeof value === 'number') return value
      const date = Date.parse(String(value))
      return Number.isNaN(date) ? null : date
    })
    const ok = numbers.every((value) => value !== null) && numbers.every((value, index) => index === 0 || value >= numbers[index - 1])
    return ok ? null : fail(`${path} 未按升序排列`)
  }
  if (kind === 'order_conditional') {
    return advisory('order_conditional 暂按提示处理')
  }
  if (kind === 'tag_required' || kind === 'tag_required_all' || kind === 'tag_conditional') {
    return advisory(`${kind} 暂按提示处理`)
  }
  return advisory(`未实现的 consistency 规则：${kind}`)
}

function checkRule(rule, output) {
  const checks = []
  if (typeof rule.minEvidence === 'number' && countEvidence(output) < rule.minEvidence) {
    checks.push(fail('evidence', `证据数 ${countEvidence(output)} < ${rule.minEvidence}`))
  }
  if (typeof rule.minCoverage === 'number') {
    const coverage = computeCoverage(output)
    if (coverage < rule.minCoverage) checks.push(fail('coverage', `覆盖率 ${coverage.toFixed(2)} < ${rule.minCoverage}`))
  }
  for (const path of rule.requiredFields ?? []) {
    const value = getByPath(output, path)
    if (!isFilled(value)) checks.push(fail(`required:${path}`, `${path} 为空`))
  }
  for (const [path, min] of Object.entries(rule.minItems ?? {})) {
    const value = getByPath(output, path)
    if (!Array.isArray(value) || value.length < min) checks.push(fail(`minItems:${path}`, `${path} 少于 ${min} 项`))
  }
  for (const path of rule.sixStateFields ?? []) {
    const values = getByPathValues(output, path)
    if (values.length === 0) {
      checks.push(fail(`sixState:${path}`, `${path} 未找到六态字段`))
      continue
    }
    for (const value of values) {
      if (!isPlainObject(value) || !SIX_STATES.has(value.status)) {
        checks.push(fail(`sixState:${path}`, `${path} 不是六态字段`))
      } else if (value.status === 'not_disclosed_after_search' && !value.note) {
        checks.push(fail(`sixStateNote:${path}`, `${path} 未披露但缺少检索说明`))
      }
    }
  }
  if (typeof rule.maxEstimatedRatio === 'number') {
    const values = []
    const walk = (value) => {
      if (!isPlainObject(value)) return
      if (value.status === 'estimated') values.push(value)
      for (const child of Object.values(value)) walk(child)
    }
    walk(output.data ?? {})
    const all = []
    const walkAll = (value) => {
      if (!isPlainObject(value)) return
      if (SIX_STATES.has(value.status)) all.push(value)
      for (const child of Object.values(value)) walkAll(child)
    }
    walkAll(output.data ?? {})
    const ratio = all.length === 0 ? 0 : values.length / all.length
    if (ratio > rule.maxEstimatedRatio) {
      checks.push(fail('estimatedRatio', `估算字段占比 ${ratio.toFixed(2)} > ${rule.maxEstimatedRatio}`))
    }
  }
  for (const item of rule.consistency ?? []) {
    const result = consistencyCheck(item, output)
    if (result) checks.push(result)
  }
  return checks
}

function rubricScores(output) {
  const coverage = computeCoverage(output)
  const evidenceCoverage = materialEvidenceCoverage(output)
  return {
    factAccuracy: 4,
    citationAccuracy: evidenceCoverage >= 1 ? 5 : evidenceCoverage >= 0.8 ? 4 : evidenceCoverage >= 0.5 ? 3 : 2,
    completeness: scoreCompleteness(coverage),
    sourceQuality: averageAuthority(output),
    reconciliation: 4,
  }
}

/**
 * Evaluate every declared gate.
 * @returns {{passed: boolean, checks: object[], blocking: boolean, coverage: number, rubric: object|null}}
 */
export function evaluateGates({ module, output, outputType = undefined, review = undefined }) {
  const checks = []
  let blocking = false
  let rubric = null
  // A multi-output builder may have per-output semantics: the deliverable index
  // carries files/QA/signoff, while the DD request list carries only items.
  if (module?.id === 'builtin/deliverable' && outputType === 'dd.request_list') {
    return { passed: true, blocking: false, checks: [pass('schema', 'schema 已通过')], coverage: 1, rubric: null }
  }
  for (const gate of module.manifest.gates ?? []) {
    if (gate.type === 'schema') {
      checks.push(pass(gate.id ?? 'schema', 'schema 已通过'))
      continue
    }
    if (gate.type === 'coverage') {
      const min = gate.config?.min ?? module.gates?.minCoverage ?? 0.7
      const coverage = computeCoverage(output)
      if (coverage < min) {
        checks.push(fail(gate.id ?? 'coverage', `覆盖率 ${coverage.toFixed(2)} < ${min}`))
        blocking = true
      } else {
        checks.push(pass(gate.id ?? 'coverage', `覆盖率 ${coverage.toFixed(2)}`))
      }
      continue
    }
    if (gate.type === 'rule') {
      const rule = { ...(module.gates ?? {}), ...(gate.config ?? {}) }
      const ruleChecks = checkRule(rule, output)
      if (ruleChecks.length > 0) {
        checks.push(...ruleChecks)
        if (ruleChecks.some((check) => check.blocking !== false)) blocking = true
      } else {
        checks.push(pass(gate.id ?? 'rule', '规则通过'))
      }
      continue
    }
    if (gate.type === 'rubric') {
      rubric = rubricScores(output)
      const minScore = gate.minScore ?? 3
      const failedDimensions = Object.entries(rubric).filter(([, score]) => score < Math.min(minScore, 3))
      if (failedDimensions.length > 0) {
        checks.push(fail(gate.id ?? 'rubric', `rubric 维度低于 3：${failedDimensions.map(([key]) => key).join(', ')}`))
        blocking = true
      } else {
        checks.push(pass(gate.id ?? 'rubric', `rubric ${Math.min(...Object.values(rubric)).toFixed(1)}`))
      }
      continue
    }
    if (gate.type === 'checklist') {
      const items = gate.config?.items ?? []
      const failed = items.filter((item) => item.blocking && item.status !== 'pass' && item.status !== 'waived')
      if (failed.length > 0) {
        checks.push(fail(gate.id ?? 'checklist', `未过清单项：${failed.map((item) => item.id).join(', ')}`))
        blocking = true
      } else {
        checks.push(pass(gate.id ?? 'checklist', `${items.length} 项`))
      }
    }
  }
  // The machine-readable rules/gates.json is authoritative even when a module
  // manifest only declares schema/coverage. Run it as one synthetic rule gate.
  const hasRuleGate = (module.manifest.gates ?? []).some((gate) => gate.type === 'rule')
  if (!hasRuleGate && module.gates && Object.keys(module.gates).length > 0) {
    const ruleChecks = checkRule(module.gates, output)
    if (ruleChecks.length > 0) {
      checks.push(...ruleChecks)
      if (ruleChecks.some((check) => check.blocking !== false)) blocking = true
    } else {
      checks.push(pass('rules', 'rules/gates.json 通过'))
    }
  }
  return {
    passed: !blocking,
    blocking,
    checks,
    coverage: computeCoverage(output),
    rubric,
  }
}

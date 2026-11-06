/**
 * Small, dependency-free JSON Schema validator for the subset this plugin uses.
 * It intentionally rejects unsupported schema constructs at load time rather
 * than silently accepting data the schema author did not express.
 */

import { canonicalJson, isPlainObject } from './json.js'

const KNOWN_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions', 'title', 'description', 'default', 'examples',
  'type', 'properties', 'required', 'additionalProperties', 'patternProperties', 'items', 'prefixItems',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'enum', 'const',
  'oneOf', 'anyOf', 'allOf', 'not', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'minLength', 'maxLength', 'pattern', 'format', 'deprecated', 'readOnly', 'writeOnly',
])

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function matchesType(value, type) {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'object') return isPlainObject(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'null') return value === null
  return typeof value === type
}

function resolvePointer(root, pointer) {
  if (pointer === '#') return root
  if (!pointer.startsWith('#/')) return undefined
  const parts = pointer
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  let node = root
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined
    node = node[part]
  }
  return node
}

function deepEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b)
}

function pushError(errors, path, keyword, message, params = undefined) {
  errors.push({ path, keyword, message, ...(params === undefined ? {} : { params }) })
}

function validateNode(schema, value, root, path, errors, depth) {
  if (depth > 80) {
    pushError(errors, path, 'depth', 'schema 递归过深')
    return
  }
  if (schema === true || schema === undefined) return
  if (schema === false) {
    pushError(errors, path, 'false', '该值不允许出现')
    return
  }
  if (!isPlainObject(schema)) {
    pushError(errors, path, 'schema', 'schema 节点必须是对象或布尔值')
    return
  }
  if (schema.$ref !== undefined) {
    const target = resolvePointer(root, schema.$ref)
    if (target === undefined) {
      pushError(errors, path, '$ref', `无法解析 $ref: ${schema.$ref}`)
      return
    }
    validateNode(target, value, root, path, errors, depth + 1)
    return
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) {
      pushError(errors, path, 'type', `应为 ${types.join(' | ')}，实际为 ${typeOf(value)}`, { expected: types })
      return
    }
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    pushError(errors, path, 'const', '值与 const 不一致', { expected: schema.const })
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) {
    pushError(errors, path, 'enum', '值不在枚举范围内', { allowed: schema.enum })
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) {
      pushError(errors, path, 'minLength', `字符串长度应 ≥ ${schema.minLength}`)
    }
    if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) {
      pushError(errors, path, 'maxLength', `字符串长度应 ≤ ${schema.maxLength}`)
    }
    if (typeof schema.pattern === 'string') {
      let regex
      try {
        regex = new RegExp(schema.pattern)
      } catch {
        pushError(errors, path, 'pattern', 'schema 的 pattern 不是合法正则')
      }
      if (regex && !regex.test(value)) pushError(errors, path, 'pattern', '字符串不匹配 pattern')
    }
    if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      pushError(errors, path, 'format', '应为 YYYY-MM-DD')
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      pushError(errors, path, 'format', '应为 ISO 日期时间')
    }
    if (schema.format === 'uri' && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      pushError(errors, path, 'format', '应为 URI')
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      pushError(errors, path, 'minimum', `应 ≥ ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      pushError(errors, path, 'maximum', `应 ≤ ${schema.maximum}`)
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      pushError(errors, path, 'exclusiveMinimum', `应 > ${schema.exclusiveMinimum}`)
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      pushError(errors, path, 'exclusiveMaximum', `应 < ${schema.exclusiveMaximum}`)
    }
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        pushError(errors, path, 'multipleOf', `应为 ${schema.multipleOf} 的倍数`)
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      pushError(errors, path, 'minItems', `数组长度应 ≥ ${schema.minItems}`)
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      pushError(errors, path, 'maxItems', `数组长度应 ≤ ${schema.maxItems}`)
    }
    if (schema.uniqueItems === true) {
      const seen = new Set()
      for (const item of value) {
        const key = canonicalJson(item)
        if (seen.has(key)) {
          pushError(errors, path, 'uniqueItems', '数组元素必须唯一')
          break
        }
        seen.add(key)
      }
    }
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((itemSchema, index) => {
        if (index < value.length) {
          validateNode(itemSchema, value[index], root, `${path}[${index}]`, errors, depth + 1)
        }
      })
    }
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        schema.items.forEach((itemSchema, index) => {
          if (index < value.length) {
            validateNode(itemSchema, value[index], root, `${path}[${index}]`, errors, depth + 1)
          }
        })
      } else {
        value.forEach((item, index) => {
          validateNode(schema.items, item, root, `${path}[${index}]`, errors, depth + 1)
        })
      }
    }
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      pushError(errors, path, 'minProperties', `对象属性数应 ≥ ${schema.minProperties}`)
    }
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
      pushError(errors, path, 'maxProperties', `对象属性数应 ≤ ${schema.maxProperties}`)
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          pushError(errors, `${path}.${key}`, 'required', `缺少必填字段 ${key}`, { missing: key })
        }
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    const patternProperties = isPlainObject(schema.patternProperties) ? schema.patternProperties : {}
    for (const [key, item] of Object.entries(value)) {
      let matched = false
      if (Object.hasOwn(properties, key)) {
        matched = true
        validateNode(properties[key], item, root, `${path}.${key}`, errors, depth + 1)
      }
      for (const [pattern, patternSchema] of Object.entries(patternProperties)) {
        let regex
        try {
          regex = new RegExp(pattern)
        } catch {
          continue
        }
        if (regex.test(key)) {
          matched = true
          validateNode(patternSchema, item, root, `${path}.${key}`, errors, depth + 1)
        }
      }
      if (!matched && schema.additionalProperties === false) {
        pushError(errors, `${path}.${key}`, 'additionalProperties', `不允许的字段 ${key}`, { extra: key })
      } else if (!matched && isPlainObject(schema.additionalProperties)) {
        validateNode(schema.additionalProperties, item, root, `${path}.${key}`, errors, depth + 1)
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validateNode(sub, value, root, path, errors, depth + 1)
  }
  if (Array.isArray(schema.anyOf)) {
    const anyErrors = []
    const valid = schema.anyOf.some((sub) => {
      const trial = []
      validateNode(sub, value, root, path, trial, depth + 1)
      if (trial.length === 0) return true
      anyErrors.push(...trial)
      return false
    })
    if (!valid) pushError(errors, path, 'anyOf', '不满足 anyOf 的任一分支', { first: anyErrors[0] })
  }
  if (Array.isArray(schema.oneOf)) {
    let validCount = 0
    const branchErrors = []
    for (const sub of schema.oneOf) {
      const trial = []
      validateNode(sub, value, root, path, trial, depth + 1)
      if (trial.length === 0) validCount += 1
      else branchErrors.push(trial[0])
    }
    if (validCount !== 1) {
      pushError(errors, path, 'oneOf', `oneOf 应恰好命中 1 个分支，实际 ${validCount}`, {
        branches: branchErrors.slice(0, 3),
      })
    }
  }
  if (schema.not !== undefined) {
    const trial = []
    validateNode(schema.not, value, root, path, trial, depth + 1)
    if (trial.length === 0) pushError(errors, path, 'not', '命中了不允许的 not 分支')
  }
}

/**
 * Validate one value.
 * @returns {{valid: boolean, errors: Array<{path: string, keyword: string, message: string}>}}
 */
export function validate(schema, value) {
  const errors = []
  validateNode(schema, value, schema, '$', errors, 0)
  return { valid: errors.length === 0, errors }
}

/** Throw a stable error when invalid. */
export function validateOrThrow(schema, value, label = 'value') {
  const result = validate(schema, value)
  if (!result.valid) {
    const error = new Error(`${label} 不符合 schema：${result.errors[0]?.path} ${result.errors[0]?.message}`)
    error.code = 'schema_mismatch'
    error.details = { label, errors: result.errors }
    throw error
  }
  return value
}

/** Check that a schema is an object-root schema in the supported subset. */
/**
 * DSH subagent `outputSchema` accepts a deliberately small JSON Schema subset:
 * type/oneOf/properties/required/additionalProperties/items/enum/const plus
 * annotations. Artifact schemas are full JSON Schema (2020-12) with `$schema`,
 * `$defs` and `format: date`; strip those before handing the schema to a child.
 * Unresolvable `$ref` is rejected rather than silently weakened.
 */
export function sanitizeForSubagent(schema) {
  const allowed = new Set([
    'type', 'oneOf', 'properties', 'required', 'additionalProperties',
    'items', 'enum', 'const', 'title', 'description',
  ])
  const clone = (node, path) => {
    if (Array.isArray(node)) return node.map((item, index) => clone(item, `${path}[${index}]`))
    if (!isPlainObject(node)) return node
    if (typeof node.$ref === 'string') {
      throw new Error(`subagent schema 不支持 $ref：${path}`)
    }
    const out = {}
    for (const [key, value] of Object.entries(node)) {
      if (!allowed.has(key)) continue
      if (key === 'properties' && isPlainObject(value)) {
        out.properties = {}
        for (const [name, child] of Object.entries(value)) out.properties[name] = clone(child, `${path}.properties.${name}`)
        continue
      }
      if (key === 'items') {
        out.items = Array.isArray(value) ? clone(value, `${path}.items`) : clone(value, `${path}.items`)
        continue
      }
      if (key === 'additionalProperties' && isPlainObject(value)) {
        out.additionalProperties = clone(value, `${path}.additionalProperties`)
        continue
      }
      if (key === 'oneOf' && Array.isArray(value)) {
        out.oneOf = value.map((child, index) => clone(child, `${path}.oneOf[${index}]`))
        continue
      }
      out[key] = Array.isArray(value) ? [...value] : value
    }
    return out
  }
  return clone(schema, 'schema')
}

export function assertObjectSchema(schema, label = 'schema') {
  if (!isPlainObject(schema)) {
    throw new Error(`${label} 必须是 JSON Schema 对象`)
  }
  const rootType = schema.type
  if (rootType !== 'object' && !(Array.isArray(rootType) && rootType.includes('object'))) {
    throw new Error(`${label} 的根 type 必须是 object`)
  }
  const errors = []
  lintNode(schema, schema, '$', errors, new Set())
  if (errors.length > 0) {
    const error = new Error(`${label} 含不支持的 schema 构造：${errors[0]}`)
    error.code = 'bad_schema'
    error.details = { label, errors }
    throw error
  }
  return schema
}

function lintNode(node, root, path, errors, seen) {
  if (node === true || node === false) return
  if (!isPlainObject(node)) {
    errors.push(`${path}: schema 节点必须是对象或布尔值`)
    return
  }
  if (seen.has(node)) return
  seen.add(node)
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) errors.push(`${path}: 不支持的 schema 关键字 ${key}`)
  }
  if (node.$ref !== undefined) {
    if (typeof node.$ref !== 'string' || resolvePointer(root, node.$ref) === undefined) {
      errors.push(`${path}: 无法解析 $ref ${String(node.$ref)}`)
    }
    return
  }
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type]
    for (const type of types) {
      if (!KNOWN_TYPES.has(type)) errors.push(`${path}.type: 未知类型 ${String(type)}`)
    }
  }
  if (node.required !== undefined && !Array.isArray(node.required)) errors.push(`${path}.required 必须是数组`)
  if (node.properties !== undefined && !isPlainObject(node.properties)) errors.push(`${path}.properties 必须是对象`)
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean' && !isPlainObject(node.additionalProperties)) {
    errors.push(`${path}.additionalProperties 必须是布尔值或 schema`)
  }
  if (node.items !== undefined && !Array.isArray(node.items) && !isPlainObject(node.items) && typeof node.items !== 'boolean') {
    errors.push(`${path}.items 必须是 schema 或 schema 数组`)
  }
  if (node.enum !== undefined && !Array.isArray(node.enum)) errors.push(`${path}.enum 必须是数组`)
  for (const keyword of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
    if (node[keyword] !== undefined && !Array.isArray(node[keyword])) errors.push(`${path}.${keyword} 必须是数组`)
  }
  for (const keyword of ['properties', 'patternProperties', '$defs', 'definitions']) {
    if (isPlainObject(node[keyword])) {
      for (const [key, child] of Object.entries(node[keyword])) lintNode(child, root, `${path}.${keyword}.${key}`, errors, seen)
    }
  }
  if (isPlainObject(node.items)) lintNode(node.items, root, `${path}.items`, errors, seen)
  if (Array.isArray(node.items)) node.items.forEach((child, index) => lintNode(child, root, `${path}.items[${index}]`, errors, seen))
  for (const keyword of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
    if (Array.isArray(node[keyword])) {
      node[keyword].forEach((child, index) => lintNode(child, root, `${path}.${keyword}[${index}]`, errors, seen))
    }
  }
  if (isPlainObject(node.additionalProperties)) lintNode(node.additionalProperties, root, `${path}.additionalProperties`, errors, seen)
  if (node.not !== undefined) lintNode(node.not, root, `${path}.not`, errors, seen)
}

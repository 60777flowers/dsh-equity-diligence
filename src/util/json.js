import { createHash, randomUUID } from 'node:crypto'

/** Error carrying a stable machine code and optional details. */
export class EquityError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'EquityError'
    this.code = code
    this.details = details
  }
}

/** JSON-safe clone that also drops undefined object members. */
export function jsonClone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

/** Sort object keys recursively so equal data always hashes equally. */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (value instanceof Date) return value.toISOString()
  const out = {}
  for (const key of Object.keys(value).sort()) {
    const item = value[key]
    if (item === undefined) continue
    if (typeof item === 'number' && !Number.isFinite(item)) {
      out[key] = null
      continue
    }
    out[key] = canonicalize(item)
  }
  return out
}

/** Canonical JSON text; stable across key insertion order. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

/** sha256 of a string or Buffer. */
export function sha256(input) {
  const hash = createHash('sha256')
  hash.update(input)
  return 'sha256:' + hash.digest('hex')
}

/** Semantic data hash of a JSON value. */
export function semanticHash(value) {
  return sha256(canonicalJson(value))
}

/** Presentation hash of rendered text. */
export function presentationHash(text) {
  return sha256(String(text ?? ''))
}

/** Short hash for display and file names. */
export function shortHash(value, length = 8) {
  const text = typeof value === 'string' ? value : canonicalJson(value)
  return createHash('sha256').update(text).digest('hex').slice(0, length)
}

/** New opaque id with a stable prefix. */
export function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 24)}`
}

/** Parse JSON with a useful error code. */
export function parseJson(text, source = 'json') {
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new EquityError('invalid_json', `${source} 不是合法 JSON：${error.message}`, { source })
  }
}

/** Return the value when it is a plain object (not an array or null). */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Merge arrays without duplicates, preserving first occurrence order. */
export function unique(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const key = typeof value === 'string' ? value : canonicalJson(value)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/** Ensure a value is an array. */
export function asArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** Deterministic string comparison for stable sorts. */
export function compareText(a, b) {
  return String(a).localeCompare(String(b), 'zh-Hans-CN')
}

/** Pick defined fields only. */
export function pick(object, keys) {
  const out = {}
  for (const key of keys) {
    if (object[key] !== undefined) out[key] = object[key]
  }
  return out
}

/** Omit listed fields. */
export function omit(object, keys) {
  const drop = new Set(keys)
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (!drop.has(key)) out[key] = value
  }
  return out
}

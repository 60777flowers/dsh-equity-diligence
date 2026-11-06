import test from 'node:test'
import assert from 'node:assert/strict'

import { loadLibrary } from '../src/kernel/registry.js'
import { sanitizeForSubagent } from '../src/util/schema.js'

const ALLOWED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'title', 'description'])

function assertSubset(node, path = 'schema') {
  if (node === null || typeof node !== 'object') return
  assert.ok(!Array.isArray(node), `${path} should not be an array`)
  for (const [key, value] of Object.entries(node)) {
    assert.ok(ALLOWED.has(key), `${path}.${key} is outside the subagent subset`)
    if (key === 'properties') {
      for (const [name, child] of Object.entries(value)) assertSubset(child, `${path}.properties.${name}`)
    } else if (key === 'items' || key === 'additionalProperties') {
      assertSubset(value, `${path}.${key}`)
    } else if (key === 'oneOf') {
      value.forEach((child, index) => assertSubset(child, `${path}.oneOf[${index}]`))
    }
  }
}

test('schema: every artifact schema is reduced to the subagent output subset', async () => {
  const library = await loadLibrary({ strict: true })
  for (const type of library.typeList) {
    const sanitized = sanitizeForSubagent(type.schema)
    assertSubset(sanitized, type.id)
    assert.equal(sanitized.type, 'object')
    assert.ok(sanitized.properties)
    assert.equal(sanitized.$schema, undefined)
    assert.equal(sanitized.$defs, undefined)
    assert.equal(sanitized.properties.asOf.format, undefined)
  }
})

test('schema: unresolvable $ref is rejected instead of silently weakened', () => {
  assert.throws(
    () => sanitizeForSubagent({ type: 'object', properties: { a: { $ref: '#/$defs/x' } } }),
    /不支持 \$ref/,
  )
})

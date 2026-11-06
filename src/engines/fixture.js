import { join } from 'node:path'

import { EquityError } from '../util/json.js'
import { readJson } from '../util/fs.js'
import { today } from '../util/time.js'

/**
 * Offline executor used by golden tests and demos. It reads a deterministic
 * JSON file per unit and never touches the network.
 */
export class FixtureExecutor {
  constructor({ fixtureDir, library }) {
    this.name = 'fixture'
    this.fixtureDir = fixtureDir
    this.library = library
  }

  async execute({ step, unit }) {
    const candidates = [
      join(this.fixtureDir, 'module-outputs', `${step.instanceId}__${unit.subjectId}.json`),
      join(this.fixtureDir, 'module-outputs', `${step.instanceId}.json`),
      join(this.fixtureDir, 'module-outputs', `${step.moduleId.split('/').pop()}.json`),
      join(this.fixtureDir, 'module-outputs', `${unit.subjectId}__${step.instanceId}.json`),
    ]
    for (const file of candidates) {
      const data = await readJson(file, null)
      if (data) return normalizeFixture(data, step, unit)
    }
    if (this.fixtureDir) {
      throw new EquityError('fixture_missing', `缺少 fixture：${candidates[0]}`)
    }
    return normalizeFixture(sampleOutput(step, unit, this.library), step, unit)
  }
}

function normalizeFixture(data, step, unit) {
  if (Array.isArray(data?.artifacts)) {
    return {
      artifacts: data.artifacts.map((item) => ({
        type: item.type ?? step.outputs?.[0]?.type,
        subjectId: item.subjectId ?? unit.subjectId,
        partitionKey: item.partitionKey ?? unit.partitionKey ?? '_default',
        period: item.period,
        output: item.output ?? item,
      })),
      tokens: data.tokens ?? 0,
      toolCalls: data.toolCalls ?? 0,
      searches: data.searches ?? [],
    }
  }
  const output = data.output ?? data
  return {
    artifacts: [{
      type: data.type ?? step.outputs?.[0]?.type,
      subjectId: data.subjectId ?? unit.subjectId,
      partitionKey: data.partitionKey ?? unit.partitionKey ?? '_default',
      period: data.period,
      output,
    }],
    tokens: data.tokens ?? 0,
    toolCalls: data.toolCalls ?? 0,
    searches: data.searches ?? [],
  }
}

/** Minimal schema-shaped output for structural tests where no fixture exists. */
export function sampleOutput(step, unit, library) {
  const type = step.outputs?.[0]?.type
  const meta = library.types.get(type)
  const data = sampleValue(meta?.schema?.properties?.data ?? { type: 'object', additionalProperties: true }, 0)
  if (data && typeof data === 'object' && !Array.isArray(data)) data.mode = data.mode ?? undefined
  return {
    asOf: unit.asOf ?? today(),
    openQuestions: [],
    flags: [],
    sourceCoverage: { queries: [], databases: [], retrievedAt: new Date().toISOString(), limitations: ['fixture sample'] },
    claims: [],
    evidence: [],
    data: data ?? {},
  }
}

function sampleValue(schema, depth) {
  if (!schema || depth > 4) return null
  if (schema.$ref) return null
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (schema.type === 'object' || schema.properties) {
    const out = {}
    for (const key of schema.required ?? []) {
      const child = schema.properties?.[key] ?? { type: 'string' }
      out[key] = sampleValue(child, depth + 1)
    }
    if (schema.properties) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (out[key] !== undefined) continue
        if (key === 'mode' && child.const) out[key] = child.const
      }
    }
    return out
  }
  if (schema.type === 'array') return []
  if (schema.type === 'integer' || schema.type === 'number') return 0
  if (schema.type === 'boolean') return false
  if (schema.type === 'null') return null
  return 'sample'
}

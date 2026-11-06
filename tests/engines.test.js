import test from 'node:test'
import assert from 'node:assert/strict'

import { NativeResearchExecutor, extractJsonObject } from '../src/engines/native-loop.js'
import { PrivateAgentExecutor } from '../src/engines/private-agent.js'
import { freshLibrary, readFixture } from './helpers/common.js'

test('native-loop: parses JSON actions and extracts a fenced object', () => {
  assert.deepEqual(extractJsonObject('```json\n{"action":"search","query":"x"}\n```'), { action: 'search', query: 'x' })
  assert.deepEqual(extractJsonObject('prefix {"action":"final","result":{"a":1}} suffix'), { action: 'final', result: { a: 1 } })
  assert.equal(extractJsonObject('no json'), null)
})

test('native-loop: forces a final artifact when the step budget is exhausted', async () => {
  const library = await freshLibrary()
  const module = library.modules.get('builtin/entity-resolution')
  let calls = 0
  const ctx = {
    llm: {
      stream() {
        calls += 1
        const text = calls <= 4
          ? '{"action":"search","query":"example query","maxResults":2}'
          : JSON.stringify({
              action: 'final',
              result: {
                asOf: '2026-09-30',
                openQuestions: [],
                flags: [],
                sourceCoverage: { queries: [{ query: 'example query', outcome: 'ok' }], databases: [], retrievedAt: '2026-11-07T00:00:00+08:00', limitations: [] },
                claims: [],
                evidence: [],
                data: {
                  legalName: 'Example Technology Co., Ltd.',
                  code: '91310000MA1FL00000',
                  aliases: [],
                  domicile: { country: '中国', city: '上海' },
                  status: '存续',
                  identifiers: [],
                  branches: [],
                  controllingPerson: { status: 'not_disclosed_after_search', value: '未提供', note: '示例' },
                },
              },
            })
        return (async function* () {
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'usage', usage: { totalTokens: 10 } }
          yield { type: 'finish', reason: 'stop' }
        })()
      },
    },
  }
  const source = {
    signal: null,
    async search(query) {
      return {
        ok: true,
        query,
        sources: [{ url: 'https://example.com/1', title: '示例', snippet: 'snippet', sourceTier: 'registry' }],
        attempt: { query, engine: 'web', at: new Date().toISOString(), resultCount: 1, outcome: 'ok' },
      }
    },
    async fetch() { throw new Error('not used') },
    async fetchPdf() { throw new Error('not used') },
  }
  const executor = new NativeResearchExecutor({
    ctx,
    source,
    config: { provider: 'fake', model: 'fake', library },
  })
  const outcome = await executor.execute({
    module: { ...module, manifest: { ...module.manifest, budget: { toolCallsPerUnit: 4 } } },
    step: { outputs: [{ type: 'company.identity' }] },
    prompt: { text: 'task', system: 'system' },
    signal: undefined,
    onEvent: async () => {},
  })
  assert.equal(calls, 5)
  assert.equal(outcome.artifacts.length, 1)
  assert.equal(outcome.artifacts[0].type, 'company.identity')
  assert.equal(outcome.artifacts[0].output.data.legalName, 'Example Technology Co., Ltd.')
  assert.ok(outcome.toolCalls >= 1)
})

test('native-loop: a hung model stream is aborted by the per-call timeout', async () => {
  const library = await freshLibrary()
  const module = library.modules.get('builtin/entity-resolution')
  const ctx = {
    llm: {
      stream({ signal }) {
        return (async function* () {
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        })()
      },
    },
  }
  const executor = new NativeResearchExecutor({
    ctx,
    source: { signal: null, async search() { return { ok: true, sources: [], attempt: {} } } },
    config: { provider: 'fake', model: 'fake', library, modelTimeoutMs: 20 },
  })
  await assert.rejects(
    () => executor.execute({
      module,
      step: { instanceId: 'entity-resolution', outputs: [{ type: 'company.identity' }] },
      prompt: { text: 'task', system: 'system' },
      signal: undefined,
      onEvent: async () => {},
    }),
    (error) => error.code === 'model_timeout',
  )
})

test('private-agent: passes a sanitized output schema to the child and records its artifact', async () => {
  const library = await freshLibrary()
  const module = library.modules.get('builtin/entity-resolution')
  const fixture = await readFixture('golden-zhongji/module-outputs/entity-resolution.json')
  const output = {
    ...fixture,
    claims: [],
    evidence: [{
      evidenceId: 'ev_test',
      url: 'https://example.com/source',
      quote: '示例原文',
      sourceTier: 'registry',
      verificationStatus: 'unverified',
    }],
  }
  let spec
  const ctx = {
    subagents: {
      async startActivation(input) {
        spec = input
        return {
          childId: 'child_test',
          async dispose() {},
          result: Promise.resolve({ stopReason: 'completed', structured: output }),
        }
      },
    },
  }
  const executor = new PrivateAgentExecutor({
    ctx,
    source: {
      async fetch() {
        return { ok: true, finalUrl: 'https://example.com/source', url: 'https://example.com/source', text: '前文 示例原文 后文', rawHash: 'sha256:test', truncated: false, sourceTier: 'registry' }
      },
    },
    agent: { options: {} },
    config: { library, cwd: process.cwd() },
  })
  const result = await executor.execute({
    module,
    step: { instanceId: 'entity-resolution', outputs: [{ type: 'company.identity' }] },
    prompt: { text: 'task', system: 'system' },
    signal: new AbortController().signal,
    onEvent: async () => {},
  })
  assert.equal(result.artifacts.length, 1)
  assert.equal(result.artifacts[0].output.data.legalName, fixture.data.legalName)
  assert.equal(result.artifacts[0].output.evidence[0].verification.method, 'quote-exact')
  assert.ok(spec.request.outputSchema)
  assert.equal(spec.request.outputSchema.$schema, undefined)
  assert.equal(spec.request.outputSchema.$defs, undefined)
  assert.equal(spec.request.outputSchema.properties.asOf.format, undefined)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'

import { EquityService } from '../src/service.js'
import { PRESET_NAMES, loadPreset } from '../src/kernel/registry.js'
import { registerTools } from '../src/tools.js'
import { registerWebApi } from '../src/web-api.js'
import { tempDir, cleanup, setTestHome } from './helpers/common.js'

async function setup() {
  setTestHome()
  const svc = new EquityService({ ctx: { web: null, llm: null, subagents: null }, config: { executor: 'fixture' } })
  await svc.init()
  const tools = []
  registerTools({ ctx: { tools: { register: (definition) => { tools.push(definition); return () => {} } } }, service: svc })
  const routes = []
  registerWebApi({ ctx: { connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } } }, service: svc })
  return { svc, tools: Object.fromEntries(tools.map((tool) => [tool.name, tool])), routes }
}

/** Minimal HTTP client over the registered Fetch routes. */
function httpClient(routes) {
  const routeFor = (path, method) => {
    const url = new URL(path, 'http://localhost')
    const route = routes.find((candidate) => candidate.path === url.pathname && candidate.methods.includes(method))
    assert.ok(route, `${method} ${path}`)
    return { url, route }
  }
  const respond = async (url, route, options) => {
    const response = await route.fetch(options ? new Request(url, options) : new Request(url))
    return { status: response.status, body: await response.json() }
  }
  return {
    get(path) {
      const { url, route } = routeFor(path, 'GET')
      return respond(url, route)
    },
    post(path, body) {
      const { url, route } = routeFor(path, 'POST')
      return respond(url, route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
  }
}

/** Register the web API against a stub service; returns its routes. */
function mockWebApi(service, options = {}) {
  const routes = []
  registerWebApi({
    ctx: { connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } } },
    service,
    ...options,
  })
  return routes
}

function uniqueOutsidePath(label) {
  return join(tmpdir(), `${label}-${randomUUID().slice(0, 8)}`)
}

test('tools + API: create, compile, run, deliver through the same service', async (t) => {
  const { svc, tools, routes } = await setup()
  for (const path of ['/api/equity/run', '/api/equity/artifact', '/api/equity/evidence', '/api/equity/deliver']) {
    assert.ok(routes.some((route) => route.path === path), `missing route ${path}`)
  }
  const root = tempDir('tools-api')
  t.after(() => cleanup(root))
  const created = await tools.equity_project.execute({ action: 'create', target: '示例科技', root, preset: 'skill-only', asOf: '2026-09-30' }, {})
  assert.equal(created.ok, true)
  const projectId = created.projectId
  const compiled = await tools.equity_playbook.execute({ action: 'compile', projectId }, {})
  assert.equal(compiled.ok, true)
  assert.equal(compiled.plan.steps.length, 4)
  const run = await tools.equity_run.execute({ action: 'start', projectId, executor: 'fixture', wait: true }, {})
  assert.equal(run.ok, true)
  assert.equal(run.status, 'completed')
  const delivery = await tools.equity_deliver.execute({ action: 'build', projectId }, {})
  assert.equal(delivery.ok, true)
  assert.equal(delivery.qa.passed, true)

  // User-only review action is rejected through the agent tool.
  await assert.rejects(
    () => tools.equity_review.execute({ action: 'decide', projectId, issueId: 'iss_x', decision: 'accept' }, {}),
    (error) => error.code === 'user_only',
  )

  // API routes share the same state.
  const get = async (path) => {
    const url = new URL(path, 'http://localhost')
    const route = routes.find((candidate) => candidate.path === url.pathname && candidate.methods.includes('GET'))
    assert.ok(route, path)
    return (await route.fetch(new Request(url))).json()
  }
  const post = async (path, body) => {
    const url = new URL(path, 'http://localhost')
    const route = routes.find((candidate) => candidate.path === url.pathname && candidate.methods.includes('POST'))
    assert.ok(route, path)
    return (await route.fetch(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json()
  }
  // A build alone is not "delivery ready": the user channel must sign off.
  const signed = await post('/api/equity/review', {
    projectId,
    action: 'signoff',
    preparedBy: 'tester',
    reviewedBy: 'tester',
    approvedBy: 'tester',
    note: '自动化测试用户签发',
  })
  assert.equal(signed.ok, true, JSON.stringify(signed))
  const projects = await get('/api/equity/projects')
  assert.ok(projects.projects.some((project) => project.projectId === projectId))
  const state = await get(`/api/equity/state?projectId=${encodeURIComponent(projectId)}`)
  assert.equal(state.ok, true)
  assert.equal(state.state.readiness.deliveryReady, true)
  const fileUrl = new URL(`http://localhost/api/equity/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent('01_管理层摘要.md')}`)
  const fileRoute = routes.find((candidate) => candidate.path === fileUrl.pathname && candidate.methods.includes('GET'))
  const fileResponse = await fileRoute.fetch(new Request(fileUrl))
  assert.equal(fileResponse.status, 200)
  assert.ok((await fileResponse.text()).includes('# 示例科技'))
  const modules = await get('/api/equity/modules')
  assert.equal(modules.modules.length, 25)

  const artifactId = state.state.artifacts.find((artifact) => artifact.type === 'company.identity').id
  const artifact = await get(`/api/equity/artifact?projectId=${encodeURIComponent(projectId)}&artifactId=${encodeURIComponent(artifactId)}`)
  assert.equal(artifact.ok, true)
  assert.ok(artifact.claims.length >= 2)
  assert.ok(artifact.evidence.length >= 2)
})

test('tools: undefined snapshot fields are removed before the JSON boundary', async () => {
  const defs = []
  const service = {
    async state() {
      return {
        project: { projectId: 'p_test' },
        runs: [{ runId: 'r1', status: 'partial', budget: undefined }],
        counts: { total: 0, byStatus: {} },
        stale: [],
        issues: [],
        readiness: {},
      }
    },
  }
  registerTools({ ctx: { tools: { register: (definition) => { defs.push(definition); return () => {} } } }, service })
  const projectTool = defs.find((definition) => definition.name === 'equity_project')
  const value = await projectTool.execute({ action: 'status', projectId: 'p_test' }, {})
  assert.equal(value.ok, true)
  assert.equal(Object.hasOwn(value.runs[0], 'budget'), false)
  assert.equal(value.project.projectId, 'p_test')
})

test('client bundle: registers main, sidebar and turn-tail slots', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8')
  let loaded
  class Component {
    constructor(props) { this.props = props ?? {}; this.state = {} }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
  }
  const React = {
    Component,
    createElement: () => ({}),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (factory) => factory,
  }
  const registrations = []
  const ctx = {
    slots: {
      inject: (name, callback) => { callback() },
      register: (options) => { registrations.push(options); return () => {} },
    },
  }
  const sandbox = {
    window: { __DSH_EQUITY_TEST__: true, __ModuleLoader__: { load: (module) => { loaded = module } } },
    console,
    setTimeout,
    clearInterval,
    setInterval,
    fetch: async () => ({ ok: true, text: async () => '{}' }),
    navigator: { clipboard: { writeText: () => {} } },
    document: { title: '' },
    require: (name) => {
      if (name === 'react') return React
      throw new Error(`unknown module ${name}`)
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const api = loaded.factory(sandbox.require)
  api.apply(ctx)
  assert.deepEqual(registrations.map((item) => item.name), ['main', 'sidebar.panellist', 'conversation.chat.turnTail'])
  assert.equal(registrations[0].key, 'equity')
  assert.equal(registrations[1].id, 'equity')
  assert.equal(typeof api.__test.DeliveryView, 'function')
  assert.equal(typeof api.__test.ErrorBoundary, 'function')
})

// ---------------------------------------------------------------------------
// D1 HTTP boundary: project roots, preset allow-list, write authority
// ---------------------------------------------------------------------------

test('web api: project create root stays inside the workspace and writes nothing on traversal', async (t) => {
  setTestHome()
  const workspace = tempDir('api-root-ws')
  const outside = uniqueOutsidePath('equity-outside')
  const escapeName = `escaped-${randomUUID().slice(0, 8)}`
  const svc = new EquityService({ ctx: { web: null, llm: null, subagents: null }, config: { executor: 'fixture', workspaceRoot: workspace } })
  await svc.init()
  const http = httpClient(mockWebApi(svc))
  t.after(async () => { await cleanup(workspace); await cleanup(outside) })

  const relativeEscape = await http.post('/api/equity/project', { action: 'create', target: '边界测试甲', root: `../${escapeName}`, preset: 'skill-only' })
  assert.equal(relativeEscape.status, 400)
  assert.equal(relativeEscape.body.error.code, 'invalid_root')
  assert.equal(existsSync(resolve(workspace, '..', escapeName)), false)

  const absoluteEscape = await http.post('/api/equity/project', { action: 'create', target: '边界测试乙', root: outside, preset: 'skill-only' })
  assert.equal(absoluteEscape.status, 403)
  assert.equal(absoluteEscape.body.error.code, 'forbidden_root')
  assert.equal(existsSync(outside), false)

  const mixedEscape = await http.post('/api/equity/project', { action: 'create', target: '边界测试丙', root: `nested/../../${escapeName}`, preset: 'skill-only' })
  assert.equal(mixedEscape.status, 400)
  assert.equal(mixedEscape.body.error.code, 'invalid_root')

  // The rejected calls wrote no project artifacts anywhere.
  assert.equal(existsSync(join(workspace, 'project.json')), false)
  assert.equal(existsSync(resolve(workspace, '..', escapeName)), false)

  // An absolute path already inside the workspace is still accepted.
  const insideRoot = join(workspace, 'inside-absolute')
  const inside = await http.post('/api/equity/project', { action: 'create', target: '边界测试丁', root: insideRoot, preset: 'skill-only' })
  assert.equal(inside.status, 200, JSON.stringify(inside.body))
  assert.equal(inside.body.ok, true)
  assert.equal(existsSync(join(insideRoot, 'project.json')), true)
})

test('web api: preset names are a fixed allow-list (path traversal rejected)', async (t) => {
  setTestHome()
  const workspace = tempDir('api-preset-ws')
  const svc = new EquityService({ ctx: { web: null, llm: null, subagents: null }, config: { executor: 'fixture', workspaceRoot: workspace } })
  await svc.init()
  const http = httpClient(mockWebApi(svc))
  t.after(async () => { await cleanup(workspace) })

  const goodRoot = join(workspace, 'preset-ok')
  const created = await http.post('/api/equity/project', { action: 'create', target: '预设测试', root: goodRoot, preset: 'skill-only' })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const projectId = created.body.project.projectId

  const badRoot = join(workspace, 'preset-bad')
  for (const preset of ['../../outside', '..\\..\\outside', 'quick.yaml', 'standard/../deep', '/etc/passwd']) {
    const response = await http.post('/api/equity/project', { action: 'create', target: '预设测试二', root: badRoot, preset })
    assert.equal(response.status, 400, preset)
    assert.equal(response.body.error.code, 'bad_preset', preset)
  }
  assert.equal(existsSync(join(badRoot, 'project.json')), false)

  const applied = await http.post('/api/equity/playbook', { action: 'apply', projectId, preset: '../outside' })
  assert.equal(applied.status, 400)
  assert.equal(applied.body.error.code, 'bad_preset')

  // The registry refuses non-preset names too, including the old `.yaml` fallback.
  for (const preset of ['../../outside', 'quick.yaml', 'unknown', undefined]) {
    await assert.rejects(() => loadPreset(preset), (error) => error.code === 'preset_missing', String(preset))
  }
  for (const name of PRESET_NAMES) {
    const playbook = await loadPreset(name)
    assert.ok(playbook.modules.length > 0, name)
  }
})

test('web api: project create strips overwrite/playbook/clientProfileText and unknown fields', async (t) => {
  setTestHome()
  const workspace = tempDir('api-whitelist-ws')
  const svc = new EquityService({ ctx: { web: null, llm: null, subagents: null }, config: { executor: 'fixture', workspaceRoot: workspace } })
  await svc.init()
  const http = httpClient(mockWebApi(svc))
  t.after(async () => { await cleanup(workspace) })

  const root = join(workspace, 'whitelist')
  const payload = {
    action: 'create',
    target: '白名单测试',
    root,
    preset: 'skill-only',
    overwrite: true,
    workspaceRoot: 'C:\\Windows',
    playbook: join(workspace, 'attacker-playbook.yaml'),
    clientProfileText: '# PWNED-BY-HTTP',
    projectId: 'eq_hijack',
    name: 'hijacked-name',
    budget: { maxTokens: 1 },
    unknownField: 'x',
  }
  const first = await http.post('/api/equity/project', payload)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const profile = await readFile(join(root, '00_基准', '委托方背景.md'), 'utf8')
  assert.equal(profile.includes('PWNED-BY-HTTP'), false)
  const manifest = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'))
  assert.equal(manifest.root, resolve(root))
  assert.notEqual(manifest.projectId, 'eq_hijack')
  assert.notEqual(manifest.name, 'hijacked-name')
  assert.equal(manifest.budget.maxTokens, 80_000_000)

  // `overwrite:true` was stripped, so a second create hits the kernel guard.
  const second = await http.post('/api/equity/project', payload)
  assert.equal(second.status, 400)
  assert.equal(second.body.error.code, 'project_exists')
})

test('web api: create forwards only the whitelisted fields to the service', async () => {
  setTestHome()
  const workspace = tempDir('api-mock-ws')
  const calls = []
  const service = {
    config: { workspaceRoot: workspace },
    async createProject(options) {
      calls.push(options)
      return { projectId: 'eq_mock', root: options.root, workspaceRoot: options.workspaceRoot }
    },
  }
  const http = httpClient(mockWebApi(service))
  const response = await http.post('/api/equity/project', {
    action: 'create',
    target: 'X',
    targets: [{ name: 'X' }],
    code: '300308',
    identifiers: [{ scheme: 'CN_USCC', value: '9137' }],
    preset: 'quick',
    asOf: '2026-11-07',
    clientName: '委托方A',
    currency: 'CNY',
    executor: 'fixture',
    root: 'inside',
    overwrite: true,
    playbook: '/etc/passwd',
    clientProfileText: 'x',
    workspaceRoot: 'C:\\Windows',
    projectId: 'eq_hack',
    name: 'hacked',
    budget: { maxTokens: 1 },
    foo: 'bar',
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(calls.length, 1)
  const options = calls[0]
  assert.deepEqual(Object.keys(options).sort(), [
    'asOf', 'clientName', 'code', 'currency', 'executor', 'identifiers', 'preset', 'root', 'target', 'targets', 'workspaceRoot',
  ].sort())
  assert.equal(options.root, resolve(workspace, 'inside'))
  assert.equal(options.workspaceRoot, resolve(workspace))
  assert.equal(options.preset, 'quick')
  for (const key of ['overwrite', 'playbook', 'clientProfileText', 'projectId', 'name', 'budget', 'foo']) {
    assert.equal(Object.hasOwn(options, key), false, key)
  }

  const before = calls.length
  const traversal = await http.post('/api/equity/project', { action: 'create', target: 'X', root: '../../etc' })
  assert.equal(traversal.status, 400)
  const outside = await http.post('/api/equity/project', { action: 'create', target: 'X', root: uniqueOutsidePath('equity-mock-outside') })
  assert.equal(outside.status, 403)
  const badPreset = await http.post('/api/equity/project', { action: 'create', target: 'X', preset: '../quick' })
  assert.equal(badPreset.status, 400)
  assert.equal(calls.length, before)
})

test('web api: record is agent/draft only and cannot self-verify', async () => {
  const calls = []
  const service = {
    async record(projectId, payload) {
      calls.push({ projectId, payload })
      return { kind: 'artifact', artifact: { id: 'art_1' } }
    },
  }
  const http = httpClient(mockWebApi(service))

  const human = await http.post('/api/equity/record', { projectId: 'p1', type: 'company.identity', data: {}, actor: 'human' })
  assert.equal(human.status, 403)
  assert.equal(human.body.error.code, 'user_only')

  const verified = await http.post('/api/equity/record', { projectId: 'p1', type: 'company.identity', data: {}, status: 'verified' })
  assert.equal(verified.status, 403)
  assert.equal(verified.body.error.code, 'user_only')

  const stale = await http.post('/api/equity/record', { projectId: 'p1', type: 'company.identity', data: {}, status: 'stale' })
  assert.equal(stale.status, 400)
  assert.equal(stale.body.error.code, 'bad_status')

  const system = await http.post('/api/equity/record', { projectId: 'p1', type: 'company.identity', data: {}, actor: 'system' })
  assert.equal(system.status, 400)
  assert.equal(system.body.error.code, 'bad_actor')

  assert.deepEqual(calls, [])

  const ok = await http.post('/api/equity/record', {
    projectId: 'p1',
    kind: 'artifact',
    type: 'company.identity',
    subjectId: 'co_x',
    data: { legalName: 'X' },
    claims: [],
    evidence: [],
    actor: 'agent',
    status: 'draft',
    unknownField: 'nope',
  })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].projectId, 'p1')
  assert.equal(calls[0].payload.actor, 'agent')
  assert.equal(calls[0].payload.status, 'draft')
  assert.equal(calls[0].payload.subjectId, 'co_x')
  for (const key of ['projectId', 'unknownField']) {
    assert.equal(Object.hasOwn(calls[0].payload, key), false, key)
  }

  // Omitting actor/status also defaults to agent/draft.
  const defaults = await http.post('/api/equity/record', { projectId: 'p2', type: 'company.identity', data: {} })
  assert.equal(defaults.status, 200)
  assert.equal(calls[1].payload.actor, 'agent')
  assert.equal(calls[1].payload.status, 'draft')
})

test('web api: signoff goes through the user channel (actor=user), never agent', async () => {
  const calls = []
  const service = {
    async signoff(projectId, payload, options) {
      calls.push({ projectId, payload, options })
      return { ok: true, signoff: { signedAt: 'server-time' }, artifact: { id: 'art_1' } }
    },
  }
  const http = httpClient(mockWebApi(service))
  const response = await http.post('/api/equity/review', {
    projectId: 'p1',
    action: 'signoff',
    preparedBy: 'A',
    signedAt: '1999-01-01T00:00:00Z',
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].options, { actor: 'user' })
  // Timestamps are server-generated; client values are stripped before the service.
  assert.equal(Object.hasOwn(calls[0].payload, 'signedAt'), false)
  // The route echoes the server-produced signoff, not client timestamps.
  assert.equal(response.body.signoff.signedAt, 'server-time')
  assert.equal(response.body.artifact.id, 'art_1')
})

test('web api: archive rejects a filesystem path outside the workspace', async () => {
  const calls = []
  const service = {
    async archiveProject(target) {
      calls.push(target)
      return { projectId: 'eq_1', status: 'archived' }
    },
  }
  const workspace = tempDir('api-archive-ws')
  const http = httpClient(mockWebApi(service, { workspaceRoot: workspace }))

  const outside = await http.post('/api/equity/project', { action: 'archive', projectId: uniqueOutsidePath('equity-archive-outside') })
  assert.equal(outside.status, 403)
  assert.equal(outside.body.error.code, 'forbidden_root')
  assert.deepEqual(calls, [])

  const ok = await http.post('/api/equity/project', { action: 'archive', projectId: 'eq_123' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.deepEqual(calls, ['eq_123'])
})

test('web api: migrate validates the effective project root, including projectId-shaped targets', async () => {
  const calls = []
  const service = {
    async migrate(target, options) {
      calls.push({ target, options })
      return { ok: true, migrated: 1 }
    },
  }
  const workspace = tempDir('api-migrate-ws')
  const http = httpClient(mockWebApi(service, { workspaceRoot: workspace }))

  const indexed = await http.post('/api/equity/project', { action: 'migrate', projectId: 'eq_123', dryRun: true })
  assert.equal(indexed.status, 200, JSON.stringify(indexed.body))
  assert.equal(calls.at(-1).target, 'eq_123')

  // service.migrate treats any non-`eq_` string as a filesystem root, so a
  // projectId-shaped field must not smuggle an arbitrary path past the check.
  const forged = await http.post('/api/equity/project', { action: 'migrate', projectId: uniqueOutsidePath('equity-migrate-outside') })
  assert.equal(forged.status, 403)
  assert.equal(forged.body.error.code, 'forbidden_root')
  const traversal = await http.post('/api/equity/project', { action: 'migrate', projectId: '../escape' })
  assert.equal(traversal.status, 400)
  assert.equal(traversal.body.error.code, 'invalid_root')
  assert.equal(calls.length, 1)
})

test('web api: deliver verify is explicit when unsupported and never silently rebuilds', async () => {
  const calls = []
  const service = {
    async deliver(projectId, action) {
      calls.push({ projectId, action })
      return { ok: true }
    },
  }
  const http = httpClient(mockWebApi(service))

  const verify = await http.post('/api/equity/deliver', { projectId: 'p1', action: 'verify' })
  assert.equal(verify.status, 501)
  assert.equal(verify.body.error.code, 'unsupported')
  assert.deepEqual(calls, []) // did not fall back to build

  const built = await http.post('/api/equity/deliver', { projectId: 'p1', action: 'build' })
  assert.equal(built.status, 200)
  assert.deepEqual(calls, [{ projectId: 'p1', action: 'build' }])

  const bad = await http.post('/api/equity/deliver', { projectId: 'p1', action: 'rebuild-all' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'bad_action')
  assert.equal(calls.length, 1)

  const verifyCalls = []
  const verifyingService = {
    async deliver() { throw new Error('verify must not call deliver/build') },
    async verifyDelivery(projectId, options) {
      verifyCalls.push({ projectId, options })
      return { ok: true, qa: { passed: true, blocking: [], warnings: [] } }
    },
  }
  const http2 = httpClient(mockWebApi(verifyingService))
  const verified = await http2.post('/api/equity/deliver', { projectId: 'p9', action: 'verify', template: 'deep', bogus: 'x' })
  assert.equal(verified.status, 200, JSON.stringify(verified.body))
  assert.deepEqual(verifyCalls, [{ projectId: 'p9', options: { template: 'deep' } }])
})

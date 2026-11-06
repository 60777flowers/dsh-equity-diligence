import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

import { EquityService } from '../src/service.js'
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

test('client bundle: registers main, sidebar and turn-tail slots', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8')
  let loaded
  const React = {
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
    window: { __ModuleLoader__: { load: (module) => { loaded = module } } },
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
})

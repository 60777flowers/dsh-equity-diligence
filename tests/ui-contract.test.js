import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

const source = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8')

const Fragment = Symbol('Fragment')

function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children } }
}

/** Depth-first text extraction from the stub React element tree. */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (typeof node === 'object' && node.props) {
    // Inline function components (Empty/Section/Icon/...) so their text lands
    // in the tree without a full React renderer.
    if (typeof node.type === 'function') {
      textOf(node.type(node.props), out)
      return out
    }
    textOf(node.props.children, out)
  }
  return out
}

function loadClient(testHooks = true) {
  class Component {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }
    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
    }
  }
  const React = {
    Component,
    Fragment,
    createElement,
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (factory) => factory,
  }
  let loaded
  const sandbox = {
    window: {
      ...(testHooks ? { __DSH_EQUITY_TEST__: true } : {}),
      __ModuleLoader__: { load: (module) => { loaded = module } },
    },
    console,
    setTimeout,
    clearInterval,
    setInterval,
    fetch: async () => ({ ok: false, status: 401, text: async () => '{}' }),
    navigator: { clipboard: { writeText: () => {} } },
    document: { title: '' },
    require: (name) => {
      if (name === 'react') return React
      throw new Error(`unknown module ${name}`)
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return loaded.factory(sandbox.require)
}

const { __test: { DeliveryView, ErrorBoundary, qaSummary, toQaItems } } = loadClient()

function deliveryState(qa, { deliverable = true } = {}) {
  return {
    project: { projectId: 'eq_test', name: '测试项目', engagement: { asOf: '2026-11-07' } },
    deliverable: deliverable
      ? {
          id: 'art_deliverable',
          type: 'report.deliverable',
          status: 'draft',
          data: {
            generatedAt: '2026-11-07T10:00:00+08:00',
            files: [{ path: '01_管理层摘要.md', sha256: 'sha256:abcdef0123456789', kind: 'summary', size: 2048 }],
            qa,
          },
        }
      : null,
  }
}

function renderDelivery(qa, options = {}) {
  return DeliveryView({
    state: deliveryState(qa, options),
    onAction: async () => {},
    busy: false,
    toast: () => {},
  })
}

test('client delivery view: numeric qa counts (legacy service shape) render without throwing', () => {
  let tree
  assert.doesNotThrow(() => { tree = renderDelivery({ blocking: 2, warnings: 1, passed: false }) })
  const text = textOf(tree).join(' ')
  assert.match(text, /QA 阻断 2 项/)
  assert.match(text, /警告 1 项/)
  // Counts are preserved even though the server did not send item details.
  assert.equal(qaSummary({ blocking: 2, warnings: 1 }).blockingCount, 2)
  assert.equal(qaSummary({ blocking: 2, warnings: 1 }).blocking.length, 2)
})

test('client delivery view: array qa items render without throwing', () => {
  let tree
  assert.doesNotThrow(() => {
    tree = renderDelivery({
      blocking: [{ id: 'qa_gate_1', message: '证据不足：股权链缺少 claim' }],
      warnings: [{ id: 'qa_warn_1', message: '时效偏旧' }],
      passed: false,
    })
  })
  const text = textOf(tree).join(' ')
  assert.match(text, /QA 阻断 1 项/)
  assert.match(text, /qa_gate_1/)
  assert.match(text, /证据不足：股权链缺少 claim/)
  assert.match(text, /时效偏旧/)
})

test('client delivery view: passed/absent/string qa shapes stay renderable', () => {
  assert.doesNotThrow(() => {
    assert.match(textOf(renderDelivery({ blocking: [], warnings: [], passed: true })).join(' '), /QA 通过/)
    assert.match(textOf(renderDelivery(null)).join(' '), /尚无体检结果/)
    assert.match(textOf(renderDelivery(undefined, { deliverable: false })).join(' '), /还没有交付包/)
    // Defensive: primitive arrays and non-numeric counts.
    assert.match(textOf(renderDelivery({ blocking: ['缺少证据'], warnings: 3, passed: false })).join(' '), /缺少证据/)
  })
  // Arrays come from the vm realm, so compare shape via length/Array.isArray.
  const empty = toQaItems('not-a-count')
  assert.equal(Array.isArray(empty), true)
  assert.equal(empty.length, 0)
  assert.equal(qaSummary({ blocking: 1000 }).blocking.length, 50)
  assert.equal(qaSummary({ blocking: 1000 }).blockingCount, 1000)
  assert.equal(qaSummary(7), null)
})

test('client error boundary: catches a render error and offers a retry', () => {
  const child = { type: 'div', props: { children: ['child-ok'] } }
  const boundary = new ErrorBoundary({ children: child, standalone: false })
  assert.equal(boundary.render(), child)

  boundary.state = { error: new Error('qa.blocking.map is not a function') }
  const fallback = boundary.render()
  const text = textOf(fallback).join(' ')
  assert.match(text, /这一页渲染失败/)
  assert.match(text, /qa\.blocking\.map is not a function/)
  assert.match(text, /重试渲染/)
  assert.equal(fallback.props.className, 'eq-banner error')
  assert.equal(fallback.props.role, 'alert')

  boundary.retry()
  assert.equal(boundary.state.error, null)
  assert.equal(boundary.render(), child)

  // Standalone mode wraps the fallback in the panel shell so the host slot
  // still gets styled content when the workbench itself crashed.
  const standalone = new ErrorBoundary({ children: child, standalone: true })
  standalone.state = { error: new Error('boom') }
  const shell = standalone.render()
  assert.equal(shell.type, 'div')
  assert.equal(shell.props.className, 'eq-root')
  assert.match(textOf(shell).join(' '), /这\S*页渲染失败/)
})

test('client actions: verify is sent as verify, not build', () => {
  assert.match(source, /name === 'verify' \? 'verify' : 'build'/)
  assert.match(source, /error\?\.code === 'unsupported'/)
  assert.match(source, /ErrorBoundary, \{ standalone: true \}/)
})

test('client module: production exports stay inject/apply only', () => {
  const api = loadClient(false)
  assert.deepEqual([...Object.keys(api)].sort(), ['apply', 'inject'])
  assert.equal(api.__test, undefined)
  assert.equal(typeof api.apply, 'function')
})

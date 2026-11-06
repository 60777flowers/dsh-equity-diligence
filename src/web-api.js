import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { EquityError, isPlainObject } from './util/json.js'
import { resolveInside, statOrNull } from './util/fs.js'

const API_PREFIX = '/api/equity'

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function errorResponse(error) {
  const status = error?.code === 'user_only' ? 403 : error?.code === 'not_found' || error?.code === 'project_missing' ? 404 : 400
  return json({
    ok: false,
    error: {
      code: error?.code ?? 'error',
      message: error?.message ?? String(error),
      details: error?.details ?? null,
    },
  }, status)
}

async function bodyOf(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return {}
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new EquityError('invalid_json', '请求体不是合法 JSON')
  }
}

function query(request) {
  return new URL(request.url).searchParams
}

/**
 * Authenticated owner-only JSON API for the Web workbench. Every operation is
 * the same EquityService method the agent tools call.
 */
export function registerWebApi({ ctx, service }) {
  if (!ctx.connection?.fetch) return () => {}
  const disposers = []
  const route = (path, methods, handler) => {
    disposers.push(ctx.connection.fetch.register({
      path,
      methods,
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return await handler(request)
        } catch (error) {
          return errorResponse(error)
        }
      },
    }))
  }

  route(`${API_PREFIX}/projects`, ['GET'], async () => json({ ok: true, projects: await service.listProjects() }))

  route(`${API_PREFIX}/state`, ['GET'], async (request) => {
    const projectId = query(request).get('projectId') ?? undefined
    return json({ ok: true, state: await service.state(projectId) })
  })

  route(`${API_PREFIX}/project`, ['POST'], async (request) => {
    const body = await bodyOf(request)
    if (body.action === 'create') {
      const result = await service.createProject({ ...body, workspaceRoot: body.workspaceRoot ?? process.cwd() })
      return json({ ok: true, project: result })
    }
    if (body.action === 'open' || body.action === 'status') {
      const result = await service.openProject(body.projectId ?? body.root)
      return json({ ok: true, project: result })
    }
    if (body.action === 'archive') return json({ ok: true, project: await service.archiveProject(body.projectId ?? body.root) })
    if (body.action === 'migrate') return json({ ok: true, result: await service.migrate(body.root ?? body.projectId, { targetName: body.target, dryRun: body.dryRun }) })
    throw new EquityError('bad_action', `不支持的 project action：${body.action}`)
  })

  // One path may be registered once with several methods. Registering the same
  // path twice throws in the Fetch registry and silently drops later routes.
  route(`${API_PREFIX}/playbook`, ['GET', 'POST'], async (request) => {
    if (request.method === 'GET') {
      const projectId = query(request).get('projectId') ?? undefined
      return json({ ok: true, ...(await service.playbook(projectId)) })
    }
    const body = await bodyOf(request)
    if (body.action === 'compile') return json({ ok: true, compile: await service.compile(body.projectId, body.playbook) })
    if (body.action === 'save') return json({ ok: true, result: await service.savePlaybook(body.projectId, body.playbook) })
    if (body.action === 'apply') return json({ ok: true, result: await service.applyPreset(body.projectId, body.preset) })
    if (body.action === 'presets') return json({ ok: true, presets: (await service.modules()).presets })
    throw new EquityError('bad_action', `不支持的 playbook action：${body.action}`)
  })

  route(`${API_PREFIX}/run`, ['POST'], async (request) => {
    const body = await bodyOf(request)
    if (body.action === 'start') {
      const result = await service.run(body.projectId, {
        mode: body.mode ?? 'playbook',
        question: body.question,
        executor: body.executor,
        wait: false,
      })
      return json({ ok: true, run: result })
    }
    if (body.action === 'pause') return json({ ok: true, ...service.pause(body.runId) })
    if (body.action === 'cancel') return json({ ok: true, ...service.cancel(body.runId) })
    if (body.action === 'resume') return json({ ok: true, run: await service.resume(body.projectId, body.runId, { wait: false }) })
    if (body.action === 'detail') return json({ ok: true, run: await service.runDetail(body.projectId, body.runId) })
    if (body.action === 'list') return json({ ok: true, runs: await service.runs(body.projectId) })
    throw new EquityError('bad_action', `不支持的 run action：${body.action}`)
  })

  route(`${API_PREFIX}/artifact`, ['GET'], async (request) => {
    const params = query(request)
    return json({ ok: true, ...(await service.artifact(params.get('projectId') ?? undefined, params.get('artifactId'))) })
  })

  route(`${API_PREFIX}/evidence`, ['GET'], async (request) => {
    const params = query(request)
    return json({ ok: true, ...(await service.evidence(params.get('projectId') ?? undefined, params.get('evidenceId'))) })
  })

  route(`${API_PREFIX}/record`, ['POST'], async (request) => {
    const body = await bodyOf(request)
    return json({ ok: true, result: await service.record(body.projectId, { ...body, actor: 'human' }) })
  })

  route(`${API_PREFIX}/review`, ['POST'], async (request) => {
    const body = await bodyOf(request)
    if (body.action === 'decide') {
      return json({ ok: true, issue: await service.decideIssue(body.projectId, body.issueId, body.decision, { actor: 'user', reason: body.reason }) })
    }
    if (body.action === 'signoff') {
      return json({ ok: true, signoff: await service.signoff(body.projectId, body) })
    }
    if (body.action === 'propose') return json({ ok: true, issue: await service.proposeReview(body.projectId, body) })
    if (body.action === 'list') return json({ ok: true, issues: await service.issues(body.projectId, body) })
    throw new EquityError('bad_action', `不支持的 review action：${body.action}`)
  })

  route(`${API_PREFIX}/deliver`, ['POST'], async (request) => {
    const body = await bodyOf(request)
    return json({ ok: true, result: await service.deliver(body.projectId, body.action ?? 'build', body) })
  })

  route(`${API_PREFIX}/modules`, ['GET'], async () => json({ ok: true, ...(await service.modules()) }))

  route(`${API_PREFIX}/doctor`, ['GET'], async () => json({ ok: true, doctor: await service.doctor() }))

  route(`${API_PREFIX}/file`, ['GET'], async (request) => {
    const params = query(request)
    const state = await service.state(params.get('projectId') ?? undefined)
    const root = state.project.root
    const relative = params.get('path') ?? ''
    const target = resolveInside(join(root, '05_交付'), relative)
    const info = await statOrNull(target)
    if (!info?.isFile()) throw new EquityError('not_found', `文件不存在：${relative}`)
    const data = await readFile(target)
    const ext = extname(target).toLowerCase()
    const type = ext === '.xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : ext === '.md'
        ? 'text/markdown; charset=utf-8'
        : ext === '.json'
          ? 'application/json; charset=utf-8'
          : 'application/octet-stream'
    return new Response(data, { status: 200, headers: { 'content-type': type, 'content-disposition': `inline; filename="${encodeURIComponent(target.split(/[\\/]/).pop())}"` } })
  })

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        Promise.resolve(dispose()).catch(() => {})
      } catch {
        // ignore
      }
    }
  }
}

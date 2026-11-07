import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { EquityError, isPlainObject } from './util/json.js'
import { resolveInside, statOrNull } from './util/fs.js'
import { PRESET_NAMES, equityHomeDir, isPresetName } from './kernel/registry.js'

const API_PREFIX = '/api/equity'

/**
 * Fields `POST /api/equity/project {action:'create'}` may forward to the
 * service. Everything else in the request body is dropped on purpose:
 * `overwrite`, `playbook` (a file path), `clientProfileText`, `workspaceRoot`,
 * `projectId`, `engagement`, `budget` are all filesystem/authority primitives
 * that must not be controlled by an HTTP caller.
 */
export const PROJECT_CREATE_FIELDS = Object.freeze([
  'target',
  'targets',
  'code',
  'identifiers',
  'listingStatus',
  'preset',
  'asOf',
  'clientName',
  'currency',
  'executor',
  'root',
])

/**
 * Fields `POST /api/equity/record` may forward. `actor` and `status` are set by
 * the route, not by the caller: HTTP writers are always `agent` and `draft`.
 */
export const RECORD_FIELDS = Object.freeze([
  'kind',
  'type',
  'subjectId',
  'partitionKey',
  'period',
  'data',
  'output',
  'claims',
  'evidence',
  'moduleId',
  'moduleVersion',
  'derivedFrom',
  'asOf',
  'openQuestions',
  'flags',
  'sourceCoverage',
  'expectedRev',
])

const DELIVER_ACTIONS = Object.freeze(['build', 'verify', 'present'])

const STATUS_BY_CODE = Object.freeze({
  user_only: 403,
  forbidden_root: 403,
  unsupported: 501,
  not_found: 404,
  project_missing: 404,
  artifact_missing: 404,
  evidence_missing: 404,
  run_missing: 404,
})

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function errorResponse(error) {
  const status = STATUS_BY_CODE[error?.code] ?? 400
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
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new EquityError('invalid_json', '请求体不是合法 JSON')
  }
  if (!isPlainObject(value)) throw new EquityError('invalid_body', '请求体必须是 JSON 对象')
  return value
}

function query(request) {
  return new URL(request.url).searchParams
}

/** Copy only the listed fields that the caller actually supplied. */
function pick(body, fields) {
  const out = {}
  for (const field of fields) {
    if (Object.hasOwn(body, field) && body[field] !== undefined) out[field] = body[field]
  }
  return out
}

/** True when `target` is `root` or lives below it (case-aware on Windows). */
export function isPathInside(root, target) {
  const base = resolve(root)
  const candidate = resolve(target)
  const rel = relative(base, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Allowed roots for project creation, fixed when the API is registered (a
 * per-request `process.cwd()` would make the boundary depend on whoever
 * launched the process). The configured workspace is first; the launch
 * directory and the DSH equity home are kept for backwards compatibility.
 */
export function projectRootPolicy(service, options = {}) {
  const allowedRoots = []
  const add = (value) => {
    if (typeof value !== 'string' || !value.trim()) return
    const resolved = resolve(value)
    if (!allowedRoots.includes(resolved)) allowedRoots.push(resolved)
  }
  for (const root of options.allowedRoots ?? []) add(root)
  add(options.workspaceRoot)
  add(service?.config?.workspaceRoot)
  add(process.cwd())
  add(equityHomeDir())
  const workspaceRoot = resolve(options.workspaceRoot ?? service?.config?.workspaceRoot ?? process.cwd())
  return { workspaceRoot, allowedRoots }
}

/**
 * Normalize and authorize a caller-supplied project root. Relative paths are
 * resolved against the configured workspace; absolute paths are accepted only
 * when they already sit inside an allowed root. Parent traversal is rejected
 * outright (400) and escaping roots are forbidden (403) before any file
 * operation happens in the kernel.
 */
export function validateProjectRoot(input, policy) {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'string') throw new EquityError('invalid_root', 'root 必须是字符串')
  const raw = input.trim()
  if (!raw) return undefined
  if (raw.includes('\0')) throw new EquityError('invalid_root', 'root 含非法字符')
  // `C:foo` is drive-relative on Windows and would resolve against the cwd.
  if (/^[a-zA-Z]:(?![\\/])/.test(raw)) {
    throw new EquityError('invalid_root', 'root 不能是盘符相对路径（请使用绝对路径或工作区相对路径）', { root: raw })
  }
  const segments = raw.replaceAll('\\', '/').split('/')
  if (segments.includes('..')) {
    throw new EquityError('invalid_root', 'root 不能包含 ..（禁止父目录穿越）', { root: raw })
  }
  const workspaceRoot = resolve(policy?.workspaceRoot ?? process.cwd())
  const target = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot, raw)
  const allowedRoots = policy?.allowedRoots ?? [workspaceRoot]
  if (!allowedRoots.some((root) => isPathInside(root, target))) {
    throw new EquityError('forbidden_root', '项目目录必须位于工作区（或 ~/.dsh/equity）内', {
      root: raw,
      workspaceRoot,
      allowedRoots,
    })
  }
  return target
}

/** True when a value is a filesystem path rather than an opaque projectId. */
function isPathLike(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!text) return false
  if (isAbsolute(text)) return true
  return text === '.' || text === '..'
    || text.startsWith('./') || text.startsWith('.\\')
    || text.startsWith('../') || text.startsWith('..\\')
    || text.includes('/') || text.includes('\\')
}

/**
 * Write endpoints accept either an opaque indexed projectId or a filesystem
 * path. A path-shaped value must be validated exactly like a create root;
 * otherwise `/playbook save` or `/run` could write to an arbitrary directory
 * outside the workspace even though `/project create` is confined.
 */
function validateProjectReference(value, policy) {
  if (!isPathLike(value)) return value
  return validateProjectRoot(value, policy)
}

/** Reject any preset name that is not one of the five fixed presets. */
export function validatePreset(value, { field = 'preset' } = {}) {
  if (value === undefined || value === null || value === '') return undefined
  if (!isPresetName(value)) {
    throw new EquityError('bad_preset', `预设必须是以下之一：${PRESET_NAMES.join(' / ')}`, {
      field,
      preset: value,
      allowed: [...PRESET_NAMES],
    })
  }
  return value
}

/**
 * Authenticated owner-only JSON API for the Web workbench. Every operation is
 * the same EquityService method the agent tools call, after the HTTP boundary
 * has validated filesystem roots, preset names and writable authority fields.
 */
export function registerWebApi({ ctx, service, workspaceRoot, allowedRoots }) {
  if (!ctx.connection?.fetch) return () => {}
  const policy = projectRootPolicy(service, { workspaceRoot, allowedRoots })
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
      const input = pick(body, PROJECT_CREATE_FIELDS)
      const preset = validatePreset(input.preset)
      const root = validateProjectRoot(input.root, policy)
      const options = { ...input, workspaceRoot: policy.workspaceRoot }
      if (preset === undefined) delete options.preset
      else options.preset = preset
      if (root === undefined) delete options.root
      else options.root = root
      const result = await service.createProject(options)
      return json({ ok: true, project: result })
    }
    if (body.action === 'open' || body.action === 'status') {
      const result = await service.openProject(body.projectId ?? body.root)
      return json({ ok: true, project: result })
    }
    if (body.action === 'archive') {
      // archive is a write; a path-shaped target must stay inside the workspace.
      const target = body.projectId ?? body.root
      if (isPathLike(target)) validateProjectRoot(target, policy)
      return json({ ok: true, project: await service.archiveProject(target) })
    }
    if (body.action === 'migrate') {
      // migrate writes into the target directory; treat it like create. The
      // service treats any non-`eq_` string as a filesystem root, so check the
      // value that will actually be used, not only `body.root`.
      const target = body.root ?? body.projectId
      if (typeof target === 'string' && !target.startsWith('eq_')) validateProjectRoot(target, policy)
      const result = await service.migrate(target, { targetName: body.target, dryRun: body.dryRun })
      return json({ ok: true, result })
    }
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
    const projectId = validateProjectReference(body.projectId, policy)
    if (body.action === 'compile') return json({ ok: true, compile: await service.compile(projectId, body.playbook) })
    if (body.action === 'save') return json({ ok: true, result: await service.savePlaybook(projectId, body.playbook) })
    if (body.action === 'apply') {
      const preset = validatePreset(body.preset)
      if (preset === undefined) throw new EquityError('missing_preset', '缺少 preset')
      return json({ ok: true, result: await service.applyPreset(projectId, preset) })
    }
    if (body.action === 'presets') return json({ ok: true, presets: (await service.modules()).presets })
    throw new EquityError('bad_action', `不支持的 playbook action：${body.action}`)
  })

  route(`${API_PREFIX}/run`, ['POST'], async (request) => {
    const body = await bodyOf(request)
    const projectId = validateProjectReference(body.projectId, policy)
    if (body.action === 'start') {
      const result = await service.run(projectId, {
        mode: body.mode ?? 'playbook',
        question: body.question,
        executor: body.executor,
        wait: false,
      })
      return json({ ok: true, run: result })
    }
    if (body.action === 'pause') return json({ ok: true, ...service.pause(body.runId) })
    if (body.action === 'cancel') return json({ ok: true, ...service.cancel(body.runId) })
    if (body.action === 'resume') return json({ ok: true, run: await service.resume(projectId, body.runId, { wait: false }) })
    if (body.action === 'detail') return json({ ok: true, run: await service.runDetail(projectId, body.runId) })
    if (body.action === 'list') return json({ ok: true, runs: await service.runs(projectId) })
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
    // The HTTP channel is an agent-grade writer. Human attribution and
    // `verified` can only be produced by the review/signoff path (server-side),
    // never by a caller-supplied field.
    if (body.actor !== undefined && body.actor !== 'agent') {
      const code = body.actor === 'human' ? 'user_only' : 'bad_actor'
      throw new EquityError(code, 'HTTP 写底稿的 actor 固定为 agent；human 只能由复核/签发通道产生', {
        field: 'actor',
        value: body.actor,
      })
    }
    if (body.status === 'verified') {
      throw new EquityError('user_only', 'HTTP 不能写 status=verified；verified 只能由复核/签发生成', {
        field: 'status',
        value: body.status,
      })
    }
    if (body.status !== undefined && body.status !== 'draft') {
      throw new EquityError('bad_status', 'HTTP 写底稿只接受 status=draft', { field: 'status', value: body.status })
    }
    const payload = { ...pick(body, RECORD_FIELDS), actor: 'agent', status: 'draft' }
    return json({ ok: true, result: await service.record(validateProjectReference(body.projectId, policy), payload) })
  })

  route(`${API_PREFIX}/review`, ['POST'], async (request) => {
    const body = await bodyOf(request)
    const projectId = validateProjectReference(body.projectId, policy)
    if (body.action === 'decide') {
      return json({ ok: true, issue: await service.decideIssue(projectId, body.issueId, body.decision, { actor: 'user', reason: body.reason }) })
    }
    if (body.action === 'signoff') {
      // Signoff is user-only. The HTTP owner channel is the user channel, so it
      // must say so explicitly (service.signoff(projectId, payload, {actor})).
      // Timestamps are server-generated: never forward caller-supplied ones.
      const { signedAt: _signedAt, proposedAt: _proposedAt, ...payload } = body
      const result = await service.signoff(projectId, payload, { actor: 'user' })
      return json({ ok: true, signoff: result?.signoff ?? result, artifact: result?.artifact ?? null })
    }
    if (body.action === 'propose') return json({ ok: true, issue: await service.proposeReview(projectId, body) })
    if (body.action === 'list') return json({ ok: true, issues: await service.issues(projectId, body) })
    throw new EquityError('bad_action', `不支持的 review action：${body.action}`)
  })

  route(`${API_PREFIX}/deliver`, ['POST'], async (request) => {
    const body = await bodyOf(request)
    const action = body.action ?? 'build'
    if (!DELIVER_ACTIONS.includes(action)) {
      throw new EquityError('bad_action', `不支持的 deliver action：${action}`, { allowed: [...DELIVER_ACTIONS] })
    }
    if (action === 'verify') {
      // `service.deliver(projectId, 'verify')` would silently rebuild the whole
      // package (service.js treats every non-present action as build). Until the
      // service exposes a real QA-only entry point, say so instead of pretending.
      if (typeof service.verifyDelivery !== 'function') {
        throw new EquityError('unsupported', '后端尚未提供独立的交付体检（verify）；请先构建交付包并查看体检单', {
          action: 'verify',
          supported: ['build', 'present'],
        })
      }
      return json({ ok: true, result: await service.verifyDelivery(validateProjectReference(body.projectId, policy), pick(body, ['template'])) })
    }
    return json({ ok: true, result: await service.deliver(validateProjectReference(body.projectId, policy), action, body) })
  })

  route(`${API_PREFIX}/modules`, ['GET'], async () => json({ ok: true, ...(await service.modules()) }))

  route(`${API_PREFIX}/doctor`, ['GET'], async () => json({ ok: true, doctor: await service.doctor() }))

  route(`${API_PREFIX}/file`, ['GET'], async (request) => {
    const params = query(request)
    const state = await service.state(params.get('projectId') ?? undefined)
    const root = state.project.root
    const relativePath = params.get('path') ?? ''
    const target = resolveInside(join(root, '05_交付'), relativePath)
    const info = await statOrNull(target)
    if (!info?.isFile()) throw new EquityError('not_found', `文件不存在：${relativePath}`)
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

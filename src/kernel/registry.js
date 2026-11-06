import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EquityError, canonicalJson, isPlainObject, sha256 } from '../util/json.js'
import { readJson, readText, resolveInside } from '../util/fs.js'
import { parseYamlObject } from '../util/yaml.js'

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const ASSETS_DIR = join(PACKAGE_ROOT, 'assets')
export const KERNEL_VERSION = '1.0.0'
export const MODULE_API = 'equity.module/v1'
export const PLAYBOOK_API = 'equity.playbook/v1'

export const MODULE_KINDS = ['collect', 'verify', 'synthesize', 'assess', 'deliver']
export const SCOPES = ['company', 'project']
export const STAGE_HINTS = ['identity', 'ownership', 'people', 'business', 'tech', 'finance', 'risk', 'market', 'assessment', 'delivery', 'investigation']
export const GATE_TYPES = ['schema', 'rule', 'coverage', 'rubric', 'checklist']
// provenance.origin：human = 人工编写并对该方法论负责；agent = AI 初稿（author 默认 ai-draft），待人工接管
export const PROVENANCE_ORIGINS = ['human', 'agent']
export const DEFAULT_TOOLS = [
  'web_search', 'web_fetch', 'skill', 'equity_project', 'equity_playbook',
  'equity_run', 'equity_record', 'equity_review', 'equity_deliver',
]

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function defaultUserModulesDir() {
  return join(dshHome(), 'equity', 'modules')
}

export function projectsIndexPath() {
  return join(dshHome(), 'equity', 'projects.json')
}

/** Semver parse with a stable error. */
export function parseVersion(version) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(String(version).trim())
  if (!match) throw new EquityError('bad_version', `版本号不合法：${version}`)
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function compareVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/** npm-style subset: exact, ^, ~, >=x <y, wildcard. */
export function satisfies(version, range) {
  const v = parseVersion(version)
  const text = String(range ?? '*').trim()
  if (!text || text === '*' || text === 'x') return true
  if (text.startsWith('^')) {
    const base = parseVersion(text.slice(1))
    const upper = base[0] > 0 ? [base[0] + 1, 0, 0] : [0, base[1] + 1, 0]
    return compareVersion(v, base) >= 0 && compareVersion(v, upper) < 0
  }
  if (text.startsWith('~')) {
    const base = parseVersion(text.slice(1))
    const upper = [base[0], base[1] + 1, 0]
    return compareVersion(v, base) >= 0 && compareVersion(v, upper) < 0
  }
  if (text.includes(' ')) {
    const parts = text.split(/\s+/).filter(Boolean)
    return parts.every((part) => satisfies(version, part))
  }
  if (text.startsWith('>=')) return compareVersion(v, parseVersion(text.slice(2))) >= 0
  if (text.startsWith('<=')) return compareVersion(v, parseVersion(text.slice(2))) <= 0
  if (text.startsWith('>')) return compareVersion(v, parseVersion(text.slice(1))) > 0
  if (text.startsWith('<')) return compareVersion(v, parseVersion(text.slice(1))) < 0
  return compareVersion(v, parseVersion(text)) === 0
}

/** Parse a `use` string `builtin/id@^0.1`. */
export function parseUse(use) {
  const text = String(use ?? '').trim()
  const at = text.lastIndexOf('@')
  if (at <= 0) return { id: text, range: '*' }
  return { id: text.slice(0, at), range: text.slice(at + 1) }
}

function isWithin(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  return target === base || target.startsWith(base + sep)
}

async function readMaybeYamlOrJson(file) {
  const text = await readText(file, null)
  if (text === null) return null
  if (text.trimStart().startsWith('{')) return JSON.parse(text)
  return parseYamlObject(text, file)
}

/** Load one module directory into a normalized module object. */
async function loadModuleDir(dir, source) {
  const manifestFile = join(dir, 'module.yaml')
  const manifest = await readMaybeYamlOrJson(manifestFile)
  if (!manifest) return null
  const slug = manifest.id?.split('/')?.[1] ?? dir.split(sep).pop()
  const skill = await readText(join(dir, 'SKILL.md'), '')
  const system = await readText(join(dir, 'prompts', '_system.md'), '')
  const task = await readText(join(dir, 'prompts', 'collect.md'), '')
  const tail = await readText(join(dir, 'prompts', '_tail.md'), '')
  const gatesFile = join(dir, 'rules', 'gates.json')
  const gates = (await readJson(gatesFile, null)) ?? {}
  const rubric = await readText(join(dir, 'rules', 'rubric.md'), '')
  const fallback = await readText(join(dir, 'fallback.md'), '')
  const hash = sha256(
    canonicalJson({
      manifest,
      skill,
      task,
      system,
      tail,
      gates,
      rubric,
      fallback,
    }),
  )
  return {
    id: manifest.id,
    slug,
    source,
    dir,
    manifest,
    skill,
    prompts: { system, task, tail },
    gates,
    rubric,
    fallback,
    hash,
    status: manifest.status ?? 'draft',
    provenance: manifest.provenance ?? null,
  }
}

function resolveModuleFile(module, relativePath) {
  const target = resolve(module.dir, relativePath)
  if (module.source === 'builtin') {
    if (!isWithin(ASSETS_DIR, target)) {
      throw new EquityError('module_path_escape', `模块 ${module.id} 的模板越界：${relativePath}`)
    }
  } else if (!isWithin(module.dir, target)) {
    throw new EquityError('module_path_escape', `模块 ${module.id} 的模板越界：${relativePath}`)
  }
  return target
}

async function readModuleTemplates(module) {
  const render = module.manifest.render ?? {}
  const files = {}
  for (const key of ['system', 'task', 'tail']) {
    const relative = render[key]
    if (!relative) continue
    const file = resolveModuleFile(module, relative)
    files[key] = await readText(file, null)
    if (files[key] === null) files[key] = ''
  }
  module.prompts = {
    system: files.system ?? module.prompts.system,
    task: files.task ?? module.prompts.task,
    tail: files.tail ?? module.prompts.tail,
  }
  module.templateSha = sha256(
    canonicalJson({
      system: module.prompts.system,
      task: module.prompts.task,
      tail: module.prompts.tail,
    }),
  )
  return module
}

/** Validate a module against the registry. */
export function validateModule(module, registry, allowedTools = DEFAULT_TOOLS) {
  const errors = []
  const warnings = []
  const m = module.manifest
  const add = (code, message, field) => errors.push({ code, message, field, moduleId: m.id })
  const warn = (code, message, field) => warnings.push({ code, message, field, moduleId: m.id })

  if (m.apiVersion !== MODULE_API) add('bad_api_version', `apiVersion 必须为 ${MODULE_API}`, 'apiVersion')
  if (!/^(builtin|local)\/[a-z0-9][a-z0-9-]*$/.test(String(m.id ?? ''))) {
    add('bad_id', 'id 必须为 builtin/<slug> 或 local/<slug>', 'id')
  }
  if (m.slug && m.slug !== module.slug) add('id_dir_mismatch', 'id 的 slug 与目录名不一致', 'id')
  if (!m.name || String(m.name).length > 40) add('bad_name', 'name 必填且 ≤40 字', 'name')
  try {
    parseVersion(m.version)
  } catch {
    add('bad_version', 'version 必须是 semver', 'version')
  }
  if (!MODULE_KINDS.includes(m.kind)) add('bad_kind', `kind 必须是 ${MODULE_KINDS.join('/')}`, 'kind')
  if (!SCOPES.includes(m.scope)) add('bad_scope', 'scope 必须是 company/project', 'scope')
  // provenance：谁写的、怎么来的。缺省只告警（兼容早期与第三方模块），写错则报错。
  const provenance = m.provenance
  if (!provenance) {
    warn('missing_provenance', '未声明 provenance（author/origin），无法区分作者与来源', 'provenance')
  } else {
    if (typeof provenance.author !== 'string' || !provenance.author.trim()) {
      add('bad_provenance', 'provenance.author 必填（作者标识）', 'provenance')
    }
    if (!PROVENANCE_ORIGINS.includes(provenance.origin)) {
      add('bad_provenance', `provenance.origin 必须是 ${PROVENANCE_ORIGINS.join('/')}`, 'provenance')
    }
  }
  if (m.stageHint && !STAGE_HINTS.includes(m.stageHint)) warn('unknown_stage_hint', `未知 stageHint: ${m.stageHint}`, 'stageHint')
  if (!Array.isArray(m.outputs) || m.outputs.length === 0) add('missing_outputs', 'outputs 至少一项', 'outputs')
  for (const output of m.outputs ?? []) {
    const type = registry.types.get(output.type)
    if (!type) add('unknown_artifact_type', `未注册的类型：${output.type}`, 'outputs')
    else if (output.typeVersion && output.typeVersion !== type.version) {
      add('type_version_mismatch', `${output.type} 版本应为 ${type.version}`, 'outputs')
    }
  }
  for (const input of m.inputs ?? []) {
    if (input.type !== 'all' && !registry.types.has(input.type)) {
      add('unknown_input_type', `未注册的输入类型：${input.type}`, 'inputs')
    }
    if (input.onMissing && !['block', 'degrade'].includes(input.onMissing)) {
      add('bad_on_missing', 'onMissing 必须是 block/degrade', 'inputs')
    }
  }
  for (const reference of m.references ?? []) {
    if (!registry.types.has(reference.type)) add('unknown_input_type', `未注册的引用类型：${reference.type}`, 'references')
  }
  for (const param of m.params ?? []) {
    if (!param.key || !/^[a-z][a-zA-Z0-9_]*$/.test(param.key)) add('bad_param', '参数 key 不合法', 'params')
    if (!['string', 'integer', 'number', 'boolean'].includes(param.type)) add('bad_param', `参数 ${param.key} 类型不合法`, 'params')
    if (param.enum && !Array.isArray(param.enum)) add('bad_param', `参数 ${param.key} enum 必须是数组`, 'params')
    if (param.default !== undefined && param.type === 'integer' && !Number.isInteger(param.default)) {
      add('bad_param_default', `参数 ${param.key} 默认值不是整数`, 'params')
    }
    if (param.min !== undefined && param.max !== undefined && param.min > param.max) {
      add('bad_param_default', `参数 ${param.key} min > max`, 'params')
    }
  }
  const render = m.render ?? {}
  if (!render.task) add('missing_template', 'render.task 必填', 'render')
  if (!Array.isArray(m.tools) || m.tools.length === 0) warn('missing_tools', '未声明 tools，将使用默认白名单', 'tools')
  for (const tool of m.tools ?? []) {
    if (!allowedTools.includes(tool)) add('unknown_tool', `未知工具：${tool}`, 'tools')
    if (tool === 'equity_evidence') add('unknown_tool', '证据写入口统一为 equity_record(kind=evidence)', 'tools')
  }
  for (const gate of m.gates ?? []) {
    if (!gate.id || !GATE_TYPES.includes(gate.type)) add('bad_gate', `门 ${gate.id ?? '?'} 类型不合法`, 'gates')
    if (gate.type === 'rubric' && !gate.rubric && !module.rubric) add('bad_gate', 'rubric 门缺少 rubric 文件', 'gates')
  }
  if (m.review && !['none', 'single', 'adversarial'].includes(m.review.mode)) {
    add('bad_review', 'review.mode 必须是 none/single/adversarial', 'review')
  }
  const compat = m.compat?.kernel
  if (compat) {
    try {
      if (!satisfies(KERNEL_VERSION, compat)) add('compat_kernel', `内核 ${KERNEL_VERSION} 不满足 ${compat}`, 'compat')
    } catch {
      add('compat_kernel', 'compat.kernel 不是合法范围', 'compat')
    }
  }
  if (!module.skill.trim()) warn('missing_skill', 'SKILL.md 为空', 'SKILL.md')
  if (!module.rubric.trim()) warn('missing_rubric', 'rules/rubric.md 为空', 'rules/rubric.md')
  return { valid: errors.length === 0, errors, warnings }
}

/** Load the whole module library and registry. */
export async function loadLibrary(options = {}) {
  const {
    userModulesDir = defaultUserModulesDir(),
    allowedTools = DEFAULT_TOOLS,
    strict = false,
  } = options

  const typeRegistry = await readJson(join(ASSETS_DIR, 'registry', 'types.json'), null)
  if (!typeRegistry?.types?.length) {
    throw new EquityError('registry_missing', 'assets/registry/types.json 缺失或为空')
  }
  const types = new Map(typeRegistry.types.map((type) => [type.type, type]))
  const registry = { types, typeList: typeRegistry.types }

  const modules = new Map()
  const errors = []
  const warnings = []
  const roots = [
    { dir: join(ASSETS_DIR, 'modules'), source: 'builtin' },
    { dir: userModulesDir, source: 'local' },
  ]
  for (const root of roots) {
    let entries = []
    try {
      const { readdir } = await import('node:fs/promises')
      entries = await readdir(root.dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
      const loaded = await loadModuleDir(join(root.dir, entry.name), root.source)
      if (!loaded) continue
      loaded.slug = entry.name
      await readModuleTemplates(loaded)
      loaded.validation = validateModule(loaded, registry, allowedTools)
      if (modules.has(loaded.id)) {
        errors.push({ code: 'duplicate_id', message: `模块 id 重复：${loaded.id}`, moduleId: loaded.id })
        continue
      }
      modules.set(loaded.id, loaded)
      errors.push(...loaded.validation.errors)
      warnings.push(...loaded.validation.warnings)
    }
  }

  if (strict && errors.length > 0) {
    throw new EquityError('module_library_invalid', `模块库有 ${errors.length} 个错误`, { errors })
  }

  const producers = new Map()
  const systemProducers = new Map([
    ['company.roster', 'system/project-bootstrap'],
    ['search.ledger', 'system/source-acquisition'],
    ['source.coverage', 'system/source-acquisition'],
  ])
  for (const module of modules.values()) {
    for (const output of module.manifest.outputs ?? []) {
      const existing = producers.get(output.type)
      if (existing && existing !== module.id) {
        warnings.push({
          code: 'duplicate_producer',
          message: `类型 ${output.type} 有多个生产者：${existing} / ${module.id}`,
          moduleId: module.id,
        })
      } else {
        producers.set(output.type, module.id)
      }
    }
  }
  for (const [type, producer] of systemProducers) {
    if (!producers.has(type)) producers.set(type, producer)
  }
  const legacy = new Set(
    [...types.values()].filter((type) => type.status === 'legacy').map((type) => type.type),
  )
  return {
    root: PACKAGE_ROOT,
    assetsDir: ASSETS_DIR,
    kernelVersion: KERNEL_VERSION,
    types,
    typeList: typeRegistry.types,
    modules,
    moduleList: [...modules.values()].sort((a, b) => a.id.localeCompare(b.id)),
    producers,
    systemProducers,
    legacy,
    errors,
    warnings,
    userModulesDir,
  }
}

/** Find a module by id and semver range. */
export function resolveModule(library, use) {
  const { id, range } = parseUse(use)
  const module = library.modules.get(id)
  if (!module) {
    throw new EquityError('unknown_module', `模块不存在：${id}`, { id })
  }
  if (!satisfies(module.manifest.version, range)) {
    throw new EquityError('version_unsatisfied', `模块 ${id}@${module.manifest.version} 不满足 ${range}`, {
      id,
      version: module.manifest.version,
      range,
    })
  }
  return module
}

/** Public module summary for tools and UI. */
export function moduleSummary(module) {
  const m = module.manifest
  return {
    id: m.id,
    slug: module.slug,
    name: m.name,
    version: m.version,
    kind: m.kind,
    stageHint: m.stageHint ?? null,
    scope: m.scope,
    description: m.description,
    status: module.status,
    provenance: m.provenance ?? null,
    source: module.source,
    inputs: m.inputs ?? [],
    references: m.references ?? [],
    outputs: m.outputs ?? [],
    params: m.params ?? [],
    gates: m.gates ?? [],
    review: m.review ?? null,
    budget: m.budget ?? null,
    tools: m.tools ?? [],
    hash: module.hash,
    templateSha: module.templateSha,
    hasSkill: Boolean(module.skill.trim()),
    hasRubric: Boolean(module.rubric.trim()),
    validation: module.validation,
  }
}

/** Load a preset playbook by name. */
export async function loadPreset(name) {
  const map = {
    'skill-only': 'skill-only.yaml',
    quick: 'quick.yaml',
    standard: 'standard.yaml',
    deep: 'deep.yaml',
    generic: 'generic.yaml',
  }
  const file = map[name] ?? (name.endsWith('.yaml') ? name : `${name}.yaml`)
  const path = join(ASSETS_DIR, 'playbooks', file)
  const text = await readText(path, null)
  if (text === null) throw new EquityError('preset_missing', `预设不存在：${name}`, { name })
  return parsePlaybook(text, path)
}

/** List presets with counts. */
export async function listPresets() {
  const names = ['skill-only', 'quick', 'standard', 'deep', 'generic']
  const out = []
  for (const name of names) {
    try {
      const playbook = await loadPreset(name)
      out.push({
        name,
        id: playbook.id,
        title: playbook.name,
        moduleCount: playbook.modules.length,
        modules: playbook.modules.map((module) => module.use ?? module.id),
      })
    } catch (error) {
      out.push({ name, error: error.message })
    }
  }
  return out
}

/** Parse a playbook from YAML or JSON text. */
export function parsePlaybook(text, source = 'playbook') {
  let value
  if (text.trimStart().startsWith('{')) value = JSON.parse(text)
  else value = parseYamlObject(text, source)
  if (value.apiVersion !== PLAYBOOK_API) {
    throw new EquityError('bad_api_version', `playbook apiVersion 必须为 ${PLAYBOOK_API}`, { source })
  }
  if (!value.id || !value.name || !value.version) {
    throw new EquityError('missing_field', 'playbook 缺少 id/name/version', { source })
  }
  if (!Array.isArray(value.modules) || value.modules.length === 0) {
    throw new EquityError('missing_field', 'playbook.modules 至少一项', { source })
  }
  const ids = new Set()
  const modules = value.modules.map((module, index) => {
    if (!isPlainObject(module)) throw new EquityError('invalid_playbook', `modules[${index}] 必须是对象`, { source })
    if (!module.id || !module.use) throw new EquityError('invalid_playbook', `modules[${index}] 缺少 id/use`, { source })
    if (ids.has(module.id)) throw new EquityError('duplicate_id', `模块实例 id 重复：${module.id}`, { source })
    ids.add(module.id)
    return {
      ...module,
      params: module.params ?? {},
      enabled: module.enabled !== false,
      order: index,
    }
  })
  return {
    ...value,
    modules,
    stages: value.stages ?? [],
    budget: value.budget ?? {},
  }
}

/** Read a project playbook file (YAML or JSON). */
export async function readPlaybookFile(file) {
  const text = await readText(file, null)
  if (text === null) throw new EquityError('playbook_missing', `方案文件不存在：${file}`)
  return parsePlaybook(text, file)
}

/** Serialize a playbook for disk. */
export function playbookToText(playbook) {
  return JSON.stringify(playbook, null, 2) + '\n'
}

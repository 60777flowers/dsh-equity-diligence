import { mkdir, readdir, rename, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { EquityError, isPlainObject, newId, semanticHash, shortHash } from '../util/json.js'
import {
  atomicWriteJson,
  atomicWriteText,
  ensureDir,
  readJson,
  readText,
  statOrNull,
} from '../util/fs.js'
import { nowIso, today } from '../util/time.js'
import { projectIdFor, slugify } from '../util/ids.js'
import { ASSETS_DIR, loadPreset, playbookToText, projectsIndexPath, readPlaybookFile } from './registry.js'
import { recordSystemArtifact } from './artifacts.js'

export const PROJECT_SCHEMA_VERSION = 1

export function projectFile(root) {
  return join(root, 'project.json')
}

export function playbookFile(root) {
  return join(root, 'playbook.yaml')
}

/** Normalize targets from tool/UI input. */
export function normalizeTargets(input = {}) {
  const candidates = []
  if (Array.isArray(input.targets)) candidates.push(...input.targets)
  if (Array.isArray(input.target)) candidates.push(...input.target)
  if (typeof input.target === 'string' && input.target.trim()) candidates.push({ name: input.target.trim() })
  if (typeof input.name === 'string' && candidates.length === 0) candidates.push({ name: input.name })
  if (typeof input.code === 'string' && candidates.length === 1) candidates[0].code = input.code
  const out = []
  const seen = new Set()
  for (const item of candidates) {
    const target = typeof item === 'string' ? { name: item } : item
    if (!isPlainObject(target) || !target.name) continue
    const key = String(target.name).trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    const normalized = {
      name: String(target.name).trim(),
      type: target.type ?? 'corporate',
      jurisdiction: target.jurisdiction ?? input.jurisdiction ?? 'CN',
      status: target.status ?? 'target',
    }
    if (target.code) normalized.code = String(target.code).trim()
    if (target.market) normalized.market = String(target.market).trim()
    out.push(normalized)
  }
  if (out.length === 0) {
    throw new EquityError('missing_target', '至少需要一个调查目标（公司名称）')
  }
  return out
}

function defaultEngagement(input = {}, target) {
  return {
    client: input.client ?? 'example',
    clientName: input.clientName || '委托方',
    purpose: input.purpose ?? 'pre-deal public-information investigation',
    asOf: input.asOf ?? today(),
    currency: input.currency ?? 'CNY',
    materiality: input.materiality ?? '以影响合作判断的事项为 material；其余为 attention',
    targetType: input.targetType ?? target.type ?? 'corporate',
    listingStatus: input.listingStatus ?? (target.code ? 'listed' : 'unknown'),
    jurisdiction: input.jurisdiction ?? target.jurisdiction ?? 'CN',
    consolidationPerimeter: input.consolidationPerimeter ?? '以公告/工商口径为准，未特别说明按合并口径',
    accountingStandard: input.accountingStandard ?? 'CAS',
    lookbackYears: Number(input.lookbackYears ?? 3),
    sourcePack: input.sourcePack ?? 'cn-public',
    mode: input.mode ?? 'standard',
  }
}

/** Default project directory under a workspace. */
export function defaultProjectRoot(workspaceRoot, name) {
  return join(workspaceRoot, 'equity-projects', slugify(name))
}

/** Write a client profile placeholder or copy the bundled example profile. */
async function ensureClientProfile(root, engagement, profileText = undefined) {
  const dir = join(root, '00_基准')
  await ensureDir(dir)
  const file = join(dir, '委托方背景.md')
  const existing = await readText(file, null)
  if (existing !== null && existing.trim()) return file
  let text = profileText
  if (text === undefined) {
    text = await readText(join(ASSETS_DIR, 'profiles', `${engagement.client}.md`), null)
  }
  if (text === null) {
    text = `# 委托方背景：${engagement.clientName}\n\n> 本文件由项目创建时生成。请补充委托方技术要点、合作评估口径与禁区。\n\n## 技术要点\n\n- 待补充\n\n## 合作评估口径（a/b/c/d）\n\n- a：待补充\n- b：待补充\n- c：待补充\n- d：待补充\n`
  }
  await atomicWriteText(file, text)
  return file
}

/** Read/update the cross-project index. This is an index, not domain truth. */
async function readProjectIndex() {
  return readJson(projectsIndexPath(), { version: 1, projects: {} })
}

async function writeProjectIndex(index) {
  await ensureDir(join(projectsIndexPath(), '..'))
  await atomicWriteJson(projectsIndexPath(), index)
}

export async function upsertProjectIndex(project) {
  const index = await readProjectIndex()
  index.projects = index.projects ?? {}
  index.projects[project.projectId] = {
    projectId: project.projectId,
    name: project.name,
    root: project.root,
    preset: project.preset,
    status: project.status ?? 'active',
    targets: (project.targets ?? []).map((target) => target.name),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
  await writeProjectIndex(index)
  return index
}

export async function removeProjectIndex(projectId) {
  const index = await readProjectIndex()
  if (index.projects?.[projectId]) {
    delete index.projects[projectId]
    await writeProjectIndex(index)
  }
}

/** List indexed projects, dropping entries whose project.json disappeared. */
export async function listProjects() {
  const index = await readProjectIndex()
  const out = []
  for (const entry of Object.values(index.projects ?? {})) {
    const manifest = await readJson(projectFile(entry.root), null)
    if (!manifest) continue
    out.push({
      ...entry,
      status: manifest.status ?? entry.status,
      updatedAt: manifest.updatedAt ?? entry.updatedAt,
    })
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/**
 * Create a project skeleton and bootstrap the project-level roster artifact.
 */
export async function createProject(options = {}) {
  const targets = normalizeTargets(options)
  const root = resolve(
    (typeof options.root === 'string' && options.root.trim() ? options.root : undefined)
      ?? defaultProjectRoot(process.cwd(), targets[0].name),
  )
  const existing = await readJson(projectFile(root), null)
  if (existing && !options.overwrite) {
    throw new EquityError('project_exists', `项目已存在：${root}`, { root })
  }
  await ensureDir(root)
  await ensureDir(join(root, '00_基准'))
  await ensureDir(join(root, '05_交付'))
  await ensureDir(join(root, '.equity'))

  const now = nowIso()
  const projectId = options.projectId ?? `${projectIdFor(targets[0].name)}_${shortHash(root, 6)}`
  const engagement = defaultEngagement(options.engagement ?? options, targets[0])
  const preset = options.preset ?? engagement.mode ?? 'standard'
  let playbook
  if (options.playbook) {
    playbook = typeof options.playbook === 'string' ? await readPlaybookFile(options.playbook) : options.playbook
  } else {
    playbook = await loadPreset(preset)
  }
  const clientProfileFile = await ensureClientProfile(root, engagement, options.clientProfileText)
  const project = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId,
    name: options.name ?? `${targets[0].name} · 公开信息调查`,
    root,
    status: 'active',
    preset,
    playbookId: playbook.id,
    engagement,
    targets,
    engine: {
      executor: options.executor ?? 'private-agent',
      fallback: 'native-loop',
      provider: options.provider ?? null,
      model: options.model ?? null,
    },
    budget: options.budget ?? { maxTokens: 80_000_000, maxWallClockMin: 1440 },
    clientProfile: {
      id: engagement.client,
      ref: '00_基准/委托方背景.md',
      sha256: null,
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const profileText = await readText(clientProfileFile, '')
  project.clientProfile.sha256 = semanticHash(profileText)
  await atomicWriteJson(projectFile(root), project)
  await atomicWriteText(playbookFile(root), playbookToText(playbook))

  // Bootstrap the project-scope roster. The entity-resolution module consumes it.
  // The registry is loaded by the caller and passed as `library` when available;
  // otherwise a minimal roster is written without schema validation.
  if (options.library) {
    await recordSystemArtifact({
      root,
      library: options.library,
      type: 'company.roster',
      subjectId: 'project',
      partitionKey: '_default',
      asOf: engagement.asOf,
      moduleId: 'system/project-bootstrap',
      data: {
        targets,
        resolution: [],
        targetCount: targets.length,
        resolvedCount: 0,
      },
    })
  } else {
    await ensureDir(join(root, '.equity', 'artifacts', 'company.roster', 'project', '_default'))
  }

  await upsertProjectIndex(project)
  return openProject(root)
}

/** Open a project and load its playbook. */
export async function openProject(rootInput) {
  const root = resolve(rootInput)
  const project = await readJson(projectFile(root), null)
  if (!project) throw new EquityError('not_a_project', `不是有效项目（缺 project.json）：${root}`, { root })
  if (project.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new EquityError('schema_version', `项目 schemaVersion ${project.schemaVersion} 不受支持`, {
      root,
      expected: PROJECT_SCHEMA_VERSION,
    })
  }
  const playbook = await readPlaybookFile(playbookFile(root))
  return { root, project, playbook }
}

/** Save the project manifest with a new updatedAt. */
export async function saveProject(project) {
  const next = { ...project, updatedAt: nowIso() }
  await atomicWriteJson(projectFile(project.root), next)
  await upsertProjectIndex(next)
  return next
}

/** Save the playbook. */
export async function savePlaybook(root, playbook) {
  await atomicWriteText(playbookFile(root), playbookToText(playbook))
  const project = await readJson(projectFile(root), null)
  if (project) {
    project.playbookId = playbook.id
    project.preset = playbook.preset ?? project.preset
    await atomicWriteJson(projectFile(root), { ...project, updatedAt: nowIso() })
    await upsertProjectIndex({ ...project, updatedAt: nowIso() })
  }
  return playbook
}

/** Archive a project (does not delete files). */
export async function archiveProject(root) {
  const project = await readJson(projectFile(root), null)
  if (!project) throw new EquityError('not_a_project', `不是有效项目：${root}`)
  project.status = 'archived'
  project.updatedAt = nowIso()
  await atomicWriteJson(projectFile(root), project)
  await upsertProjectIndex(project)
  return project
}

/** Detect whether a directory looks like a legacy skill project. */
export async function detectLegacyProject(root) {
  const markers = ['01_平台收集', '02_实体收集', '04_批量调研', '05_交付']
  const found = []
  for (const marker of markers) {
    if (await statOrNull(join(root, marker))) found.push(marker)
  }
  return { legacy: found.length > 0, markers: found }
}

/** Copy a directory tree with a dry-run-friendly manifest. */
export async function listDirectory(root) {
  try {
    return await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

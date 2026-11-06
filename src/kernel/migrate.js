import { join } from 'node:path'

import { EquityError, newId, semanticHash } from '../util/json.js'
import { atomicWriteJson, atomicWriteText, ensureDir, hashFile, listFiles, readJson, readText, statOrNull } from '../util/fs.js'
import { nowIso, today } from '../util/time.js'
import { projectIdFor, slugify, subjectIdFor } from '../util/ids.js'
import { recordArtifact, recordSystemArtifact } from './artifacts.js'
import { playbookToText, loadPreset, projectsIndexPath } from './registry.js'
import { upsertProjectIndex } from './project.js'

function parseMarkdownTables(text) {
  const lines = String(text ?? '').split('\n')
  const tables = []
  let current = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) {
      if (current && current.rows.length > 0) tables.push(current)
      current = null
      continue
    }
    const cells = trimmed.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
    if (!current) current = { header: cells, rows: [] }
    else if (cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === '')) continue
    else current.rows.push(cells)
  }
  if (current && current.rows.length > 0) tables.push(current)
  return tables
}

function firstTableWith(text, keywords) {
  for (const table of parseMarkdownTables(text)) {
    if (keywords.some((keyword) => table.header.some((header) => header.includes(keyword)))) return table
  }
  return null
}

function tableToObjects(table) {
  if (!table) return []
  return table.rows
    .filter((row) => row.some(Boolean))
    .map((row) => Object.fromEntries(table.header.map((header, index) => [header, row[index] ?? ''])))
}

function pickByKey(object, keys) {
  for (const key of keys) {
    for (const actual of Object.keys(object)) {
      if (actual.includes(key)) return object[actual]
    }
  }
  return ''
}

async function importRoster({ root, library, project }) {
  const file = join(root, '01_平台收集', '平台汇总_工作稿.md')
  const text = await readText(file, null)
  if (!text) return []
  const table = firstTableWith(text, ['平台'])
  const rows = tableToObjects(table)
  if (rows.length === 0) return []
  const platforms = rows.map((row, index) => ({
    platformId: pickByKey(row, ['平台编号', '编号']) || `P${String(index + 1).padStart(2, '0')}`,
    name: pickByKey(row, ['平台全称', '平台名称', '平台/主体', '平台']) || `平台${index + 1}`,
    fullName: pickByKey(row, ['平台全称', '全称']),
    category: pickByKey(row, ['分类', '类型']) || '1',
    role: pickByKey(row, ['类型/角色', '角色']),
    vehicles: [],
    entities: [],
    note: pickByKey(row, ['备注', '时间/备注']),
  }))
  const asOf = project.engagement?.asOf ?? today()
  const summary = {
    asOf,
    openQuestions: ['迁移导入：平台/实体明细未重新核验，需人工复核'],
    flags: [{ level: 'attention', rule: 'legacy_import', desc: '旧项目迁移导入，未经本轮重新核验' }],
    sourceCoverage: { queries: [], databases: ['legacy_import'], retrievedAt: nowIso(), limitations: ['原文件保留，底稿为 draft'] },
    claims: [],
    evidence: [],
    data: {
      mode: 'summary',
      platformCount: platforms.length,
      entityCount: 0,
      overseasCount: 0,
      categories: [],
      platforms,
    },
  }
  await recordArtifact({
    root,
    library,
    type: 'investment.map',
    subjectId: project.targets?.[0] ? subjectIdFor('co', project.targets[0].name) : 'project',
    partitionKey: '_summary',
    output: summary,
    producedBy: { moduleId: 'migration/legacy', moduleVersion: '1.0.0', actor: 'import' },
    status: 'draft',
    actor: 'import',
  })
  return platforms
}

async function importResearchResults({ root, library, project }) {
  const dir = join(root, '04_批量调研', 'results')
  const files = await listFiles(dir, { filter: (file) => file.endsWith('.json'), maxDepth: 2 })
  const imported = []
  for (const file of files) {
    const data = await readJson(file, null)
    if (!data) continue
    const company = data.company ?? data.name ?? data.公司名称 ?? file.split(/[\\/]/).pop().replace(/\.json$/, '')
    const subjectId = subjectIdFor('co', company)
    const findings = []
    const fields = data.fields ?? data
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === undefined) continue
      if (typeof value === 'object' && value.status) {
        findings.push({
          claim: key,
          value: value.value ?? value.status,
          evidenceIds: value.sources ?? [],
          confidence: value.confidence ?? 'low',
          openQuestions: value.status === 'not_found' ? [String(value.note ?? '')] : [],
        })
      } else if (['string', 'number', 'boolean'].includes(typeof value)) {
        findings.push({ claim: key, value, evidenceIds: [], confidence: 'low', openQuestions: [] })
      }
    }
    if (findings.length === 0) continue
    await recordArtifact({
      root,
      library,
      type: 'structured.findings',
      subjectId,
      partitionKey: slugify(data.company ?? company),
      output: {
        asOf: data.researchedAt?.slice(0, 10) ?? project.engagement?.asOf ?? today(),
        openQuestions: ['迁移导入：字段未逐条重新核验'],
        flags: [{ level: 'attention', rule: 'legacy_import', desc: '旧 results JSON 迁移导入' }],
        sourceCoverage: { queries: [], databases: ['legacy_import'], retrievedAt: nowIso(), limitations: ['原文件保留'] },
        claims: [],
        evidence: [],
        data: { question: `旧项目迁移：${company}`, findings },
      },
      producedBy: { moduleId: 'migration/legacy', moduleVersion: '1.0.0', actor: 'import' },
      status: 'draft',
      actor: 'import',
    })
    imported.push({ company, file })
  }
  return imported
}

async function importDeliverables({ root, library, project }) {
  const dir = join(root, '05_交付')
  const files = await listFiles(dir, { maxDepth: 1 })
  const xlsx = files.filter((file) => file.toLowerCase().endsWith('.xlsx'))
  if (xlsx.length === 0) return []
  const dataFiles = []
  for (const file of xlsx) {
    const info = await statOrNull(file)
    dataFiles.push({ path: file.replace(root, '').replaceAll('\\', '/'), sha256: await hashFile(file), kind: 'xlsx_import', size: info?.size ?? 0 })
  }
  await recordArtifact({
    root,
    library,
    type: 'report.deliverable',
    subjectId: 'project',
    partitionKey: '_default',
    output: {
      asOf: project.engagement?.asOf ?? today(),
      openQuestions: ['迁移导入：旧交付件未重新体检'],
      flags: [{ level: 'attention', rule: 'legacy_import', desc: '旧交付件迁移导入' }],
      sourceCoverage: { queries: [], databases: ['legacy_import'], retrievedAt: nowIso(), limitations: [] },
      claims: [],
      evidence: [],
      data: { generatedAt: nowIso(), files: dataFiles, summaryFindings: [], qa: { blocking: 0, warnings: 1, passed: false }, signoff: {} },
    },
    producedBy: { moduleId: 'migration/legacy', moduleVersion: '1.0.0', actor: 'import' },
    status: 'draft',
    actor: 'import',
  })
  return xlsx
}

/**
 * Migrate a legacy project directory in place: create project.json, import
 * readable ledgers/results, keep every original file untouched.
 */
export async function migrateLegacyProject({ root, library, targetName = undefined, dryRun = false }) {
  const markers = ['01_平台收集', '02_实体收集', '04_批量调研', '05_交付']
  const found = []
  for (const marker of markers) if (await statOrNull(join(root, marker))) found.push(marker)
  if (found.length === 0) throw new EquityError('not_legacy', `目录中没有旧项目标记：${root}`)
  if (await statOrNull(join(root, 'project.json'))) {
    throw new EquityError('project_exists', `已有 project.json，拒绝覆盖：${root}`)
  }
  const name = targetName ?? root.split(/[\\/]/).filter(Boolean).pop() ?? 'legacy-project'
  const projectId = `${projectIdFor(name)}_${semanticHash(root).slice(-6)}`
  const targets = [{ name, type: 'corporate', jurisdiction: 'CN', status: 'target' }]
  const engagement = {
    client: 'example',
    clientName: '委托方',
    purpose: 'legacy migration',
    asOf: today(),
    currency: 'CNY',
    materiality: '以影响合作判断的事项为 material；其余为 attention',
    targetType: 'corporate',
    listingStatus: 'unknown',
    jurisdiction: 'CN',
    consolidationPerimeter: '以公告/工商口径为准',
    accountingStandard: 'CAS',
    lookbackYears: 3,
    sourcePack: 'cn-public',
    mode: 'skill-only',
  }
  if (dryRun) {
    return { ok: true, dryRun: true, root, markers: found, projectId, targets }
  }
  const project = {
    schemaVersion: 1,
    projectId,
    name: `${name} · 旧项目迁移`,
    root,
    status: 'active',
    preset: 'skill-only',
    playbookId: 'skill-only',
    engagement,
    targets,
    engine: { executor: 'fixture', fallback: 'native-loop', provider: null, model: null },
    budget: { maxTokens: 0, maxWallClockMin: 0 },
    clientProfile: { id: 'example', ref: '00_基准/委托方背景.md', sha256: null },
    migratedFrom: { markers: found, migratedAt: nowIso() },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  await ensureDir(root)
  await atomicWriteJson(join(root, 'project.json'), project)
  const preset = await loadPreset('skill-only')
  await atomicWriteText(join(root, 'playbook.yaml'), playbookToText(preset))
  if (library) {
    await recordSystemArtifact({
      root,
      library,
      type: 'company.roster',
      subjectId: 'project',
      partitionKey: '_default',
      asOf: engagement.asOf,
      moduleId: 'system/project-bootstrap',
      data: { targets, resolution: [], targetCount: targets.length, resolvedCount: 0 },
    })
  }
  const platforms = library ? await importRoster({ root, library, project }) : []
  const results = library ? await importResearchResults({ root, library, project }) : []
  const deliverables = library ? await importDeliverables({ root, library, project }) : []
  await upsertProjectIndex(project)
  return {
    ok: true,
    projectId,
    root,
    markers: found,
    imported: { platforms: platforms.length, results: results.length, deliverables: deliverables.length },
    warnings: ['迁移底稿均为 draft/actor=import，未重新核验前不得 verified', '原文件未修改'],
  }
}

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

import { readJson } from '../util/fs.js'
import { PACKAGE_ROOT } from '../kernel/registry.js'

const execFileAsync = promisify(execFile)

const SEVEN_N_FIXED = [
  '1-直接投资',
  '2-合作基金-GP',
  '3-合作基金-主导LP',
  '4-合作基金-财务LP',
  '5-海外平台',
  '6-合资公司',
  '7-国内基地',
]

const COMPREHENSIVE_SHEETS = [
  '00_目录',
  '01_执行摘要',
  '02_主体与股权',
  '03_业务与技术',
  '04_财务',
  '05_风险',
  '06_待核清单',
  '07_资料请求',
  '08_来源索引',
  '09_模块底稿索引',
  '10_体检单',
]

const SEVEN_N_RAW_HEADERS = [
  '平台/主体', '类型/角色', '股权结构/出资', '战投定位/协同方向', '时间/备注',
  '公司名称', '调查时间', '审核状态', '最新融资轮次和情况', '第一大股东持股比例(%)',
  '前5大股东合计持股比例(%)', '股东数目', '创始团队是否实控', '创始团队背景',
  '产业链环节', '扩产周期', '产业景气度', '产品毛利率', '该公司行业排名(国际/国内)',
  '是否与委托方技术有关联、有合作潜力', '历史融资总额', '投资合作评估（重点字段）',
  '数据质量说明', '结果JSON文件',
]
// 交付清理版删除原第 7/8/23/24 列，剩 20 列。
const SEVEN_N_HEADERS = [...SEVEN_N_RAW_HEADERS.slice(0, 6), ...SEVEN_N_RAW_HEADERS.slice(8, 22)]

function check(id, ok, detail, blocking = false) {
  return { id, status: ok ? 'pass' : blocking ? 'fail' : 'warn', detail }
}

async function inspect(file) {
  const python = process.env.EQUITY_PYTHON || process.env.PYTHON || 'python'
  const jsonFile = file.replace(/\.xlsx$/i, '.inspect.json')
  try {
    await execFileAsync(python, [join(PACKAGE_ROOT, 'python', 'inspect_workbook.py'), '--file', file, '--json', jsonFile], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    })
    return readJson(jsonFile, null)
  } catch {
    return null
  }
}

/**
 * Delivery QA. Risk content never blocks; consistency and traceability do.
 */
export async function validateDelivery({ outDir, artifacts, claims, evidence, findings, workbookMap, meta }) {
  const blocking = []
  const warnings = []
  const checks = []
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]))
  const claimById = new Map(claims.map((item) => [item.claimId, item]))

  const summaryPath = join(outDir, '01_管理层摘要.md')
  const { statOrNull } = await import('../util/fs.js')
  const summaryStat = await statOrNull(summaryPath)
  checks.push(check('summary_exists', Boolean(summaryStat), summaryStat ? '01_管理层摘要.md 存在' : '缺少管理层摘要', true))
  if (!summaryStat) blocking.push({ id: 'summary_exists', message: '缺少 01_管理层摘要.md' })

  const materialClaims = claims.filter((claim) => claim.materiality === 'material')
  const unsupported = materialClaims.filter((claim) => !(claim.evidenceLinks ?? []).some((link) => link.role === 'supports'))
  checks.push(check('material_evidence', unsupported.length === 0, unsupported.length ? `${unsupported.length} 条 material claim 无 supports 证据` : 'material claim 均有 supports 证据', true))
  if (unsupported.length > 0) blocking.push({ id: 'material_evidence', message: `${unsupported.length} 条 material claim 无 supports 证据` })

  const findingsWithClaim = findings.filter((finding) => finding.claimId)
  const danglingClaims = findingsWithClaim.filter((finding) => !claimById.has(finding.claimId))
  checks.push(check('finding_claims', danglingClaims.length === 0, danglingClaims.length ? `${danglingClaims.length} 条摘要结论引用了不存在的 claimId` : '摘要结论 claimId 均存在', true))
  if (danglingClaims.length > 0) blocking.push({ id: 'finding_claims', message: '摘要结论引用了不存在的 claimId' })

  const stale = artifacts.filter((artifact) => artifact.status === 'stale')
  const rejected = artifacts.filter((artifact) => artifact.status === 'rejected')
  checks.push(check('stale', stale.length === 0, stale.length ? `${stale.length} 份底稿 stale，需重跑或 waiver` : '无 stale', true))
  if (stale.length > 0) blocking.push({ id: 'stale', message: `${stale.length} 份底稿 stale` })
  checks.push(check('rejected', rejected.length === 0, rejected.length ? `${rejected.length} 份底稿 rejected` : '无 rejected', true))
  if (rejected.length > 0) blocking.push({ id: 'rejected', message: `${rejected.length} 份底稿 rejected` })

  const pinned = findingsWithClaim.filter((finding) => {
    const claim = claimById.get(finding.claimId)
    return !claim?.artifactId || !claim?.artifactRevision || !claim?.artifactContentHash
  })
  checks.push(check('cellmap_pin', pinned.length === 0, pinned.length ? `${pinned.length} 条结论未 pin artifact revision/hash` : '结论已 pin artifact revision/hash', true))
  if (pinned.length > 0) blocking.push({ id: 'cellmap_pin', message: '摘要结论未 pin artifact revision/hash' })

  const map = workbookMap ?? {}
  const comprehensiveNames = (map.sheets ?? [])
    .filter((sheet) => sheet.file === '02' || sheet.file === undefined)
    .map((sheet) => sheet.name)
  const fallbackNames = (map.comprehensive?.sheets ?? []).map((sheet) => sheet.name)
  const namesToCheck = comprehensiveNames.length > 0 ? comprehensiveNames : fallbackNames
  const hasAllComprehensive = COMPREHENSIVE_SHEETS.every((name) => namesToCheck.includes(name))
  checks.push(check('workbook_structure', hasAllComprehensive, hasAllComprehensive ? '综合工作簿 11 个 sheet 齐全' : `综合工作簿缺 sheet：${COMPREHENSIVE_SHEETS.filter((name) => !namesToCheck.includes(name)).join(', ')}`, true))
  if (!hasAllComprehensive) blocking.push({ id: 'workbook_structure', message: '综合工作簿结构不完整' })

  const hasSevenN = Boolean(map.sevenN?.sheetOrder?.length || map.sevenN?.sheets?.length || map.files?.some((file) => file.key === '03'))
  if (hasSevenN) {
    const names = map.sevenN?.sheetOrder ?? (map.sevenN?.sheets ?? []).map((sheet) => sheet.name)
    const missingFixed = SEVEN_N_FIXED.filter((name) => !names.some((actual) => actual === name || actual.startsWith(name)))
    checks.push(check('seven_n_fixed', missingFixed.length === 0, missingFixed.length ? `7+N 缺固定表：${missingFixed.join(', ')}` : '7+N 固定表齐全', true))
    if (missingFixed.length > 0) blocking.push({ id: 'seven_n_fixed', message: '7+N 固定表不完整' })
    const expected = SEVEN_N_HEADERS.slice(0, 20)
    const actual = (map.sevenN?.headers ?? map.sevenN?.sheets?.[0]?.headers ?? []).slice(0, 20)
    const headerOk = expected.every((header, index) => actual[index] === header)
    checks.push(check('seven_n_headers', headerOk, headerOk ? '7+N 清理版 20 列表头逐字一致' : '7+N 表头与契约不一致', true))
    if (!headerOk) blocking.push({ id: 'seven_n_headers', message: '7+N 表头不一致' })
  } else {
    checks.push(check('seven_n_fixed', true, '无 investment.map 交付件，跳过 7+N', false))
  }

  const inspections = []
  for (const [kind, file] of [
    ['comprehensive', join(outDir, '02_综合尽调工作簿.xlsx')],
    ['sevenN', join(outDir, '03_专项_投资版图_7+N.xlsx')],
  ]) {
    if (await statOrNull(file)) {
      const data = await inspect(file)
      if (data) inspections.push({ kind, data })
    }
  }
  const formulaErrors = inspections.flatMap((item) => (item.data.formulaErrors ?? []).map((error) => ({ ...error, workbook: item.kind })))
  checks.push(check('formula_errors', formulaErrors.length === 0, formulaErrors.length ? `${formulaErrors.length} 个公式错误` : '无公式错误', true))
  if (formulaErrors.length > 0) blocking.push({ id: 'formula_errors', message: '工作簿存在公式错误' })

  const emptyHeaders = inspections.flatMap((item) => item.data.emptyHeaders ?? [])
  const duplicateHeaders = inspections.flatMap((item) => item.data.duplicateHeaders ?? [])
  checks.push(check('headers', emptyHeaders.length === 0 && duplicateHeaders.length === 0, emptyHeaders.length || duplicateHeaders.length ? '存在空表头/重复表头' : '表头完整', true))
  if (emptyHeaders.length > 0 || duplicateHeaders.length > 0) blocking.push({ id: 'headers', message: '表头空/重复' })

  const revised = artifacts.filter((artifact) => artifact.producedBy?.actor === 'import' && artifact.status === 'verified')
  checks.push(check('import_not_verified', revised.length === 0, revised.length ? `${revised.length} 份导入底稿被标 verified` : '导入底稿未被自动 verified', true))
  if (revised.length > 0) blocking.push({ id: 'import_not_verified', message: '导入底稿不得自动 verified' })

  if (meta?.partial) warnings.push({ id: 'partial', message: '报告为 scope-limited / partial，必须向读者明示缺口' })
  if (!meta?.signoff?.reviewedBy) warnings.push({ id: 'review_pending', message: '尚未完成 reviewedBy 复核' })
  if (evidence.length === 0) warnings.push({ id: 'no_evidence', message: '交付包没有证据快照' })

  return {
    passed: blocking.length === 0,
    blocking,
    warnings,
    checks,
    inspections,
    summary: {
      artifactCount: artifacts.length,
      claimCount: claims.length,
      evidenceCount: evidence.length,
      staleCount: stale.length,
      rejectedCount: rejected.length,
    },
  }
}

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, join } from 'node:path'

import { readJson, readText, listFiles, portableRelative, statOrNull } from '../util/fs.js'
import { PACKAGE_ROOT } from '../kernel/registry.js'
import {
  NON_BUSINESS_ARTIFACT_TYPES,
  REBUILDABLE_OUTPUT_TYPES,
  SIX_STATES,
  workpaperRelativePath,
} from './delivery-common.js'

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

const FIELD_SHEETS = new Set(['02_主体与股权', '03_业务与技术', '04_财务', '05_风险'])

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

const PLACEHOLDER = '未提供/not_reviewed'

function check(id, ok, detail, blocking = false) {
  return { id, status: ok ? 'pass' : blocking ? 'fail' : 'warn', detail }
}

function isPlaceholder(value) {
  const text = String(value ?? '').trim()
  return text === '' || text === '未提供' || text === PLACEHOLDER
}

function asList(value) {
  return Array.isArray(value) ? value : []
}

async function inspect(file, tmpDir) {
  const python = process.env.EQUITY_PYTHON || process.env.PYTHON || 'python'
  const jsonFile = join(tmpDir, `${basename(file).replace(/\.xlsx$/i, '')}.inspect.json`)
  try {
    await execFileAsync(python, [join(PACKAGE_ROOT, 'python', 'inspect_workbook.py'), '--file', file, '--json', jsonFile], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    })
    return await readJson(jsonFile, null)
  } catch {
    return await readJson(jsonFile, null)
  }
}

/** Run the independent Python checker and merge its blocking/warnings into QA. */
async function runDeliveryChecker(outDir, tmpDir) {
  const python = process.env.EQUITY_PYTHON || process.env.PYTHON || 'python'
  const jsonFile = join(tmpDir, 'check-deliverable.json')
  try {
    await execFileAsync(python, [join(PACKAGE_ROOT, 'python', 'check_deliverable.py'), '--dir', outDir, '--json', jsonFile], {
      maxBuffer: 128 * 1024 * 1024,
      timeout: 180_000,
      windowsHide: true,
    })
  } catch {
    // Exit code 1 means "blocking findings"; the JSON is still written.
  }
  return await readJson(jsonFile, null)
}

/**
 * Delivery QA. Risk content never blocks; consistency, evidence and traceability do.
 */
export async function validateDelivery({
  root, // eslint-disable-line no-unused-vars
  outDir,
  qaDir = join(outDir, '.qa'),
  artifacts = [],
  verifiedArtifacts = undefined,
  allArtifacts = [],
  claims = [],
  evidence = [],
  findings = [],
  workbookMap = null,
  comprehensive = [],
  meta = {},
  signoff = {},
  full = true,
}) {
  const blocking = []
  const warnings = []
  const checks = []
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]))
  const claimById = new Map(claims.map((item) => [item.claimId, item]))
  const block = (id, message) => blocking.push({ id, message })

  // ---------------------------------------------------------------- files
  const summaryPath = join(outDir, '01_管理层摘要.md')
  const summaryStat = await statOrNull(summaryPath)
  checks.push(check('summary_exists', Boolean(summaryStat), summaryStat ? '01_管理层摘要.md 存在' : '缺少管理层摘要', true))
  if (!summaryStat) block('summary_exists', '缺少 01_管理层摘要.md')

  for (const name of ['00_范围与口径.md']) {
    const exists = Boolean(await statOrNull(join(outDir, name)))
    checks.push(check(`file:${name}`, exists, exists ? `${name} 存在` : `缺少 ${name}`, true))
    if (!exists) block('file_missing', `缺少 ${name}`)
  }

  // ------------------------------------------------------------- artifacts
  const verified = artifacts.filter((artifact) => artifact.status === 'verified')
  const business = verified.filter((artifact) => !NON_BUSINESS_ARTIFACT_TYPES.has(artifact.type))
  const noArtifacts = verified.length === 0
  checks.push(check('no_artifacts', !noArtifacts, noArtifacts ? '没有任何 verified 底稿' : `verified 底稿 ${verified.length} 份`, true))
  if (noArtifacts) block('no_artifacts', '没有任何 verified 底稿，交付包为空壳')
  const noBusiness = business.length === 0
  checks.push(check('no_business_artifacts', !noBusiness, noBusiness ? '没有业务底稿（仅有系统台账/上一轮产物）' : `业务底稿 ${business.length} 份`, true))
  if (noBusiness) block('no_business_artifacts', '没有已验证的业务底稿，不能交付')

  const currentAll = allArtifacts.length > 0 ? allArtifacts : verified
  const unverifiedInputs = currentAll.filter(
    (artifact) => artifact.status !== 'verified' && !REBUILDABLE_OUTPUT_TYPES.has(artifact.type),
  )
  const unverifiedDetail = ['draft', 'stale', 'rejected']
    .map((status) => {
      const count = unverifiedInputs.filter((artifact) => artifact.status === status).length
      return count > 0 ? `${count} 份 ${status}` : null
    })
    .filter(Boolean)
    .join('，')
  checks.push(check('unverified_artifacts', unverifiedInputs.length === 0, unverifiedInputs.length ? `存在未核验底稿：${unverifiedDetail}，不得进入交付` : '无 draft/stale/rejected 输入底稿', true))
  if (unverifiedInputs.length > 0) block('unverified_artifacts', `存在未核验底稿（${unverifiedDetail}），draft/stale/rejected 不得进入交付`)

  // A current record can claim `verified` while its verified.json pointer is
  // absent (crash window, manual cleanup, old migration). Such a record is not
  // returned by listVerifiedArtifacts and would otherwise disappear from the
  // package without any QA signal.
  const released = new Set((verifiedArtifacts ?? artifacts).map((artifact) => `${artifact.id}@${artifact.revision}#${artifact.contentHash}`))
  const verifiedWithoutPointer = currentAll.filter(
    (artifact) => artifact.status === 'verified'
      && !released.has(`${artifact.id}@${artifact.revision}#${artifact.contentHash}`),
  )
  checks.push(check(
    'verified_pointer_missing',
    verifiedWithoutPointer.length === 0,
    verifiedWithoutPointer.length
      ? `存在 current=verified 但 verified 指针缺失/不一致的底稿：${verifiedWithoutPointer.map((artifact) => `${artifact.id}(${artifact.type}@${artifact.revision})`).join(', ')}`
      : '所有 current=verified 底稿均有匹配的 verified 指针',
    true,
  ))
  if (verifiedWithoutPointer.length > 0) {
    block('verified_pointer_missing', `current=verified 但 verified 指针缺失：${verifiedWithoutPointer.map((artifact) => `${artifact.id}(${artifact.type}@${artifact.revision})`).join(', ')}；不能静默丢弃`)
  }

  // ------------------------------------------------------- claims/evidence
  const materialClaims = claims.filter((claim) => claim.materiality === 'material')
  const unsupported = materialClaims.filter((claim) => !(claim.evidenceLinks ?? []).some((link) => link.role === 'supports'))
  checks.push(check('material_evidence', unsupported.length === 0, unsupported.length ? `${unsupported.length} 条 material claim 无 supports 证据` : 'material claim 均有 supports 证据', true))
  if (unsupported.length > 0) block('material_evidence', `${unsupported.length} 条 material claim 无 supports 证据`)

  const findingsWithClaim = findings.filter((finding) => finding.claimId)
  const danglingClaims = findingsWithClaim.filter((finding) => !claimById.has(finding.claimId))
  checks.push(check('finding_claims', danglingClaims.length === 0, danglingClaims.length ? `${danglingClaims.length} 条摘要结论引用了不存在的 claimId` : '摘要结论 claimId 均存在', true))
  if (danglingClaims.length > 0) block('finding_claims', '摘要结论引用了不存在的 claimId')

  const stale = verified.filter((artifact) => artifact.status === 'stale')
  const rejected = verified.filter((artifact) => artifact.status === 'rejected')
  checks.push(check('stale', stale.length === 0, stale.length ? `${stale.length} 份底稿 stale，需重跑或 waiver` : '无 stale', true))
  if (stale.length > 0) block('stale', `${stale.length} 份底稿 stale`)
  checks.push(check('rejected', rejected.length === 0, rejected.length ? `${rejected.length} 份底稿 rejected` : '无 rejected', true))
  if (rejected.length > 0) block('rejected', `${rejected.length} 份底稿 rejected`)

  const noEvidence = evidence.length === 0
  checks.push(check('no_evidence', !noEvidence, noEvidence ? '交付包没有任何证据' : `证据 ${evidence.length} 条`, true))
  if (noEvidence) block('no_evidence', '交付包没有任何证据，结论不可追溯')

  const danglingEvidence = claims.flatMap((claim) =>
    (claim.evidenceLinks ?? [])
      .filter((link) => link?.evidenceId && !evidenceById.has(link.evidenceId))
      .map((link) => `${claim.claimId}→${link.evidenceId}`),
  )
  checks.push(check('dangling_evidence', danglingEvidence.length === 0, danglingEvidence.length ? `${danglingEvidence.length} 条 claim 引用不存在的证据` : 'claim 证据引用均可解析', true))
  if (danglingEvidence.length > 0) block('dangling_evidence', `${danglingEvidence.length} 条 claim 引用不存在的证据`)

  const pinned = findingsWithClaim.filter((finding) => {
    const claim = claimById.get(finding.claimId)
    return !claim?.artifactId || !claim?.artifactRevision || !claim?.artifactContentHash
  })
  checks.push(check('cellmap_pin', pinned.length === 0, pinned.length ? `${pinned.length} 条结论未 pin artifact revision/hash` : '结论已 pin artifact revision/hash', true))
  if (pinned.length > 0) block('cellmap_pin', '摘要结论未 pin artifact revision/hash')

  // -------------------------------------------------------------- workbook
  const map = workbookMap ?? {}
  const comprehensiveNames = (map.sheets ?? [])
    .filter((sheet) => sheet.file === '02' || sheet.file === undefined)
    .map((sheet) => sheet.name)
  const fallbackNames = (map.comprehensive?.sheets ?? []).map((sheet) => sheet.name)
  const namesToCheck = comprehensiveNames.length > 0 ? comprehensiveNames : fallbackNames
  const hasAllComprehensive = COMPREHENSIVE_SHEETS.every((name) => namesToCheck.includes(name))
  checks.push(check('workbook_structure', hasAllComprehensive, hasAllComprehensive ? '综合工作簿 11 个 sheet 齐全' : `综合工作簿缺 sheet：${COMPREHENSIVE_SHEETS.filter((name) => !namesToCheck.includes(name)).join(', ')}`, true))
  if (!hasAllComprehensive) block('workbook_structure', '综合工作簿结构不完整')

  const hasSevenN = Boolean(map.sevenN?.sheetOrder?.length || map.sevenN?.sheets?.length || map.files?.some((file) => file.key === '03'))
  if (hasSevenN) {
    const names = map.sevenN?.sheetOrder ?? (map.sevenN?.sheets ?? []).map((sheet) => sheet.name)
    const missingFixed = SEVEN_N_FIXED.filter((name) => !names.some((actual) => actual === name || actual.startsWith(name)))
    checks.push(check('seven_n_fixed', missingFixed.length === 0, missingFixed.length ? `7+N 缺固定表：${missingFixed.join(', ')}` : '7+N 固定表齐全', true))
    if (missingFixed.length > 0) block('seven_n_fixed', '7+N 固定表不完整')
    const expected = SEVEN_N_HEADERS.slice(0, 20)
    const actual = (map.sevenN?.headers ?? map.sevenN?.sheets?.[0]?.headers ?? []).slice(0, 20)
    const headerOk = expected.every((header, index) => actual[index] === header)
    checks.push(check('seven_n_headers', headerOk, headerOk ? '7+N 清理版 20 列表头逐字一致' : '7+N 表头与契约不一致', true))
    if (!headerOk) block('seven_n_headers', '7+N 表头不一致')
  } else {
    checks.push(check('seven_n_fixed', true, '无 investment.map 交付件，跳过 7+N', false))
  }

  const inspections = []
  if (full) {
    const expectedInspections = []
    for (const [kind, file] of [
      ['comprehensive', join(outDir, '02_综合尽调工作簿.xlsx')],
      ['sevenN', join(outDir, '03_专项_投资版图_7+N.xlsx')],
    ]) {
      if (await statOrNull(file)) {
        expectedInspections.push(kind)
        const data = await inspect(file, qaDir)
        if (data) inspections.push({ kind, data })
      }
    }
    if (inspections.length < expectedInspections.length) {
      checks.push(check('inspect_failed', false, '工作簿体检无法完成（inspect_workbook.py 未返回结果）', true))
      block('inspect_failed', '工作簿体检无法完成，公式/表头/结构未被核验')
    }
    const formulaErrors = inspections.flatMap((item) => (item.data.formulaErrors ?? []).map((error) => ({ ...error, workbook: item.kind })))
    checks.push(check('formula_errors', formulaErrors.length === 0, formulaErrors.length ? `${formulaErrors.length} 个公式错误` : '无公式错误', true))
    if (formulaErrors.length > 0) block('formula_errors', '工作簿存在公式错误')
    const inspectErrors = inspections.flatMap((item) =>
      (item.data.checks ?? []).filter((entry) => entry.status === 'error').map((entry) => `${item.kind}: ${entry.detail}`),
    )
    checks.push(check('inspect_structure', inspectErrors.length === 0, inspectErrors.length ? inspectErrors.slice(0, 5).join('；') : '工作簿结构体检通过', true))
    if (inspectErrors.length > 0) block('inspect_structure', `工作簿结构体检失败：${inspectErrors.slice(0, 5).join('；')}`)

    const emptyHeaders = inspections.flatMap((item) => item.data.emptyHeaders ?? [])
    const duplicateHeaders = inspections.flatMap((item) => item.data.duplicateHeaders ?? [])
    checks.push(check('headers', emptyHeaders.length === 0 && duplicateHeaders.length === 0, emptyHeaders.length || duplicateHeaders.length ? '存在空表头/重复表头' : '表头完整', true))
    if (emptyHeaders.length > 0 || duplicateHeaders.length > 0) block('headers', '表头空/重复')
  } else {
    checks.push(check('full_checks_deferred', true, '初步 QA 跳过大体量工作簿体检；写入 QA 后会重跑全量体检', false))
  }

  const revised = verified.filter((artifact) => artifact.producedBy?.actor === 'import')
  checks.push(check('import_not_verified', revised.length === 0, revised.length ? `${revised.length} 份导入底稿被标 verified` : '导入底稿未被自动 verified', true))
  if (revised.length > 0) block('import_not_verified', '导入底稿不得自动 verified')

  // ------------------------------------------------- 02–05 six-state rows
  const invalidStates = []
  const emptyFound = []
  const foundWithoutEvidence = []
  const fabricatedNone = []
  for (const sheet of comprehensive) {
    if (!FIELD_SHEETS.has(sheet?.name)) continue
    for (const row of asList(sheet.rows)) {
      if (!Array.isArray(row)) continue
      const [label, value, status, refs] = row
      const where = `${sheet.name}/${label}`
      if (!SIX_STATES.has(String(status ?? ''))) invalidStates.push(`${where}=${status ?? ''}`)
      if (status === 'found' && isPlaceholder(value)) emptyFound.push(where)
      if (status === 'found' && isPlaceholder(refs)) foundWithoutEvidence.push(where)
      if (
        ['05_风险'].includes(sheet.name) &&
        ['诉讼', '被执行', '失信', '股权冻结', '行政处罚', '管制清单'].includes(String(label)) &&
        status !== 'found' &&
        ['0', '无', '没有', '未发现', '无记录'].includes(String(value ?? '').trim())
      ) {
        fabricatedNone.push(`${where}=${value}`)
      }
    }
  }
  checks.push(check('six_states', invalidStates.length === 0, invalidStates.length ? `${invalidStates.length} 行状态不在 8 个取值内：${invalidStates.slice(0, 5).join(', ')}` : '02–05 状态均为 8 个取值', true))
  if (invalidStates.length > 0) block('six_states', `02–05 存在非法状态：${invalidStates.slice(0, 5).join(', ')}`)
  checks.push(check('empty_found', emptyFound.length === 0, emptyFound.length ? `${emptyFound.length} 行空值却标 found：${emptyFound.slice(0, 5).join(', ')}` : '无「空值 + found」', true))
  if (emptyFound.length > 0) block('empty_found', `存在空值却标 found 的行：${emptyFound.slice(0, 5).join(', ')}`)
  checks.push(check('found_without_evidence', foundWithoutEvidence.length === 0, foundWithoutEvidence.length ? `${foundWithoutEvidence.length} 行 found 无证据列` : 'found 行均有 claim/证据', true))
  if (foundWithoutEvidence.length > 0) block('found_without_evidence', `found 行缺少 claim/证据：${foundWithoutEvidence.slice(0, 5).join(', ')}`)
  checks.push(check('fabricated_none', fabricatedNone.length === 0, fabricatedNone.length ? `${fabricatedNone.length} 行空数组被写成「无/0」` : '风险空数组未被写成「无/0」', true))
  if (fabricatedNone.length > 0) block('fabricated_none', `风险字段空数组被写成「无/0」：${fabricatedNone.slice(0, 5).join(', ')}`)

  // ------------------------------------------------------------- workpapers
  const wpRoot = join(outDir, '04_工作底稿')
  const wpFiles = (await listFiles(wpRoot, { filter: (file) => file.endsWith('workpaper.md') }))
    .map((file) => portableRelative(outDir, file))
    .sort()
  const expectedWorkpapers = verified.map((artifact) => workpaperRelativePath(artifact)).sort()
  const missingWorkpapers = expectedWorkpapers.filter((path) => !wpFiles.includes(path))
  const orphanWorkpapers = wpFiles.filter((path) => !expectedWorkpapers.includes(path))
  const workpaperCountOk = verified.length === wpFiles.length
  checks.push(check('workpaper_count', workpaperCountOk, workpaperCountOk ? `${wpFiles.length} 份底稿对应 ${verified.length} 份 workpaper` : `底稿 ${verified.length} 份，workpaper ${wpFiles.length} 份`, true))
  if (!workpaperCountOk) block('workpaper_count', `底稿 ${verified.length} 份，workpaper ${wpFiles.length} 份，数量不一致`)
  checks.push(check('workpaper_missing', missingWorkpapers.length === 0, missingWorkpapers.length ? `缺 workpaper：${missingWorkpapers.slice(0, 5).join(', ')}` : '每份底稿都有 workpaper', true))
  if (missingWorkpapers.length > 0) block('workpaper_missing', `缺 workpaper：${missingWorkpapers.slice(0, 5).join(', ')}`)
  checks.push(check('workpaper_orphan', orphanWorkpapers.length === 0, orphanWorkpapers.length ? `${orphanWorkpapers.length} 份 workpaper 无对应底稿` : '无多余 workpaper', true))
  if (orphanWorkpapers.length > 0) block('workpaper_orphan', `workpaper 无对应底稿：${orphanWorkpapers.slice(0, 5).join(', ')}`)

  const indexFile = join(wpRoot, '00_索引.md')
  const indexStat = await statOrNull(indexFile)
  let indexOk = Boolean(indexStat)
  let indexDetail = indexStat ? '04_工作底稿/00_索引.md 存在' : '缺少 04_工作底稿/00_索引.md'
  if (indexStat) {
    const text = await readText(indexFile, '')
    const absent = verified.filter((artifact) => !text.includes(artifact.id)).map((artifact) => artifact.id)
    indexOk = absent.length === 0
    indexDetail = indexOk ? '索引列出全部 artifactId' : `索引缺 artifactId：${absent.slice(0, 5).join(', ')}`
  }
  checks.push(check('workpaper_index', indexOk, indexDetail, true))
  if (!indexOk) block('workpaper_index', indexDetail)

  // ------------------------------------------------------ independent check
  let pythonCheck = null
  if (full) {
    try {
      pythonCheck = await runDeliveryChecker(outDir, qaDir)
    } catch {
      pythonCheck = null
    }
    if (!pythonCheck) {
      checks.push(check('check_deliverable', false, '独立检查器 check_deliverable.py 未返回结果', true))
      block('check_deliverable', '独立检查器 check_deliverable.py 未返回结果')
    } else {
      const independentBlocking = asList(pythonCheck.blocking)
      const independentWarnings = asList(pythonCheck.warnings)
      checks.push(check('check_deliverable', independentBlocking.length === 0, independentBlocking.length ? `独立检查器 ${independentBlocking.length} 个阻断项` : '独立检查器通过', true))
      for (const item of independentBlocking) {
        const code = item?.code ?? 'unknown'
        const where = item?.where ? `（${item.where}）` : ''
        block(`check_deliverable:${code}`, `${item?.message ?? code}${where}`)
      }
      for (const item of independentWarnings) {
        const code = item?.code ?? 'unknown'
        const message = item?.message ?? code
        if (!warnings.some((entry) => entry.id === `check_deliverable:${code}` && entry.message === message)) {
          warnings.push({ id: `check_deliverable:${code}`, message })
        }
      }
    }
  }

  // -------------------------------------------------------------- signoff
  const signed = signoff ?? meta?.signoff ?? {}
  if (meta?.partial) warnings.push({ id: 'partial', message: '报告为 scope-limited / partial，必须向读者明示缺口' })
  if (!signed.reviewedBy) warnings.push({ id: 'review_pending', message: '尚未完成 reviewedBy 复核' })
  if (!signed.approvedBy) warnings.push({ id: 'approval_pending', message: '尚未完成 approvedBy 批准' })

  return {
    passed: blocking.length === 0,
    blocking,
    warnings,
    checks,
    inspections,
    pythonCheck,
    summary: {
      artifactCount: verified.length,
      businessArtifactCount: business.length,
      claimCount: claims.length,
      evidenceCount: evidence.length,
      workpaperCount: wpFiles.length,
      staleCount: currentAll.filter((artifact) => artifact.status === 'stale').length,
      rejectedCount: currentAll.filter((artifact) => artifact.status === 'rejected').length,
      draftCount: currentAll.filter((artifact) => artifact.status === 'draft').length,
    },
  }
}

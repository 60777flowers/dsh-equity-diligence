import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

import { EquityError, canonicalJson, isPlainObject, semanticHash, sha256 } from '../util/json.js'
import {
  atomicWriteJson,
  atomicWriteText,
  copyFileInto,
  ensureDir,
  hashFile,
  listFiles,
  portableJoin,
  portableRelative,
  readJson,
  readText,
  statOrNull,
} from '../util/fs.js'
import { nowIso, today } from '../util/time.js'
import { PACKAGE_ROOT } from '../kernel/registry.js'
import { listArtifacts, listClaims, listEvidence, readEvidenceBlob } from '../kernel/artifacts.js'
import { BUILDER_VERSION } from '../kernel/snapshot.js'
import { validateDelivery } from './check.js'

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

const CATEGORY_TO_SHEET = {
  1: '1-直接投资',
  2: '2-合作基金-GP',
  3: '3-合作基金-主导LP',
  4: '4-合作基金-财务LP',
  5: '5-海外平台',
  6: '6-合资公司',
  7: '7-国内基地',
}

function truncate(text, max = 4000) {
  const value = String(text ?? '')
  return value.length > max ? value.slice(0, max) + '\n…（截断）' : value
}

function valueText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function sixState(value, fallback = 'not_reviewed') {
  if (isPlainObject(value) && value.status) return value
  if (value === null || value === undefined || value === '') return { status: fallback, value: '未提供', note: '' }
  return { status: 'found', value, note: '' }
}

function topClaims(artifacts, claims) {
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]))
  const material = claims.filter((claim) => claim.materiality === 'material')
  const attention = claims.filter((claim) => claim.materiality === 'attention')
  return [...material, ...attention].filter((claim) => byId.has(claim.claimId))
}

function evidenceStrength(claim, evidenceById) {
  const links = claim.evidenceLinks ?? []
  if (links.length === 0) return '无证据'
  const supports = links.filter((link) => link.role === 'supports').map((link) => evidenceById.get(link.evidenceId)).filter(Boolean)
  if (supports.length === 0) return '仅反证/背景'
  const authorities = supports.map((item) => item.sourceAuthority ?? 'C').sort()
  const verified = supports.filter((item) => item.verificationStatus === 'verified').length
  return `${authorities[0]} / ${verified > 0 ? '已核验' : '未核验'} / ${supports.length} 源`
}

function buildFindings({ artifacts, claims, evidence }) {
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]))
  const redflags = artifacts.find((artifact) => artifact.type === 'risk.redflags')
  const flags = dedupeBy(
    redflags?.data?.flags ?? artifacts.flatMap((artifact) => artifact.flags ?? []),
    (flag) => `${flag.rule ?? flag.triggerId ?? ''}|${flag.desc ?? ''}`,
  )
  const findings = []
  for (const flag of flags.slice(0, 10)) {
    const claimId = flag.claimIds?.[0] ?? null
    const claim = claimId ? claims.find((item) => item.claimId === claimId) : null
    findings.push({
      findingId: `F${String(findings.length + 1).padStart(2, '0')}`,
      fact: flag.desc,
      impact: flag.action ?? '需在摘要首页披露或在后续尽调中核实',
      evidenceStrength: claim ? evidenceStrength(claim, evidenceById) : '线索',
      materiality: flag.level ?? 'attention',
      nextStep: flag.action ?? '进入待核清单',
      claimId,
      artifactId: redflags?.id ?? null,
    })
  }
  if (findings.length < 5) {
    for (const claim of topClaims(artifacts, claims)) {
      if (findings.length >= 10) break
      if (findings.some((finding) => finding.claimId === claim.claimId)) continue
      findings.push({
        findingId: `F${String(findings.length + 1).padStart(2, '0')}`,
        fact: `${claim.predicate}：${valueText(claim.value)}${claim.unit ? ` ${claim.unit}` : ''}`,
        impact: claim.note || '影响合作/投资判断的公开事实',
        evidenceStrength: evidenceStrength(claim, evidenceById),
        materiality: claim.materiality ?? 'attention',
        nextStep: '已写入底稿；如需进一步核实，进入资料请求清单',
        claimId: claim.claimId,
        artifactId: claim.artifactId ?? null,
      })
    }
  }
  if (findings.length === 0) {
    const first = artifacts.find((artifact) => artifact.type === 'company.identity')
    findings.push({
      findingId: 'F01',
      fact: first ? `已完成 ${first.data?.legalName ?? '目标公司'} 的主体识别与基础底稿` : '尚未完成底稿',
      impact: '公开信息调查刚刚开始，结论有限',
      evidenceStrength: '待补',
      materiality: 'attention',
      nextStep: '运行方案并补齐证据',
      claimId: null,
      artifactId: first?.id ?? null,
    })
  }
  return findings.slice(0, 10)
}

function dedupeBy(items, keyOf) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function buildRedFlags(artifacts) {
  const redflags = artifacts.find((artifact) => artifact.type === 'risk.redflags')
  const raw = redflags?.data?.flags ?? artifacts.flatMap((artifact) => artifact.flags ?? [])
  return dedupeBy(raw, (flag) => `${flag.rule ?? flag.triggerId ?? ''}|${flag.desc ?? ''}`)
}

function buildGaps(artifacts) {
  const out = []
  for (const artifact of artifacts) {
    for (const question of artifact.openQuestions ?? []) {
      if (typeof question === 'string') out.push({ topic: artifact.type, question, why: '公开信息未能确认', priority: 'medium' })
      else if (question?.question) out.push({
        topic: artifact.type,
        question: question.question,
        why: question.why ?? '公开信息未能确认',
        priority: question.priority ?? 'medium',
      })
    }
  }
  return dedupeBy(out, (gap) => `${gap.topic}|${gap.question}`).slice(0, 50)
}

function categorySheet(platform, familySheets) {
  const category = Number(platform.category ?? 0)
  if (CATEGORY_TO_SHEET[category]) return CATEGORY_TO_SHEET[category]
  if (category >= 8) {
    const key = platform.familyName || platform.name || '家族'
    const existing = familySheets.find((sheet) => sheet.family === key)
    if (existing) return existing.name
    if (familySheets.length >= 3) return '说明'
    const name = `${8 + familySheets.length}-${key}家族`
    familySheets.push({ family: key, name })
    return name
  }
  return '说明'
}

function latestFinancials(artifacts, subjectId) {
  return artifacts
    .filter((artifact) => artifact.type === 'financials.public' && artifact.subjectId === subjectId)
    .sort((a, b) => String(a.partitionKey).localeCompare(String(b.partitionKey)))
    .at(-1) ?? null
}

function findArtifact(artifacts, type, subjectId) {
  const list = artifacts.filter((artifact) => artifact.type === type && artifact.subjectId === subjectId)
  return list.find((artifact) => artifact.partitionKey === '_summary') ?? list.find((artifact) => artifact.partitionKey === '_default') ?? list[0] ?? null
}

function entityFields({ artifacts, entity }) {
  const subjectId = entity.subjectId ?? entity.entityId
  const ownership = findArtifact(artifacts, 'ownership.chain', subjectId)
  const business = findArtifact(artifacts, 'business.segment', subjectId)
  const financials = latestFinancials(artifacts, subjectId)
  const financing = findArtifact(artifacts, 'financing.history', subjectId)
  const fit = findArtifact(artifacts, 'assessment.fit', subjectId)
  const market = findArtifact(artifacts, 'market.landscape', subjectId)
  const people = findArtifact(artifacts, 'org.people', subjectId)
  const capTable = ownership?.data?.capTable ?? []
  const top5 = capTable
    .map((row) => Number(row.totalPct ?? row.directPct ?? 0))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)
    .slice(0, 5)
  const rounds = financing?.data?.rounds ?? []
  const lastRound = rounds.at(-1)
  const totalFunding = rounds.reduce((sum, round) => sum + (Number(round.amount?.amount) || 0), 0)
  const founderControl = (ownership?.data?.control ?? []).some((item) => /创始|实控|控股|董事长/.test(`${item.role ?? ''} ${item.basis ?? ''}`))
  return {
    latestFunding: sixState(lastRound ? `${lastRound.round ?? ''} ${lastRound.date ?? ''} ${valueText(lastRound.amount)}`.trim() : null),
    largestShareholderPct: sixState(capTable[0]?.totalPct ?? capTable[0]?.directPct ?? null),
    top5Pct: sixState(top5.length ? top5.reduce((sum, value) => sum + value, 0) : null),
    shareholderCount: sixState(capTable.length || null),
    founderControl: sixState(founderControl ? '是' : '否'),
    founderBackground: sixState(people?.data?.keyPeople?.[0]?.name ?? null),
    industryChain: sixState(business?.data?.products?.[0]?.category ?? null),
    expansionCycle: sixState(business?.data?.techRoute?.[0]?.route ?? null),
    prosperity: sixState(market?.data?.marketSize?.[0]?.growthPct ?? null),
    grossMargin: sixState(financials?.data?.grossMargin ?? null),
    ranking: sixState(market?.data?.competition?.[0]?.positioning ?? null),
    techRelevance: sixState(fit?.data?.technologyFit?.value ?? fit?.data?.technologyFit ?? null),
    totalFunding: sixState(totalFunding || null),
    assessment: sixState(fit?.data?.conclusion?.technologyCommercial ?? fit?.data?.equityView?.value ?? null),
  }
}

function claimRefFor(claims, predicate) {
  return claims.find((claim) => claim.predicate === predicate)?.claimId ?? null
}

function buildSevenN({ artifacts, claims }) {
  const platforms = artifacts.filter((artifact) => artifact.type === 'investment.map' && artifact.data?.mode === 'platform')
  const familySheets = []
  const rows = []
  for (const platform of platforms) {
    const sheet = categorySheet(platform.data, familySheets)
    if (sheet === '说明') continue
    for (const entity of platform.data.entities ?? []) {
      const subjectId = entity.subjectId ?? null
      const fields = entityFields({ artifacts, entity: { ...entity, subjectId } })
      rows.push({
        sheet,
        platform: {
          name: platform.data.name ?? platform.data.platformId,
          role: platform.data.role ?? '',
          structure: valueText(platform.data.vehicles?.map((vehicle) => `${vehicle.name ?? ''} ${vehicle.role ?? ''}`).join('；')),
          positioning: platform.data.evidenceSummary ?? '',
          note: platform.data.platformId ?? '',
        },
        entity: {
          name: entity.fullName ?? entity.name,
          latestFunding: valueText(fields.latestFunding.value),
          largestShareholderPct: fields.largestShareholderPct.value,
          top5Pct: fields.top5Pct.value,
          shareholderCount: fields.shareholderCount.value,
          founderControl: fields.founderControl.value,
          founderBackground: fields.founderBackground.value,
          industryChain: fields.industryChain.value,
          expansionCycle: fields.expansionCycle.value,
          prosperity: fields.prosperity.value,
          grossMargin: fields.grossMargin.value,
          ranking: fields.ranking.value,
          techRelevance: fields.techRelevance.value,
          totalFunding: fields.totalFunding.value,
          assessment: fields.assessment.value,
          dataQuality: `${fields.largestShareholderPct.status}/${fields.grossMargin.status}`,
        },
        claimRefs: {
          largestShareholderPct: claimRefFor(claims, 'largest_shareholder_pct'),
          grossMargin: claimRefFor(claims, 'gross_margin'),
          assessment: claimRefFor(claims, 'investment_cooperation_assessment'),
        },
      })
    }
  }
  return {
    enabled: platforms.length > 0,
    fixedSheets: SEVEN_N_FIXED,
    familySheets: familySheets.map((sheet) => sheet.name),
    rows,
    notes: [
      '一行 = 一个（平台路径 × 被投实体）对；同一实体多路径在各涉及分表各占一行。',
      '比例、金额、日期均为公开信息口径；未披露字段以状态字段标注（8 个取值），不得臆测。',
      '本表为投资版图专项附件，不是全部 25 个模块的总目录。',
    ],
  }
}

function buildComprehensive({ artifacts, claims }) {
  const sheets = []
  const identity = artifacts.find((artifact) => artifact.type === 'company.identity')
  const ownership = artifacts.find((artifact) => artifact.type === 'ownership.chain')
  const business = artifacts.find((artifact) => artifact.type === 'business.segment')
  const ip = artifacts.find((artifact) => artifact.type === 'ip.portfolio')
  const financials = artifacts.find((artifact) => artifact.type === 'financials.public')
  const financing = artifacts.find((artifact) => artifact.type === 'financing.history')
  const legal = artifacts.find((artifact) => artifact.type === 'legal.risk')
  const regulatory = artifacts.find((artifact) => artifact.type === 'regulatory.compliance')
  const redflags = artifacts.find((artifact) => artifact.type === 'risk.redflags')

  const row = (label, value, status = 'found', evidenceIds = []) => [label, valueText(value), status, evidenceIds.join(', ')]
  sheets.push({
    name: '02_主体与股权',
    title: '主体与股权',
    headers: ['字段', '值', '状态', '证据'],
    rows: [
      row('法定名称', identity?.data?.legalName),
      row('统一社会信用代码', identity?.data?.code),
      row('注册地', identity?.data?.domicile),
      row('成立日期', identity?.data?.incorporationDate),
      row('主体状态', identity?.data?.status),
      row('股权层级', ownership?.data?.layers?.length, ownership ? 'found' : 'not_reviewed'),
      row('实控人线索', ownership?.data?.ubo?.map((item) => item.name).join('、')),
      row('控制方式', ownership?.data?.control?.map((item) => `${item.name}${item.role ? `（${item.role}）` : ''}`).join('、')),
      row('特殊权利', ownership?.data?.specialRights?.map((item) => item.type).join('、')),
    ],
  })
  sheets.push({
    name: '03_业务与技术',
    title: '业务与技术',
    headers: ['字段', '值', '状态', '证据'],
    rows: [
      row('产品线', business?.data?.products?.map((item) => item.name).join('、')),
      row('收入构成', business?.data?.segments?.map((item) => `${item.name} ${item.revenuePct ?? ''}%`).join('；')),
      row('专利数', ip?.data?.patents?.length),
      row('商标数', ip?.data?.trademarks?.length),
      row('软著数', ip?.data?.software?.length),
      row('技术来源', artifacts.find((artifact) => artifact.type === 'tech.origin')?.data?.origins?.map((item) => item.technology).join('、')),
      row('资质', artifacts.find((artifact) => artifact.type === 'qualifications')?.data?.items?.map((item) => item.name).join('、')),
    ],
  })
  sheets.push({
    name: '04_财务',
    title: '财务',
    headers: ['字段', '值', '状态', '证据'],
    rows: [
      row('财年', financials?.data?.fiscalYear),
      row('营业收入', financials?.data?.revenue),
      row('净利润', financials?.data?.netProfit),
      row('毛利率', financials?.data?.grossMargin),
      row('融资轮次', financing?.data?.rounds?.length),
      row('最新估值', financing?.data?.valuationMarks?.at(-1)?.postMoney),
      row('有息负债', artifacts.find((artifact) => artifact.type === 'debt.guarantee')?.data?.debt?.length),
    ],
  })
  sheets.push({
    name: '05_风险',
    title: '风险',
    headers: ['字段', '值', '状态', '证据'],
    rows: [
      row('诉讼', legal?.data?.litigation?.length),
      row('被执行', legal?.data?.enforcement?.length),
      row('失信', legal?.data?.dishonest?.length),
      row('股权冻结', legal?.data?.frozen?.length),
      row('行政处罚', regulatory?.data?.penalties?.length),
      row('管制清单', artifacts.find((artifact) => artifact.type === 'policy.exposure')?.data?.listings?.length),
      row('红旗', redflags?.data?.flags?.length),
    ],
  })
  sheets.push({
    name: '06_待核清单',
    title: '待核清单',
    headers: ['主题', '问题', '为什么重要', '优先级', '来源'],
    rows: buildGaps(artifacts).map((gap) => [gap.topic, gap.question, gap.why, gap.priority, 'openQuestions']),
  })
  return sheets
}

function summaryMarkdown({ project, meta, findings, redFlags, gaps, limitations, sources }) {
  const lines = []
  lines.push(`# ${meta.title}`)
  lines.push('')
  lines.push(`> ${meta.subtitle}`)
  lines.push('')
  lines.push(`> **数据截至日**：${meta.asOf} ｜ **口径**：${meta.perimeter} ｜ **币种**：${meta.currency} ｜ **模板**：${meta.template}`)
  lines.push('>')
  lines.push(`> **委托方**：${meta.clientName} ｜ **目标**：${meta.targetName}${meta.targetCode ? `（${meta.targetCode}）` : ''}`)
  lines.push('>')
  lines.push(`> **状态**：${meta.partial ? '**部分完成（scope-limited / partial）**' : '完整'} ｜ stale ${meta.staleCount} ｜ rejected ${meta.rejectedCount}`)
  lines.push('')
  lines.push(`> ${meta.banner}`)
  lines.push('')
  lines.push('## 一、关键发现')
  lines.push('')
  lines.push('| # | 事实 | 影响 | 证据强度 | materiality | 下一步 | claimId |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const finding of findings) {
    lines.push(`| ${finding.findingId} | ${escapeCell(finding.fact)} | ${escapeCell(finding.impact)} | ${escapeCell(finding.evidenceStrength)} | ${finding.materiality} | ${escapeCell(finding.nextStep)} | ${finding.claimId ?? ''} |`)
  }
  lines.push('')
  lines.push('## 二、红旗与核查项')
  lines.push('')
  lines.push('| 级别 | 规则 | 描述 | 建议动作 |')
  lines.push('|---|---|---|---|')
  for (const flag of redFlags.slice(0, 20)) {
    lines.push(`| ${flag.level ?? 'attention'} | ${flag.rule ?? flag.triggerId ?? ''} | ${escapeCell(flag.desc)} | ${escapeCell(flag.action ?? '')} |`)
  }
  if (redFlags.length === 0) lines.push('| — | — | 暂无已核实红旗 | — |')
  lines.push('')
  lines.push('## 三、缺口与下一步')
  lines.push('')
  lines.push('| 主题 | 问题 | 为什么重要 | 优先级 |')
  lines.push('|---|---|---|---|')
  for (const gap of gaps.slice(0, 30)) {
    lines.push(`| ${escapeCell(gap.topic)} | ${escapeCell(gap.question)} | ${escapeCell(gap.why)} | ${gap.priority} |`)
  }
  if (gaps.length === 0) lines.push('| — | 暂无 | — | — |')
  lines.push('')
  lines.push('## 四、范围、来源与限制')
  lines.push('')
  for (const limitation of limitations) lines.push(`- ${limitation}`)
  lines.push('')
  lines.push('### 来源索引（节选）')
  lines.push('')
  lines.push('| evidenceId | 来源 | URL | 类型 | 截至日 |')
  lines.push('|---|---|---|---|---|')
  for (const source of sources.slice(0, 60)) {
    lines.push(`| ${source.evidenceId} | ${escapeCell(source.title)} | ${source.url} | ${source.sourceTier} | ${source.asOf ?? ''} |`)
  }
  lines.push('')
  lines.push('## 五、声明')
  lines.push('')
  lines.push(meta.disclaimer)
  lines.push('')
  lines.push(`> 生成时间：${meta.generatedAt} ｜ 构建器：${BUILDER_VERSION} ｜ 项目：${project.projectId}`)
  return lines.join('\n')
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function workpaperMarkdown({ artifact, claims, evidence, module }) {
  const lines = []
  lines.push(`# 工作底稿：${artifact.type} / ${artifact.subjectId} / ${artifact.partitionKey}`)
  lines.push('')
  lines.push(`> revision ${artifact.revision} ｜ status ${artifact.status} ｜ asOf ${artifact.asOf} ｜ hash ${artifact.contentHash}`)
  lines.push('')
  lines.push('## 1. 程序')
  lines.push('')
  lines.push(module?.manifest?.description ?? '按模块方法论执行公开信息检索与核验。')
  lines.push('')
  lines.push(`- 模块：${artifact.producedBy?.moduleId ?? ''}@${artifact.producedBy?.moduleVersion ?? ''}`)
  lines.push(`- 输入：${(artifact.derivedFrom ?? []).map((edge) => `${edge.type} rev${edge.revision}`).join('；') || '无'}`)
  lines.push(`- 检查：${(artifact.checks ?? []).map((check) => `${check.id}:${check.status}`).join('；')}`)
  lines.push('')
  lines.push('## 2. 发现')
  lines.push('')
  lines.push('```json')
  lines.push(truncate(JSON.stringify(artifact.data, null, 2), 12_000))
  lines.push('```')
  lines.push('')
  lines.push('## 3. Claim 与证据')
  lines.push('')
  lines.push('| claimId | predicate | value | status | 证据 |')
  lines.push('|---|---|---|---|---|')
  for (const claim of claims) {
    lines.push(`| ${claim.claimId} | ${claim.predicate} | ${escapeCell(valueText(claim.value))} | ${claim.status} | ${(claim.evidenceLinks ?? []).map((link) => link.evidenceId).join(', ')} |`)
  }
  lines.push('')
  lines.push('| evidenceId | 来源 | 引文 | 定位 | 核验 |')
  lines.push('|---|---|---|---|---|')
  for (const item of evidence) {
    lines.push(`| ${item.evidenceId} | ${item.url ?? ''} | ${escapeCell(truncate(item.quote, 200))} | ${item.locator ?? ''} | ${item.verificationStatus ?? ''} |`)
  }
  lines.push('')
  lines.push('## 4. 红旗、缺口与复核')
  lines.push('')
  lines.push('### 红旗')
  for (const flag of artifact.flags ?? []) lines.push(`- [${flag.level ?? 'attention'}] ${flag.desc}${flag.action ? ` → ${flag.action}` : ''}`)
  if ((artifact.flags ?? []).length === 0) lines.push('- 无')
  lines.push('')
  lines.push('### 待核/开放问题')
  for (const question of artifact.openQuestions ?? []) {
    lines.push(`- ${typeof question === 'string' ? question : question.question}`)
  }
  if ((artifact.openQuestions ?? []).length === 0) lines.push('- 无')
  lines.push('')
  lines.push('### 复核记录')
  lines.push('- 机器检查：见 `checks`。')
  lines.push('- 人工复核：待填（reviewedBy / reviewedAt / 结论）。')
  return lines.join('\n')
}

function rangeMarkdown({ project, meta }) {
  return `# 范围与口径

- 项目：${project.name}（${project.projectId}）
- 目标：${meta.targetName}${meta.targetCode ? `（${meta.targetCode}）` : ''}
- 委托方：${meta.clientName}
- 调查时点：${meta.asOf}
- 财务期间：${meta.period}
- 币种：${meta.currency}
- 合并/母公司口径：${meta.perimeter}
- 会计准则：${meta.accountingStandard}
- 来源范围：公开信息（公告、监管、法院、交易所、工商、中基协、审计报告、公司官网、权威媒体）
- 未覆盖：现场尽调、受益所有权核验、法律/审计/税务/估值意见
- 数据状态：stale ${meta.staleCount}；rejected ${meta.rejectedCount}；partial ${meta.partial ? '是' : '否'}

## 口径纪律

1. 每条结论带来源、原文、截至日期、置信度。
2. 未披露写状态字段（8 个取值），不留空；公司特定事实不用同行均值替代。
3. 风险线索只生成核查动作，不自动定性为违规/利益输送/否决。
4. 报告不创造底稿之外的新事实；数字挂 claimId。
5. 本报告基于公开信息，不构成投资建议，不能替代现场尽调、法律、审计、税务或估值意见。
`
}

async function runPython(script, args, timeout = 180_000) {
  const python = process.env.EQUITY_PYTHON || process.env.PYTHON || 'python'
  try {
    const { stdout, stderr } = await execFileAsync(python, [script, ...args], {
      maxBuffer: 128 * 1024 * 1024,
      timeout,
      windowsHide: true,
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    throw new EquityError('builder_failed', `Python 构建失败：${error.message}`, {
      stdout: error.stdout,
      stderr: error.stderr,
    })
  }
}

/**
 * Build the full delivery package.
 */
export async function buildDeliverable({
  root,
  library,
  project,
  playbook,
  plan,
  run,
  template = 'standard',
  signoff = {},
  partial = undefined,
}) {
  const outDir = join(root, '05_交付')
  await ensureDir(outDir)
  const artifacts = await listArtifacts(root)
  const stale = artifacts.filter((artifact) => artifact.status === 'stale')
  const rejected = artifacts.filter((artifact) => artifact.status === 'rejected')
  const allClaims = []
  for (const subjectId of new Set(artifacts.map((artifact) => artifact.subjectId))) {
    const claims = await listClaims(root, subjectId)
    for (const claim of claims) {
      const artifact = artifacts.find((candidate) => candidate.claimIds?.includes(claim.claimId))
      allClaims.push({
        ...claim,
        artifactId: artifact?.id ?? null,
        artifactRevision: artifact?.revision ?? null,
        artifactContentHash: artifact?.contentHash ?? null,
      })
    }
  }
  const evidence = await listEvidence(root)
  const target = project.targets?.[0] ?? { name: project.name, code: '' }
  const meta = {
    projectId: project.projectId,
    projectName: project.name,
    targetName: target.name,
    targetCode: target.code ?? '',
    clientName: project.engagement?.clientName ?? project.engagement?.client ?? '',
    asOf: project.engagement?.asOf ?? today(),
    period: project.engagement?.period ?? '最新公开期间',
    currency: project.engagement?.currency ?? 'CNY',
    perimeter: project.engagement?.consolidationPerimeter ?? '以公告/工商口径为准',
    accountingStandard: project.engagement?.accountingStandard ?? 'CAS',
    generatedAt: nowIso(),
    template,
    partial: partial ?? (artifacts.some((artifact) => ['draft', 'stale', 'rejected'].includes(artifact.status)) || stale.length > 0 || rejected.length > 0),
    staleCount: stale.length,
    rejectedCount: rejected.length,
    banner: '本报告基于公开信息，不构成投资建议；不能替代现场尽调、法律、审计、税务或估值意见。',
    title: `${target.name} · 公开信息调查报告`,
    subtitle: `尽调前公开信息调查 / ${today()}`,
    disclaimer: '本报告仅用于内部尽调前公开信息调查，不构成任何投资、法律、审计、税务或估值意见。所有比例、金额、日期均应按原文口径复核；未披露不等于不存在。',
  }
  const findings = buildFindings({ artifacts, claims: allClaims, evidence })
  const redFlags = buildRedFlags(artifacts)
  const gaps = buildGaps(artifacts)
  const limitations = [
    '公开信息存在滞后、缺失与口径差异；未披露不等于不存在。',
    '未进行现场尽调、受益所有权核验、银行流水核对、访谈或函证。',
    '工商/媒体数据可能滞后于公告；关键结论应以原始公告/监管文件为准。',
    ...(stale.length ? [`有 ${stale.length} 份底稿 stale，报告可能基于旧版本。`] : []),
    ...(rejected.length ? [`有 ${rejected.length} 份底稿 rejected，相关结论不得引用。`] : []),
  ]
  const sources = evidence.slice(0, 200).map((item) => ({
    evidenceId: item.evidenceId,
    title: item.title ?? item.url ?? '',
    url: item.url ?? '',
    sourceTier: item.sourceTier ?? 'media',
    asOf: item.asOf ?? '',
  }))
  const sevenN = buildSevenN({ artifacts, claims: allClaims })
  const comprehensive = buildComprehensive({ artifacts, claims: allClaims })

  // Markdown deliverables
  const summaryFile = join(outDir, '01_管理层摘要.md')
  await atomicWriteText(summaryFile, summaryMarkdown({ project, meta, findings, redFlags, gaps, limitations, sources }))
  await atomicWriteText(join(outDir, '00_范围与口径.md'), rangeMarkdown({ project, meta }))

  // Workpapers
  const wpRoot = join(outDir, '04_工作底稿')
  for (const artifact of artifacts) {
    const module = library.modules.get(artifact.producedBy?.moduleId)
    const slug = (artifact.producedBy?.moduleId ?? artifact.type).split('/').pop()
    const dir = join(wpRoot, slug)
    await ensureDir(dir)
    const claims = allClaims.filter((claim) => artifact.claimIds?.includes(claim.claimId))
    const ev = evidence.filter((item) => artifact.evidenceIds?.includes(item.evidenceId))
    await atomicWriteText(join(dir, 'workpaper.md'), workpaperMarkdown({ artifact, claims, evidence: ev, module }))
  }

  // Evidence snapshots (immutable copies)
  const snapshotDir = join(outDir, '05_证据快照')
  await ensureDir(snapshotDir)
  const snapshotIndex = []
  for (const item of evidence) {
    const blob = await readEvidenceBlob(root, item)
    // A fixture or an import may carry only a quote, not a raw snapshot. Keep a
    // quote-only record so the reader can still see what was cited.
    const text = blob ?? `EVIDENCE ${item.evidenceId}\nURL: ${item.url ?? ''}\nTITLE: ${item.title ?? ''}\nLOCATOR: ${item.locator ?? ''}\nQUOTE:\n${item.quote ?? ''}\n`
    const file = join(snapshotDir, `${item.evidenceId}.txt`)
    await atomicWriteText(file, text)
    snapshotIndex.push({
      evidenceId: item.evidenceId,
      file: portableRelative(outDir, file),
      rawHash: item.rawHash ?? sha256(text),
      source: blob ? 'raw-snapshot' : 'quote-only',
    })
  }
  await atomicWriteJson(join(snapshotDir, 'evidence-index.json'), snapshotIndex)

  // Input for the Python workbook builder
  const buildInput = {
    meta,
    summary: { title: meta.title, subtitle: meta.subtitle, findings, redFlags, gaps, limitations, sources, disclaimer: meta.disclaimer },
    artifacts: artifacts.map((artifact) => ({
      artifactId: artifact.id,
      type: artifact.type,
      subjectId: artifact.subjectId,
      subjectName: artifact.subjectId,
      partitionKey: artifact.partitionKey,
      status: artifact.status,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
      asOf: artifact.asOf,
      data: artifact.data,
      claims: allClaims.filter((claim) => artifact.claimIds?.includes(claim.claimId)),
      evidenceIds: artifact.evidenceIds ?? [],
      flags: artifact.flags ?? [],
      openQuestions: artifact.openQuestions ?? [],
    })),
    claims: allClaims,
    evidence: evidence.map((item) => ({
      evidenceId: item.evidenceId,
      url: item.url,
      title: item.title,
      quote: item.quote,
      locator: item.locator,
      sourceTier: item.sourceTier,
      sourceAuthority: item.sourceAuthority,
      verificationStatus: item.verificationStatus,
      asOf: item.asOf,
      retrievedAt: item.retrievedAt,
      rawHash: item.rawHash,
    })),
    entities: sevenN.rows.map((row, index) => ({
      entityId: `entity_${index + 1}`,
      name: row.entity.name,
      platformId: row.platform.note,
      platformName: row.platform.name,
      platformCategory: row.sheet.match(/^\d+/) ? row.sheet.match(/^\d+/)[0] : '',
      path: row.platform.name,
      ownership: row.entity.largestShareholderPct ? `${row.entity.largestShareholderPct}` : '',
      fields: {},
      claimRefs: row.claimRefs,
    })),
    sevenN,
    comprehensive: { sheets: comprehensive },
    qa: { blocking: [], warnings: [], passed: true },
    signoff: {
      preparedBy: signoff.preparedBy ?? 'equity-diligence',
      reviewedBy: signoff.reviewedBy ?? '',
      approvedBy: signoff.approvedBy ?? '',
      proposedAt: signoff.proposedAt ?? nowIso(),
      signedAt: signoff.signedAt ?? null,
    },
    cellMap: findings.filter((finding) => finding.claimId).map((finding) => {
      const claim = allClaims.find((item) => item.claimId === finding.claimId)
      return {
        location: `01_管理层摘要.md#${finding.findingId}`,
        claimId: finding.claimId,
        artifactId: claim?.artifactId ?? finding.artifactId,
        artifactRevision: claim?.artifactRevision ?? null,
        artifactContentHash: claim?.artifactContentHash ?? null,
        value: finding.fact,
        evidenceIds: claim?.evidenceLinks?.map((link) => link.evidenceId) ?? [],
      }
    }),
  }
  const inputFile = join(outDir, '.build-input.json')
  await atomicWriteJson(inputFile, buildInput)
  const buildResult = await runPython(join(PACKAGE_ROOT, 'python', 'build_workbooks.py'), ['--input', inputFile, '--out', outDir])
  const workbookMap = await readJson(join(outDir, 'workbook_map.json'), null)

  // QA
  const qa = await validateDelivery({
    root,
    outDir,
    artifacts,
    claims: allClaims,
    evidence,
    findings,
    workbookMap,
    meta,
  })

  // Manifest
  const files = await listFiles(outDir, { filter: (file) => !file.endsWith('.build-input.json') })
  const manifestFiles = []
  for (const file of files) {
    const info = await statOrNull(file)
    manifestFiles.push({
      path: portableRelative(outDir, file),
      sha256: await hashFile(file),
      size: info?.size ?? 0,
      kind: file.endsWith('.xlsx') ? 'xlsx' : file.endsWith('.md') ? 'markdown' : file.endsWith('.json') ? 'json' : 'other',
    })
  }
  const manifest = {
    schemaVersion: 1,
    projectId: project.projectId,
    generatedAt: nowIso(),
    builderVersion: BUILDER_VERSION,
    runId: run?.runId ?? null,
    snapshotHash: plan?.snapshotHash ?? null,
    template,
    files: manifestFiles,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      subjectId: artifact.subjectId,
      partitionKey: artifact.partitionKey,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
      status: artifact.status,
      asOf: artifact.asOf,
    })),
    evidenceCount: evidence.length,
    claimCount: allClaims.length,
    qa: { passed: qa.passed, blocking: qa.blocking, warnings: qa.warnings },
    signoff: buildInput.signoff,
    cellMap: buildInput.cellMap,
  }
  await atomicWriteJson(join(outDir, 'manifest.json'), manifest)
  await atomicWriteText(join(outDir, 'QA与签发记录.md'), qaMarkdown({ qa, manifest, signoff: buildInput.signoff }))

  const ddRequests = gaps.map((gap, index) => ({
    id: `DD-${String(index + 1).padStart(2, '0')}`,
    topic: gap.topic,
    question: gap.question,
    why: gap.why,
    priority: gap.priority,
    owner: 'analyst',
    status: 'open',
  }))
  return {
    outDir,
    files: manifestFiles,
    manifest,
    qa,
    workbookMap,
    ddRequests,
    findings,
    stdout: buildResult.stdout,
  }
}

function qaMarkdown({ qa, manifest, signoff }) {
  const lines = []
  lines.push('# QA 与签发记录')
  lines.push('')
  lines.push(`> 生成时间：${manifest.generatedAt} ｜ 构建器：${manifest.builderVersion}`)
  lines.push('')
  lines.push(`## 结论：${qa.passed ? '通过（可交付）' : '阻断（不可交付）'}`)
  lines.push('')
  lines.push('| 检查项 | 结果 | 说明 |')
  lines.push('|---|---|---|')
  for (const item of qa.checks ?? []) lines.push(`| ${item.id} | ${item.status} | ${escapeCell(item.detail)} |`)
  lines.push('')
  if (qa.blocking.length > 0) {
    lines.push('## 阻断项')
    for (const item of qa.blocking) lines.push(`- [${item.id}] ${item.message}`)
    lines.push('')
  }
  if (qa.warnings.length > 0) {
    lines.push('## 警告')
    for (const item of qa.warnings) lines.push(`- [${item.id}] ${item.message}`)
    lines.push('')
  }
  lines.push('## 签发')
  lines.push('')
  lines.push(`- preparedBy：${signoff.preparedBy || '待填'}`)
  lines.push(`- reviewedBy：${signoff.reviewedBy || '待填'}`)
  lines.push(`- approvedBy：${signoff.approvedBy || '待填'}`)
  lines.push(`- proposedAt：${signoff.proposedAt || ''}`)
  lines.push(`- signedAt：${signoff.signedAt || '未签发'}`)
  lines.push('')
  lines.push('> Agent 只能提议复核；approve/signoff/waive 为用户专属动作。')
  return lines.join('\n')
}

/** Draft a review proposal without signing. */
export function proposeReview({ reviewer = '', note = '' } = {}) {
  return { status: 'proposed', reviewer, note, proposedAt: nowIso() }
}

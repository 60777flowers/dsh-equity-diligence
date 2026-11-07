import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

import { EquityError, canonicalJson, isPlainObject, sha256 } from '../util/json.js'
import {
  atomicWriteJson,
  atomicWriteText,
  ensureDir,
  hashFile,
  listFiles,
  portableRelative,
  readJson,
  removeDir,
  statOrNull,
} from '../util/fs.js'
import { nowIso, today } from '../util/time.js'
import { PACKAGE_ROOT } from '../kernel/registry.js'
import {
  artifactVersionKey,
  listArtifacts,
  listClaims,
  listEvidence,
  listVerifiedArtifacts,
  readEvidenceBlob,
} from '../kernel/artifacts.js'
import { BUILDER_VERSION } from '../kernel/snapshot.js'
import { NON_BUSINESS_ARTIFACT_TYPES, SIX_STATES, workpaperRelativePath } from './delivery-common.js'
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

/** A value is empty when it carries no fact: null/blank/empty array/empty object. */
function isEmptyValue(value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') {
    const text = value.trim()
    return text === '' || text === '未提供' || text === '未提供/not_reviewed'
  }
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return false
}

/** Join a non-empty array; return null (not an empty string) when there is no fact. */
function joinText(list, mapper = valueText, separator = '、') {
  if (!Array.isArray(list) || list.length === 0) return null
  const parts = list.map((item) => valueText(mapper(item)).trim()).filter(Boolean)
  return parts.length > 0 ? parts.join(separator) : null
}

/** Count only when the array carries data; empty arrays mean "not reviewed", not 0. */
function arrayCount(value) {
  return Array.isArray(value) && value.length > 0 ? value.length : null
}

/**
 * Normalize a value into a six-state object. Status objects are preserved; a
 * non-empty value is never reported as `found` without the caller supplying
 * evidence through the row builder.
 */
function sixState(value, { fallback = 'not_reviewed', note = '' } = {}) {
  if (isPlainObject(value) && typeof value.status === 'string') {
    const status = SIX_STATES.has(value.status) ? value.status : 'not_reviewed'
    const inner = value.value
    if (isEmptyValue(inner)) {
      return {
        status: status === 'found' ? fallback : status,
        value: '',
        note: value.note ?? note,
      }
    }
    return { status, value: inner, note: value.note ?? note }
  }
  if (isEmptyValue(value)) return { status: fallback, value: '', note }
  return { status: 'found', value, note }
}

function subjectClaims(claims, artifact) {
  if (!artifact) return []
  const ids = new Set(artifact.claimIds ?? [])
  return claims.filter((claim) => ids.has(claim.claimId))
}

function claimFor(claims, artifact, predicates) {
  if (predicates.length === 0) return null
  const scoped = subjectClaims(claims, artifact)
  return scoped.find((claim) => predicates.includes(claim.predicate)) ?? null
}

/**
 * Build one 02–05 row: status is derived from the data, never defaulted to
 * `found`; `found` requires a non-empty value AND a claim/evidence reference.
 */
function fieldRow(claims, {
  label,
  value,
  artifact = null,
  predicates = [],
  status = null,
  missing = 'not_reviewed',
  evidenceIds = [],
}) {
  const claim = claimFor(claims, artifact, predicates)
  const refs = []
  if (claim?.claimId) refs.push(claim.claimId)
  for (const link of claim?.evidenceLinks ?? []) {
    if (link?.evidenceId && !refs.includes(link.evidenceId)) refs.push(link.evidenceId)
  }
  for (const id of evidenceIds) {
    if (id && !refs.includes(id)) refs.push(id)
  }
  if (!claim && refs.length === 0) {
    for (const id of artifact?.evidenceIds ?? []) {
      if (id && !refs.includes(id)) refs.push(id)
    }
  }
  let resolved = status && SIX_STATES.has(status) ? status : null
  if (!resolved) {
    if (isEmptyValue(value)) resolved = missing
    else if (claim) resolved = SIX_STATES.has(claim.status) ? claim.status : 'found'
    else resolved = refs.length > 0 ? 'found' : 'not_reviewed'
  }
  if (resolved === 'found' && (isEmptyValue(value) || refs.length === 0)) resolved = 'not_reviewed'
  return [label, valueText(value), resolved, refs.join(', ')]
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

/**
 * Resolve the join key for one investment.map entity.
 * The artifact key is the internal entity id (entityId) or the legacy subjectId.
 * A display name is only a deterministic fallback and is never treated as an
 * artifact subject.
 */
function entityJoin(entity) {
  const entityId = typeof entity?.entityId === 'string' ? entity.entityId.trim() : ''
  if (entityId) return { key: entityId, kind: 'entityId', artifactSubjectId: entityId }
  const subjectId = typeof entity?.subjectId === 'string' ? entity.subjectId.trim() : ''
  if (subjectId) return { key: subjectId, kind: 'subjectId', artifactSubjectId: subjectId }
  const name = typeof entity?.fullName === 'string' && entity.fullName.trim()
    ? entity.fullName.trim()
    : String(entity?.name ?? '').trim()
  return {
    key: name ? `name:${name}` : null,
    kind: 'name',
    artifactSubjectId: null,
  }
}

/** Founder-control answer from actual control data; no data never becomes "否". */
function founderControlField(ownership) {
  const control = Array.isArray(ownership?.data?.control) ? ownership.data.control : []
  const explicit = ownership?.data?.founderControl
  if (explicit !== undefined && explicit !== null) {
    return sixState(explicit, { fallback: 'not_reviewed', note: '底稿 founderControl 字段' })
  }
  if (!ownership || control.length === 0) {
    return { status: 'not_reviewed', value: '', note: '未取得控制权/创始团队控制关系数据' }
  }
  const founder = control.some((item) =>
    /创始|创始人|创始团队/.test(`${item?.role ?? ''} ${item?.basis ?? ''} ${item?.name ?? ''}`),
  )
  if (founder) {
    return {
      status: 'found',
      value: '是',
      note: control.map((item) => [item?.name, item?.role].filter(Boolean).join('：')).filter(Boolean).join('；'),
    }
  }
  return {
    status: 'not_reviewed',
    value: '',
    note: `控制关系已披露（${control.map((item) => item?.name).filter(Boolean).join('、') || '未列名'}），未取得创始团队控制结论`,
  }
}

function entityFields({ artifacts, entity }) {
  const join = entityJoin(entity)
  const subjectId = join.artifactSubjectId
  const ownership = subjectId ? findArtifact(artifacts, 'ownership.chain', subjectId) : null
  const business = subjectId ? findArtifact(artifacts, 'business.segment', subjectId) : null
  const financials = subjectId ? latestFinancials(artifacts, subjectId) : null
  const financing = subjectId ? findArtifact(artifacts, 'financing.history', subjectId) : null
  const fit = subjectId ? findArtifact(artifacts, 'assessment.fit', subjectId) : null
  const market = subjectId ? findArtifact(artifacts, 'market.landscape', subjectId) : null
  const people = subjectId ? findArtifact(artifacts, 'org.people', subjectId) : null
  const capTable = Array.isArray(ownership?.data?.capTable) ? ownership.data.capTable : []
  const top5 = capTable
    .map((row) => Number(row.totalPct ?? row.directPct ?? 0))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)
    .slice(0, 5)
  const rounds = Array.isArray(financing?.data?.rounds) ? financing.data.rounds : []
  const lastRound = rounds.at(-1)
  const totalFunding = rounds.reduce((sum, round) => sum + (Number(round.amount?.amount) || 0), 0)
  return {
    latestFunding: sixState(lastRound ? `${lastRound.round ?? ''} ${lastRound.date ?? ''} ${valueText(lastRound.amount)}`.trim() : null),
    largestShareholderPct: sixState(capTable[0]?.totalPct ?? capTable[0]?.directPct ?? null),
    top5Pct: sixState(top5.length ? top5.reduce((sum, value) => sum + value, 0) : null),
    shareholderCount: sixState(capTable.length > 0 ? capTable.length : null),
    founderControl: founderControlField(ownership),
    founderBackground: sixState(people?.data?.keyPeople?.[0]?.name ?? null),
    industryChain: sixState(business?.data?.products?.[0]?.category ?? null),
    expansionCycle: sixState(business?.data?.techRoute?.[0]?.route ?? null),
    prosperity: sixState(market?.data?.marketSize?.[0]?.growthPct ?? null),
    grossMargin: sixState(financials?.data?.grossMargin ?? null),
    ranking: sixState(market?.data?.competition?.[0]?.positioning ?? null),
    techRelevance: sixState(fit?.data?.technologyFit?.value ?? fit?.data?.technologyFit ?? null),
    totalFunding: sixState(totalFunding > 0 ? totalFunding : null),
    assessment: sixState(fit?.data?.conclusion?.technologyCommercial ?? fit?.data?.equityView?.value ?? null),
  }
}

function claimRefFor(claims, predicate, subjectId) {
  if (!subjectId) return null
  return claims.find((claim) => claim.predicate === predicate && claim.subjectId === subjectId)?.claimId ?? null
}

function buildSevenN({ artifacts, claims }) {
  const platforms = artifacts.filter((artifact) => artifact.type === 'investment.map' && artifact.data?.mode === 'platform')
  const familySheets = []
  const rows = []
  for (const platform of platforms) {
    const sheet = categorySheet(platform.data, familySheets)
    if (sheet === '说明') continue
    for (const entity of platform.data.entities ?? []) {
      const join = entityJoin(entity)
      const fields = entityFields({ artifacts, entity })
      rows.push({
        sheet,
        platform: {
          platformId: platform.data.platformId ?? platform.partitionKey ?? '',
          name: platform.data.name ?? platform.data.platformId,
          role: platform.data.role ?? '',
          structure: joinText(
            platform.data.vehicles,
            (vehicle) => [vehicle?.name, vehicle?.role].filter(Boolean).join(' '),
            '；',
          ) ?? '',
          positioning: platform.data.evidenceSummary ?? '',
          time: platform.data.time ?? platform.data.date ?? '',
          note: platform.data.note ?? '',
        },
        entity: {
          entityId: join.kind === 'entityId' ? join.key : null,
          entityKey: join.key,
          joinKind: join.kind,
          artifactSubjectId: join.artifactSubjectId,
          subjectId: typeof entity.subjectId === 'string' ? entity.subjectId : null,
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
          fields,
        },
        claimRefs: {
          largestShareholderPct: claimRefFor(claims, 'largest_shareholder_pct', join.artifactSubjectId),
          grossMargin: claimRefFor(claims, 'gross_margin', join.artifactSubjectId),
          assessment: claimRefFor(claims, 'investment_cooperation_assessment', join.artifactSubjectId),
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
  const techOrigin = artifacts.find((artifact) => artifact.type === 'tech.origin')
  const qualifications = artifacts.find((artifact) => artifact.type === 'qualifications')
  const debt = artifacts.find((artifact) => artifact.type === 'debt.guarantee')
  const policy = artifacts.find((artifact) => artifact.type === 'policy.exposure')

  const row = (options) => fieldRow(claims, options)
  sheets.push({
    name: '02_主体与股权',
    title: '主体与股权',
    headers: ['字段', '值', '状态', '证据'],
    rows: [
      row({ label: '法定名称', value: identity?.data?.legalName, artifact: identity, predicates: ['legal_name'] }),
      row({ label: '统一社会信用代码', value: identity?.data?.code, artifact: identity, predicates: ['unified_social_credit_code'] }),
      row({ label: '注册地', value: identity?.data?.domicile, artifact: identity, predicates: ['domicile', 'registered_address'] }),
      row({ label: '成立日期', value: identity?.data?.incorporationDate, artifact: identity, predicates: ['incorporation_date', 'established_date'] }),
      row({ label: '主体状态', value: identity?.data?.status, artifact: identity, predicates: ['company_status', 'legal_status'] }),
      row({ label: '股权层级', value: arrayCount(ownership?.data?.layers), artifact: ownership, predicates: ['ownership_layer_count'] }),
      row({
        label: '实控人线索',
        value: joinText(ownership?.data?.ubo, (item) => item?.name),
        artifact: ownership,
        predicates: ['ultimate_beneficial_owner', 'ubo'],
      }),
      row({
        label: '控制方式',
        value: joinText(ownership?.data?.control, (item) => `${item?.name ?? ''}${item?.role ? `（${item.role}）` : ''}`),
        artifact: ownership,
      }),
      row({
        label: '特殊权利',
        value: joinText(ownership?.data?.specialRights, (item) => item?.type),
        artifact: ownership,
      }),
    ],
  })
  sheets.push({
    name: '03_业务与技术',
    title: '业务与技术',
    headers: ['字段', '值', '状态', '证据'],
    rows: [
      row({ label: '产品线', value: joinText(business?.data?.products, (item) => item?.name), artifact: business, predicates: ['main_products', 'product_lines'] }),
      row({
        label: '收入构成',
        value: joinText(
          business?.data?.segments,
          (item) => `${item?.name ?? ''}${item?.revenuePct === undefined || item?.revenuePct === null ? '' : ` ${item.revenuePct}%`}`,
          '；',
        ),
        artifact: business,
      }),
      row({ label: '专利数', value: arrayCount(ip?.data?.patents), artifact: ip, predicates: ['patent_count'] }),
      row({ label: '商标数', value: arrayCount(ip?.data?.trademarks), artifact: ip, predicates: ['trademark_count'] }),
      row({ label: '软著数', value: arrayCount(ip?.data?.software), artifact: ip, predicates: ['software_copyright_count'] }),
      row({ label: '技术来源', value: joinText(techOrigin?.data?.origins, (item) => item?.technology), artifact: techOrigin }),
      row({ label: '资质', value: joinText(qualifications?.data?.items, (item) => item?.name), artifact: qualifications }),
    ],
  })
  sheets.push({
    name: '04_财务',
    title: '财务',
    headers: ['字段', '值', '状态', '证据'],
    rows: [
      row({ label: '财年', value: financials?.data?.fiscalYear, artifact: financials, predicates: ['fiscal_year'] }),
      row({ label: '营业收入', value: financials?.data?.revenue, artifact: financials, predicates: ['revenue', 'operating_revenue'] }),
      row({ label: '净利润', value: financials?.data?.netProfit, artifact: financials, predicates: ['net_profit'] }),
      row({ label: '毛利率', value: financials?.data?.grossMargin, artifact: financials, predicates: ['gross_margin'] }),
      row({ label: '融资轮次', value: arrayCount(financing?.data?.rounds), artifact: financing, predicates: ['financing_round_count'] }),
      row({
        label: '最新估值',
        value: financing?.data?.valuationMarks?.at(-1)?.postMoney,
        artifact: financing,
        predicates: ['post_money_valuation'],
      }),
      row({ label: '有息负债', value: arrayCount(debt?.data?.debt), artifact: debt }),
    ],
  })
  sheets.push({
    name: '05_风险',
    title: '风险',
    headers: ['字段', '值', '状态', '证据'],
    rows: [
      row({ label: '诉讼', value: arrayCount(legal?.data?.litigation), artifact: legal, predicates: ['litigation_count'] }),
      row({ label: '被执行', value: arrayCount(legal?.data?.enforcement), artifact: legal, predicates: ['enforcement_count'] }),
      row({ label: '失信', value: arrayCount(legal?.data?.dishonest), artifact: legal, predicates: ['dishonest_count'] }),
      row({ label: '股权冻结', value: arrayCount(legal?.data?.frozen), artifact: legal, predicates: ['equity_freeze_count'] }),
      row({ label: '行政处罚', value: arrayCount(regulatory?.data?.penalties), artifact: regulatory, predicates: ['penalty_count'] }),
      row({ label: '管制清单', value: arrayCount(policy?.data?.listings), artifact: policy }),
      row({ label: '红旗', value: arrayCount(redflags?.data?.flags), artifact: redflags }),
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
  lines.push(`> artifactId ${artifact.id} ｜ revision ${artifact.revision} ｜ status ${artifact.status} ｜ asOf ${artifact.asOf}`)
  lines.push('>')
  lines.push(`> contentHash ${artifact.contentHash}`)
  lines.push(`> versionKey ${artifactVersionKey(artifact)}`)
  lines.push('')
  lines.push('## 1. 程序')
  lines.push('')
  lines.push(module?.manifest?.description ?? '按模块方法论执行公开信息检索与核验。')
  lines.push('')
  lines.push(`- 模块：${artifact.producedBy?.moduleId ?? ''}@${artifact.producedBy?.moduleVersion ?? ''}`)
  lines.push(`- 输入：${(artifact.derivedFrom ?? []).map((edge) => `${edge.type} rev${edge.revision}`).join('；') || '无'}`)
  lines.push(`- 检查：${(artifact.checks ?? []).map((check) => `${check.id}:${check.status}`).join('；') || '无'}`)
  lines.push(`- 证据：${(artifact.evidenceIds ?? []).join(', ') || '无'}`)
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
  if (claims.length === 0) lines.push('| — | — | — | not_reviewed | 无 |')
  lines.push('')
  lines.push('| evidenceId | 来源 | 引文 | 定位 | 核验 |')
  lines.push('|---|---|---|---|---|')
  for (const item of evidence) {
    lines.push(`| ${item.evidenceId} | ${item.url ?? ''} | ${escapeCell(truncate(item.quote, 200))} | ${item.locator ?? ''} | ${item.verificationStatus ?? ''} |`)
  }
  if (evidence.length === 0) lines.push('| — | — | — | — | 无 |')
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
  lines.push('- preparedBy：equity-diligence（系统构建）。')
  lines.push('- reviewedBy / reviewedAt / 复核结论：待填。')
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
/**
 * Keep the delivery directory free of builder-internal artefacts and of the
 * previous package's verdicts. A failed rebuild must not leave an old
 * manifest/QA record that can be mistaken for the new package.
 */
async function cleanDeliveryResidue(outDir) {
  const stale = [
    'manifest.json',
    'QA与签发记录.md',
    'workbook_map.json',
    '00_范围与口径.md',
    '01_管理层摘要.md',
    '02_综合尽调工作簿.xlsx',
    '03_专项_投资版图_7+N.xlsx',
    '04_工作底稿',
    '05_证据快照',
  ]
  for (const name of stale) await removeDir(join(outDir, name))
  const files = await listFiles(outDir)
  for (const file of files) {
    const relative = portableRelative(outDir, file)
    if (relative === '.build-input.json' || relative.endsWith('/.build-input.json') || relative.endsWith('.inspect.json')) {
      await removeDir(file)
    }
  }
}

function qaPayload(qa) {
  return {
    passed: qa.passed === true,
    blocking: Array.isArray(qa.blocking) ? qa.blocking : [],
    warnings: Array.isArray(qa.warnings) ? qa.warnings : [],
  }
}

function workpaperIndexMarkdown({ artifacts, claims, evidence }) {
  const lines = []
  lines.push('# 工作底稿索引')
  lines.push('')
  lines.push(`> 共 ${artifacts.length} 份底稿 / ${artifacts.length} 份 workpaper；claim ${claims.length} 条；证据 ${evidence.length} 条。`)
  lines.push('>')
  lines.push('> 路径规则：`04_工作底稿/<type>/<subjectId>/<partitionKey>/workpaper.md`，一份底稿一个文件，不覆盖。')
  lines.push('')
  lines.push('| # | artifactId | 类型 | 主体 | 分区 | revision | status | 证据数 | claim 数 | workpaper |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const [index, artifact] of artifacts.entries()) {
    const artifactClaims = claims.filter((claim) => artifact.claimIds?.includes(claim.claimId))
    const artifactEvidence = evidence.filter((item) => artifact.evidenceIds?.includes(item.evidenceId))
    lines.push(`| ${index + 1} | ${artifact.id} | ${artifact.type} | ${artifact.subjectId} | ${artifact.partitionKey} | ${artifact.revision} | ${artifact.status} | ${artifactEvidence.length} | ${artifactClaims.length} | ${workpaperRelativePath(artifact)} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Build the full delivery package.
 *
 * QA is computed for real: a preliminary workbook is generated, `validateDelivery`
 * runs against it, and the workbooks are rebuilt with that real QA so the
 * `10_体检单` sheet, `manifest.qa` and `QA与签发记录.md` carry the same verdict.
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
  const qaDir = join(root, '.equity', 'delivery')
  await ensureDir(outDir)
  await ensureDir(qaDir)
  await cleanDeliveryResidue(outDir)

  // Delivery reads only genuinely released revisions. Draft/stale/rejected
  // artifacts stay in the project but never enter the package.
  const allArtifacts = await listArtifacts(root)
  const artifacts = (await listVerifiedArtifacts(root)).filter((artifact) => artifact.status === 'verified')
  const businessArtifacts = artifacts.filter((artifact) => !NON_BUSINESS_ARTIFACT_TYPES.has(artifact.type))
  const stale = allArtifacts.filter((artifact) => artifact.status === 'stale')
  const rejected = allArtifacts.filter((artifact) => artifact.status === 'rejected')
  const draft = allArtifacts.filter((artifact) => artifact.status === 'draft')

  const allClaims = []
  const seenClaimIds = new Set()
  for (const artifact of artifacts) {
    const claims = await listClaims(root, artifact.subjectId)
    for (const claim of claims) {
      if (!artifact.claimIds?.includes(claim.claimId)) continue
      if (seenClaimIds.has(claim.claimId)) continue
      seenClaimIds.add(claim.claimId)
      allClaims.push({
        ...claim,
        artifactId: artifact.id,
        artifactRevision: artifact.revision,
        artifactContentHash: artifact.contentHash,
      })
    }
  }

  // Only evidence referenced by released artifacts/claims is deliverable.
  const deliveredEvidenceIds = new Set()
  for (const artifact of artifacts) {
    for (const id of artifact.evidenceIds ?? []) deliveredEvidenceIds.add(id)
  }
  for (const claim of allClaims) {
    for (const link of claim.evidenceLinks ?? []) {
      if (link?.evidenceId) deliveredEvidenceIds.add(link.evidenceId)
    }
  }
  const evidence = (await listEvidence(root)).filter((item) => deliveredEvidenceIds.has(item.evidenceId))

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
    partial: partial ?? (
      allArtifacts.some((artifact) => ['draft', 'stale', 'rejected'].includes(artifact.status)) ||
      businessArtifacts.length === 0
    ),
    staleCount: stale.length,
    rejectedCount: rejected.length,
    draftCount: draft.length,
    verifiedCount: artifacts.length,
    businessCount: businessArtifacts.length,
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
    ...(draft.length ? [`有 ${draft.length} 份底稿 draft，未进入本次交付。`] : []),
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

  // Workpapers: one file per artifact, path carries type/subject/partition.
  const workpapers = []
  for (const artifact of artifacts) {
    const module = library.modules.get(artifact.producedBy?.moduleId)
    const relative = workpaperRelativePath(artifact)
    const file = join(outDir, relative)
    const claims = allClaims.filter((claim) => artifact.claimIds?.includes(claim.claimId))
    const ev = evidence.filter((item) => artifact.evidenceIds?.includes(item.evidenceId))
    await atomicWriteText(file, workpaperMarkdown({ artifact, claims, evidence: ev, module }))
    workpapers.push({ artifactId: artifact.id, path: relative })
  }
  await atomicWriteText(
    join(outDir, '04_工作底稿', '00_索引.md'),
    workpaperIndexMarkdown({ artifacts, claims: allClaims, evidence }),
  )

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

  // Input for the Python workbook builder. No QA verdict is assumed here: the
  // first build is explicitly provisional, then rebuilt with the real QA.
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
    entities: sevenN.rows.map((row) => ({
      // Preserve the real entity identifier: `entityId` when the data model has
      // one, otherwise the legacy artifact subjectId. A display-name fallback is
      // recorded as entityKey with joinKey='name' and never pretends to be an
      // artifact subject.
      entityId: row.entity.entityId ?? row.entity.artifactSubjectId ?? null,
      entityKey: row.entity.entityKey,
      joinKey: row.entity.joinKind,
      artifactSubjectId: row.entity.artifactSubjectId,
      subjectId: row.entity.subjectId,
      name: row.entity.name,
      platformId: row.platform.platformId,
      platformName: row.platform.name,
      platformCategory: row.sheet.match(/^\d+/) ? row.sheet.match(/^\d+/)[0] : '',
      path: row.platform.name,
      ownership: row.entity.largestShareholderPct ? String(row.entity.largestShareholderPct) : '',
      fields: row.entity.fields,
      claimRefs: row.claimRefs,
    })),
    sevenN,
    comprehensive: { sheets: comprehensive },
    qa: { passed: null, provisional: true, blocking: [], warnings: [] },
    signoff: {
      preparedBy: signoff.preparedBy ?? 'equity-diligence',
      reviewedBy: signoff.reviewedBy ?? '',
      approvedBy: signoff.approvedBy ?? '',
      proposedAt: signoff.proposedAt ?? nowIso(),
      signedAt: signoff.signedAt ?? null,
    },
    cellMap: findings.filter((finding) => finding.claimId).map((finding) => {
      const claim = allClaims.find((item) => item.claimId === finding.claimId)
      const artifact = claim ? artifacts.find((item) => item.claimIds?.includes(claim.claimId)) : null
      return {
        location: `01_管理层摘要.md#${finding.findingId}`,
        workpaper: artifact ? workpaperRelativePath(artifact) : null,
        claimId: finding.claimId,
        artifactId: claim?.artifactId ?? finding.artifactId,
        artifactRevision: claim?.artifactRevision ?? null,
        artifactContentHash: claim?.artifactContentHash ?? null,
        value: finding.fact,
        evidenceIds: claim?.evidenceLinks?.map((link) => link.evidenceId) ?? [],
      }
    }),
  }
  const inputFile = join(qaDir, 'build-input.json')
  await atomicWriteJson(inputFile, buildInput)
  const pythonScript = join(PACKAGE_ROOT, 'python', 'build_workbooks.py')
  const mapFile = join(outDir, 'workbook_map.json')

  // 1) preliminary build + real QA (no hardcoded `passed: true` anywhere)
  await runPython(pythonScript, ['--input', inputFile, '--out', outDir])
  let workbookMap = await readJson(mapFile, null)
  const qa = await validateDelivery({
    root,
    outDir,
    qaDir,
    artifacts,
    verifiedArtifacts: artifacts,
    allArtifacts,
    claims: allClaims,
    evidence,
    findings,
    comprehensive,
    workbookMap,
    meta,
    signoff: buildInput.signoff,
  })

  // 2) write the real QA back into the build input and rebuild the workbooks so
  //    `10_体检单` carries the same verdict as manifest.json / QA与签发记录.md.
  buildInput.qa = qaPayload(qa)
  await atomicWriteJson(inputFile, buildInput)
  const buildResult = await runPython(pythonScript, ['--input', inputFile, '--out', outDir])
  workbookMap = await readJson(mapFile, null)

  // Manifest + QA record. QA is written before hashing so it is part of the
  // manifest; manifest.json cannot hash itself and is therefore not listed.
  const manifestBase = {
    schemaVersion: 1,
    projectId: project.projectId,
    generatedAt: nowIso(),
    builderVersion: BUILDER_VERSION,
    runId: run?.runId ?? null,
    snapshotHash: plan?.snapshotHash ?? null,
    template,
    counts: {
      artifacts: artifacts.length,
      workpapers: workpapers.length,
      claims: allClaims.length,
      evidence: evidence.length,
    },
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      subjectId: artifact.subjectId,
      partitionKey: artifact.partitionKey,
      revision: artifact.revision,
      contentHash: artifact.contentHash,
      status: artifact.status,
      asOf: artifact.asOf,
      workpaper: workpaperRelativePath(artifact),
    })),
    evidenceCount: evidence.length,
    claimCount: allClaims.length,
    qa: qaPayload(qa),
    signoff: buildInput.signoff,
    cellMap: buildInput.cellMap,
  }
  await atomicWriteText(join(outDir, 'QA与签发记录.md'), qaMarkdown({ qa, manifest: manifestBase, signoff: buildInput.signoff }))
  const isDeliverableFile = (file) => {
    const relative = portableRelative(outDir, file)
    if (relative === 'manifest.json') return false
    if (relative === '.build-input.json' || relative.endsWith('/.build-input.json')) return false
    if (relative.endsWith('.inspect.json')) return false
    if (relative.split('/').some((segment) => segment.startsWith('.'))) return false
    return true
  }
  const files = await listFiles(outDir, { filter: isDeliverableFile })
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
  const manifest = { ...manifestBase, files: manifestFiles }
  await atomicWriteJson(join(outDir, 'manifest.json'), manifest)

  // Manifest/directory correspondence is part of the contract, not a courtesy.
  const listed = manifestFiles.map((file) => file.path).sort()
  const onDisk = (await listFiles(outDir, { filter: isDeliverableFile }))
    .map((file) => portableRelative(outDir, file))
    .sort()
  if (canonicalJson(listed) !== canonicalJson(onDisk)) {
    throw new EquityError('manifest_mismatch', 'manifest.json 与交付目录不一致', { listed, onDisk })
  }

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
    buildInput,
    inputFile,
    workpapers,
    ddRequests,
    findings,
    stdout: buildResult.stdout ?? '',
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

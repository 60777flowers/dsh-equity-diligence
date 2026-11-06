#!/usr/bin/env node
/**
 * Generate the 25 module manifests (24 built-in + generic).
 * SKILL.md, prompts and rules are authored separately; this script only owns
 * the machine-readable contract so ids, inputs and outputs cannot drift.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const modulesDir = join(root, 'assets', 'modules')

/**
 * provenance：每个模块必须能回答"谁写的、怎么来的"。
 *   human = 人工编写，作者对该方法论负责，能解释每条规则的来历；
 *   agent = AI 初稿（默认 author 记为 `ai-draft`），待人工接管
 *           （接管后把 author 改成接手人、origin 改成 human）。
 * 后续作者（人或 AI）新增模块时，在这里登记或在 module.yaml 里手写。
 */
const PROVENANCE = {
  'investment-map': {
    author: '60777flowers',
    origin: 'human',
    derivedFrom: 'investigate-equity-structure v7',
  },
}
const AI_DRAFT_AUTHOR = 'ai-draft'
const provenanceFor = (slug) => PROVENANCE[slug] ?? { author: AI_DRAFT_AUTHOR, origin: 'agent' }

const modules = [
  {
    slug: 'entity-resolution', id: 'builtin/entity-resolution', name: '主体识别与工商底册', version: '0.1.0',
    kind: 'collect', stage: 'identity', scope: 'company',
    description: '把项目目标解析为唯一法定主体，产出工商底册与主体标识。',
    inputs: [{ type: 'company.roster', onMissing: 'block' }],
    outputs: [{ type: 'company.identity', typeVersion: 1 }],
    params: [
      { key: 'maxCandidates', type: 'integer', default: 5, min: 1, max: 20, label: '候选主体上限' },
      { key: 'requireCode', type: 'boolean', default: true, label: '是否要求统一社会信用代码' },
    ],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.8 } }],
    review: { mode: 'single', maxRounds: 1 },
    // 实测校准：真实标的常需多次工商/公告检索，12/40000 不够用，提到 20/60000/25。
    budget: { toolCallsPerUnit: 20, tokensPerUnit: 60000, wallClockMinPerUnit: 25 },
  },
  {
    slug: 'ownership-chain', id: 'builtin/ownership-chain', name: '股权、控制权与特殊权利', version: '0.1.0',
    kind: 'collect', stage: 'ownership', scope: 'company',
    description: '梳理股权层级、控制链、一致行动、特殊权利与历次变更。',
    inputs: [{ type: 'company.identity', onMissing: 'block' }],
    outputs: [{ type: 'ownership.chain', typeVersion: 1 }],
    params: [
      { key: 'maxLayers', type: 'integer', default: 8, min: 2, max: 15, label: '穿透层级上限' },
      { key: 'includeSpecialRights', type: 'boolean', default: true, label: '是否查特殊权利' },
    ],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.8 } }, { id: 'evidence', type: 'rule', config: { minEvidence: 3 } }],
    review: { mode: 'adversarial', maxRounds: 2 },
    budget: { toolCallsPerUnit: 30, tokensPerUnit: 90000, wallClockMinPerUnit: 45 },
  },
  {
    slug: 'investment-map', id: 'builtin/investment-map', name: '对外投资版图', version: '0.2.0',
    kind: 'collect', stage: 'ownership', scope: 'company',
    description: '梳理九类投资出口、平台、被投实体与跨平台路径。',
    inputs: [{ type: 'company.identity', onMissing: 'block' }, { type: 'ownership.chain', onMissing: 'block' }],
    references: [{ type: 'business.segment' }],
    outputs: [{ type: 'investment.map', typeVersion: 1 }],
    params: [
      { key: 'maxPlatforms', type: 'integer', default: 40, min: 5, max: 120, label: '平台数量上限' },
      { key: 'includeOverseas', type: 'boolean', default: true, label: '是否包含境外平台' },
    ],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.8 } }, { id: 'evidence', type: 'rule', config: { minEvidence: 3 } }],
    review: { mode: 'adversarial', maxRounds: 3 },
    budget: { toolCallsPerUnit: 40, tokensPerUnit: 120000, wallClockMinPerUnit: 90 },
  },
  {
    slug: 'related-parties', id: 'builtin/related-parties', name: '关联方与关联交易', version: '0.1.0',
    kind: 'collect', stage: 'ownership', scope: 'company',
    description: '梳理关联方清单、关联交易、资金占用与买卖重叠。',
    inputs: [{ type: 'company.identity', onMissing: 'block' }, { type: 'ownership.chain', onMissing: 'block' }],
    references: [{ type: 'valuechain.parties' }, { type: 'supply.capacity' }],
    outputs: [{ type: 'related.parties', typeVersion: 1 }],
    params: [{ key: 'includeExecutives', type: 'boolean', default: true, label: '是否含董监高关联方' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 18, tokensPerUnit: 60000, wallClockMinPerUnit: 30 },
  },
  {
    slug: 'org-people', id: 'builtin/org-people', name: '创始人与关键人', version: '0.1.0',
    kind: 'collect', stage: 'people', scope: 'company',
    description: '梳理实控人、董监高、核心团队、任职与关联企业。',
    inputs: [{ type: 'company.identity', onMissing: 'block' }, { type: 'ownership.chain', onMissing: 'block' }],
    outputs: [{ type: 'org.people', typeVersion: 1 }],
    params: [{ key: 'includeLitigation', type: 'boolean', default: true, label: '是否查关键人诉讼' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 18, tokensPerUnit: 60000, wallClockMinPerUnit: 30 },
  },
  {
    slug: 'workforce', id: 'builtin/workforce', name: '组织、人力与用工', version: '0.1.0',
    kind: 'collect', stage: 'people', scope: 'company',
    description: '梳理人数、结构、人效、社保合规与招聘趋势。',
    inputs: [{ type: 'company.identity', onMissing: 'block' }],
    references: [{ type: 'financials.public' }],
    outputs: [{ type: 'workforce.profile', typeVersion: 1 }],
    params: [{ key: 'yearsBack', type: 'integer', default: 3, min: 1, max: 10, label: '回溯年限' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 14, tokensPerUnit: 40000, wallClockMinPerUnit: 25 },
  },
  {
    slug: 'business-segment', id: 'builtin/business-segment', name: '产品矩阵与技术路线', version: '0.1.0',
    kind: 'collect', stage: 'business', scope: 'company',
    description: '梳理产品线、代际、收入构成、技术路线与扩产周期。',
    inputs: [{ type: 'company.identity', onMissing: 'block' }],
    references: [{ type: 'market.landscape' }],
    outputs: [{ type: 'business.segment', typeVersion: 1 }],
    params: [{ key: 'includeRevenueMix', type: 'boolean', default: true, label: '是否拆收入构成' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.8 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 24, tokensPerUnit: 80000, wallClockMinPerUnit: 40 },
  },
  {
    slug: 'customers-orders', id: 'builtin/customers-orders', name: '客户、订单与招投标', version: '0.1.0',
    kind: 'collect', stage: 'business', scope: 'company',
    description: '梳理前五大客户、集中度、认证阶段、订单与中标记录。',
    inputs: [{ type: 'business.segment', onMissing: 'block' }],
    references: [{ type: 'related.parties' }, { type: 'ownership.chain' }],
    outputs: [{ type: 'valuechain.parties', typeVersion: 1 }],
    params: [{ key: 'topN', type: 'integer', default: 5, min: 3, max: 10, label: '前 N 大客户' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 20, tokensPerUnit: 60000, wallClockMinPerUnit: 30 },
  },
  {
    slug: 'supply-capacity', id: 'builtin/supply-capacity', name: '供应链、产能与成本', version: '0.1.0',
    kind: 'collect', stage: 'business', scope: 'company',
    description: '梳理供应商、单一来源、产能/稼动率与成本结构。',
    inputs: [{ type: 'business.segment', onMissing: 'block' }],
    references: [{ type: 'related.parties' }],
    outputs: [{ type: 'supply.capacity', typeVersion: 1 }],
    params: [{ key: 'includeCost', type: 'boolean', default: true, label: '是否拆成本结构' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 20, tokensPerUnit: 60000, wallClockMinPerUnit: 30 },
  },
  {
    slug: 'market-landscape', id: 'builtin/market-landscape', name: '行业空间与竞争格局', version: '0.1.0',
    kind: 'collect', stage: 'market', scope: 'company',
    description: '梳理行业规模、增速、份额、竞争格局与政策。',
    inputs: [{ type: 'business.segment', onMissing: 'block' }],
    outputs: [{ type: 'market.landscape', typeVersion: 1 }],
    params: [{ key: 'yearsBack', type: 'integer', default: 3, min: 1, max: 10, label: '回溯年限' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 20, tokensPerUnit: 60000, wallClockMinPerUnit: 30 },
  },
  {
    slug: 'ip-portfolio', id: 'builtin/ip-portfolio', name: '知识产权组合', version: '0.1.0',
    kind: 'collect', stage: 'tech', scope: 'company',
    description: '梳理专利/商标/软著/资质清单、法律状态与质押。',
    inputs: [{ type: 'company.identity', onMissing: 'block' }, { type: 'business.segment', onMissing: 'block' }],
    references: [{ type: 'org.people' }],
    outputs: [{ type: 'ip.portfolio', typeVersion: 1 }],
    params: [{ key: 'includeFamily', type: 'boolean', default: true, label: '是否合并同族' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 22, tokensPerUnit: 60000, wallClockMinPerUnit: 30 },
  },
  {
    slug: 'tech-origin', id: 'builtin/tech-origin', name: '技术来源、FTO 与商业秘密', version: '0.1.0',
    kind: 'verify', stage: 'tech', scope: 'company',
    description: '核验技术来源、许可、FTO 线索与商业秘密诉讼。',
    inputs: [{ type: 'ip.portfolio', onMissing: 'block' }, { type: 'org.people', onMissing: 'block' }],
    references: [{ type: 'business.segment' }],
    outputs: [{ type: 'tech.origin', typeVersion: 1 }],
    params: [{ key: 'jurisdictions', type: 'string', default: 'CN,US,EP', label: '司法辖区' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 22, tokensPerUnit: 60000, wallClockMinPerUnit: 35 },
  },
  {
    slug: 'qualifications', id: 'builtin/qualifications', name: '资质、认定与准入', version: '0.1.0',
    kind: 'collect', stage: 'tech', scope: 'company',
    description: '梳理高企、专精特新、行业许可、体系认证及有效期。',
    inputs: [{ type: 'company.identity', onMissing: 'block' }],
    references: [{ type: 'business.segment' }],
    outputs: [{ type: 'qualifications', typeVersion: 1 }],
    params: [{ key: 'includeExpired', type: 'boolean', default: false, label: '是否含已过期' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 14, tokensPerUnit: 40000, wallClockMinPerUnit: 20 },
  },
  {
    slug: 'financials-public', id: 'builtin/financials-public', name: '财务质量与勾稽', version: '0.1.0',
    kind: 'collect', stage: 'finance', scope: 'company',
    description: '收集公开财务数据，做三表勾稽、收入质量与口径检查。',
    inputs: [{ type: 'business.segment', onMissing: 'block' }],
    references: [{ type: 'valuechain.parties' }, { type: 'supply.capacity' }],
    outputs: [{ type: 'financials.public', typeVersion: 1 }],
    params: [{ key: 'yearsBack', type: 'integer', default: 3, min: 1, max: 10, label: '回溯财年' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.8 } }, { id: 'evidence', type: 'rule', config: { minEvidence: 2 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 26, tokensPerUnit: 80000, wallClockMinPerUnit: 40 },
  },
  {
    slug: 'financing-history', id: 'builtin/financing-history', name: '融资历史与估值轨迹', version: '0.1.0',
    kind: 'collect', stage: 'finance', scope: 'company',
    description: '梳理历轮融资、金额、估值、投资人、老股与回购线索。',
    inputs: [{ type: 'company.identity', onMissing: 'block' }, { type: 'ownership.chain', onMissing: 'block' }],
    references: [{ type: 'business.segment' }],
    outputs: [{ type: 'financing.history', typeVersion: 1 }],
    params: [{ key: 'includeRepurchase', type: 'boolean', default: true, label: '是否查回购条款' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 18, tokensPerUnit: 50000, wallClockMinPerUnit: 25 },
  },
  {
    slug: 'debt-guarantee', id: 'builtin/debt-guarantee', name: '债务、担保与评级', version: '0.1.0',
    kind: 'collect', stage: 'finance', scope: 'company',
    description: '梳理有息负债、对外担保、评级与表外负债。',
    inputs: [{ type: 'financials.public', onMissing: 'block' }, { type: 'ownership.chain', onMissing: 'block' }],
    references: [{ type: 'legal.risk' }],
    outputs: [{ type: 'debt.guarantee', typeVersion: 1 }],
    params: [{ key: 'includeOffBalance', type: 'boolean', default: true, label: '是否查表外' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 18, tokensPerUnit: 50000, wallClockMinPerUnit: 25 },
  },
  {
    slug: 'legal-risk', id: 'builtin/legal-risk', name: '司法风险', version: '0.1.0',
    kind: 'collect', stage: 'risk', scope: 'company',
    description: '收集诉讼、被执行、失信、股权冻结与破产线索。',
    inputs: [{ type: 'company.identity', onMissing: 'block' }],
    references: [{ type: 'ownership.chain' }, { type: 'org.people' }],
    outputs: [{ type: 'legal.risk', typeVersion: 1 }],
    params: [{ key: 'yearsBack', type: 'integer', default: 5, min: 1, max: 10, label: '回溯年限' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 20, tokensPerUnit: 60000, wallClockMinPerUnit: 30 },
  },
  {
    slug: 'regulatory-compliance', id: 'builtin/regulatory-compliance', name: '行政监管与信用', version: '0.1.0',
    kind: 'collect', stage: 'risk', scope: 'company',
    description: '收集行政处罚、税务/海关信用、经营异常与监管问询。',
    inputs: [{ type: 'company.identity', onMissing: 'block' }],
    references: [{ type: 'business.segment' }],
    outputs: [{ type: 'regulatory.compliance', typeVersion: 1 }],
    params: [{ key: 'yearsBack', type: 'integer', default: 3, min: 1, max: 10, label: '回溯年限' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 16, tokensPerUnit: 45000, wallClockMinPerUnit: 25 },
  },
  {
    slug: 'policy-exposure', id: 'builtin/policy-exposure', name: '出口管制与地缘合规', version: '0.1.0',
    kind: 'collect', stage: 'risk', scope: 'company',
    description: '核对 BIS/OFAC/EU/UN/商务部清单、物项与交易对手暴露。',
    inputs: [{ type: 'business.segment', onMissing: 'block' }, { type: 'ip.portfolio', onMissing: 'block' }],
    references: [{ type: 'valuechain.parties' }, { type: 'supply.capacity' }],
    outputs: [{ type: 'policy.exposure', typeVersion: 1 }],
    params: [{ key: 'listAsOf', type: 'string', default: '', label: '清单版本日期' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 20, tokensPerUnit: 60000, wallClockMinPerUnit: 30 },
  },
  {
    slug: 'esg-ehs', id: 'builtin/esg-ehs', name: 'ESG、环保与安全生产', version: '0.1.0',
    kind: 'collect', stage: 'risk', scope: 'company',
    description: '梳理环评、排污许可、能耗、碳与安全生产记录。',
    inputs: [{ type: 'business.segment', onMissing: 'block' }, { type: 'supply.capacity', onMissing: 'block' }],
    references: [{ type: 'regulatory.compliance' }],
    outputs: [{ type: 'esg.ehs', typeVersion: 1 }],
    params: [{ key: 'yearsBack', type: 'integer', default: 3, min: 1, max: 10, label: '回溯年限' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 16, tokensPerUnit: 45000, wallClockMinPerUnit: 25 },
  },
  {
    slug: 'public-sentiment', id: 'builtin/public-sentiment', name: '舆情与利益相关方', version: '0.1.0',
    kind: 'collect', stage: 'risk', scope: 'company',
    description: '收集负面事件、举报、利益相关方评价与后续进展。',
    inputs: [{ type: 'org.people', onMissing: 'block' }, { type: 'business.segment', onMissing: 'block' }],
    references: [{ type: 'legal.risk' }],
    outputs: [{ type: 'public.sentiment', typeVersion: 1 }],
    params: [{ key: 'daysBack', type: 'integer', default: 365, min: 30, max: 1095, label: '回溯天数' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.6 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 18, tokensPerUnit: 45000, wallClockMinPerUnit: 25 },
  },
  {
    slug: 'assessment-fit', id: 'builtin/assessment-fit', name: '合作契合度（委托方视角）', version: '0.1.0',
    kind: 'assess', stage: 'assessment', scope: 'company',
    description: '从委托方视角评估技术/商业合作适配，股权投资判断只作 IC 输入。',
    inputs: [
      { type: 'ownership.chain', onMissing: 'block' },
      { type: 'business.segment', onMissing: 'block' },
      { type: 'investment.map', onMissing: 'block' },
    ],
    references: [{ type: 'ip.portfolio' }, { type: 'financials.public' }, { type: 'tech.origin' }],
    outputs: [{ type: 'assessment.fit', typeVersion: 1 }],
    params: [{ key: 'clientProfile', type: 'string', default: 'example', label: '委托方档案' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 10, tokensPerUnit: 50000, wallClockMinPerUnit: 30 },
  },
  {
    slug: 'red-flags', id: 'builtin/red-flags', name: '证据矩阵与红旗清单', version: '0.1.0',
    kind: 'synthesize', stage: 'assessment', scope: 'company',
    description: '汇总风险类底稿，运行 12 条核查触发器，输出红旗与待核清单。',
    inputs: [{ type: 'legal.risk', onMissing: 'block' }, { type: 'regulatory.compliance', onMissing: 'block' }],
    references: [{ type: 'financials.public' }, { type: 'ownership.chain' }, { type: 'public.sentiment' }],
    outputs: [{ type: 'risk.redflags', typeVersion: 1 }],
    params: [{ key: 'triggerPack', type: 'string', default: 'v1', label: '触发器包版本' }],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.7 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 8, tokensPerUnit: 40000, wallClockMinPerUnit: 25 },
  },
  {
    slug: 'deliverable', id: 'builtin/deliverable', name: '报告与附表', version: '0.1.0',
    kind: 'deliver', stage: 'delivery', scope: 'project',
    description: '从底稿构建管理层摘要、综合工作簿、7+N 专项、底稿包与 QA。',
    inputs: [{ type: 'all', onMissing: 'block' }],
    outputs: [{ type: 'report.deliverable', typeVersion: 1 }, { type: 'dd.request_list', typeVersion: 1 }],
    params: [
      { key: 'template', type: 'string', default: 'standard', enum: ['quick', 'standard', 'deep'], label: '交付模板' },
      { key: 'include7N', type: 'boolean', default: true, label: '是否生成 7+N 专项' },
    ],
    gates: [{ id: 'schema', type: 'schema' }],
    review: { mode: 'none', maxRounds: 0 },
    budget: { toolCallsPerUnit: 0, tokensPerUnit: 20000, wallClockMinPerUnit: 30 },
  },
  {
    slug: 'generic-investigation', id: 'builtin/generic-investigation', name: '通用调查（兜底）', version: '0.1.0',
    kind: 'collect', stage: 'investigation', scope: 'company',
    description: '没有专用模块时，对任意公开可查问题做有证据的初步调查。',
    inputs: [{ type: 'company.identity', onMissing: 'degrade' }],
    outputs: [{ type: 'document.markdown', typeVersion: 1 }, { type: 'structured.findings', typeVersion: 1 }],
    params: [
      { key: 'question', type: 'string', default: '这家公司是谁、做什么、有什么值得关注的公开信息？', label: '调查问题' },
      { key: 'depth', type: 'string', default: 'standard', enum: ['quick', 'standard', 'deep'], label: '调查深度' },
    ],
    gates: [{ id: 'schema', type: 'schema' }, { id: 'coverage', type: 'coverage', config: { min: 0.8 } }],
    review: { mode: 'single', maxRounds: 1 },
    budget: { toolCallsPerUnit: 30, tokensPerUnit: 80000, wallClockMinPerUnit: 45 },
  },
]

function needsQuote(text) {
  return /^(?:$|[-?:,[\]{}#&*!|>'"%@`]|\s)|: |\s#|[\n\r\t]/.test(text)
}

function yamlScalar(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  return needsQuote(text) ? JSON.stringify(text) : text
}

function yamlLines(value, indent = 0) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`]
    return value.flatMap((item) => {
      if (item !== null && typeof item === 'object') {
        const entries = Object.entries(item)
        if (entries.length === 0) return [`${pad}- {}`]
        const first = entries[0]
        const lines = [`${pad}- ${first[0]}: ${yamlScalar(first[1])}`]
        for (const [key, child] of entries.slice(1)) {
          if (child !== null && typeof child === 'object') {
            lines.push(`${pad}  ${key}:`)
            lines.push(...yamlLines(child, indent + 4))
          } else {
            lines.push(`${pad}  ${key}: ${yamlScalar(child)}`)
          }
        }
        return lines
      }
      return [`${pad}- ${yamlScalar(item)}`]
    })
  }
  if (value !== null && typeof value === 'object') {
    const lines = []
    for (const [key, child] of Object.entries(value)) {
      if (child !== null && typeof child === 'object') {
        lines.push(`${pad}${key}:`)
        lines.push(...yamlLines(child, indent + 2))
      } else {
        lines.push(`${pad}${key}: ${yamlScalar(child)}`)
      }
    }
    return lines
  }
  return [`${pad}${yamlScalar(value)}`]
}

for (const mod of modules) {
  const dir = join(modulesDir, mod.slug)
  await mkdir(join(dir, 'prompts'), { recursive: true })
  await mkdir(join(dir, 'rules'), { recursive: true })
  const manifest = {
    apiVersion: 'equity.module/v1',
    id: mod.id,
    name: mod.name,
    version: mod.version,
    kind: mod.kind,
    stageHint: mod.stage,
    scope: mod.scope,
    description: mod.description,
    status: mod.slug === 'policy-exposure' ? 'draft' : 'draft',
    provenance: provenanceFor(mod.slug),
    inputs: mod.inputs,
    ...(mod.references ? { references: mod.references } : {}),
    outputs: mod.outputs,
    params: mod.params,
    render: {
      system: '../_shared/_system.md',
      task: 'prompts/collect.md',
      tail: '../_shared/_tail.md',
    },
    gates: mod.gates,
    review: mod.review,
    budget: mod.budget,
    tools: ['web_search', 'web_fetch', 'equity_record'],
    compat: { kernel: '>=1.0 <2' },
  }
  const text = yamlLines(manifest).join('\n') + '\n'
  await writeFile(join(dir, 'module.yaml'), text, 'utf8')
}

console.log(`generated ${modules.length} module manifests`)

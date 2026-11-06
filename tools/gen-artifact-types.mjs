#!/usr/bin/env node
/**
 * Generate the 32 artifact-type JSON Schemas and the registry index.
 * The generated files are committed; runtime never generates them.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertObjectSchema } from '../src/util/schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'assets', 'artifact-types')
const registryDir = join(root, 'assets', 'registry')

const SIX_STATES = [
  'found',
  'not_disclosed_after_search',
  'lower_bound',
  'pending_dd',
  'conflict',
  'not_applicable',
  'not_reviewed',
  'estimated',
]
const SOURCE_TIERS = [
  'announcement', 'registry', 'regulator', 'court', 'exchange', 'company',
  'media', 'database', 'import', 'sample', 'case_reference',
]
const AUTHORITY = ['A', 'B', 'C', 'D']
const INDEPENDENCE = ['independent', 'same_origin', 'self_reported', 'unknown']
const VERIFICATION = ['verified', 'partial', 'unreachable', 'unverified']
const CONFIDENCE = ['high', 'medium', 'low']
const MATERIALITY = ['material', 'attention', 'context']

const str = (description) => ({ type: 'string', ...(description ? { description } : {}) })
const num = (description) => ({ type: 'number', ...(description ? { description } : {}) })
const bool = () => ({ type: 'boolean' })
const nullable = (schema) => ({ oneOf: [schema, { type: 'null' }] })
const any = (description) => ({ ...(description ? { description } : {}) })
const arr = (items, extra = {}) => ({ type: 'array', items, ...extra })
const openObject = (properties = {}, required = []) => ({
  type: 'object',
  additionalProperties: true,
  ...(Object.keys(properties).length ? { properties } : {}),
  ...(required.length ? { required } : {}),
})

const sixState = {
  type: 'object',
  additionalProperties: true,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: SIX_STATES, description: '六态字段状态' },
    value: any('字段值，允许 null 表示未披露'),
    note: str('状态说明；not_disclosed_after_search 必填'),
    confidence: { type: 'string', enum: CONFIDENCE },
    evidenceIds: arr(str()),
    derivation: {
      type: 'object',
      additionalProperties: true,
      required: ['method'],
      properties: {
        method: str(),
        inputs: arr(str()),
        comparables: arr(str()),
        assumptions: arr(str()),
      },
    },
  },
}

const flag = {
  type: 'object',
  additionalProperties: true,
  required: ['level', 'desc'],
  properties: {
    level: { type: 'string', enum: ['attention', 'material'] },
    rule: str(),
    desc: str(),
    triggerId: str(),
    claimIds: arr(str()),
    evidenceIds: arr(str()),
    action: str(),
    materiality: { type: 'string', enum: MATERIALITY },
  },
}

const claim = {
  type: 'object',
  additionalProperties: true,
  required: ['claimId', 'predicate', 'status'],
  properties: {
    claimId: str(),
    subjectId: str(),
    predicate: str(),
    value: any(),
    unit: str(),
    period: openObject({ asOf: str(), start: str(), end: str() }),
    status: { type: 'string', enum: SIX_STATES },
    materiality: { type: 'string', enum: MATERIALITY },
    evidenceLinks: arr(openObject({
      evidenceId: str(),
      role: { type: 'string', enum: ['supports', 'contradicts', 'contextual'] },
      locator: str(),
      rawHash: str(),
    }, ['evidenceId', 'role'])),
    derivation: openObject(),
    conflictGroup: openObject({
      candidates: arr(openObject()),
      chosenClaimId: str(),
      resolutionRationale: str(),
      decidedBy: str(),
    }),
    note: str(),
  },
}

const evidence = {
  type: 'object',
  additionalProperties: true,
  required: ['evidenceId', 'sourceTier', 'verificationStatus'],
  properties: {
    evidenceId: str(),
    url: str(),
    finalUrl: str(),
    title: str(),
    quote: str(),
    locator: str(),
    sourceTier: { type: 'string', enum: SOURCE_TIERS },
    sourceAuthority: { type: 'string', enum: AUTHORITY },
    sourceIndependence: { type: 'string', enum: INDEPENDENCE },
    verificationStatus: { type: 'string', enum: VERIFICATION },
    claimConfidence: { type: 'string', enum: CONFIDENCE },
    asOf: str(),
    publishedAt: str(),
    retrievedAt: str(),
    rawHash: str(),
    originGroupId: str(),
    verification: openObject({
      method: { type: 'string', enum: ['quote-exact', 'manual', 'import', 'provider'] },
      checkedAt: str(),
      matches: bool(),
    }),
    snapshotPath: str(),
    note: str(),
  },
}

const openQuestion = {
  oneOf: [
    { type: 'string' },
    openObject({ question: str(), why: str(), priority: str(), owner: str() }, ['question']),
  ],
}

const sourceCoverage = openObject({
  queries: arr(openObject({
    query: str(),
    engine: str(),
    at: str(),
    resultCount: num(),
    outcome: str(),
  })),
  databases: arr(str()),
  retrievedAt: str(),
  limitations: arr(str()),
  dimensions: arr(openObject()),
})

const envelope = (dataSchema) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['asOf', 'openQuestions', 'flags', 'sourceCoverage', 'claims', 'evidence', 'data'],
  properties: {
    asOf: { type: 'string', format: 'date', description: '数据截至日' },
    openQuestions: arr(openQuestion),
    flags: arr(flag),
    sourceCoverage,
    claims: arr(claim),
    evidence: arr(evidence),
    data: dataSchema,
  },
  $defs: { sixState, flag, claim, evidence, openQuestion, sourceCoverage },
})

const address = openObject({
  country: str(),
  province: str(),
  city: str(),
  detail: str(),
})
const money = openObject({
  amount: num(),
  currency: str(),
  unit: str(),
  note: str(),
})
const percentage = openObject({
  value: num(),
  unit: { type: 'string', enum: ['percent'] },
  note: str(),
})
const person = openObject({
  name: str(),
  role: str(),
  id: str(),
  since: str(),
  note: str(),
})
const namedParty = openObject({
  name: str(),
  fullName: str(),
  id: str(),
  role: str(),
  relation: str(),
  note: str(),
})
const datedEvent = openObject({
  date: str(),
  event: str(),
  detail: str(),
  sourceIds: arr(str()),
}, ['event'])

const defs = [
  {
    type: 'company.roster',
    title: '目标公司清单与主体识别',
    scope: 'project',
    cardinality: 'one',
    requiredEvidence: false,
    freshness: { maxAgeDays: 365 },
    summaryFields: ['targetCount', 'resolvedCount'],
    data: openObject({
      targets: arr(openObject({
        name: str(),
        code: str(),
        market: str(),
        type: str(),
        jurisdiction: str(),
        status: str(),
      }, ['name'])),
      resolution: arr(openObject({
        inputName: str(),
        legalName: str(),
        code: str(),
        confidence: { type: 'string', enum: CONFIDENCE },
        candidates: arr(openObject()),
      })),
      targetCount: num(),
      resolvedCount: num(),
    }, ['targets']),
  },
  {
    type: 'company.identity',
    title: '主体识别与工商底册',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 365 },
    summaryFields: ['legalName', 'code', 'status'],
    data: openObject({
      legalName: str(),
      code: str(),
      aliases: arr(str()),
      englishName: str(),
      domicile: address,
      incorporationDate: str(),
      status: str(),
      registeredCapital: money,
      legalRepresentative: str(),
      businessScope: str(),
      identifiers: arr(openObject({ kind: str(), value: str(), jurisdiction: str() })),
      branches: arr(namedParty),
      controllingPerson: sixState,
      notes: str(),
    }, ['legalName']),
  },
  {
    type: 'ownership.chain',
    title: '股权、控制权与特殊权利',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['layers', 'ubo', 'control'],
    data: openObject({
      asOfLabel: str(),
      capTable: arr(openObject({
        holder: str(),
        holderId: str(),
        directPct: num(),
        indirectPct: num(),
        totalPct: num(),
        type: str(),
        note: str(),
      })),
      layers: arr(openObject({
        level: num(),
        holder: str(),
        subject: str(),
        pct: num(),
        basis: str(),
        note: str(),
      })),
      ubo: arr(openObject({
        name: str(),
        pct: num(),
        basis: str(),
        confidence: { type: 'string', enum: CONFIDENCE },
      })),
      control: arr(openObject({
        name: str(),
        role: str(),
        basis: str(),
        note: str(),
      })),
      specialRights: arr(openObject({
        type: str(),
        holder: str(),
        terms: str(),
        sourceIds: arr(str()),
      })),
      history: arr(datedEvent),
    }, ['layers']),
  },
  {
    type: 'investment.map',
    title: '对外投资版图',
    scope: 'company',
    cardinality: 'many',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['platformCount', 'entityCount', 'overseasCount'],
    data: {
      oneOf: [
        openObject({
          mode: { type: 'string', const: 'summary' },
          platformCount: num(),
          entityCount: num(),
          overseasCount: num(),
          categories: arr(openObject({ category: str(), count: num() })),
          platforms: arr(openObject({
            platformId: str(),
            name: str(),
            category: str(),
            role: str(),
            entityCount: num(),
          })),
        }, ['mode']),
        openObject({
          mode: { type: 'string', const: 'platform' },
          platformId: str(),
          name: str(),
          fullName: str(),
          category: str(),
          role: str(),
          vehicles: arr(namedParty),
          entities: arr(openObject({
            name: str(),
            fullName: str(),
            path: str(),
            directPct: num(),
            indirectPct: num(),
            totalPct: num(),
            status: str(),
            note: str(),
          })),
          evidenceSummary: str(),
        }, ['mode', 'platformId']),
      ],
    },
  },
  {
    type: 'org.people',
    title: '创始人与关键人',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['directors', 'keyPeople'],
    data: openObject({
      directors: arr(person),
      keyPeople: arr(person),
      affiliations: arr(openObject({
        person: str(),
        entity: str(),
        role: str(),
        note: str(),
      })),
      litigation: arr(openObject()),
      credit: arr(openObject()),
    }),
  },
  {
    type: 'company.history',
    title: '公司沿革（迁移专用）',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 365 },
    summaryFields: ['events'],
    data: openObject({ events: arr(datedEvent) }),
  },
  {
    type: 'financing.history',
    title: '融资历史与估值轨迹',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['rounds', 'valuationMarks'],
    data: openObject({
      rounds: arr(openObject({
        date: str(),
        round: str(),
        amount: money,
        valuation: money,
        investors: arr(str()),
        note: str(),
      })),
      valuationMarks: arr(openObject({
        date: str(),
        postMoney: money,
        basis: str(),
        note: str(),
      })),
      repurchase: arr(openObject({
        clause: str(),
        trigger: str(),
        obligation: str(),
        note: str(),
      })),
    }),
  },
  {
    type: 'business.segment',
    title: '产品矩阵与技术路线',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['products', 'segments'],
    data: openObject({
      products: arr(openObject({
        name: str(),
        category: str(),
        generation: str(),
        application: str(),
        status: str(),
        note: str(),
      })),
      segments: arr(openObject({
        name: str(),
        revenue: money,
        revenuePct: num(),
        grossMargin: num(),
        note: str(),
      })),
      revenueMix: arr(openObject({ name: str(), pct: num(), period: str() })),
      techRoute: arr(openObject({ route: str(), status: str(), note: str() })),
    }),
  },
  {
    type: 'valuechain.parties',
    title: '客户、供应商与订单',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['customers', 'suppliers'],
    data: openObject({
      customers: arr(namedParty),
      suppliers: arr(namedParty),
      concentration: openObject({ c1: num(), c5: num(), period: str(), note: str() }),
      orders: arr(openObject({
        date: str(),
        counterparty: str(),
        amount: money,
        product: str(),
        note: str(),
      })),
      bids: arr(openObject({
        date: str(),
        project: str(),
        result: str(),
        amount: money,
        note: str(),
      })),
    }),
  },
  {
    type: 'ip.portfolio',
    title: '知识产权组合',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['patents', 'trademarks', 'software'],
    data: openObject({
      patents: arr(openObject({
        title: str(),
        number: str(),
        applicant: str(),
        status: str(),
        filedAt: str(),
        inventors: arr(str()),
        note: str(),
      })),
      trademarks: arr(openObject({ name: str(), number: str(), status: str(), note: str() })),
      software: arr(openObject({ name: str(), number: str(), status: str(), note: str() })),
      pledges: arr(openObject({ patent: str(), pledgee: str(), status: str(), note: str() })),
    }),
  },
  {
    type: 'legal.risk',
    title: '司法风险',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 90 },
    summaryFields: ['litigation', 'enforcement', 'dishonest', 'frozen'],
    data: openObject({
      litigation: arr(openObject({
        caseId: str(),
        court: str(),
        parties: arr(str()),
        cause: str(),
        amount: money,
        stage: str(),
        status: str(),
        date: str(),
        note: str(),
      })),
      enforcement: arr(openObject({
        caseId: str(),
        court: str(),
        amount: money,
        status: str(),
        date: str(),
        note: str(),
      })),
      dishonest: arr(openObject({ person: str(), caseId: str(), status: str(), note: str() })),
      frozen: arr(openObject({ subject: str(), amount: money, status: str(), note: str() })),
    }),
  },
  {
    type: 'ops.risk',
    title: '经营异常与运营风险（迁移专用）',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['abnormal', 'penalties', 'incidents'],
    data: openObject({
      abnormal: arr(openObject()),
      penalties: arr(openObject()),
      incidents: arr(openObject()),
    }),
  },
  {
    type: 'market.landscape',
    title: '行业空间与竞争格局',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['marketSize', 'competition'],
    data: openObject({
      marketSize: arr(openObject({
        year: str(),
        size: money,
        growthPct: num(),
        sourceBasis: str(),
        note: str(),
      })),
      competition: arr(openObject({
        name: str(),
        sharePct: num(),
        positioning: str(),
        note: str(),
      })),
      share: arr(openObject({ year: str(), sharePct: num(), basis: str() })),
      policy: arr(openObject({ name: str(), date: str(), impact: str(), note: str() })),
    }),
  },
  {
    type: 'financials.public',
    title: '公开财务数据与勾稽',
    scope: 'company',
    cardinality: 'many',
    requiredEvidence: true,
    freshness: { maxAgeDays: 365 },
    summaryFields: ['fiscalYear', 'revenue', 'netProfit', 'grossMargin'],
    data: openObject({
      fiscalYear: str(),
      currency: str(),
      accountingStandard: str(),
      auditOpinion: str(),
      consolidation: str(),
      revenue: money,
      netProfit: money,
      grossMargin: num(),
      statements: openObject(),
      recon: arr(openObject({
        check: str(),
        left: any(),
        right: any(),
        status: { type: 'string', enum: ['pass', 'fail', 'insufficient'] },
        note: str(),
      })),
    }, ['fiscalYear']),
  },
  {
    type: 'related.parties',
    title: '关联方与关联交易',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['parties', 'transactions'],
    data: openObject({
      parties: arr(namedParty),
      transactions: arr(openObject({
        counterparty: str(),
        direction: str(),
        amount: money,
        period: str(),
        pricing: str(),
        approval: str(),
        note: str(),
      })),
      overlapFlags: arr(openObject({ with: str(), kind: str(), note: str() })),
    }),
  },
  {
    type: 'workforce.profile',
    title: '组织、人力与用工',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['headcount', 'socialInsurance'],
    data: openObject({
      headcount: num(),
      structure: arr(openObject({ kind: str(), count: num(), pct: num() })),
      socialInsurance: num(),
      employeeCost: money,
      hiring: arr(openObject({ role: str(), location: str(), count: num(), note: str() })),
      laborDisputes: arr(openObject()),
    }),
  },
  {
    type: 'supply.capacity',
    title: '供应链、产能与成本',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['suppliers', 'capacity'],
    data: openObject({
      suppliers: arr(namedParty),
      singleSource: arr(openObject({ item: str(), supplier: str(), note: str() })),
      capacity: arr(openObject({
        product: str(),
        designCapacity: str(),
        effectiveCapacity: str(),
        output: str(),
        utilization: num(),
        period: str(),
        note: str(),
      })),
      costStructure: arr(openObject({ item: str(), pct: num(), note: str() })),
    }),
  },
  {
    type: 'tech.origin',
    title: '技术来源、许可与 FTO 线索',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['origins', 'licenses', 'ftoRisks'],
    data: openObject({
      origins: arr(openObject({
        technology: str(),
        origin: str(),
        basis: str(),
        note: str(),
      })),
      licenses: arr(openObject({ licensor: str(), scope: str(), status: str(), note: str() })),
      ftoRisks: arr(openObject({ patent: str(), holder: str(), jurisdiction: str(), note: str() })),
      tradeSecretCases: arr(openObject()),
    }),
  },
  {
    type: 'qualifications',
    title: '资质、认定与准入',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 365 },
    summaryFields: ['items', 'certifications', 'licenses'],
    data: openObject({
      items: arr(openObject({
        name: str(),
        issuer: str(),
        number: str(),
        validFrom: str(),
        validTo: str(),
        status: str(),
        note: str(),
      })),
      certifications: arr(openObject()),
      licenses: arr(openObject()),
    }),
  },
  {
    type: 'debt.guarantee',
    title: '债务、担保与评级',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['debt', 'guarantees', 'ratings'],
    data: openObject({
      debt: arr(openObject({
        instrument: str(),
        balance: money,
        rate: num(),
        maturity: str(),
        note: str(),
      })),
      guarantees: arr(openObject({
        beneficiary: str(),
        amount: money,
        type: str(),
        status: str(),
        note: str(),
      })),
      ratings: arr(openObject({ agency: str(), rating: str(), date: str(), outlook: str() })),
      offBalance: arr(openObject()),
    }),
  },
  {
    type: 'regulatory.compliance',
    title: '行政监管与信用',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 90 },
    summaryFields: ['penalties', 'taxCredit', 'customsCredit', 'abnormal'],
    data: openObject({
      penalties: arr(openObject({
        authority: str(),
        date: str(),
        matter: str(),
        amount: money,
        status: str(),
        note: str(),
      })),
      taxCredit: openObject({ level: str(), asOf: str(), note: str() }),
      customsCredit: openObject({ level: str(), asOf: str(), note: str() }),
      abnormal: arr(openObject({ reason: str(), date: str(), status: str(), note: str() })),
    }),
  },
  {
    type: 'esg.ehs',
    title: 'ESG、环保与安全生产',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['permits', 'eia', 'energy', 'safety'],
    data: openObject({
      eia: arr(openObject({ project: str(), approval: str(), capacity: str(), date: str(), note: str() })),
      permits: arr(openObject({ kind: str(), number: str(), validTo: str(), note: str() })),
      energy: arr(openObject({ year: str(), consumption: str(), intensity: str(), note: str() })),
      safety: arr(openObject({ incident: str(), date: str(), status: str(), note: str() })),
    }),
  },
  {
    type: 'public.sentiment',
    title: '舆情与利益相关方',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 30 },
    summaryFields: ['incidents', 'sentiment'],
    data: openObject({
      incidents: arr(openObject({
        date: str(),
        title: str(),
        summary: str(),
        sourceTier: str(),
        status: str(),
        note: str(),
      })),
      sentiment: arr(openObject({ period: str(), tone: str(), summary: str(), note: str() })),
      stakeholders: arr(openObject({ party: str(), stance: str(), note: str() })),
    }),
  },
  {
    type: 'assessment.fit',
    title: '合作契合度（委托方视角）',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 90 },
    summaryFields: ['technologyFit', 'commercialFit', 'equityView'],
    data: openObject({
      technologyFit: sixState,
      commercialFit: sixState,
      equityView: sixState,
      approach: arr(openObject({ mode: str(), rationale: str(), nextStep: str() })),
      conclusion: openObject({
        technologyCommercial: str(),
        equityInvestment: str(),
        basis: arr(str()),
        limitations: arr(str()),
      }),
    }, ['technologyFit', 'commercialFit', 'equityView']),
  },
  {
    type: 'risk.redflags',
    title: '证据矩阵与红旗清单',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 30 },
    summaryFields: ['flags', 'ddRequests'],
    data: openObject({
      flags: arr(flag),
      claimMatrix: arr(openObject({
        claimId: str(),
        predicate: str(),
        value: any(),
        status: str(),
        severity: str(),
        note: str(),
      })),
      ddRequests: arr(openObject({
        id: str(),
        topic: str(),
        question: str(),
        why: str(),
        priority: str(),
        owner: str(),
        status: str(),
      })),
      triggerResults: arr(openObject({
        triggerId: str(),
        status: { type: 'string', enum: ['hit', 'miss', 'insufficient'] },
        level: { type: 'string', enum: ['attention', 'material'] },
        action: str(),
        inputs: arr(str()),
      })),
    }),
  },
  {
    type: 'report.deliverable',
    title: '交付包索引',
    scope: 'project',
    cardinality: 'one',
    requiredEvidence: false,
    freshness: { maxAgeDays: 30 },
    summaryFields: ['files', 'summaryFindings', 'qa'],
    data: openObject({
      generatedAt: str(),
      files: arr(openObject({
        path: str(),
        sha256: str(),
        kind: str(),
        size: num(),
      })),
      summaryFindings: arr(openObject({
        findingId: str(),
        fact: str(),
        impact: str(),
        evidenceStrength: str(),
        materiality: str(),
        nextStep: str(),
        claimId: str(),
        artifactId: str(),
      })),
      qa: openObject({
        blocking: num(),
        warnings: num(),
        passed: bool(),
      }),
      signoff: openObject({
        preparedBy: str(),
        reviewedBy: str(),
        approvedBy: str(),
        proposedAt: str(),
        signedAt: str(),
      }),
    }),
  },
  {
    type: 'document.markdown',
    title: 'Markdown 文档',
    scope: 'company',
    cardinality: 'many',
    requiredEvidence: false,
    freshness: { maxAgeDays: 365 },
    summaryFields: ['title'],
    data: openObject({ title: str(), markdown: str() }, ['markdown']),
  },
  {
    type: 'structured.findings',
    title: '通用调查发现',
    scope: 'company',
    cardinality: 'many',
    requiredEvidence: true,
    freshness: { maxAgeDays: 180 },
    summaryFields: ['question', 'findings'],
    data: openObject({
      question: str(),
      findings: arr(openObject({
        claim: str(),
        value: any(),
        evidenceIds: arr(str()),
        confidence: { type: 'string', enum: CONFIDENCE },
        openQuestions: arr(str()),
      })),
    }, ['question', 'findings']),
  },
  {
    type: 'search.ledger',
    title: '检索记录',
    scope: 'company',
    cardinality: 'many',
    requiredEvidence: false,
    freshness: { maxAgeDays: 365 },
    summaryFields: ['moduleId', 'attempts'],
    data: openObject({
      moduleId: str(),
      unitId: str(),
      attempts: arr(openObject({
        query: str(),
        engine: str(),
        at: str(),
        resultCount: num(),
        outcome: str(),
        note: str(),
      })),
      notFound: arr(openObject({
        predicate: str(),
        attemptedPaths: arr(str()),
        note: str(),
      })),
      limitations: arr(str()),
    }, ['attempts']),
  },
  {
    type: 'source.coverage',
    title: '来源覆盖与限制',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: false,
    freshness: { maxAgeDays: 365 },
    summaryFields: ['dimensions', 'limitations'],
    data: openObject({
      dimensions: arr(openObject({
        key: str(),
        label: str(),
        status: { type: 'string', enum: ['covered', 'partial', 'missing', 'not_applicable'] },
        note: str(),
      })),
      databases: arr(str()),
      limitations: arr(str()),
      retrievedAt: str(),
    }),
  },
  {
    type: 'dd.request_list',
    title: '进场资料请求清单',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: false,
    freshness: { maxAgeDays: 30 },
    summaryFields: ['items'],
    data: openObject({
      items: arr(openObject({
        id: str(),
        topic: str(),
        question: str(),
        why: str(),
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        owner: str(),
        status: str(),
      })),
    }, ['items']),
  },
  {
    type: 'policy.exposure',
    title: '出口管制与地缘合规',
    scope: 'company',
    cardinality: 'one',
    requiredEvidence: true,
    freshness: { maxAgeDays: 90 },
    summaryFields: ['listings', 'exposure', 'licenses'],
    data: openObject({
      listings: arr(openObject({
        list: str(),
        entity: str(),
        date: str(),
        scope: str(),
        status: str(),
        note: str(),
      })),
      exposure: arr(openObject({
        dimension: str(),
        description: str(),
        level: { type: 'string', enum: ['material', 'attention', 'none', 'unknown'] },
        note: str(),
      })),
      licenses: arr(openObject({ kind: str(), status: str(), note: str() })),
    }),
  },
]

const types = []
for (const def of defs) {
  const schema = envelope(def.data)
  assertObjectSchema(schema, def.type)
  const record = {
    type: def.type,
    version: 1,
    scope: def.scope,
    cardinality: def.cardinality,
    title: def.title,
    status: def.type === 'policy.exposure' ? 'draft' : 'active',
    requiredEvidence: def.requiredEvidence,
    freshness: def.freshness,
    summaryFields: def.summaryFields,
    schema,
  }
  types.push(record)
  await writeFile(join(outDir, `${def.type}.json`), JSON.stringify(schema, null, 2) + '\n', 'utf8')
}

const registry = {
  version: 1,
  generatedAt: '2026-11-07',
  count: types.length,
  types,
}

await mkdir(registryDir, { recursive: true })
await writeFile(join(registryDir, 'types.json'), JSON.stringify(registry, null, 2) + '\n', 'utf8')
console.log(`generated ${types.length} artifact types`)

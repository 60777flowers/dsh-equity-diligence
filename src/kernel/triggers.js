import { isPlainObject } from '../util/json.js'

function recordFor(artifacts, type) {
  const list = (artifacts ?? []).filter((artifact) => artifact.type === type)
  return list.find((artifact) => artifact.partitionKey === '_summary') ?? list.find((artifact) => artifact.partitionKey === '_default') ?? list[0] ?? null
}

function dataFor(artifacts, type) {
  return recordFor(artifacts, type)?.data ?? null
}

function names(list, key = 'name') {
  return new Set((Array.isArray(list) ? list : []).map((item) => String(item?.[key] ?? item ?? '').trim()).filter(Boolean))
}

function intersection(a, b) {
  return [...a].filter((value) => b.has(value))
}

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (isPlainObject(value)) {
    if (typeof value.amount === 'number') return value.amount
    if (typeof value.value === 'number') return value.value
  }
  if (typeof value === 'string') {
    const match = value.replaceAll(',', '').match(/-?\d+(?:\.\d+)?/)
    if (match) return Number(match[0])
  }
  return null
}

function result(triggerId, { status = 'miss', level = 'attention', action = '', inputs = [], evidenceLinks = [], detail = '' }) {
  return { triggerId, status, level, action, inputs, evidenceLinks, detail }
}

function insufficient(triggerId, inputs, detail) {
  return result(triggerId, { status: 'insufficient', level: 'attention', inputs, detail })
}

export function runTriggers(artifacts) {
  const results = []
  const concentration = dataFor(artifacts, 'valuechain.parties')?.concentration
  const financials = dataFor(artifacts, 'financials.public')
  const related = dataFor(artifacts, 'related.parties')
  const ip = dataFor(artifacts, 'ip.portfolio')
  const people = dataFor(artifacts, 'org.people')
  const business = dataFor(artifacts, 'business.segment')
  const supply = dataFor(artifacts, 'supply.capacity')
  const workforce = dataFor(artifacts, 'workforce.profile')
  const financing = dataFor(artifacts, 'financing.history')
  const legal = dataFor(artifacts, 'legal.risk')
  const regulatory = dataFor(artifacts, 'regulatory.compliance')
  const policy = dataFor(artifacts, 'policy.exposure')

  // T1 customer concentration
  if (concentration?.c5 !== undefined && concentration?.c5 !== null) {
    const c5 = number(concentration.c5)
    results.push(
      c5 !== null && c5 >= 70
        ? result('T1', { status: 'hit', level: 'material', action: '核对前五大客户占比的分子分母期间与口径，确认是否含关联方与贸易商', inputs: ['valuechain.parties.concentration.c5'], detail: `前五大占比 ${c5}%` })
        : result('T1', { status: 'miss', level: 'attention', inputs: ['valuechain.parties.concentration.c5'] }),
    )
  } else {
    results.push(insufficient('T1', ['valuechain.parties.concentration.c5'], '未披露前五大集中度'))
  }

  // T2 related-party overlap
  if (related?.parties && dataFor(artifacts, 'valuechain.parties')) {
    const relatedNames = names(related.parties)
    const customerNames = names(dataFor(artifacts, 'valuechain.parties')?.customers)
    const supplierNames = names(dataFor(artifacts, 'valuechain.parties')?.suppliers)
    const overlap = intersection(relatedNames, new Set([...customerNames, ...supplierNames]))
    results.push(
      overlap.length > 0
        ? result('T2', { status: 'hit', level: 'material', action: '核对是否已披露、交易方向/金额/期间/定价/审批', inputs: ['related.parties.parties', 'valuechain.parties.customers', 'valuechain.parties.suppliers'], detail: overlap.join('、') })
        : result('T2', { status: 'miss', level: 'material', inputs: ['related.parties.parties', 'valuechain.parties.customers', 'valuechain.parties.suppliers'] }),
    )
  } else {
    results.push(insufficient('T2', ['related.parties.parties', 'valuechain.parties'], '关联方或客户/供应商底稿缺失'))
  }

  // T3 dual-role counterparties
  if (dataFor(artifacts, 'valuechain.parties')) {
    const customerNames = names(dataFor(artifacts, 'valuechain.parties')?.customers)
    const supplierNames = names(dataFor(artifacts, 'valuechain.parties')?.suppliers)
    const dual = intersection(customerNames, supplierNames)
    results.push(
      dual.length > 0
        ? result('T3', { status: 'hit', level: 'attention', action: '核对是否同商品、背靠背合同、净额/总额确认', inputs: ['valuechain.parties.customers', 'valuechain.parties.suppliers'], detail: dual.join('、') })
        : result('T3', { status: 'miss', level: 'attention', inputs: ['valuechain.parties.customers', 'valuechain.parties.suppliers'] }),
    )
  } else {
    results.push(insufficient('T3', ['valuechain.parties'], '客户/供应商底稿缺失'))
  }

  // T4 inventors vs core/former people
  if (ip?.patents && people) {
    const peopleNames = new Set([...names(people.directors), ...names(people.keyPeople)])
    const inventors = new Set(ip.patents.flatMap((patent) => patent.inventors ?? []))
    const overlap = intersection(inventors, peopleNames)
    results.push(
      overlap.length > 0
        ? result('T4', { status: 'hit', level: 'attention', action: '核对任职期间、职务发明制度、保密/竞业、原单位争议', inputs: ['ip.portfolio.patents.inventors', 'org.people'], detail: overlap.join('、') })
        : result('T4', { status: 'miss', level: 'attention', inputs: ['ip.portfolio.patents.inventors', 'org.people'] }),
    )
  } else {
    results.push(insufficient('T4', ['ip.portfolio.patents', 'org.people'], '专利或人员底稿缺失'))
  }

  // T5 technology claim vs patent coverage
  if (business?.products && ip?.patents) {
    const productsWithRoute = (business.products ?? []).filter((product) => product.generation || product.category)
    const hit = productsWithRoute.length > 0 && (ip.patents ?? []).length === 0
    results.push(
      hit
        ? result('T5', { status: 'hit', level: 'attention', action: '核对技术是否来自商业秘密/许可/公开技术，缺口在哪', inputs: ['business.segment.products', 'ip.portfolio.patents'], detail: '有产品/代际但无专利覆盖' })
        : result('T5', { status: 'miss', level: 'attention', inputs: ['business.segment.products', 'ip.portfolio.patents'] }),
    )
  } else {
    results.push(insufficient('T5', ['business.segment.products', 'ip.portfolio.patents'], '产品/专利底稿缺失'))
  }

  // T6 capacity three measures
  if (Array.isArray(supply?.capacity) && supply.capacity.length > 0) {
    const inconsistent = supply.capacity.filter((item) => {
      const values = [item.designCapacity, item.effectiveCapacity, item.output].map(number).filter((value) => value !== null)
      if (values.length < 2) return false
      const max = Math.max(...values)
      const min = Math.min(...values)
      return max > 0 && (max - min) / max > 0.2
    })
    results.push(
      inconsistent.length > 0
        ? result('T6', { status: 'hit', level: 'attention', action: '统一设计/有效/在建产能与产量期间后再判断', inputs: ['supply.capacity.capacity'], detail: `${inconsistent.length} 项产能口径差异 >20%` })
        : result('T6', { status: 'miss', level: 'attention', inputs: ['supply.capacity.capacity'] }),
    )
  } else {
    results.push(insufficient('T6', ['supply.capacity.capacity'], '产能底稿缺失'))
  }

  // T7 overseas revenue reconciliation
  const overseas = financials?.statements?.overseasRevenue ?? financials?.statements?.overseas_revenue
  results.push(
    overseas === undefined || overseas === null
      ? insufficient('T7', ['financials.public.statements.overseasRevenue'], '未披露境外收入')
      : result('T7', { status: 'hit', level: 'attention', action: '核对交易路径、收入类型、合并边界、汇率与海关/境外子公司数据', inputs: ['financials.public.statements.overseasRevenue'], detail: String(overseas) }),
  )

  // T8 social insurance vs employee cost
  if (workforce?.socialInsurance !== undefined && financials?.employeeCost !== undefined) {
    const ratio = number(financials.employeeCost) && number(workforce.headcount) ? number(financials.employeeCost) / number(workforce.headcount) : null
    results.push(
      ratio === null
        ? insufficient('T8', ['workforce.profile.socialInsurance', 'financials.public.employeeCost'], '人数或员工成本缺失')
        : result('T8', { status: ratio < 50_000 ? 'hit' : 'miss', level: 'attention', action: '核对劳务派遣、退休返聘、境外员工、并表范围与时点', inputs: ['workforce.profile.socialInsurance', 'financials.public.employeeCost'], detail: `人均员工成本约 ${Math.round(ratio).toLocaleString()}` }),
    )
  } else {
    results.push(insufficient('T8', ['workforce.profile.socialInsurance', 'financials.public.employeeCost'], '社保或员工成本底稿缺失'))
  }

  // T9 valuation vs net assets
  const lastValuation = (financing?.valuationMarks ?? []).at(-1)?.postMoney
  const netAssets = financials?.statements?.netAssets
  if (lastValuation !== undefined && netAssets !== undefined) {
    const valuation = number(lastValuation)
    const assets = number(netAssets)
    const multiple = valuation && assets ? valuation / assets : null
    results.push(
      multiple !== null && multiple > 10
        ? result('T9', { status: 'hit', level: 'material', action: '比较同种证券、拆股/稀释调整后的历轮价格与 post-money；回购条款另找协议依据', inputs: ['financing.history.valuationMarks', 'financials.public.statements.netAssets'], detail: `P/B 约 ${multiple.toFixed(1)}x` })
        : result('T9', { status: 'miss', level: 'material', inputs: ['financing.history.valuationMarks', 'financials.public.statements.netAssets'] }),
    )
  } else {
    results.push(insufficient('T9', ['financing.history.valuationMarks', 'financials.public.statements.netAssets'], '估值或净资产缺失'))
  }

  // T10 litigation amount vs provisions
  if (Array.isArray(legal?.litigation) && financials?.statements?.provisions !== undefined) {
    const amount = legal.litigation.reduce((sum, item) => sum + (number(item.amount) ?? 0), 0)
    const provisions = number(financials.statements.provisions) ?? 0
    results.push(
      amount > 0 && provisions === 0
        ? result('T10', { status: 'hit', level: 'attention', action: '核对案件阶段、法律评估、会计政策与披露，不按涉诉额机械计提', inputs: ['legal.risk.litigation', 'financials.public.statements.provisions'], detail: `涉诉约 ${amount.toLocaleString()}，预计负债 0` })
        : result('T10', { status: 'miss', level: 'attention', inputs: ['legal.risk.litigation', 'financials.public.statements.provisions'] }),
    )
  } else {
    results.push(insufficient('T10', ['legal.risk.litigation', 'financials.public.statements.provisions'], '诉讼或预计负债缺失'))
  }

  // T11 suspension-type penalty vs capacity
  if (Array.isArray(regulatory?.penalties)) {
    const suspensions = regulatory.penalties.filter((penalty) => /停产|限产|整改/.test(`${penalty.matter ?? ''} ${penalty.note ?? ''}`))
    results.push(
      suspensions.length > 0
        ? result('T11', { status: 'hit', level: 'material', action: '核对整改/复产批复、替代产能、影响期间', inputs: ['regulatory.compliance.penalties', 'supply.capacity.capacity'], detail: suspensions.map((item) => item.matter).join('、') })
        : result('T11', { status: 'miss', level: 'material', inputs: ['regulatory.compliance.penalties', 'supply.capacity.capacity'] }),
    )
  } else {
    results.push(insufficient('T11', ['regulatory.compliance.penalties'], '处罚底稿缺失'))
  }

  // T12 listing hit vs counterparties
  if (Array.isArray(policy?.listings) && dataFor(artifacts, 'valuechain.parties')) {
    const listed = names(policy.listings, 'entity')
    const parties = new Set([...names(dataFor(artifacts, 'valuechain.parties')?.customers), ...names(dataFor(artifacts, 'valuechain.parties')?.suppliers)])
    const overlap = intersection(listed, parties)
    results.push(
      overlap.length > 0
        ? result('T12', { status: 'hit', level: 'material', action: '核对名单规则、实体匹配、适用范围与替代方案', inputs: ['policy.exposure.listings', 'valuechain.parties'], detail: overlap.join('、') })
        : result('T12', { status: 'miss', level: 'material', inputs: ['policy.exposure.listings', 'valuechain.parties'] }),
    )
  } else {
    results.push(insufficient('T12', ['policy.exposure.listings', 'valuechain.parties'], '管制清单或交易对手缺失'))
  }

  return results
}

/** Convert trigger hits into flags for the artifact envelope. */
export function triggerFlags(results) {
  return results
    .filter((item) => item.status === 'hit')
    .map((item) => ({
      level: item.level,
      rule: item.triggerId,
      desc: item.detail || item.action,
      triggerId: item.triggerId,
      action: item.action,
      materiality: item.level,
    }))
}

/** Build DD requests from open questions + trigger hits. */
export function ddRequestsFrom({ triggers = [], openQuestions = [] }) {
  const items = []
  let index = 1
  for (const trigger of triggers.filter((item) => item.status === 'hit')) {
    items.push({
      id: `DD-${String(index).padStart(2, '0')}`,
      topic: trigger.triggerId,
      question: trigger.action || trigger.detail,
      why: `触发器 ${trigger.triggerId} 命中：${trigger.detail ?? ''}`,
      priority: trigger.level === 'material' ? 'high' : 'medium',
      owner: 'analyst',
      status: 'open',
    })
    index += 1
  }
  for (const question of openQuestions) {
    const text = typeof question === 'string' ? question : question?.question
    if (!text) continue
    items.push({
      id: `DD-${String(index).padStart(2, '0')}`,
      topic: 'open_question',
      question: text,
      why: typeof question === 'object' ? question.why ?? '公开信息未能确认' : '公开信息未能确认',
      priority: typeof question === 'object' ? question.priority ?? 'medium' : 'medium',
      owner: typeof question === 'object' ? question.owner ?? 'analyst' : 'analyst',
      status: 'open',
    })
    index += 1
  }
  return items
}

# {{module.name}} · 任务模板

## 0. 本次任务

对 **{{company.name}}**（代码/标识：{{company.code}}）执行"技术来源、许可与 FTO 线索"核验，产出 `tech.origin` 底稿。委托方：{{project.client}}。分区：`{{unit.partition}}`。FTO 扫描辖区 `jurisdictions` = {{params.jurisdictions}}（逗号分隔，逐个辖区检索）。

本模块是 **verify（核验）** 类：不是把公司说法抄一遍，而是为每条"技术来源"找到可打开的证据，并明确哪些只能作为线索。

## 1. 输入（渲染摘要）

- 知识产权清单：{{artifact:ip.portfolio}}（专利号、状态、质押、许可备案线索）
- 关键人员：{{artifact:org.people}}（创始人、核心技术人员、发明人）
- 产品与技术路线（软引用）：{{artifact:business.segment}}

先建立"技术清单 → 对应产品 → 对应专利/论文/合同"的映射，再逐条找来源证据。

## 2. 必答问题

1. **Q1 技术来源**：公司核心技术分别属于自研/引进/转化/逆向/合作研发/并购取得/员工自带哪一类？依据是什么？
2. **Q2 自研旁证**：若为自研，除公司自述外有哪些旁证（专利原始申请人、研发费用、研发人员、第三方鉴定）？
3. **Q3 转化证据**：若为高校/院所成果转化，公示、协议、作价入股或收益分配安排是什么？
4. **Q4 许可范围**：许可方是谁、地域/期限/独占性/再许可/改进归属如何？是否已备案？
5. **Q5 转让与受让**：有无专利转让登记？原权利人是谁？转让对价是否披露？
6. **Q6 商业秘密**：有无侵害商业秘密/不正当竞争诉讼？案号、当事人、结果、是否涉及核心技术与前员工？
7. **Q7 开源**：产品是否使用开源组件？许可证类型、是否 copyleft、是否有合规声明？
8. **Q8 FTO 线索**：在 `jurisdictions` 各辖区，是否存在可能覆盖公司产品特征的**有效**专利？专利号、权利人、独立权利要求要点？

## 3. 检索要求

- 来源优先级：官方登记/裁判文书 > 高校与政府公示 > 论文与标准 > 公司披露 > 媒体。
- 中文检索词至少覆盖：`专利权转让`、`受让 专利`、`专利实施许可`、`技术许可`、`技术引进`、`产学研`、`成果转化`、`侵害商业秘密`、`不正当竞争`、`开源`、`自主研发`。
- 英文/境外：`patent assignment`、`license agreement`、`technology transfer`、`trade secret litigation`、`freedom to operate`。
- 论文必须核作者单位/致谢/基金号；高校公示必须核公示期与落款单位。
- 诉讼必须核案号与判决结果，不得只凭标题。
- FTO 只检索**有效**专利（排除失效、期限届满、驳回）；只读独立权利要求。

## 4. 字段与六态

- 输出 `data.origins[]`、`data.licenses[]`、`data.ftoRisks[]`、`data.tradeSecretCases[]`，字段名不得改。
- `origins[].origin`、`origins[].basis`、`licenses[].scope`、`licenses[].status`、`ftoRisks[].holder` 必须落六态并带 note：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`。
- **技术来源、许可范围、诉讼结果属于公司特定事实，禁止用同行均值或行业惯例替代**；无证据写 `not_reviewed` 或 `not_disclosed_after_search`。
- `estimated` 仅用于来源占比类归纳，占比 ≤20%，必须带 `derivation`。
- **FTO 只写线索**：`ftoRisks[].note` 必须包含"线索"与"需专利律师做权利要求比对"限定；**不得出现"侵权/不侵权/规避可行"等结论**。
- 诉讼无案号不得入 `tradeSecretCases[]`；开源结论必须指到 LICENSE 或官方声明。

- `not_disclosed_after_search` 必须关联 `search.ledger` 的尝试记录（库、词、辖区、检索日期、筛选条件），`sourceCoverage.queries` 必须能逐条对应。

## 5. 门与自检（提交前逐条勾）

- 证据：`minEvidence=3`、`minCoverage=0.7`；`data.origins` ≥1 行。
- 每条 `origins` 的 `basis` 能对上至少一条 `evidence`；`origin` 取值合法。
- `licenses[]` 每条有 `scope`（地域/期限/独占性）或明确六态。
- `ftoRisks[]` 每条含 patent/holder/jurisdiction，note 含"线索 + 需律师比对"限定语。
- `tradeSecretCases[]` 每条有案号或公告来源；确无则空数组并说明已检索渠道。
- 不得把"框架协议""意向书"写成已受让/已许可。

## 6. 输出

严格返回契约 JSON：`{asOf, openQuestions, flags, sourceCoverage, claims, evidence, data}`。

- `claims`：建议谓词 `tech_origin`、`tech_origin_basis`、`license_scope`、`license_exclusive`、`patent_assignment`、`trade_secret_case`、`fto_clue`；来源类 claim 的 `status` 不要轻易给 `found`。
- `evidence`：`quote` 原文片段，`locator` 到公示段落/判决书页/合同条款；`sourceTier` 用 `court`/`registry`/`regulator`/`company`。
- `flags`：FTO 线索、诉讼、许可到期只写 `attention`/`material` 与核查动作，不写法律结论。
- `sourceCoverage.queries` 记录检索词、辖区、库与日期；`limitations` 写清未检索到的辖区、未取得的合同、未公开的 FTO 报告。

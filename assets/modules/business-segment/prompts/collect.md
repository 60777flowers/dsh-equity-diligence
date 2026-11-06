# {{module.name}} · 任务模板

## 0. 本次任务

对 **{{company.name}}**（代码/标识：{{company.code}}）执行"产品矩阵与技术路线"调查，产出 `business.segment` 底稿。委托方：{{project.client}}。分区：`{{unit.partition}}`（公司级固定 `_default`）。所有期间写 `FYyyyy` 或 `yyyyHn`，并注明截至日。

## 1. 输入（渲染摘要）

- 主体底册：{{artifact:company.identity}}（全称、曾用名、经营范围）
- 行业与竞争（软引用，仅用于应用领域口径校准）：{{artifact:market.landscape}}
- 参数 `includeRevenueMix` = {{params.includeRevenueMix}}（为 false 时仍输出 `revenueMix` 字段，空数组 + 说明）

先用底册的曾用名与经营范围扩展检索词，不要重复做主体识别。

## 2. 必答问题

1. **Q1 产品线**：公司卖哪些产品/系列/服务？每个产品的用途、品类、是否在售？
2. **Q2 代际**：每个产品属于第几代、代际命名依据是什么？是否存在"制程/工艺"与"产品代次"两套说法？
3. **Q3 收入构成**：按分产品/分行业/分地区分别能拆到什么程度？金额或占比、期间、口径（主营/营业收入）？
4. **Q4 合计校验**：同一口径下各分项占比合计是否≈100%？不一致的原因（其他业务、内部抵销、四舍五入）？
5. **Q5 技术路线**：核心技术路线有哪些？各自处于研发/送样/验证/小批量/量产/规划哪个阶段，依据是什么？
6. **Q6 扩产周期**：主要产品从建设/认证到达产需要多久？有无资本开支或产能规划佐证？
7. **Q7 产品与行业分离**：哪些是产品，哪些是下游应用/行业？是否存在只按行业披露收入的情况？

## 3. 检索要求

- 来源优先级：招股书"业务与技术"章 > 年报"经营情况讨论与分析" > 问询回复 > 官网产品中心/技术白皮书 > 标准组织文档 > 专利 > 研报（仅线索）。
- 中文检索词至少覆盖：`产品 系列`、`产品型号`、`第X代`、`新一代`、`收入构成 分产品`、`主营业务 分行业`、`技术路线`、`募投项目 达产`、`扩产 投产`、`收入确认 政策`。
- 境外或英文资料：`product portfolio`、`revenue by product`、`technology roadmap`、`10-K Item 1 Business`。
- 至少一次官网/产品手册与一次定期报告交叉；研报只作 `contextual` 证据，不得作为代际或收入构成的唯一来源。
- 同一新闻稿转载只算一个 `originGroupId`。

## 4. 字段与六态

- 输出 `data.products[]`、`data.segments[]`、`data.revenueMix[]`、`data.techRoute[]`，字段名不得改。
- `products[].generation`、`products[].status`、`techRoute[].status`、`segments[].revenuePct` 必须落六态并带 note：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`。
- **公司特定事实（产品线、代际、收入构成）禁止用同行均值或行业惯例替代**；未披露写 `not_disclosed_after_search` 或 `pending_dd`。
- `estimated` 仅用于由金额推导的占比、毛利率区间等分析型字段，必须带 `derivation {method, inputs[], comparables[], assumptions[]}`；整体估算占比 ≤20%。
- `revenueMix[].pct` 用 0–100 的数值，不用小数；`revenueMix[].period` 必填。
- 扩产周期写入 `products[].note` 或 `techRoute[].note`，格式：`周期=…；达产=…；资本开支=…；来源=…`。

- `not_disclosed_after_search` 必须关联 `search.ledger` 的尝试记录（查过哪些库、哪些词、检索日期、筛选条件），`sourceCoverage.queries` 必须能逐条对应。

## 5. 门与自检（提交前逐条勾）

- 证据：`minEvidence=3`、`minCoverage=0.8`；`data.products` 与 `data.revenueMix` 各 ≥1 行。
- 同一期间同一口径下 `revenueMix[].pct` 合计 100% ±1pp；不得把分产品与分行业混在一组求和。
- `products[].name` 不得重复；`products` 里不出现行业/应用名。
- 每条 `generation` 有来源或六态；不得出现"据说/业内"。
- `techRoute[].status` 与来源一致，"规划/预计"不得写成"量产"。
- `segments[].revenuePct` 与 `revenueMix` 对账，差异 >1pp 时必须写 note 说明口径。

## 6. 输出

严格返回契约 JSON：`{asOf, openQuestions, flags, sourceCoverage, claims, evidence, data}`。

- `claims`：建议谓词 `product_count`、`product_generation`、`revenue_mix_pct`、`tech_route_status`、`expansion_cycle_months`；金额带 `unit`，比例带分母说明。
- `evidence`：`quote` 原文片段，`locator` 到章节/表格；标 `sourceTier`、`sourceAuthority`、`sourceIndependence`。
- `openQuestions`：写清"缺哪个产品的哪项口径、为什么影响下游、下一步查什么文档"。
- `sourceCoverage.queries` 逐条记录检索词与结论；`limitations` 写清未取得的披露（如分产品收入未披露）。

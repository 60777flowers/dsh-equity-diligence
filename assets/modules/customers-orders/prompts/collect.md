# {{module.name}} · 任务模板

## 0. 本次任务

对 **{{company.name}}**（代码/标识：{{company.code}}）执行"客户、订单与招投标"调查，产出自定义 `valuechain.parties` 底稿。委托方：{{project.client}}。分区：`{{unit.partition}}`。前 N 大客户的 N 取 `{{params.topN}}`，若与公司披露口径不同，必须在 `concentration.note` 说明。

## 1. 输入（渲染摘要）

- 产品矩阵：{{artifact:business.segment}}（用于把客户与订单挂到产品）
- 关联方清单（软引用）：{{artifact:related.parties}}
- 股权与控制链（软引用）：{{artifact:ownership.chain}}
- 参数 `topN` = {{params.topN}}（3–10）

本模块输出 `valuechain.parties`，包含 `customers`、`suppliers`、`concentration`、`orders`、`bids` 五个字段；供应商只登记用于"双重身份"比对的公开前 N 大供应商，供应链分析不在本模块。

## 2. 必答问题

1. **Q1 客户名单**：前 N 大客户分别是谁？名称能否核到工商全称或上市公司代码？脱敏客户有哪些？
2. **Q2 集中度**：c1/c5 是多少、分母是营业收入还是主营业务收入、期间是哪一期、同一控制下是否合并？
3. **Q3 认证阶段**：主要客户处于送样/小批量/合格供应商名录/量产供货哪个阶段，依据是什么？
4. **Q4 订单**：有哪些已签合同/订单？金额、含税口径、交付期、是否已履行？
5. **Q5 中标**：有哪些中标记录？项目名、招标方、中标金额、公告来源、结果状态？
6. **Q6 双重身份**：客户与供应商名单有无交集？交集主体两侧交易内容是否同一商品？
7. **Q7 关联性**：客户/供应商中是否有 `related.parties` 中的关联方？是否已按关联交易披露？

## 3. 检索要求

- 来源优先级：招股书"主要客户"章 > 年报"前五名客户" > 问询回复 > 客户方公告/供应商名录 > 招投标与政采平台 > 权威媒体。
- 中文检索词至少覆盖：`前五大客户`、`第一大客户`、`客户集中度`、`前五名客户 销售额 占比`、`合格供应商`、`量产供货`、`重大合同`、`订单`、`中标`、`集采`、`客户 供应商 重叠`。
- 英文/境外：`major customers`、`customer concentration`、`awarded contract`、10-K "major customers"。
- 招投标必须有平台侧或客户方公告来源，不能只引用公司自述"已中标"。
- 同一新闻稿转载只算一个 `originGroupId`。

## 4. 字段与六态

- 输出 `data.customers[]`、`data.suppliers[]`、`data.concentration{}`、`data.orders[]`、`data.bids[]`，字段名不得改。
- `customers[].relation`、`customers[].id`、`orders[].amount`、`bids[].amount`、`concentration.c5` 必须落六态并带 note：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`。
- **客户名称、前五大占比、客户数量属于公司特定事实，禁止用同行均值或行业惯例替代**。脱敏客户写 `pending_dd` 或 `not_disclosed_after_search`，不得猜名。
- 金额必须带 `unit`（币种）与期间；比例用 0–100 数值。
- `estimated` 仅用于"由总额与占比反推的单客户金额"等分析型字段，必须带 `derivation`；整体估算占比 ≤20%。
- 双重身份：同一主体在 `customers[].note` 与 `suppliers[].note` 都要出现"双重身份"，并互指。

- `not_disclosed_after_search` 必须关联 `search.ledger` 的尝试记录（查过哪些平台、哪些词、检索日期、筛选条件），`sourceCoverage.queries` 必须能逐条对应。

## 5. 门与自检（提交前逐条勾）

- 证据：`minEvidence=3`、`minCoverage=0.7`；`data.customers` ≥1 行。
- `concentration.c5 ≥ c1`，两者同期间同分母；`concentration.period` 必填；`concentration.note` 写清分母、合并规则、topN。
- `customers[].fullName` 可核率 ≥50%；不可核客户全部进 `openQuestions`。
- `orders`/`bids` 每条有对手方/项目名与日期；金额未披露写六态，**不得把框架协议预计金额写成订单金额**。
- `customers` 与 `suppliers` 的交集已在两侧标注"双重身份"。
- 与 `financials.public` 对账：c5 占比 × 营业收入 ≈ 前五大客户金额合计，差异写 note。

## 6. 输出

严格返回契约 JSON：`{asOf, openQuestions, flags, sourceCoverage, claims, evidence, data}`。

- `claims`：建议谓词 `customer_count`、`customer_c1_pct`、`customer_c5_pct`、`customer_stage`、`order_amount`、`bid_result`、`dual_role`；比例带分母，金额带币种与期间。
- `evidence`：`quote` 原文片段，`locator` 到章节/表格/公告段落；标 `sourceTier`、`sourceAuthority`、`sourceIndependence`。
- `flags`：集中度过高、单一客户依赖、双重身份只写 `attention`/`material` 与"需核什么"，不写定性结论。
- `sourceCoverage.queries` 记录检索词与平台；`limitations` 写清脱敏客户、未公开订单、未覆盖的招投标平台。

# 客户、订单与招投标（customers-orders）

> 模块 id：`builtin/customers-orders` ｜ 状态：**draft**（未经金融专家评审，不得称为 stable）
> 输出底稿：`valuechain.parties`（typeVersion 1，cardinality one，scope company）
> 硬输入：`business.segment`；软引用：`related.parties`、`ownership.chain`

## 1. 一句话目标

回答四件事：**客户是谁、集中度多高（c1/c5，分母是什么）、处在什么认证阶段、有哪些订单与中标**。三条硬约束：**客户名称可核到工商/公开主体**、**集中度与收入期间一致**、**客户与供应商双重身份必须单独标注**。

## 2. 输入、前置与输出

| 项 | 内容 | 缺失时 |
|---|---|---|
| `business.segment` | 产品线，用于把客户/订单挂到产品 | `onMissing: block`，否则订单无法归因 |
| `related.parties`（软） | 关联方清单，用于标注"关联客户/关联供应商" | 缺失只警告；关联标注降级为 `not_reviewed` |
| `ownership.chain`（软） | 股东与子公司，用于识别"同一控制下客户合并计算" | 缺失只警告 |

输出 `data`：`customers[]`、`suppliers[]`、`concentration{}`、`orders[]`、`bids[]`。`{{params.topN}}` 控制 "前 N 大客户" 的 N（默认 5，范围 3–10）；N 改变时必须在 `concentration.note` 写清。

> **与 `supply-capacity` 的字段分工**：`valuechain.parties.suppliers[]` 只登记"与客户侧披露同源、需要做双重身份比对"的供应商（通常是招股书/年报披露的前 N 大供应商）；单一来源、产能、成本结构、外协归 `supply.capacity`。两处同名供应商以 `valuechain.parties` 为交叉主数据。

## 3. 口径定义

### 3.1 集中度的四个必标项

一笔集中度数字只有同时满足以下四项才可判 `found`：

1. **分母**：营业收入 / 主营业务收入 / 含税销售额——三者不可混用；
2. **期间**：`FY2025`、`2025H1`，与收入期间严格一致；
3. **合并口径**：同一控制下客户是否合并计算（受同一实控人控制的多个客户应合并），招股书常见"合并披露"说明；
4. **口径来源**：公司披露 / 自行计算（自行计算必须 `estimated` + derivation）。

### 3.2 客户名称可核的三档

| 档 | 特征 | 处理 |
|---|---|---|
| A 可核 | 披露工商全称或上市公司简称+代码 | `customers[].fullName` 写全称，`id` 写代码 |
| B 半可核 | 披露品牌名/简称，能对上公开主体 | `fullName` 写推定全称，`note` 标 `推定` 与依据 |
| C 不可核 | "客户A""第一名"等脱敏 | `id`/`fullName` 留空或写 `not_disclosed_after_search`，`relation` 标 `脱敏客户`，进 `openQuestions` |

### 3.3 认证阶段（关系深度）

`customers[].relation` 除交易关系外，还要能表达认证阶段：`送样` / `小批量` / `合格供应商名录` / `量产供货` / `框架协议` / `脱敏客户` / `经销商` / `终端客户` / `同一控制下合并`。认证阶段影响收入可持续性，必须有来源（公告、问询回复、客户方供应商名录、认证证书）。

### 3.4 订单与中标

- **订单**：有明确标的、数量/金额、交付期的合同或订单；框架协议、意向书、MOU **不算订单金额**，只能记 `note`。
- **中标**：以中标通知书/中标公示/客户公告为准；`bids[].result` 取 `中标` / `未中标` / `候选人` / `废标` / `未披露`。
- 订单金额与收入确认期间不同：订单年度 ≠ 收入年度，`orders[].date` 记签约/中标日，收入期间另记。
- 在手订单（backlog）只在公司明确披露口径时记，注明"截至日"与"是否含税"。

### 3.5 双重身份（客户兼供应商）

同一主体同时出现在 `customers[]` 与 `suppliers[]` 时：

1. 在两侧各自的 `note` 写 **`双重身份`** 并互相引用；
2. `relation` 保留主身份（按交易金额大的一方），另一身份写进 note；
3. 只生成核查项：交易内容是否同一种商品、是否背靠背合同、收入按总额还是净额确认、是否存在循环交易；
4. **不得**据此推断虚增收入或资金空转。

## 4. 检索计划

来源优先级：**招股书"主要客户"章 > 年报"前五名客户" > 问询回复 > 客户方公告/供应商名录 > 招投标与政采平台 > 权威媒体**。

| # | 目标 | 首查来源 | 检索词（示例） | 判 found 的条件 |
|---|---|---|---|---|
| 1 | 前 N 大客户 | 招股书、年报 | `[A公司] 前五大客户`、`[A公司] 第一大客户`、`[A公司] 客户集中度` | 有客户名/脱敏标识 + 金额或占比 + 期间 |
| 2 | 集中度 | 年报"前五名客户销售额及占比" | `[A公司] 前五名客户 销售额 占比` | 有 c5 数值 + 分母口径 + 期间 |
| 3 | 认证阶段 | 公告、问询回复、客户供应商名录 | `[A公司] 合格供应商`、`[A公司] 通过认证`、`[A公司] 量产供货` | 有客户 + 阶段 + 时间 |
| 4 | 订单 | 公告（重大合同）、定期报告 | `[A公司] 重大合同`、`[A公司] 订单`、`[A公司] 框架协议` | 有对手方 + 金额 + 期限 |
| 5 | 中标 | 政采/公共资源交易/客户公告 | `[A公司] 中标`、`[A公司] 中标通知书`、`[A公司] 集采` | 有项目名 + 结果 + 金额/期间 |
| 6 | 双重身份 | 招股书"客户与供应商重叠"、问询回复 | `[A公司] 客户 供应商 重叠`、`[A公司] 既是客户又是供应商` | 有同一主体两侧记录 |
| 7 | 关联客户 | `related.parties` + 公告 | `[客户名] 关联方`、`[A公司] 关联销售` | 有股权/任职链 |

必查库：交易所/巨潮类公告库、招股书与年报、中国政府采购网类平台、公共资源交易平台、客户方公告与供应商名录；境外加 `[company] major customers`、`[company] customer concentration`、`[company] awarded contract`、10-K "major customers"（通常披露占收入 10% 以上的客户）。

## 5. 字段与口径映射

| 字段 | 定义 | 缺失处理 |
|---|---|---|
| `customers[].name` | 底稿内引用名 | 必填（脱敏客户用"客户A"并标 `脱敏`） |
| `customers[].fullName` | 工商全称/上市公司全称 | 不可核写 `not_disclosed_after_search` |
| `customers[].id` | 统一社会信用代码/证券代码 | 无则空并 note |
| `customers[].relation` | 交易关系 + 认证阶段 + 是否关联 | 不确定写 `not_reviewed` |
| `concentration.c1` / `c5` | 百分比（0–100），同一分母同一期间 | 只有区间写 `lower_bound`；无披露写 `not_disclosed_after_search` |
| `concentration.period` | 期间 | 必填 |
| `concentration.note` | 分母口径、合并规则、topN | 必填 |
| `orders[].amount` | 金额 + 币种 + 含税口径 | 未披露写 `not_disclosed_after_search`，不得用"框架金额"填 |
| `bids[].project` / `result` | 项目名 / 结果 | 必填 |

## 6. 六态与边界

六态：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`。

- `customers[].relation`、`customers[].id`、`orders[].amount`、`bids[].amount`、`concentration.c5` 必须能落六态并带 note。
- `maxEstimatedRatio` 0.2；允许 `estimated` 的只有"由公司披露总额与占比反推的客户金额""按行业惯例估算的认证周期"，且必须带 `derivation`。
- **公司特定事实（前五大占比、第一大客户、客户数量）禁止用同行均值替代**；无披露写 `not_disclosed_after_search` 并附检索记录。
- 只能 `pending_dd` 的：脱敏客户真实身份、单客户毛利率、在手订单明细、合同含税与否、认证阶段的具体时间点。
- 不推断：不把"送样"当"量产"、不把"供应商名录"当"批量供货"、不把"战略合作"当订单。

## 7. 常见误判（逐条对照）

1. **框架协议当订单**：把 MOU/战略合作/框架协议的"预计金额"写成 `orders[].amount`。
2. **合并口径漏算**：同一实控人下多个客户未合并，c5 被低估；或反向把无关联关系的同名客户合并。
3. **分母错位**：用营业收入做分母却把其他业务收入算进分子；含税与不含税混用。
4. **期间错位**：用本年订单金额对上年收入算集中度。
5. **经销商当终端**：把经销/贸易商客户当终端客户，未标 `经销商`，导致"客户集中度"失真。
6. **双重身份即定罪**：客户兼供应商只生成核查项，不得写"虚增收入""循环交易"。
7. **认证阶段越级**：把"进入合格供应商名录"写成"量产供货"。
8. **脱敏客户硬填全称**：按行业常识猜客户名并写成 `found`。

## 8. 验收要点

- `minEvidence: 3`、`minCoverage: 0.7`；`data.customers` ≥1 行。
- `concentration.c5 ≥ c1`，两者同期间同分母；`concentration.period` 与客户披露期间一致。
- 客户名称可核率（A+B 档 / 全部）应 ≥50%，且 C 档客户全部进 `openQuestions`。
- `orders`/`bids` 每条有对手方与日期；金额缺披露写六态，不得留空。
- 双重身份：`customers` 与 `suppliers` 的交集主体在两侧 `note` 都含"双重身份"。
- 与 `financials.public` 的营业收入对账：c5 占比 × 营业收入 应≈前五大客户金额合计（差异写 note）。

### 8.1 样例（占位符）

```
customers[0] = {name:"客户A", fullName:"E01股份有限公司", id:"统一社会信用代码/证券代码", role:"直接客户",
                relation:"量产供货；非关联方", note:"found｜依据招股书‘主要客户’；认证阶段=量产"}
concentration = {c1:0, c5:0, period:"FY2025", note:"百分比为占位符；分母=营业收入（不含税）；同一控制下已合并；topN=5"}
orders[0] = {date:"20XX-XX", counterparty:"E01", amount:{status:"pending_dd", note:"合同金额未披露，需企业版订单台账"}, product:"产品甲"}
bids[0] = {date:"20XX-XX", project:"项目甲", result:"中标", amount:{status:"found", value:0, note:"金额占位"}, note:"依据中标公示"}
```

## 9. 与其他模块的关系

- **上游**：`business.segment`（产品线决定客户/订单归属）。
- **下游**：`financials-public`（收入勾稽、集中度风险）、`red-flags`（T1 客户集中度、T3 双重身份）、`market-landscape`（客户行业景气度）。
- **交叉**：`related.parties`（关联客户标注）、`ownership.chain`（同一控制下合并）、`supply-capacity`（同一供应商的供应关系）。
- 与 `market-landscape` 边界：本模块只写"公司自己的客户与订单"，行业客户结构归 `market-landscape`。

## 10. 版本与状态

- 模块状态：`draft`，未经金融专家评审。
- 客户名单与集中度是高频变更字段，重跑时对比 `contentHash`，差异写入 `conflictGroup` 并保留两个期间口径。

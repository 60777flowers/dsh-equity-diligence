# 产品矩阵与技术路线（business-segment）

> 模块 id：`builtin/business-segment` ｜ 状态：**draft**（未经金融专家评审，不得称为 stable）
> 输出底稿：`business.segment`（typeVersion 1，cardinality one，scope company）
> 硬输入：`company.identity`；软引用：`market.landscape`

## 1. 一句话目标

用可核的公司披露把"**卖什么、卖第几代、各占多少收入、靠什么技术路线做出来、扩产要多久**"讲清楚，并让**收入构成合计≈100%**、**产品与行业不混**、**代际不臆造**。

## 2. 输入、前置与输出

| 项 | 内容 | 缺失时 |
|---|---|---|
| `company.identity` | 全称、曾用名、主营范围、上市地 | `onMissing: block` |
| `market.landscape`（软） | 行业口径、下游应用、竞争格局 | 缺失只警告；"应用领域"只能来自公司披露 |
| `ip.portfolio`（非输入，但强相关） | 专利与技术覆盖 | 不影响本模块，技术路线佐证可后补 |

输出 `data` 四个数组：`products[]`、`segments[]`、`revenueMix[]`、`techRoute[]`。`{{params.includeRevenueMix}}` 为 false 时仍要输出 `revenueMix`（可为空数组）并在 `openQuestions` 说明未拆。

## 3. 口径定义

### 3.1 产品（products）与行业（segments）必须分开

- **产品** = 公司对外销售的标的物（型号/系列/服务），回答"卖什么"。
- **行业/应用** = 客户所在行业或下游应用（如通信、汽车、工业），回答"卖给谁、用在哪"。
- `products[].application` 写下游应用；**不得把下游应用写成产品名**（见 §7 误判 1）。
- 若公司只按行业披露收入（如"半导体行业""新能源行业"），写入 `segments[]` 并在 `note` 标 `披露口径=分行业`；此时 `products[]` 仍要从产品章节补齐，两个数组不是二选一。

### 3.2 代际（generation）的三条铁律

1. **以公司披露的命名为准**：系列名/代次/型号段，原文照录，不改写成自己的编号习惯。
2. **制程节点 ≠ 产品代际**：`10nm 级`、`28nm` 是工艺节点，不能直接当"第 N 代产品"；两者都出现时分别写（`generation` 写产品代次，工艺节点写进 `note` 或 `techRoute[].route`）。
3. **代际必须有来源**：招股书/官网/公告/标准文档任一；只有研报或媒体说"第 N 代"时，`generation` 标 `estimated` 或 `not_disclosed_after_search`，不得直接采信。

### 3.3 收入构成（revenueMix）的口径

- 分子分母：**主营业务收入**（优先）或**营业收入**，两者必须统一并在 `period`/`note` 写清；分产品、分行业、分地区是三套并列口径，**不得相加**。
- 合计校验：同一口径下 `pct` 合计 100% ±1pp（四舍五入/其他项导致的小差可接受）。
- 期间：`revenueMix[].period` 必填，如 `FY2025`、`2025H1`；不同期间不得混在一组里求和。
- 金额优先于比例：能拿到金额就记金额并由金额算占比（`derivation`），比直接抄比例更可核。

### 3.4 技术路线（techRoute）

`route` 写技术路线/工艺/架构（如"路线甲""工艺乙"），`status` 必须是**可核的阶段**：`研发中` / `送样` / `客户端验证` / `小批量` / `量产` / `规划` / `已淘汰`。阶段必须有来源；公司未披露阶段时写 `not_disclosed_after_search`，不得按"已量产"默认。

### 3.5 扩产周期记在哪

`business.segment` schema 没有独立的扩产周期字段，统一写入 **`products[].note`**（单产品扩产）或 **`techRoute[].note`**（路线级别扩产），必须含：建设/认证周期、达产时间、资本开支量级（有则记）、来源。下游 7+N 的"扩产周期"列从这里取数。

### 3.6 收入确认政策与产品口径的一致性

- 同一产品在不同期间若收入确认政策变化（如从"验收后确认"改为"发货确认"），`revenueMix` 的期间可比性会被破坏，必须在 `note` 标注政策变更。
- 服务类收入与产品类收入混在一个分部时，注明"含服务收入"及其占比；不得把服务收入并入硬件产品口径去算单价。
- 出口/内销、直销/经销如果影响单价与毛利率，作为 `note` 维度记录，不单独新开产品行。

## 4. 检索计划

来源优先级：**招股书"业务与技术"章 > 年报"经营情况讨论与分析" > 问询回复 > 官网产品中心/技术白皮书 > 标准组织文档 > 专利 > 研报（仅线索）**。

| # | 目标 | 首查来源 | 检索词（示例） | 判 found 的条件 |
|---|---|---|---|---|
| 1 | 产品线与型号 | 招股书"主要产品"、官网产品中心 | `[A公司] 产品 系列`、`[A公司] 产品型号`、`[A公司] 产品中心` | 有产品名 + 型号/系列 + 用途 |
| 2 | 产品代际 | 产品手册、公告"新一代产品" | `[A公司] 第X代`、`[A公司] 新一代`、`[A公司] 产品迭代` | 公司原文明确代次 |
| 3 | 收入构成 | 年报"主营业务分产品/分行业/分地区"、招股书 | `[A公司] 收入构成 分产品`、`[A公司] 主营业务 分行业` | 有金额或占比 + 期间 + 口径 |
| 4 | 技术路线 | 招股书"核心技术"、技术白皮书 | `[A公司] 技术路线`、`[A公司] 工艺`、`[A公司] 架构` | 有路线名 + 阶段 + 来源 |
| 5 | 扩产周期 | 募投项目公告、环评、问询回复 | `[A公司] 募投项目 达产`、`[A公司] 扩产 投产`、`[A公司] 建设周期` | 有周期/达产时间 |
| 6 | 收入确认政策 | 年报会计政策 | `[A公司] 收入确认 政策` | 有确认时点与依据（与 revenueMix 口径相关） |
| 7 | 标准与认证 | 标准组织、行业协会 | `[A公司] 标准 参与制定`、`[A公司] 认证` | 有标准号/认证名 |

必查库：交易所/巨潮类公告库、公司年报与招股书、官网、问询回复；境外主体加 `[company] product portfolio`、`[company] revenue by product`、`[company] technology roadmap`、10-K Item 1。

## 5. 字段与口径映射

| 字段 | 定义 | 缺失处理 |
|---|---|---|
| `products[].name` | 产品/系列名（公司口径） | 必填 |
| `products[].category` | 品类（如器件/模组/服务） | 无法归类写 `not_reviewed` |
| `products[].generation` | 产品代次（公司口径） | 无来源写 `not_disclosed_after_search`；推断写 `estimated` + derivation |
| `products[].application` | 下游应用 | 未披露写 `not_disclosed_after_search` |
| `products[].status` | `量产` / `小批量` / `送样` / `研发` / `停产` | 未披露写 `not_disclosed_after_search` |
| `segments[].name` | 收入分部名称（产品/行业/地区三者之一，note 标口径） | 必填 |
| `segments[].revenue` | 金额 + 币种 + 单位 | 只有占比时用占比反推并标 `estimated` |
| `segments[].revenuePct` | 百分比（0–100） | 与 revenueMix 对账 |
| `segments[].grossMargin` | 百分比（0–100） | 未披露写 `not_disclosed_after_search`，不得用同行替代 |
| `revenueMix[].pct` | 百分比，同口径合计≈100 | 必填 |
| `techRoute[].route` / `status` | 路线名 / 阶段 | 阶段无来源写 `not_disclosed_after_search` |

### 5.1 claim 谓词建议

| predicate | value 示例 | 必带 |
|---|---|---|
| `product_count` | 数字 | 口径（在售/含规划）、asOf |
| `product_generation` | `第N代` | 产品、来源表述 |
| `product_status` | `量产` / `验证` | 产品、来源 |
| `revenue_mix_pct` | 百分比 | 产品/分部、期间、分母口径 |
| `revenue_share_amount` | 数值 + 币种 | 期间、合并口径 |
| `segment_gross_margin` | 百分比 | 期间、口径 |
| `tech_route_status` | `小批量` | 路线、来源 |
| `expansion_cycle_months` | 月数 | 产品、起点与终点定义 |

同一 predicate 多期间并列，不要把两个期间平均成一个数。

## 6. 六态与边界

六态取值：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`。

- `products[].generation`、`products[].status`、`techRoute[].status` 必须能落六态并带 `note`；行级写法：`status` 对象或 `note` 以六态词开头（如 `pending_dd｜需企业版产品手册`）。
- 允许 `estimated` 的只有：收入占比（由金额推导）、毛利率区间（有可比口径）、市场份额（推导）。**公司特定事实（产品线数量、代际、收入构成）不得用同行均值替代**。
- `maxEstimatedRatio` 0.2；收入构成整组都靠估算时，`revenueMix` 整体标 `estimated` 并在 `derivation` 写清假设。
- 只能 `pending_dd` 的：未披露的分产品收入、单产品毛利率、客户认证阶段、未公开的产品路线图。
- 不推断：不把"招聘 JD 提到某产品"当产品存在证据；不把专利申请当产品量产；不把"规划产能"当已投产。

## 7. 常见误判（逐条对照）

1. **把下游应用当产品线**：如把"AI 服务器""新能源汽车"写进 `products`——它们是应用/行业，应进 `application` 或 `segments`。
2. **代际与制程混用**：把工艺节点、封装形式、型号后缀当"第 N 代"；代际命名必须以公司原文为准。
3. **收入合计超 100%**：把分产品与分行业两套占比相加；或把"其他业务收入"重复计入。
4. **把规划写成量产**：`status` 写"量产"但来源只提到"计划/拟建/预计"。
5. **研报口径覆盖公司口径**：研报拆分的收入结构与公司披露不一致时，以公司披露为准，研报只作 `contextual` 证据。
6. **合并/母公司混用**：用母公司报表的分产品收入去对合并口径的总额。
7. **把样品/试用收入当量产收入**，或把框架协议金额当已确认收入。
8. **产品数量虚增**：把同一产品的不同型号、不同包装、不同地区版本各算一个产品线。

## 8. 验收要点

- `minEvidence: 3`、`minCoverage: 0.8`；`data.products` 与 `data.revenueMix` 各 ≥1 行。
- `revenueMix[].pct` 同一期间同一口径合计 100% ±1pp；跨期间混排直接判不过。
- `products[].generation` 每条都有来源或六态；不得出现无 note 的代际。
- `products` 与 `segments` 不得互相污染（产品名里不出现行业名，行业名不冒充产品）。
- `techRoute[].status` 与来源一致；"规划/预计"不得写成"量产"。
- 收入构成与 `financials.public` 的营业收入能对上（差额写 note）。

### 8.1 样例（占位符，非真实数据）

```
products[0] = {name:"产品甲", category:"品类甲", generation:"第2代", application:"应用A", status:"量产", note:"found｜依据定期报告‘主要产品’节；工艺节点=XXnm 记于 techRoute"}
revenueMix[0] = {name:"产品甲", pct:60, period:"FY2025"}
revenueMix[1] = {name:"产品乙", pct:40, period:"FY2025"}      ← 合计 100
techRoute[0] = {route:"路线乙", status:"客户端验证", note:"found｜依据问询回复；扩产周期=约XX个月，达产=20XX年"}
```

示例中的产品甲、XXnm、60 均为占位符；实际底稿只允许写检索到的事实。

## 9. 与其他模块的关系

- **上游**：`company.identity`（经营范围与曾用名影响产品检索）。
- **下游**：`market-landscape`（按产品线找行业空间）、`customers-orders`（按产品找客户与认证阶段）、`supply-capacity`（按产品找产能与成本）、`ip-portfolio`（技术路线与专利覆盖交叉）、`financials-public`（收入构成与毛利率对账）。
- 与 `market.landscape` 的边界：**本模块只写公司自己的产品与收入结构**，行业规模、份额、竞争格局归 `market-landscape`，不得越界写"行业第一"。

## 10. 版本与状态

- 模块状态：`draft`，未经过金融专家评审。
- 代际命名与收入口径属于高变更字段，重跑时需比对上一版 `contentHash`，差异写入 `conflictGroup`。

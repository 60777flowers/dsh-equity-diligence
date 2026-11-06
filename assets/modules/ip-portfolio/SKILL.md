# 知识产权组合（ip-portfolio）

> 模块 id：`builtin/ip-portfolio` ｜ 状态：**draft**（未经金融专家评审，不得称为 stable）
> 输出底稿：`ip.portfolio`（typeVersion 1，cardinality one，scope company）
> 硬输入：`company.identity`、`business.segment`；软引用：`org.people`

## 1. 一句话目标

用官方数据库把"**公司（含子公司、含曾用名）名下到底有多少专利/商标/软著、法律状态如何、权利要求覆盖什么、同族布到哪些国家、有没有被质押**"盘清楚，做到**去重、状态准确、申请人范围完整**。

## 2. 输入、前置与输出

| 项 | 内容 | 缺失时 |
|---|---|---|
| `company.identity` | 全称、曾用名、统一社会信用代码 | `onMissing: block`，否则申请人检索范围不完整 |
| `business.segment` | 产品线、技术路线 | `onMissing: block`，否则无法判断"核心专利" |
| `ownership.chain`（非输入，交叉用） | 子公司清单 | 缺失时只查母公司，`note` 标"未覆盖子公司" |
| `org.people`（软） | 发明人/核心技术人员 | 缺失只警告；发明人交叉降级 |

输出 `data`：`patents[]`、`trademarks[]`、`software[]`、`pledges[]`。`{{params.includeFamily}}` 为 true 时合并同族计数（同族只计 1 项，另记成员数），为 false 时按公开号逐条列。

## 3. 口径定义

### 3.1 申请人范围（最容易出错的地方）

检索申请人 = **公司全称 + 全部合并范围内子公司 + 曾用名 + 常见简称变体**。

- 逐个子公司在 CNIPA 用"申请人"字段检索；不能只查母公司。
- 曾用名必须单独检索（更名前的专利仍在旧名下）。
- 受让取得的专利：申请人已是本公司，但**申请日/原始申请人**不同，`note` 记原申请人。
- 境外主体：用英文名/当地注册名在 Espacenet、USPTO、WIPO 检索，注意中英文名不一致。
- 合作研发/共有专利：`applicant` 记全部共有人，`note` 标"共有"。

### 3.2 法律状态（以官方为准）

状态取值：`有效` / `审中` / `失效` / `撤回` / `驳回` / `期限届满` / `未缴年费` / `质押` / `未披露`。

- 以 **CNIPA 专利检索及分析系统 + 中国及多国专利审查信息查询（登记簿）** 为准；Google Patents、Espacenet 的状态为二手信息，只能作线索。
- `审中` 不等于 `有效`：未授权申请没有排他权，不能计入"有效专利"。
- 失效要区分原因（未缴年费/期限届满/放弃/被无效），原因影响价值判断。
- 状态必须带 `asOf`（检索日），专利状态每天可能变化。

### 3.3 权利要求（核心专利的判据）

- 记录**独立权利要求数量**与**保护范围要点**（技术特征），以授权公告文本为准。
- "核心专利"判定：与 `business.segment` 的主力产品/技术路线对应，且独立权利要求覆盖该产品的关键特征；判定要有 `note` 说明对应关系。
- 权利要求解释属法律判断，本模块只摘录与标注，不下"是否侵权/是否有效"的结论。

### 3.4 同族与引证

- **同族**：以 INPADOC 简单同族或申请号族为准；同族成员分布反映海外布局（US/EP/JP/KR 等）。
- `includeFamily=true` 时：同族只计 1 项，`note` 写 `同族成员数=N，覆盖=US/EP/...`。
- **引证**：后向引证（引用的现有技术）反映技术积累；前向引证（被引）反映影响力。只记录数量与被引主体类别，不据此推断价值高低。

### 3.5 质押与许可备案

- `pledges[]` 来自 CNIPA **专利权质押登记**（商标质押同理）：专利号、出质人、质权人、登记日期、状态（有效/注销）。
- 许可备案（专利实施许可合同备案）记入 `patents[].note`；独占/排他/普通许可影响权利价值，必须写清。
- 质押/许可与 `debt.guarantee`、`tech.origin` 交叉：质押对应融资，许可对应技术来源。

### 3.6 商标与软著

- 商标：中国商标网，按申请人检索；记录名称、注册号、尼斯分类类别、状态（注册/异议/无效/撤销/续展）、专用权期限。
- 软著：中国版权保护中心，记录名称、登记号、登记日期、著作权人；软著为登记制，**登记不代表技术先进**。
- 商标类别要覆盖公司实际业务类别；核心类别缺失是重要线索（只记核查项）。

## 4. 检索计划

来源优先级：**CNIPA 官方检索/登记簿 > 中国商标网 > 中国版权保护中心 > Espacenet/USPTO/WIPO > Google Patents（线索）**。

| # | 目标 | 首查来源 | 检索词（示例） | 判 found 的条件 |
|---|---|---|---|---|
| 1 | 发明专利 | CNIPA 专利检索及分析系统 | 申请人=`[A公司]`、申请人=`[子公司名]`、申请人=`[曾用名]` | 有申请号/公开号 + 状态 + 申请日 |
| 2 | 法律状态 | CNIPA 审查信息查询/登记簿 | 专利号逐件查询 | 有官方状态 + 查询日 |
| 3 | 权利要求 | 授权公告文本 | 专利号 → 权利要求书 | 有独立权利要求数量与要点 |
| 4 | 同族 | Espacenet / INPADOC | 专利号 → 同族 | 有同族成员与国别 |
| 5 | 引证 | Google Patents / Espacenet | 专利号 → citations | 有引证数量与来源 |
| 6 | 质押 | CNIPA 专利权质押登记 | `[A公司] 专利 质押`、出质人检索 | 有专利号 + 质权人 + 登记日 |
| 7 | 商标 | 中国商标网 | 申请人=`[A公司]` | 有注册号 + 类别 + 状态 |
| 8 | 软著 | 中国版权保护中心 | 著作权人=`[A公司]` | 有登记号 + 登记日 |

必查库：CNIPA 系列系统、中国商标网、中国版权保护中心、Espacenet、USPTO Patent Center、WIPO PATENTSCOPE、Google Patents（仅线索）；境外加 `assignee:[company]`、`[company] patent portfolio`。

## 5. 字段与口径映射

| 字段 | 定义 | 缺失处理 |
|---|---|---|
| `patents[].title` | 专利名称（公告文本） | 必填 |
| `patents[].number` | 申请号或授权公告号（注明类型） | 必填；类型写进 note |
| `patents[].applicant` | 申请人（全部共有人） | 必填 |
| `patents[].status` | 上文状态枚举 | 无官方状态写 `not_disclosed_after_search` |
| `patents[].filedAt` | 申请日 | 未取得写 `pending_dd` |
| `patents[].inventors` | 发明人 | 未披露写 `not_disclosed_after_search` |
| `trademarks[].number` | 注册号 | 必填 |
| `software[].number` | 登记号 | 必填 |
| `pledges[].pledgee` | 质权人 | 未披露写 `pending_dd` |
| `pledges[].status` | 有效/注销 | 必填 |

## 6. 六态与边界

六态：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`。

- `patents[].status`、`patents[].filedAt`、`patents[].inventors`、`pledges[].pledgee`、`trademarks[].status` 必须能落六态并带 note。
- `maxEstimatedRatio` 0.1：知识产权是登记事实，**几乎不允许估算**；同族计数、引证计数这类可数项不得估算。
- 只能 `pending_dd` 的：未公开的申请（申请日起 18 个月内未公开）、未登记的许可、内部发明披露、专利维持费缴纳凭证。
- **公司特定事实（专利数量、有效专利数、核心专利）禁止用同行均值替代**；检索不到写 `not_disclosed_after_search` 并附检索式与检索日。
- 不推断：不把"申请"当"授权"、不把"审中"当"有效"、不把 Google Patents 状态当官方状态、不对权利要求做侵权判断。

## 7. 常见误判（逐条对照）

1. **申请号当授权号**：同一专利的申请号、公开号、公告号不同，混用会重复计数。
2. **同族重复计数**：同一发明的 US/EP/CN 成员各算一件，专利数虚增数倍。
3. **审中当有效**：把未授权申请计入"有效专利"，排他权并不存在。
4. **只查母公司**：漏子公司、曾用名、境外主体，数量严重低估。
5. **二手状态当官方**：用 Google Patents 的"Active"代替 CNIPA 登记簿状态。
6. **实用新型/外观当发明**：三类专利价值不同，必须分开统计。
7. **申请量当授权量**：用"累计专利申请"描述技术实力。
8. **软著当技术壁垒**：软著为登记制，不审查新颖性。
9. **共有专利忽略共有人**：只写本公司，遗漏合作方权利。

## 8. 验收要点

- `minEvidence: 3`、`minCoverage: 0.7`；`data.patents` ≥1 行（确无专利时插 1 行 `not_applicable` 占位并说明检索范围）。
- `patents[].number` 唯一；同族成员不重复计入（`includeFamily=true` 时同族计 1）。
- 状态来自官方源，且带 `asOf`；`审中` 与 `有效` 分开统计并在 note 给数量。
- 核心专利（对应主力产品）至少 1 件有权利要求要点与同族信息。
- `pledges[]` 与 `patents[].number` 能对应上；质押状态为官方登记状态。
- 商标覆盖公司实际业务类别；核心类别缺失写进 `openQuestions`。

### 8.1 样例（占位符）

```
patents[0] = {title:"专利名称（占位）", number:"申请号/公告号（占位）", applicant:"A公司；E01（共有）",
              status:"有效", filedAt:"20XX-XX-XX", inventors:"发明人甲",
              note:"found｜CNIPA 登记簿，检索日 20XX-XX-XX；独立权利要求 N 项；同族成员数=N（CN/US/EP）"}
pledges[0] = {patent:"申请号（占位）", pledgee:"质权人（占位）", status:"有效", note:"CNIPA 质押登记，登记日 20XX-XX-XX"}
trademarks[0] = {name:"商标名（占位）", number:"注册号（占位）", status:"注册", note:"类别=第 N 类；专用权期限=…"}
```

## 9. 与其他模块的关系

- **上游**：`company.identity`（申请人范围）、`business.segment`（核心专利判定基准）。
- **下游**：`tech-origin`（许可/转让/来源）、`red-flags`（T4 发明人与核心人员重叠、T5 技术宣称与专利覆盖）、`assessment-fit`（技术壁垒）、`debt.guarantee`（质押融资）。
- **交叉**：`org.people`（发明人→核心技术人员/离职人员）、`policy-exposure`（技术出口管制）。
- 与 `tech-origin` 的边界：本模块只做**权利清单与状态**；技术从哪来、许可范围、FTO 线索归 `tech-origin`。

## 10. 版本与状态

- 模块状态：`draft`，未经金融专家评审。
- 知识产权状态高频变化：每次重跑必须重取官方状态与检索日，不得沿用上一版 `asOf`。

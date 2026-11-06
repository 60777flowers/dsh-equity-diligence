# 行业空间与竞争格局（market-landscape）

> 模块 id：`builtin/market-landscape` ｜ 状态：**draft**（未经金融专家评审，不得称为 stable）
> 输出底稿：`market.landscape`（typeVersion 1，cardinality one，scope company）
> 硬输入：`business.segment`（产品线与行业口径由此而来）

## 1. 一句话目标

用**两个相互独立的来源**把"**行业多大、长多快、谁占多少、国产化到哪一步、政策往哪推**"说清楚，每个数字都带**年份**与**口径**，并且**绝不把卖方预测写成已发生的事实**。

## 2. 输入、前置与输出

| 项 | 内容 | 缺失时 |
|---|---|---|
| `business.segment` | 产品线、下游应用、收入结构 | `onMissing: block`，否则不知道要查哪个行业 |
| `financials.public`（非输入，交叉用） | 公司营业收入，用于自算份额 | 缺失时份额只能引用第三方或写 `not_reviewed` |

输出 `data`：`marketSize[]`、`competition[]`、`share[]`、`policy[]`，以及模块扩展字段 `localization[]`（国产化率；schema 未列，按 additionalProperties 约定使用）。`{{params.yearsBack}}` 控制回溯年数（默认 3，范围 1–10）；只回溯不前瞻，前瞻预测单独标 `predicted`。

## 3. 口径定义

### 3.1 市场规模的六项必标

一个规模数字只有同时写清以下六项才可判 `found`（分析型可 `estimated`）：

1. **年份**（`year`，如 `2025`）；
2. **地域**（全球 / 中国 / 中国大陆 / 亚太）；
3. **计量**（金额 or 出货量；金额须带币种与单位，如"亿美元""亿元"）；
4. **环节**（TAM 全市场 / SAM 可服务市场 / 公司所处环节，如设备、材料、模组）；
5. **性质**（实际值 / 预测值，`sourceBasis` 里写 `actual` 或 `predicted`）；
6. **来源机构**（IDC、TrendForce、Yole、Gartner、Omdia、统计局、行业协会、券商等）。

### 3.2 "两个独立口径"的判定

- **独立** = 不同机构、不同调研方法、非同一份报告的转载/引用。同一报告的媒体转述只算一个来源（`originGroupId` 相同）。
- 同一年的规模至少两个来源；两个来源差异 >30% 时，两行都保留，`note` 写差异原因（口径/汇率/统计范围），不得取平均后当"事实"。
- 招股书引用的第三方报告，若为定制报告（付费、非公开方法论），`note` 标 `定制报告`，并尽量再找一份公开机构数据交叉。

### 3.3 增速

- 增速必须标明是 **CAGR** 还是 **YoY**，区间年份写清（如 `2025–2030 CAGR`）。
- 由两个年份规模自算的 CAGR 标 `estimated` + `derivation`；引用机构预测标 `predicted`。
- 不得用"行业增速"替代"公司增速"；两者分别记录。

### 3.4 份额（competition 与 share 的区别）

- `competition[]`：**竞争对手**的名称、份额、定位；份额合计应 ≤100（若有"其他"项则合计≈100）。
- `share[]`：**本公司**的市场份额，按年份记录，`basis` 写清"按金额/按出货量、全球/中国、来源（第三方 or 自算）"。
- 自算份额 = 公司收入 ÷ 同口径市场规模，必须 `estimated` + `derivation`（分子分母同期同币种）。
- **公司特定事实（本公司份额）不得用同行均值替代**。

### 3.5 国产化率与政策

- 国产化率记入模块扩展字段 `localization[]`：`{year, ratePct, definition, source, note}`。`definition` 必须写清"按金额/按数量、按哪个环节（设备/材料/零部件/整机）、境内生产是否含外资在华工厂"；没有统一定义时并列多行并标差异。
- `localization[].ratePct` 用 0–100 数值；口径来源为 estimated 时必须带 `derivation`。
- 不得把"国产替代空间"当"国产化率"；也不得用海外市场的国产化率替代中国市场。
- 政策：`policy[].name` 写文件全称，`note` 写发文机关 + 文号 + 生效日期（有则写），`date` 写发布或生效日；`impact` 写 `正面` / `中性` / `限制` / `不确定` 并给一句依据。
- **征求意见稿、草案、传闻中的政策不得写成已生效**；未生效的写 `impact=不确定` 并在 note 标"征求意见稿"。

## 4. 检索计划

来源优先级：**政府/统计局/海关/协会官方数据 > 公开第三方机构（IDC/TrendForce/Yole/Gartner/Omdia/Counterpoint）> 招股书行业章（注意其引用报告年份）> 券商研报（仅线索/交叉）> 媒体**。

| # | 目标 | 首查来源 | 检索词（示例） | 判 found 的条件 |
|---|---|---|---|---|
| 1 | 市场规模 | 第三方机构新闻稿/摘要、统计局、协会 | `[行业] 市场规模`、`[行业] 出货量`、`[行业] 产值` | 有年份 + 地域 + 计量 + 来源 |
| 2 | 增速 | 同上 + 研报 | `[行业] CAGR`、`[行业] 增长率`、`[行业] 预测` | 有区间年份 + CAGR/YoY 口径 |
| 3 | 竞争格局 | 机构份额报告、公司公告 | `[行业] 市场份额`、`[行业] 排名`、`[对手名] 份额` | 有对手名 + 份额 + 年份 |
| 4 | 公司份额 | 第三方报告或自算 | `[A公司] 市场份额`、`[A公司] 市占率` | 有份额 + 口径 + 年份 |
| 5 | 国产化率 | 协会、海关、研报 | `[环节] 国产化率`、`[产品] 进口依赖度` | 有定义 + 年份 + 来源 |
| 6 | 政策 | 政府网站、发改委/工信部/财政部 | `[行业] 政策`、`[产品] 管理办法`、`[行业] 十四五/十五五` | 有文件全称 + 发文机关 + 日期 |
| 7 | 下游需求 | 客户行业数据、机构 | `[下游] 需求`、`[下游] 资本开支` | 有年份 + 来源 |

必查库：国家统计局、海关总署、行业协会、第三方机构公开摘要、政府政策库；境外加 `[market] market size`、`[market] market share`、`[market] forecast CAGR`、`[market] localization rate`。

## 5. 字段与口径映射

| 字段 | 定义 | 缺失处理 |
|---|---|---|
| `marketSize[].year` | 年份（数字或 `YYYY`） | 必填；无年份不得入表 |
| `marketSize[].size` | 规模（数值 + 单位/币种） | 只有区间写 `lower_bound` |
| `marketSize[].growthPct` | 增速（%，标 CAGR/YoY） | 未披露写 `not_disclosed_after_search` |
| `marketSize[].sourceBasis` | 机构 + 地域 + 计量 + 实际/预测 | 必填 |
| `competition[].sharePct` | 对手份额（0–100） | 无第三方数据写 `estimated` + derivation |
| `competition[].positioning` | 定位（高端/中低端/细分） | 未披露写 `not_reviewed` |
| `share[].basis` | 分子分母口径 | 必填 |
| `localization[].year` / `ratePct` | 国产化率年份与数值（0–100） | 无来源写 `not_disclosed_after_search` |
| `localization[].definition` | 口径定义（金额/数量、环节、是否含外资在华工厂） | 必填 |
| `policy[].date` | 发布/生效日期 | 必填 |
| `policy[].impact` | 正面/中性/限制/不确定 | 必填 + 一句依据 |

## 6. 六态与边界

六态：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`。

- `marketSize[]`、`competition[].sharePct`、`share[].sharePct`、`localization[].ratePct`、`policy[].impact` 必须能落六态并带 note。
- **市场规模、增速、份额属于分析型字段，允许 `estimated`，但必须带 `derivation {method, inputs[], comparables[], assumptions[]}`**；`maxEstimatedRatio` 0.5（本模块以分析为主）。
- 两个来源冲突且无法裁决时写 `conflict`，保留两个候选与各自口径，不得取平均伪装成 `found`。
- 只能 `pending_dd` 的：付费报告的完整方法论与分项数据、未公开的客户结构、公司内部份额口径。
- 不推断：不把 TAM 当公司可及市场；不把"行业增速"当公司增速；不把预测值当年实际；不把媒体标题数字当机构原始数据。

## 7. 常见误判（逐条对照）

1. **TAM 当 SAM/可及市场**：用全行业规模直接推公司天花板，忽略环节与地域限制。
2. **全球与中国混用**：分子用中国收入，分母用全球规模，份额被低估。
3. **金额与出货量混算**：用出货量份额乘金额单价得规模，量价口径不一致。
4. **预测当事实**：把"预计 2030 年达 XX"写成"2030 年规模为 XX"。
5. **同一报告的多次转载当双源**：两家媒体转述同一份机构新闻稿，只算一个来源。
6. **招股书引用报告的年份错位**：用 2020 年报告的数据描述 2025 年市场，未标数据年份。
7. **份额分母不一致**：对手份额按细分市场，公司份额按全市场，放在同一张表比较。
8. **政策征求意见稿当生效**：把草案、征求意见稿写成已实施政策。
9. **把行业排名当份额**：只有"排名第 N"没有份额，不能反推份额。

## 8. 验收要点

- `minEvidence: 3`、`minCoverage: 0.7`；`data.marketSize` ≥2 行（同一年的两个独立来源，或两个年份各一源）。
- 每行 `marketSize` 的 `year` 与 `sourceBasis` 齐全；预测值必须标 `predicted`。
- `competition[].sharePct` 合计 ≤100（含"其他"时≈100）；公司份额与对手份额分母一致。
- `localization[]` 如填写，必有 `definition` 与 `year`；多口径并列不合并。
- `policy[]` 至少 1 条，含文件全称、发文机关、日期、影响方向。
- 自算份额/增速必须能在 `derivation` 里复算出同一数字。

### 8.1 样例（占位符）

```
marketSize[0] = {year:"20XX", size:"规模值+单位（占位）", growthPct:0, sourceBasis:"机构甲｜全球｜金额｜actual", note:"占位"}
marketSize[1] = {year:"20XX", size:"规模值+单位（占位）", growthPct:0, sourceBasis:"机构乙｜全球｜金额｜actual", note:"与机构甲差异约XX%，口径差异=统计范围"}
competition[0] = {name:"对手A", sharePct:0, positioning:"高端", note:"占位；来源=机构甲"}
share[0] = {year:"20XX", sharePct:0, basis:"按金额｜全球｜自算=公司收入/机构甲规模｜estimated"}
policy[0] = {name:"《政策名》", date:"20XX-XX-XX", impact:"正面", note:"发文机关+文号（占位）；要点=…"}
```

## 9. 与其他模块的关系

- **上游**：`business.segment`（产品与行业口径）。
- **下游**：`assessment-fit`（行业空间与竞争位置）、`red-flags`（政策/管制类风险线索）、`deliverable`（行业章节）。
- **交叉**：`financials-public`（自算份额的分子）、`policy-exposure`（管制清单，比本模块更细）、`ip-portfolio`（技术路线与竞争位置）。
- 与 `business.segment` 的边界：本模块只写**行业与对手**，公司自己的产品、收入结构、扩产周期归 `business.segment`。

## 10. 版本与状态

- 模块状态：`draft`，未经金融专家评审。
- 行业规模与份额每年更新：重跑必须重取年份，不得沿用上一版数字；旧数据保留为历史行并标年份。

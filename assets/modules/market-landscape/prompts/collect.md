# {{module.name}} · 任务模板

## 0. 本次任务

对 **{{company.name}}**（代码/标识：{{company.code}}）执行"行业空间与竞争格局"调查，产出 `market.landscape` 底稿。委托方：{{project.client}}。分区：`{{unit.partition}}`。回溯年数 `yearsBack` = {{params.yearsBack}}（只回溯，前瞻预测单独标注）。

## 1. 输入（渲染摘要）

- 产品与收入结构：{{artifact:business.segment}}（决定查哪个行业、哪个环节）
- 财务（交叉参考，若非空）：{{artifact:financials.public}}
- 关联行业底稿（交叉参考，若非空）：{{artifact:policy.exposure}}

先从产品线确定"行业 + 环节 + 地域"三要素，再开始检索；行业选错会导致全部数字作废。

## 2. 必答问题

1. **Q1 市场规模**：最近 `yearsBack` 年，行业规模（全球/中国，金额/出货量）是多少？至少两个独立来源，差异多大？
2. **Q2 增速**：历史增速与预测增速分别是多少？是 CAGR 还是 YoY、区间年份是什么？
3. **Q3 竞争格局**：主要竞争对手是谁、份额多少、定位如何？份额合计是否≤100？
4. **Q4 公司份额**：本公司份额多少、按什么口径（金额/数量、全球/中国）、来源是第三方还是自算？
5. **Q5 国产化率**：所在环节国产化率多少、定义是什么（金额/数量）、哪一年、来源？
6. **Q6 政策**：有哪些在生效的产业政策/管制政策？文件全称、发文机关、日期、影响方向？
7. **Q7 预测标注**：哪些数字是预测值？是否已在 `sourceBasis` 标注 `predicted` 且未写成事实？

## 3. 检索要求

- 来源优先级：政府/统计局/海关/协会 > 公开第三方机构（IDC/TrendForce/Yole/Gartner/Omdia 等） > 招股书行业章 > 券商研报（仅线索/交叉） > 媒体。
- 中文检索词至少覆盖：`市场规模`、`出货量`、`产值`、`CAGR`、`增长率`、`市场份额`、`排名`、`市占率`、`国产化率`、`进口依赖度`、`行业政策`、`管理办法`。
- 英文/境外：`market size`、`market share`、`forecast CAGR`、`localization rate`、`regulation`。
- **同一份机构报告的媒体转述只算一个来源**；两个来源必须方法独立、机构不同。
- 政策必须有原文或政府网站来源；征求意见稿、草案必须显式标注。

## 4. 字段与六态

- 输出 `data.marketSize[]`、`data.competition[]`、`data.share[]`、`data.policy[]`，字段名不得改。
- `marketSize[].year`、`marketSize[].size`、`marketSize[].sourceBasis`、`competition[].sharePct`、`share[].basis`、`policy[].impact` 必须落六态并带 note：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`。
- **市场规模、增速、份额允许 `estimated`，但必须带 `derivation {method, inputs[], comparables[], assumptions[]}`**；整体估算占比 ≤50%。
- **禁止把卖方预测写成事实**：预测行 `sourceBasis` 必须含 `predicted`，`note` 写预测机构与预测年份。
- **公司特定份额禁止用同行均值替代**；两个来源冲突写 `conflict` 并保留两行，不取平均。
- 规模必须带单位与币种；份额用 0–100 数值。
- 国产化率写入 `data.localization[]`（`year`/`ratePct`/`definition`/`source`/`note`），`definition` 必填（金额还是数量、哪个环节、是否含外资在华工厂）；多口径并列，不合并。

- `not_disclosed_after_search` 必须关联 `search.ledger` 的尝试记录（查过哪些机构/库、哪些词、检索日期、年份筛选），`sourceCoverage.queries` 必须能逐条对应。

## 5. 门与自检（提交前逐条勾）

- 证据：`minEvidence=3`、`minCoverage=0.7`；`data.marketSize` ≥2 行。
- 每行 `marketSize` 有 `year` 与 `sourceBasis`；预测行已标 `predicted`。
- `competition[].sharePct` 合计≤100；公司 `share` 与对手份额分母一致。
- `policy[]` 至少 1 条，含文件全称、发文机关、日期、影响方向；征求意见稿已标注。
- 自算份额/增速可用 `derivation` 复算；不得出现"据了解/业内普遍"。

## 6. 输出

严格返回契约 JSON：`{asOf, openQuestions, flags, sourceCoverage, claims, evidence, data}`。

- `claims`：建议谓词 `market_size`、`market_growth_cagr`、`competitor_share`、`company_share`、`localization_rate`、`policy_impact`；规模带 `unit` 与 `year`，增速带区间年份与 CAGR/YoY，份额带 `basis`。
- `evidence`：`quote` 原文片段，`locator` 到章节/表格/段落；标 `sourceTier`、`sourceAuthority`、`sourceIndependence`。
- `flags`：政策限制、份额下滑、口径冲突只写 `attention`/`material` 与核查动作，不写投资建议。
- `sourceCoverage.queries` 记录检索词、机构与年份；`limitations` 写清只有单一来源、付费报告未取得、定义不统一等缺口。

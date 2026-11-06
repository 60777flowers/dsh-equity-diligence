# {{module.name}} · 任务模板

## 0. 本次任务

对 **{{company.name}}**（代码/标识：{{company.code}}）执行"知识产权组合"调查，产出 `ip.portfolio` 底稿。委托方：{{project.client}}。分区：`{{unit.partition}}`。参数 `includeFamily` = {{params.includeFamily}}（为 true 时同族计 1 项并记成员数）。

## 1. 输入（渲染摘要）

- 主体底册：{{artifact:company.identity}}（全称、曾用名、统一社会信用代码）
- 产品与技术路线：{{artifact:business.segment}}（核心专利判定基准）
- 股权与子公司（交叉参考，若非空）：{{artifact:ownership.chain}}
- 关键人员（软引用）：{{artifact:org.people}}

先列出**申请人清单**（公司 + 全部子公司 + 曾用名 + 英文名），再逐名检索；不要只查母公司。

## 2. 必答问题

1. **Q1 专利清单**：公司及子公司名下的发明/实用新型/外观设计分别有多少？申请日、公开号、状态？
2. **Q2 法律状态**：每件专利当前状态（有效/审中/失效/撤回/驳回/期限届满/未缴年费）？以哪个官方系统为准、检索日是哪天？
3. **Q3 权利要求**：核心专利的独立权利要求数量与保护范围要点？对应哪个主力产品/技术路线？
4. **Q4 同族与布局**：核心专利同族覆盖哪些国家/地区？同族成员数？
5. **Q5 引证**：核心专利的前向/后向引证情况？
6. **Q6 质押与许可**：有无专利权质押登记、许可备案？质权人、登记日期、状态？
7. **Q7 商标与软著**：商标注册号、类别、状态；软著登记号、著作权人？
8. **Q8 去重**：上述数量是否已去重（同族、申请号/公告号、PCT 国际阶段与国家阶段）？

## 3. 检索要求

- 来源优先级：CNIPA 官方检索/登记簿 > 中国商标网 > 中国版权保护中心 > Espacenet/USPTO/WIPO > Google Patents（仅线索，不作状态依据）。
- 中文检索方式：CNIPA 按"申请人"字段检索，逐个主体、逐个曾用名；专利号逐件查法律状态。
- 英文/境外：`assignee:[company]`、`[company] patent portfolio`、Espacenet 同族、USPTO Assignment。
- 每个数量都必须能说明"检索式 + 检索日 + 去重规则"。
- 质押以 CNIPA 质押登记为准；许可备案以 CNIPA 合同备案为准。
- 商标按尼斯分类记录，核心类别缺失要单独提示。

## 4. 字段与六态

- 输出 `data.patents[]`、`data.trademarks[]`、`data.software[]`、`data.pledges[]`，字段名不得改。
- `patents[].status`、`patents[].filedAt`、`patents[].inventors`、`trademarks[].status`、`pledges[].pledgee` 必须落六态并带 note：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`。
- **专利数量、有效专利数、核心专利属于登记事实，禁止估算或用同行均值替代**；确无专利写 `not_applicable` 占位行并说明检索范围。
- `estimated` 仅允许用于引证计数等二手统计，占比 ≤10%，且必须带 `derivation`。
- `patents[].number` 必须唯一；同族成员不得重复计入。
- 状态必须带检索日 `asOf`；`审中` 与 `有效` 不得混计。

- `not_disclosed_after_search` 必须关联 `search.ledger` 的尝试记录（检索式、库、检索日期、分类号/申请号范围），`sourceCoverage.queries` 必须能逐条对应。

## 5. 门与自检（提交前逐条勾）

- 证据：`minEvidence=3`、`minCoverage=0.7`；`data.patents` ≥1 行。
- `patents[].number` 唯一；同族去重规则已写进 note。
- 状态来自官方源且带检索日；`审中`/`有效`分开统计。
- 核心专利至少 1 件有独立权利要求数量 + 同族国别。
- `pledges[]` 的 `patent` 必须能对上 `patents[].number`。
- 申请人范围覆盖公司 + 子公司 + 曾用名；未覆盖的写在 `sourceCoverage.limitations`。

## 6. 输出

严格返回契约 JSON：`{asOf, openQuestions, flags, sourceCoverage, claims, evidence, data}`。

- `claims`：建议谓词 `patent_count`、`patent_valid_count`、`patent_pending_count`、`core_patent`、`patent_family_size`、`patent_pledge`、`trademark_count`、`software_count`；数量必须带检索式与检索日。
- `evidence`：`quote` 为官方页面片段，`locator` 写专利号/登记号/栏目；`sourceTier` 用 `registry`/`database`，标 `verificationStatus`。
- `flags`：核心专利失效、质押比例高、核心类别商标缺失只写 `attention`/`material` 与核查动作。
- `sourceCoverage.queries` 记录检索式（含申请人字段）、库、日期；`limitations` 写清未公开申请、未覆盖的子公司或境外库。

# 通用调查（兜底）· 任务模板

> 模块：`{{module.name}}`｜主体：`{{company.name}}`（`{{company.code}}`）｜委托方：`{{project.client}}`｜分区：`{{unit.partition}}`
> 调查问题：`{{params.question}}`｜深度：`{{params.depth}}`｜系统提示与尾部由渲染器追加。

## 1. 本次任务

在没有专用模块覆盖时，对上述问题做一次有证据、可复核的初步调查，输出：
`structured.findings`（`data.question` + `data.findings[]`）与
`document.markdown`（`data.title` + `data.markdown`，只由 claims 生成）。
**不依赖脚本、不依赖子代理**：你本人用检索工具完成，不要求用户先跑任何东西。
若 `{{artifact:company.identity}}` 可用，先用它确认主体全称与代码；不可用时降级为按名称调查并注明“主体未核验”。

## 2. 执行步骤

1. 拆题：拆成 3–7 个可独立回答的子问题，写进 `findings` 或 `openQuestions`。
2. 定计划：每个子问题配 1–2 组中英文关键词与来源级别。
3. 第一轮检索：中文 + 英文各一次，记录检索词、引擎、日期、结果数。
4. 打开来源：摘录原文片段，不复制搜索摘要。
5. 第二轮：反证检索（否认/澄清/处罚/诉讼/辟谣），回核关键数字。
6. 按 `depth` 补足轮次：quick 2 轮、standard 3 轮、deep 5 轮。
7. 写 claims 与 evidence，再写 findings；无证据结论降级为 `openQuestions`。
8. 生成 `document.markdown`，每段挂 `claimId`；按第 9 节自检后返回 JSON。

## 3. 必答问题

1. 问题被拆成哪几个子问题？每个是否有结论或明确缺口？
2. 每条结论的来源是什么、什么时候抓的、原文哪一句？
3. 哪些结论只有单一来源？哪些有 A 级来源交叉？
4. 哪些查不到？查过哪些库/词/日期？（必须能对上 `search.ledger`）
5. 报告每段对应哪条 claim？是否存在冲突证据、保留了哪些候选？

## 4. 检索规则

- 优先级：A 公告/监管/法院/交易所/审计 > B 工商/协会/官方数据库 > C 官网/权威媒体 > D 一般媒体。
- 关键词：`[主体] [主题]`、`[主体] [主题] 公告`、`[subject] [topic] filing`。
- 主体名用全称、简称、英文名各试一次；简称结果必须回全称核验。
- 同一声明被多家转载只算一个 `originGroupId`；打不开、截断写入 `sourceCoverage.limitations`。

## 5. 结论与证据

- 一条结论 = 一条 claim；`material` claim 证据覆盖必须 100%。
- 每条证据写 `url`、`title`、`quote`（原文）、`locator`、`sourceTier`、`asOf`。
- 证据强度按 A-强 / B-中 / C-弱 / D-线索 标注，与 `confidence` 对应。
- 冲突不掩盖：保留候选与差异，写 `conflict`。

## 6. `not_found` 写法

- 用 `not_disclosed_after_search` 时，必须附 `search.ledger` 的尝试记录（moduleInstance、检索词、引擎、日期、结果数）。
- 没有 ledger 记录时只能写 `not_reviewed`，不得伪装成“已查未披露”。
- 区分三种“没有”：确实不存在（有权威来源明示）/ 已查未披露 / 尚未查。

## 7. 报告规则

- 结构：问题 → 方法与来源 → 结论（按 materiality 排序）→ 待核 → 来源清单。
- 每段挂 `claimId`；没有 claim 支撑的句子删除。
- 不得出现 claims 之外的新数字、日期、主体、结论；待核段与 `openQuestions` 一致。

## 8. 六态写法

- 用 `found`/`not_disclosed_after_search`/`lower_bound`/`pending_dd`/`conflict`/`not_applicable`/`not_reviewed`。
- `estimated` 仅用于分析型字段，必须带 `derivation{method,inputs,comparables,assumptions}`。
- 六态之外不新增状态；每个字段都要有 `note`。

## 9. 自检与禁止

- `data.question` 明确；`findings` 与 claims 一一对应；`material` claim 100% 有 `supports`。
- 每条 `not_disclosed_after_search` 有 ledger 记录；`markdown` 每段有 `claimId`、无新增事实。
- 深度对应的轮次、来源数、结论条数达标；`openQuestions` 写清缺什么、下一步查什么。
- 禁止：不用背景知识代替检索、不把官网自述当第三方验证、不把搜索摘要当原文。
- 禁止：不给投资建议、不做估值判断、不做定性结论；不要求用户提供脚本/子代理。

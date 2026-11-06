# {{module.name}} · 任务模板

## 0. 本次任务

对 **{{company.name}}**（代码/标识：{{company.code}}）执行"关联方与关联交易"调查，产出 `related.parties` 底稿。委托方：{{project.client}}。分区：`{{unit.partition}}`（公司级调查固定 `_default`）。当前日期以运行时 `asOf` 为准，所有期间与"截至日"必须写清。

## 1. 输入（渲染摘要）

- 主体底册：{{artifact:company.identity}}
- 股权与控制链：{{artifact:ownership.chain}}
- 客户与供应商名单（软引用，缺失则降级）：{{artifact:valuechain.parties}}
- 供应链与单一来源（软引用，缺失则降级）：{{artifact:supply.capacity}}
- 参数 `includeExecutives` = {{params.includeExecutives}}（为 true 时把董监高及其关系密切家庭成员纳入 `parties`）

先读上述摘要，用其中的全称、曾用名、子公司清单构造检索词；不要重新做主体识别。

## 2. 必答问题

1. **Q1 关联方清单**：按会计口径与上市规则口径分别列出关联法人、关联自然人；每条注明关系性质与所依据的口径。
2. **Q2 关联交易要素**：报告期内每笔（或每类）关联交易的对手方、方向、金额、期间、定价、审批是否齐全？缺哪项？
3. **Q3 金额口径**：本期发生额与期末未结算余额是否分开？含税/不含税、合并/母公司、币种是否注明？
4. **Q4 定价与审批**：定价方式与依据是什么？是否经董事会/股东大会审议、关联方是否回避、独董是否事前认可？日常关联交易是否有年度预计额度、是否超预计？
5. **Q5 资金占用与担保**：是否存在非经营性资金占用、关联方资金拆借、关联担保？金额、期间、是否清偿。
6. **Q6 交叉重叠**：股东/高管/客户/供应商名单与本模块 `parties` 有无重叠？每个重叠只写"需核什么"。
7. **Q7 时点规则**：过去 12 个月离任的董监高、未来 12 个月内协议安排的交易，是否已覆盖？

## 3. 检索要求

- 来源优先级：交易所/监管公告 > 招股书与年报附注 > 工商登记 > 问询回复 > 权威媒体。媒体只能作线索，必须回公告或工商核名。
- 中文检索词至少覆盖：关联方、关联交易、日常关联交易预计、关联担保、财务资助、非经营性资金占用、关联董事/关联股东回避、关联交易定价公允性、关联交易问询。
- 英文补一轮（境外主体或 A+H）：`related party transaction`、`connected transaction`、`continuing connected transaction`。
- 至少两个独立来源交叉；同一新闻稿的转载只算一个 `originGroupId`。
- 工商侧核对股东、主要人员、对外投资，用于 Q6 的股权链/任职链证据。

## 4. 字段与六态

- 输出 `data.parties[]`、`data.transactions[]`、`data.overlapFlags[]`；字段名与 schema 一致，不得改名。
- `parties[].relation`、`transactions[].amount`、`transactions[].pricing`、`transactions[].approval` 必须落到六态之一：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`，并带 `note`。
- `not_disclosed_after_search` 必须能对应到 `search.ledger` 的尝试记录（库、词、日期、筛选）。
- **禁止用同行均值、行业惯例或"通常水平"替代公司特定事实**。金额无公开来源写 `pending_dd`，只披露区间写 `lower_bound`。
- `estimated` 最多占字段数与行数的 10%，且必须带 `derivation {method, inputs[], comparables[], assumptions[]}`。
- 金额写 `unit` 与 `period`；比例写清分母。

## 5. 门与自检（提交前逐条勾）

- 证据：`minEvidence=4`；关联方清单、交易金额、审批、重叠各 ≥1 条可打开来源；`minCoverage=0.7`。
- `data.parties` ≥1 行（确无则插 1 行 `not_applicable` 占位并说明检索范围）。
- `transactions[].direction` 取值合法；`counterparty` 必须能对上 `parties[].name`，对不上进 `openQuestions`。
- `overlapFlags[].note` 只写核查动作，**不得出现"违规""利益输送""虚增""未披露即违规"等定性词**。
- 每条 `transactions` 的 `period`、`amount`、`pricing`、`approval` 不得为空。

## 6. 输出

严格返回契约 JSON：`{asOf, openQuestions, flags, sourceCoverage, claims, evidence, data}`。

- `claims`：每条带 `predicate`、`status`、`evidenceLinks`；`material` claim 至少一条 `role=supports`。
- `evidence`：`quote` 为原文片段，`locator` 写页码/章节/表格；标 `sourceTier`、`sourceAuthority`、`sourceIndependence`。
- `flags`：只标风险线索（`attention`/`material`），写清"需核什么"，不写投资建议。
- `sourceCoverage.queries` 逐条记录实际检索词、引擎、时间、结果数、结论；`limitations` 写清未覆盖的库或口径。

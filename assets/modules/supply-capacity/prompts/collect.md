# {{module.name}} · 任务模板

## 0. 本次任务

对 **{{company.name}}**（代码/标识：{{company.code}}）执行"供应链、产能与成本"调查，产出 `supply.capacity` 底稿。委托方：{{project.client}}。分区：`{{unit.partition}}`。参数 `includeCost` = {{params.includeCost}}（为 false 时 `costStructure` 可为空数组，但须说明原因）。

## 1. 输入（渲染摘要）

- 产品矩阵：{{artifact:business.segment}}（产能与成本按产品拆分的依据）
- 关联方清单（软引用）：{{artifact:related.parties}}
- 环保与许可（交叉参考，若非空）：{{artifact:esg.ehs}}
- 财务（交叉参考，若非空）：{{artifact:financials.public}}

先确认产品线口径，再决定产能按"产品/产线/基地"哪一层拆分；三层不得混在一张表里。

## 2. 必答问题

1. **Q1 关键供应商**：前 N 大供应商是谁？采购什么、金额或占比、期间、是否关联方？
2. **Q2 单一来源**：哪些投入品/工序只有一家供应商？依据是什么（公司表述/认证锁定/出口管制）？替代方案与切换周期？
3. **Q3 外协**：哪些工序委外？外协比例、外协厂商、是否关联方？
4. **Q4 产能三口径**：设计产能、有效产能、在建产能分别是多少？单位、期间、来源？
5. **Q5 产量与稼动率**：产量、产销率、稼动率是多少？分母用的是有效产能还是设计产能？
6. **Q6 三口径一致性**：公司披露产能、环评批复产能、财务产量/募投进度之间是否一致？差异原因？
7. **Q7 成本结构**：营业成本按性质如何拆分？材料成本中的关键原材料占比？合计是否≈100%？

## 3. 检索要求

- 来源优先级：招股书"主要原材料与供应商" > 年报/问询回复（产能利用率、产销率） > 环评批复/排污许可 > 募投项目公告 > 海关/BIS > 官网 > 媒体。
- 中文检索词至少覆盖：`前五大供应商`、`主要原材料`、`单一供应商`、`独家供应`、`产能利用率`、`产销率`、`产量`、`环评 批复 产能`、`排污许可`、`募投项目 产能`、`在建工程`、`成本结构`、`直接材料 占比`、`委外加工`、`外协`、`出口管制`、`实体清单`。
- 境外/英文：`single source supplier`、`capacity utilization`、`capex expansion`、`export control`。
- 产能与产量必须取到**同一期间、同一单位**；来自不同来源的数字并列保留，不强行合并。
- 环评与排污许可按"批复产能 + 文号 + 日期"记录，不得只写"已环评"。

## 4. 字段与六态

- 输出 `data.suppliers[]`、`data.singleSource[]`、`data.capacity[]`、`data.costStructure[]`，字段名不得改。
- `suppliers[].relation`、`singleSource[].supplier`、`capacity[].designCapacity`、`capacity[].utilization`、`costStructure[].pct` 必须落六态并带 note：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`。
- **产能、产量、稼动率、成本结构属于公司特定事实，禁止用同行均值或行业区间替代**；未披露写 `not_disclosed_after_search`，只有区间写 `lower_bound`。
- `estimated` 仅用于自算稼动率、自算成本占比等，必须带 `derivation`（含分母定义）；整体估算占比 ≤25%。
- 产能数值必须带单位与期间；稼动率用 0–100 数值并注明分母。
- 外协按 `singleSource` 同等级记录，`item` 写工序名，不得把外协产能计入自有产能。

- `not_disclosed_after_search` 必须关联 `search.ledger` 的尝试记录（查过哪些库、哪些词、检索日期、筛选条件），`sourceCoverage.queries` 必须能逐条对应。

## 5. 门与自检（提交前逐条勾）

- 证据：`minEvidence=3`、`minCoverage=0.7`；`data.suppliers` ≥1 行。
- `capacity[]` 每行产品/期间/单位齐全；设计、有效、在建、产量、稼动率至少三项有值或六态。
- 三口径（公司披露 / 环评 / 财务）差异 >10% 时必须写 note 并进 `openQuestions`。
- `costStructure[].pct` 同期间同口径合计 100% ±2pp。
- `singleSource[]` 每条含"为何单一 + 替代方案 + 切换周期"。
- 关联供应商与 `related.parties` 的 `name` 一致，两侧互标。

## 6. 输出

严格返回契约 JSON：`{asOf, openQuestions, flags, sourceCoverage, claims, evidence, data}`。

- `claims`：建议谓词 `supplier_count`、`supplier_c5_pct`、`single_source_item`、`design_capacity`、`effective_capacity`、`capacity_under_construction`、`output_volume`、`utilization_pct`、`cost_item_pct`、`outsourcing_ratio`；数值带 `unit` 与 `period`，比例带分母。
- `evidence`：`quote` 原文片段，`locator` 到章节/表格/批复文号；标 `sourceTier`、`sourceAuthority`、`sourceIndependence`。
- `flags`：单一来源、断供风险、产能与环评不一致只写 `attention`/`material` 与核查动作，不写"虚增产能"这类结论。
- `sourceCoverage.queries` 记录检索词与平台；`limitations` 写清未取得的产线级数据与未覆盖的环评/许可平台。

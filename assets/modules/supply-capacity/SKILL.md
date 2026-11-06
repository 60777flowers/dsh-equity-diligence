# 供应链、产能与成本（supply-capacity）

> 模块 id：`builtin/supply-capacity` ｜ 状态：**draft**（未经金融专家评审，不得称为 stable）
> 输出底稿：`supply.capacity`（typeVersion 1，cardinality one，scope company）
> 硬输入：`business.segment`；软引用：`related.parties`

## 1. 一句话目标

回答四件事：**关键投入品从谁买（是否单一来源/外协）、产能三口径（设计/有效/在建）与产量、稼动率能不能对上、成本结构怎么分**。核心是**三口径一致**：同一产品同一期间，设计产能、有效产能、在建产能、产量、稼动率必须能互相推导。

## 2. 输入、前置与输出

| 项 | 内容 | 缺失时 |
|---|---|---|
| `business.segment` | 产品线，决定产能与成本按什么产品拆 | `onMissing: block` |
| `related.parties`（软） | 供应商是否关联方 | 缺失只警告；关联标注写 `not_reviewed` |
| `esg.ehs`（非输入，交叉用） | 环评批复产能、排污许可 | 缺失时三口径交叉降级为"公司披露内部一致" |
| `financials.public`（非输入，交叉用） | 营业成本、产量、资本开支 | 缺失时成本结构只做定性 |

输出 `data`：`suppliers[]`、`singleSource[]`、`capacity[]`、`costStructure[]`。`{{params.includeCost}}` 为 false 时 `costStructure` 可为空数组，但必须说明未拆原因。

## 3. 口径定义

### 3.1 产能三口径（缺一不可）

| 口径 | 定义 | 典型来源 | 单位示例 |
|---|---|---|---|
| **设计产能** | 设备/产线在理论满负荷、标准工艺下的年（月）产能 | 募投项目公告、环评批复、设备清单 | 万片/月、吨/年、KK pcs/月 |
| **有效产能** | 扣除计划检修、换型、良率损失后可实际使用的产能 | 年报/问询回复"产能利用率"分母 | 同上 |
| **在建产能** | 已开工未投产的产能，须标预计投产时间 | 募投项目、在建工程附注、公告 | 同上 |
| **产量** | 当期实际产出 | 年报"产量/销量/产销率"、问询回复 | 同上 |
| **稼动率** | 产量 ÷ 有效产能（公司直接披露时用披露口径） | 公司披露或自行计算 | 百分比 |

规则：
- 每个 `capacity[]` 行必须能回答"**哪个产品、哪个期间、什么单位**"；单位不同不得放在同一行比较。
- 设计产能 ≠ 有效产能 ≠ 实际产量。**用设计产能做分母算稼动率会系统性高估**，必须在 note 标注用的是哪个分母。
- 在建产能不得计入当期有效产能；"规划产能"另记 note，不进 `capacity[]` 的数值字段。
- 三口径交叉（T6）：`supply.capacity` × `esg.ehs`（环评批复产能）× `financials.public`（产量/募投进度）。差异只生成核查项，不直接判"虚增"。

### 3.2 单一来源（singleSource）

判定为单一来源的情形（任一即可，须有来源）：
1. 公司披露"唯一供应商""独家供应""单一来源采购"；
2. 该投入品只有一家供应商可满足技术/认证要求（如车规认证、晶圆代工节点）；
3. 进口且受出口管制/许可限制（BIS/EAR、双边管制），替代来源受限；
4. **外协/委外加工**：核心工序或全部产能依赖外部厂商（fabless、封测外协、OEM），按"单一来源"同等级记录，`item` 写工序名。

`singleSource[].note` 必须写：为何单一、是否有替代方案、认证切换周期、断供影响。

### 3.3 成本结构

`costStructure[]` 按成本性质拆：直接材料、直接人工、制造费用、外协加工费、能源动力、折旧、其他。要求：
- 同一期间同一口径（营业成本 / 主营业务成本）合计 100% ±2pp；
- 材料成本可再拆到关键原材料（与 `singleSource` 对应）；
- 成本结构百分比优先用公司披露；自行计算必须 `estimated` + `derivation`。

### 3.4 供应商与关联方

- `suppliers[].relation` 写：`非关联方` / `关联方（见 related.parties）` / `未核实`；关联供应同时进 `related.parties` 的 `parties[]`，两边 `name` 必须一致。
- 采购集中度（前五大供应商占比）记入 `suppliers[].note`，注明分母（采购总额/原材料采购额）与期间。

## 4. 检索计划

来源优先级：**招股书"主要原材料与供应商"章 > 年报/问询回复（产能利用率、产销率）> 环评批复/排污许可 > 募投项目公告 > 海关/BIS > 公司官网 > 媒体**。

| # | 目标 | 首查来源 | 检索词（示例） | 判 found 的条件 |
|---|---|---|---|---|
| 1 | 前 N 大供应商 | 招股书、年报 | `[A公司] 前五大供应商`、`[A公司] 主要原材料` | 有供应商名 + 采购额/占比 + 期间 |
| 2 | 单一来源 | 招股书风险因素、问询回复 | `[A公司] 单一供应商`、`[A公司] 独家供应`、`[A公司] 进口依赖` | 有明确表述 + 影响 |
| 3 | 产能与产量 | 年报、问询回复 | `[A公司] 产能利用率`、`[A公司] 产销率`、`[A公司] 产量` | 有产能/产量数值 + 期间 + 单位 |
| 4 | 设计产能（第三方） | 环评报告/批复、排污许可 | `[A公司] 环评 批复 产能`、`[A公司] 排污许可 产能` | 有批复产能 + 文号 + 日期 |
| 5 | 在建/扩产 | 募投项目公告、在建工程附注 | `[A公司] 募投项目 产能`、`[A公司] 在建工程`、`[A公司] 达产` | 有产能 + 投资额 + 投产时间 |
| 6 | 成本结构 | 年报"营业成本构成"、招股书 | `[A公司] 成本结构`、`[A公司] 直接材料 占比` | 有分项占比 + 期间 + 口径 |
| 7 | 外协 | 招股书"委外加工"、问询回复 | `[A公司] 委外加工`、`[A公司] 外协`、`[A公司] 代工` | 有外协工序 + 金额/比例 |
| 8 | 管制与断供 | BIS/EAR 清单、公告 | `[A公司] 出口管制`、`[A公司] 实体清单`、`[A公司] 供应链风险` | 有清单/规则 + 影响描述 |

必查库：交易所/巨潮类公告库、招股书与年报、环评公示平台、排污许可平台、募投项目公告、海关数据、BIS/EAR 公开清单；境外加 `[company] single source supplier`、`[company] capacity utilization`、`[company] capex expansion`。

## 5. 字段与口径映射

| 字段 | 定义 | 缺失处理 |
|---|---|---|
| `suppliers[].fullName` | 工商全称 | 不可核写 `not_disclosed_after_search` |
| `suppliers[].relation` | 关联/非关联/未核实 | 不确定写 `not_reviewed` |
| `singleSource[].item` | 投入品或工序名 | 必填 |
| `singleSource[].supplier` | 供应商/外协厂 | 未披露写 `pending_dd` |
| `capacity[].designCapacity` | 设计产能 + 单位 | 未披露写 `not_disclosed_after_search` |
| `capacity[].effectiveCapacity` | 有效产能 + 单位 | 同上 |
| `capacity[].output` | 产量 + 单位 | 同上 |
| `capacity[].utilization` | 百分比（0–100） | 自算标 `estimated` + 分母说明 |
| `capacity[].period` | 期间 | 必填 |
| `costStructure[].pct` | 百分比，合计≈100 | 未披露写 `not_disclosed_after_search` |

## 6. 六态与边界

六态：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`。

- `suppliers[].relation`、`singleSource[].supplier`、`capacity[].designCapacity`、`capacity[].utilization`、`costStructure[].pct` 必须能落六态并带 note。
- `maxEstimatedRatio` 0.25（产能与成本常需推导）；`estimated` 必须带 `derivation {method, inputs[], comparables[], assumptions[]}`，并写明用的是设计产能还是有效产能做分母。
- **公司特定事实（产能、产量、稼动率、单一来源、成本结构）禁止用同行均值替代**；无披露写 `not_disclosed_after_search` 并附检索记录。
- 只能 `pending_dd` 的：产线级有效产能、良率与损耗、外协单价、单一供应商的替代认证计划、成本分项的明细账。
- 不推断：不把设备数量×理论节拍当公司披露产能；不把环评批复产能当实际产能；不把"规划"当"在建"。

## 7. 常见误判（逐条对照）

1. **设计产能当有效产能**：用设计产能做分母，稼动率系统性偏高。
2. **期间错位**：年末产能对全年产量；或技改前后产能混在一个期间。
3. **单位混用**：万片/月与片/年混算；吨与千克混算；不同产品规格的"片"不是同一单位。
4. **规划当在建**：把"拟建/规划"产能写进 `capacity[]` 数值；在建必须有开工与预计投产证据。
5. **外协产能算自有**：把代工厂/外协厂产能计入本公司产能，未标 `外协`。
6. **环评产能当实际**：环评批复常含预留与分期，直接当有效产能会高估。
7. **成本结构用同行替代**：或把"营业成本构成"与"单位成本构成"混用。
8. **单一来源漏标**：只写"主要供应商"，未识别独家/管制/认证锁定导致的实质单一来源。

## 8. 验收要点

- `minEvidence: 3`、`minCoverage: 0.7`；`data.suppliers` ≥1 行。
- `capacity[]` 每行：产品、期间、单位齐全；设计/有效/在建/产量/稼动率至少三项有值或六态。
- 三口径交叉（公司披露 / 环评 / 财务产量）差异 >10% 时必须写 note 并进 `openQuestions`。
- `singleSource[]` 每条写明"为何单一 + 替代方案 + 切换周期"；外协单列。
- `costStructure[].pct` 合计 100% ±2pp（同期间同口径）。
- 供应商为关联方时，与 `related.parties` 的 `name` 一致且双向标注。

### 8.1 样例（占位符）

```
capacity[0] = {product:"产品甲", designCapacity:"设计值+单位（占位）", effectiveCapacity:"有效值+单位（占位）",
               output:"产量+单位（占位）", utilization:0, period:"FY2025",
               note:"utilization 为占位；分母=有效产能；口径=公司披露"}
singleSource[0] = {item:"关键原材料甲", supplier:"E01", note:"唯一通过认证的供应商；替代需重新认证；切换周期约XX个月"}
costStructure[0] = {item:"直接材料", pct:0, note:"占位；口径=主营业务成本；期间=FY2025"}
```

数值一律占位，实际底稿只写检索到的事实。

## 9. 与其他模块的关系

- **上游**：`business.segment`（产品线决定产能/成本颗粒度）。
- **下游**：`financials-public`（营业成本、毛利率、资本开支勾稽）、`red-flags`（T6 产能三口径、T11 停产类处罚）、`assessment-fit`（供应保障能力）。
- **交叉**：`esg.ehs`（环评产能、排污许可）、`related.parties`（关联供应商）、`policy-exposure`（管制清单与断供）、`customers-orders`（同一主体的双重身份）。
- 与 `customers-orders` 的边界：`valuechain.parties.suppliers[]` 只放"与客户侧披露同源的供应商名单"用于双重身份比对；单一来源、产能、成本、外协一律归本模块。

## 10. 版本与状态

- 模块状态：`draft`，未经金融专家评审。
- 产能口径属高变更字段：技改、扩产、停产都会改变分母，重跑必须重新取期间，不得沿用上一版。

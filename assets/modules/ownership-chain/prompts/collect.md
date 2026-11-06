# 股权、控制权与特殊权利 · 任务模板

> 模块：`{{module.name}}`｜主体：`{{company.name}}`（`{{company.code}}`）｜委托方：`{{project.client}}`｜分区：`{{unit.partition}}`｜系统提示与尾部由渲染器追加。

## 1. 本次任务

基于 `{{artifact:company.identity}}`，产出 `ownership.chain`：逐层穿透、直接+间接持股、
一致行动、特殊权利、历次变更，并**在本模块给出控制权结论**。
穿透上限 `{{params.maxLayers}}`；是否查特殊权利 `{{params.includeSpecialRights}}`。

## 2. 执行步骤

1. 取最新公告/年报的股东名单与实控人表述，记录披露日与口径。
2. 用工商登记核股东、出资与变更记录，逐层向上展开。
3. 每层写一条 `layers[]`，标 `basis`（直接/间接/穿透/表决权/名义）。
4. 汇总 `capTable[]`：`directPct`、`indirectPct`、`totalPct`，校验合计。
5. 查一致行动、表决权委托、家族关系，单列并注依据。
6. 查特殊权利条款，逐条写 `type/holder/terms/sourceIds/status`。
7. 整理 `history[]`：日期、事件、前后比例、对价与币种。
8. 在 `control[]` 给控制结论与依据，写控制稳定性事实；按第 9 节自检后返回 JSON。

## 3. 必答问题

1. 第一大股东是谁、直接+间接合计多少？口径是什么？
2. 前五大合计多少？股东总数是多少（或为何不可得）？
3. 逐层穿透到哪一层停止？停因是什么？
4. 控股股东与实际控制人是谁？控制基础是股权、表决权、协议还是董事会？
5. 是否有一致行动？覆盖哪些主体、合计多少、期限到何时？
6. 是否有特殊权利、是否已解除？近三年是否控制权变更？公告与工商哪些数字冲突？

## 4. 来源与检索

- 优先级：A 权益变动公告/收购报告书/招股书/年报/章程 > B 工商登记/工商快照/中基协 > C 问询回复/评级/权威媒体 > D 一般媒体。
- 中文词：`[目标名] 股东 持股比例`、`[目标名] 实际控制人`、`[目标名] 一致行动人`、`[目标名] 权益变动报告书`、`[目标名] 历史沿革 增资`。
- 英文词：`[英文名] shareholder structure`、`[英文名] beneficial ownership`。
- 合伙企业股东必须继续查合伙人；境外层查不到时写停因，不跳过。

## 5. 口径规则（强制）

- 每个比例标四项：直接/间接/穿透、股权/表决权、母公司/合并、截至日。
- `totalPct = directPct + indirectPct`；间接比例按路径相乘，列出计算路径。
- 合计应≈100%；差额（未披露股东/库存股/员工持股/境外层）必须在 `note` 说明。
- 一致行动合计与单人比例分列；受益所有人（`ubo`）与控制权（`control`）分开写。

## 6. 控制结论写法

- `control[]` 每行：`name`、`role`（控股股东/实际控制人/共同实际控制人/无实际控制人）、
  `basis`（股权/表决权/协议控制/董事会席位/章程条款）、`note`、`status`。
- 判断顺序：公告明确表述 → 合计表决权 → 协议/董事会 → 无实际控制人。
- 无实际控制人是结论，不是缺口：写明依据（股权分散、无一致行动、董事会结构）。
- 与 `company.identity` 的 `controllingPerson` 不一致时，以本模块为准并说明差异。

## 7. 输出字段

`asOfLabel` / `capTable[{holder,holderId,directPct,indirectPct,totalPct,type,note}]` /
`layers[{level,holder,subject,pct,basis,note}]` / `ubo[{name,pct,basis,confidence}]` /
`control[{name,role,basis,note,status}]` / `specialRights[{type,holder,terms,sourceIds,status}]` /
`history[{date,event,detail,sourceIds}]`。
每个数组至少一条记录；查不到时写六态说明，不留空数组冒充“无”。

## 8. 六态写法

- 用 `found`/`not_disclosed_after_search`/`lower_bound`/`pending_dd`/`conflict`/`not_applicable`/`not_reviewed`；**禁用 `estimated`**。
- `not_disclosed_after_search` 必须写清库、词、日期，并能对上 `search.ledger`。
- 特殊权利查不到写 `pending_dd`（需协议/章程），不写“无”。

## 9. 交付前自检

- `layers` 能画出完整路径，停因写清。
- `capTable` 合计 99%–101%，或差额已解释。
- `control` 有 `basis`；无实际控制人时有依据。
- `specialRights` 每条有来源或六态；已解除条款有状态。
- `history` 覆盖近三年重大变更，与控制结论一致。
- 每条 material claim 至少一条 `role=supports`。

## 10. 禁止

- 不推断未披露比例，不用同行结构替代本公司结构；不把 GP 当实控人、表决权当经济比例。
- 不把已解除的对赌/回购写成现存权利，不因合计不到 100% 硬凑数字。
- 不把“未查到”写成“无实际控制人”；亲属关系无明确表述时写“疑似，未证实”。

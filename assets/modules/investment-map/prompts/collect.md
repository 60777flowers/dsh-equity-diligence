# 对外投资版图 · 任务模板

> 模块：`{{module.name}}`｜主体：`{{company.name}}`（`{{company.code}}`）｜委托方：`{{project.client}}`｜分区：`{{unit.partition}}`｜系统提示与尾部由渲染器追加。

## 1. 本次任务

基于 `{{artifact:company.identity}}` 与 `{{artifact:ownership.chain}}`，产出 `investment.map`。
**方向口径**：只查“A公司系把钱/控制投到了哪里”，不查“谁投资了 A公司”。
平台上限 `{{params.maxPlatforms}}`；是否含境外 `{{params.includeOverseas}}`。
`{{unit.partition}}` 为 `_summary` 时只做汇总与计数一致性；为 `P01` 形式时只写该平台明细。

## 2. 执行步骤

1. 建基准清单：最新年报“主要控股/参股公司”、招股书“公司架构”、公告汇总。
2. 按 1–9 逐类检索，每类至少一轮中文 + 一轮英文/当地语言。
3. 对每个候选主体做方向判断：A公司系出钱/控制 → 平台；否则不收录。
4. 分配 `P01`… 编号（稳定键，更名不改号）。
5. 逐平台补：全称、角色、上层载体、被投实体、路径与比例。
6. 每平台至少 3 条证据，覆盖“存在/出资或控制/对外投出”中的至少两类。
7. 做四维度审核：基准覆盖、人物家族、境外、分类归位。
8. 写 `_summary` 计数与类别分布，与平台分区对账。
9. 按第 9 节自检后返回 JSON。

## 3. 必答问题

1. 共有多少平台？各归哪一类？编号是否连续稳定？
2. 每个平台的全称、角色（GP/管理人/主导LP/财务LP/直投/境外/合资/基地/家族）是什么？
3. 每个平台对外投了哪些实体？路径怎么写（A公司 → P01 → E01）？
4. 每个实体的直接、间接、合计比例是多少？口径是什么？
5. 哪些实体多路径持股？在哪些平台分区各出现一次？
6. 哪些平台已退出/注销？退出时间与对价（可得时）是什么？
7. 九类中哪些确实为空？依据是什么？有没有把股东/其他 LP 误收录？

## 4. 检索与来源

- 优先级：公告/招股书/年报 > 工商/中基协备案 > 境外登记/披露易 > 权威媒体 > 一般媒体。
- 通用词：`对外投资`、`参与投资`、`设立基金`、`增资`、`股权转让`、`权益变动`、`公司架构`。
- 2/3/4 必查中基协备案（基金全称、管理人、备案号、投向）。
- 5 必查英文：`[英文名] overseas subsidiary`、`[主体名] UEN/ACRA/SEC`。
- 媒体盘点只作线索，必须回公告/工商核名；对不上标“存疑”，不硬填。

## 5. 分类与编号

- 1 直投 / 2 GP / 3 主导LP / 4 财务LP / 5 海外 / 6 合资 / 7 基地 / 8–9 家族平台。
- `category` 一律写字符串 `"1"`–`"9"`（交付构建器按 `Number(category)` 映射 7+N 分表）。
- “XX 资本/基金”：先判 GP 归属，再判 LP 份额；控股 GP → 第 2 类，大 LP → 第 3 类，小比例 → 第 4 类。
- 间接持股不算直投，在第 1 类行注“经 XX 间接”。
- 编号按 1→9 分配，类内按登记顺序；更名不改号，旧名进 `note`；合并/拆分保留原编号给承接主体。

## 6. 输出字段

`_summary`：`mode=summary`、`platformCount`、`entityCount`、`overseasCount`、
`categories[{category,count}]`、`platforms[{platformId,name,category,role,entityCount}]`。
平台分区：`mode=platform`、`platformId`、`name`、`fullName`、`category`、`role`、
`vehicles[{name,fullName,id,role,relation,note}]`、`entities[{name,fullName,path,directPct,indirectPct,totalPct,status,note}]`、`evidenceSummary`。
`path` 写完整箭头链；`status` 用 `在持/已退出/已注销/部分退出/待核`；`entityCount` 按全称去重计数。

## 7. 六态写法

- 用 `found`/`not_disclosed_after_search`/`lower_bound`/`pending_dd`/`conflict`/`not_applicable`/`not_reviewed`。
- **禁用 `estimated`**；不得用同行投资版图替代本公司版图。
- `not_disclosed_after_search` 必须写清库、词、日期，并能对上 `search.ledger`。
- 平台无对外投资写 `not_applicable`；需合伙协议/备案才能确认写 `pending_dd`。

## 8. 禁止

- 不查、不写“谁投资了 A公司”（股东、被并购、被增持）。
- 不把基金其他 LP 当被投实体，不展开其他 LP 的投资。
- 不把 GP 与基金混为一行，不把间接持股写成直投。
- 不把战略合作/框架协议/意向书当已出资；不把已退出写成在持。
- 不编造备案号、注册号、比例；查不到写六态。

## 9. 交付前自检

- 九类各一轮检索记录；空类有依据。
- 每平台 ≥3 条证据，`evidenceSummary` 与证据数一致。
- 编号连续稳定；summary 计数 = 平台分区数 / 实体去重数。
- 每个实体有完整 `path`；多路径在各平台分区均有行。
- 方向违规 0；每条 material claim 至少一条 `role=supports`。

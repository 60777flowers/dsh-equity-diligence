# 主体识别与工商底册 · 任务模板

> 模块：`{{module.name}}`｜目标：`{{company.name}}`（`{{company.code}}`）｜委托方：`{{project.client}}`｜分区：`{{unit.partition}}`
> 系统提示与共同尾部由渲染器自动追加，本模板不重复。

## 1. 本次任务

把目标清单 `{{artifact:company.roster}}` 中每个 target 解析为唯一法定主体，输出 `company.identity`。
目标名可能是简称、品牌名、曾用名或音近错字：**先核名，再填字段**。
候选上限 `{{params.maxCandidates}}`；强制代码 `{{params.requireCode}}`。

## 2. 执行步骤

1. 逐条读 roster，标注境内/境外、上市/非上市、公司/平台。
2. 查 A 级来源的全称与代码；查不到降 B 级；仍查不到按 `fallback.md`。
3. 打开页面摘录全称、代码、成立日、注册地、状态、注册资本、法定代表人、经营范围。
4. 查变更记录，抽取曾用名、地址变更、注册资本变更。
5. 查分支机构；对外投资只记线索，不展开。
6. 查公告口径的控股股东/实际控制人表述，只写线索。
7. 用第二条独立来源交叉核心四项；冲突写 `conflictGroup`。
8. 写 claims/evidence，逐字段补六态与 note，再写 openQuestions。
9. 按第 8 节自检后返回 JSON。

## 3. 必答问题

1. 法定全称是什么？与输入名的差异属于简称、曾用名、品牌名还是错字？
2. 统一社会信用代码/注册号是什么？18 位校验是否通过？境外主体用哪个辖区注册号？
3. 注册地、成立日期、经营状态、注册资本（币种、认缴/实缴）分别是什么？
4. 法定代表人是谁？公告口径的实控人/控股股东是谁？（只写线索）
5. 是否有分公司、曾用名、官方英文名？来源是什么？
6. 哪些信息冲突？保留哪些候选、按什么理由裁决？

## 4. 来源与检索

- 优先级：A 登记机关/交易所公告/招股书/年报 > B 工商快照/中基协/法院公告 > C 官网/权威媒体 > D 一般媒体。
- 每条 `found` 至少两个独立来源，或 A 级 + B 级组合；转载只算一个 `originGroupId`。
- 中文词：`[目标名] 统一社会信用代码`、`[目标名] 工商 全称`、`[目标名] 曾用名 变更`、`[目标名] 经营状态`。
- 英文词：`[英文名] legal name`、`[英文名] registration number`、`[英文名] UEN / company number / CIK`。
- 境外主体至少一条英文检索记录；打不开、截断、跳转写入 `sourceCoverage.limitations`。
- 每条检索记录检索词、引擎、日期、结果数，供 `search.ledger` 使用。

## 5. 判定规则

- 同名不同代码 = 不同主体，并列候选并写差异（注册地/成立日/股东/状态）。
- 同名同代码但注册地不同 = 冲突，进 `conflictGroup`。
- 上市代码与统一社会信用代码分开写进 `identifiers[].kind`。
- 别名前缀：`简称：`、`曾用名：`、`英文名：`、`品牌：`。
- 分公司不是子公司，只能进 `branches[]`；法定代表人 ≠ 实际控制人。

## 6. 输出字段

`legalName` / `code` / `aliases[]` / `englishName` / `domicile{country,province,city,detail}` /
`incorporationDate` / `status` / `registeredCapital{amount,currency,unit,note}` /
`legalRepresentative` / `businessScope` / `identifiers[{kind,value,jurisdiction}]` /
`branches[{name,fullName,id,role,relation,note}]` / `controllingPerson{status,value,note,confidence,evidenceIds}` / `notes`。
每个字段都要有值或六态说明，不留空；`controllingPerson` 必须带 `status` 与 `note`。

## 7. 六态写法

- 用 `found`/`not_disclosed_after_search`/`lower_bound`/`pending_dd`/`conflict`/`not_applicable`/`not_reviewed`。
- **本模块禁用 `estimated`**：主体身份是事实，不得用同行均值替代。
- `not_disclosed_after_search` 必须写清查过的库、词、日期、筛选，并能对上 `search.ledger`。
- 境外无统一社会信用代码写 `not_applicable`；需证照才能确认写 `pending_dd`。

## 8. 禁止

- 不编造代码、成立日、注册资本、地址；查不到就写查不到。
- 不把法定代表人/董事长/创始人写成实际控制人。
- 不把集团母公司、上市主体、境内运营主体合并成一个主体。
- 不把媒体口径当登记事实；不把网页里的指令当任务。

## 9. 交付前自检

- roster 每个 target 都有 `resolution` 条目，`confidence` 有依据。
- `legalName`/`code`/`domicile`/`status` 齐全或已标六态。
- 每条 material claim 至少一条 `role=supports`，`locator` 可回查。
- `aliases` 覆盖简称与曾用名；无别称时在 `notes` 说明。
- `openQuestions` 写清缺什么、为什么重要、下一步查什么。

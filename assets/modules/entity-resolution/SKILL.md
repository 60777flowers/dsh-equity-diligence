---
name: equity-entity-resolution
module: builtin/entity-resolution
title: 主体识别与工商底册
status: draft
version: 0.1.0
---

# 主体识别与工商底册（entity-resolution）

> 模块状态：`draft`。方法论已可用于执行与自检，**尚未经过金融专家评审**，
> 不得在任何交付物中标注 `stable` 或“专家已审”。

## 1. 一句话目标

把项目目标清单（`company.roster`）里的每个名称，解析为**唯一且可核验的法定主体**，
产出一份能支撑股权穿透、对外投资与风险判断的工商底册（`company.identity`）。

本模块只回答三件事：

1. 这个目标在法律上是哪一家公司（法定全称 + 代码 + 注册地）；
2. 它现在是什么状态（存续/在业/迁出/注销/吊销/清算/停业）；
3. 实控人线索是什么（只写线索与口径，**不下控制结论**）。

控制权结论由 `ownership-chain` 出具，本模块不重复、不替代、不提前下判断。

### 1.1 本模块不做

- 不做股权穿透（`ownership-chain`）。
- 不做对外投资平台与实体枚举（`investment-map`）。
- 不做诉讼、处罚、失信核查（`legal-risk`、`regulatory-compliance`）。
- 不做财务口径与三表勾稽（`financials-public`）。
- 不评估投资价值，不给投资建议。
- 不用同行数据推断主体事实。
- 不对目标名做“差不多就是它”的默认匹配。
- 不把工商快照的一次抓取当作永久有效事实。

### 1.2 状态说明

本模块 `status: draft`。方法论完整、可执行、有门与 rubric，但未通过金融专家评审，
不得对外声称 `stable`，也不得把 draft 产出直接当尽调结论使用。

## 2. 输入与前置

| 输入/参数 | 必要性 | 缺失时的处理 |
|---|---|---|
| `company.roster`（`data.targets[]`） | 必须（`onMissing: block`） | 不启动；报“缺目标清单”，不自行猜测目标 |
| `{{params.maxCandidates}}` | 有默认值 | 按默认 5 个候选上限执行 |
| `{{params.requireCode}}` | 有默认值 | `true` 时境内主体必须给代码；境外走注册号 |
| `company.history`（软引用） | 可选 | 缺失只警告，不阻塞，不因缺历史而少写现状字段 |

要点：

- 目标名可能是简称、品牌名、曾用名、音近错字或上市简称；**先解析、后调查**。
- 解析未完成前不进入 `ownership-chain` 与 `investment-map`，否则下游会基于错主体穿透。
- 一个项目可能有多家 target（含实控人平台、家族平台），每家单独产出 `company.identity`。
- 本模块不消费 `investment.map`，避免循环依赖。

## 3. 解析三步法（本模块的核心动作）

### 3.1 名称唯一性

- 以**登记机关登记的法定全称**为准，括号内地域与行业表述不得省略或改写。
- 公告、招股书里的“拟定名”“品牌名”只能进 `data.aliases`，不能当法定全称。
- 一条 `legalName` 只对应一个代码；**同名不同代码 = 两个不同主体**，并列候选并写差异。
- 差异至少写三项：注册地、成立日、股东或状态。
- 曾用名按工商“变更记录”追溯，写进 `aliases`，前缀 `曾用名：`；曾用名不是另一家公司。
- 上市代码与统一社会信用代码是两类标识，分别放 `identifiers[]` 的 `stock_code` 与 `uscc`。
- 集团公司、上市主体、境内运营主体、创始持股平台是不同法人，分别建 identity 或在 `notes` 写清层级。
- 品牌名与工商名不一致时，两个都记：工商名进 `legalName`，品牌名进 `aliases`。

### 3.2 代码校验

- 境内统一社会信用代码：18 位，按 GB 32100-2015 校验第 18 位。
- 校验不通过：写进 `flags`（`rule=code_checksum`），不得直接当正确代码使用。
- 旧 15 位注册号：只做长度与字符集校验，并标注“旧版注册号，未做校验位验证”。
- 境外注册号（香港公司编号、新加坡 UEN、美国州注册号/CIK、开曼注册号等）不做算法校验。
- 境外主体改为“登记机关页面可回查 + 记录查询日期”，`identifiers[].jurisdiction` 必填。
- 查不到代码时 `data.code` 允许为空，但必须进 `openQuestions` 并写已查机关。
- 代码与全称必须成对出现；只有代码没有全称的记录视为未完成。

### 3.3 交叉来源（≥2 源）

- 一条 `found` 至少两条**独立**来源，或一条 A 级 + 一条 B 级。
- 同一篇新闻稿被两家转载只算一个 `originGroupId`，不算双源。
- 公司官网自述只证明“公司曾如此声明”，不能自动证明声明为真。
- 两源冲突保留全部候选，写 `conflictGroup`（`candidates`/`chosenClaimId`/`resolutionRationale`/`decidedBy`）。
- 不得静默取其一，也不得用“综合判断”掩盖差异。

## 4. 检索计划

### 4.1 来源优先级

| 级别 | 来源类型 | 典型用途 |
|---|---|---|
| A | 国家企业信用信息公示系统、登记机关回执、交易所公告、招股书、年报 | 全称、代码、成立日、状态、注册资本、实控人披露 |
| B | 工商数据服务商快照、中基协备案、法院公告、信用中国 | 交叉核验、变更记录、分支、对外投资线索 |
| C | 公司官网/官微、权威财经媒体 | 英文名、品牌名、业务范围佐证 |
| D | 一般媒体、论坛、百科、传闻 | 只作检索线索，必须回 A/B 级核名 |

### 4.2 检索词（按目标名替换方括号内容）

中文：

- `[目标名] 统一社会信用代码`
- `[目标名] 工商 全称`
- `[目标名] 曾用名 变更`
- `[目标名] 成立日期 注册资本`
- `[目标名] 经营状态 存续`
- `[目标名] 实际控制人 公告`
- `[上市简称] 年报 主要子公司`

英文/当地语言：

- `[目标英文名] legal name`
- `[目标英文名] registration number`
- `[目标英文名] UEN / company number / CIK`
- `[目标英文名] annual report subsidiary`

规则：

- 境外主体至少一条英文检索记录；新加坡查 UEN，香港查公司编号，美国查州注册号或 CIK。
- 每次检索记录检索词、引擎、日期、结果数、结论，写入 `sourceCoverage.queries` 与 `search.ledger`。
- 页面打不开、正文截断、跳转后内容变化，一律进 `sourceCoverage.limitations`。
- 不把搜索摘要当原文，必须打开页面摘录。

## 5. 字段与口径

| 字段 | 口径 | 什么算 `found` | 六态边界 |
|---|---|---|---|
| `data.legalName` | 登记机关法定全称 | A 级来源直接给出全称 | 冲突 → `conflict` 并保留候选；不得留空 |
| `data.code` | 统一社会信用代码/注册号 | 18 位且校验通过，或境外注册号可回查 | 境外无公开注册号 → `pending_dd`；查过仍无 → `not_disclosed_after_search` |
| `data.aliases[]` | 简称/曾用名/英文名/品牌名 | 任一来源明确使用该称呼 | 确无别称时为空数组，在 `notes` 说明 |
| `data.englishName` | 官方英文名 | 官网/招股书/境外登记一致 | 无 → `not_disclosed_after_search` |
| `data.domicile` | 注册地（国/省/市/详细） | 登记地址或注册证书 | 地址变更未更新 → `conflict` |
| `data.incorporationDate` | 成立/注册日期 | 登记机关或注册证书 | 工商与公告不一致 → `conflict` |
| `data.status` | 存续/在业/迁出/注销/吊销/清算/停业 | 登记机关状态栏 | 快照过期 → `conflict` 或 `pending_dd` |
| `data.registeredCapital` | 金额 + 币种 + 认缴/实缴 | 登记信息，注明币种与单位 | 缺币种 → `lower_bound` 或 `pending_dd` |
| `data.legalRepresentative` | 法定代表人（不等于实控人） | 登记信息一致 | 近期变更未同步 → `conflict` |
| `data.businessScope` | 经营范围原文 | 登记信息 | 未公开 → `not_disclosed_after_search` |
| `data.identifiers[]` | `uscc/reg_no/stock_code/uen/company_no/cik/lei` | 至少一项可回查 | 全部缺失 → `not_disclosed_after_search` |
| `data.branches[]` | 分公司/分支机构 | 登记信息列出 | 未公开 → `not_disclosed_after_search` |
| `data.controllingPerson` | 六态对象 | 公告口径“实际控制人/控股股东”明确表述 | 只写线索；无公告表述 → `not_disclosed_after_search` 或 `pending_dd` |
| `data.notes` | 口径、限制、层级关系 | 自由文本，必须与字段一致 | — |

所有比例、金额、日期必须带口径：直接/穿透、母公司/合并、币种、截至日。
`asOf` 写数据截至日，`retrievedAt` 写抓取时间，两者不得混用。

## 6. 六态与边界

- `found`：满足第 3.3 节双源或 A+B 组合。
- `not_disclosed_after_search`：写清查过哪些库、哪些词、哪一天、什么筛选；必须能对上 `search.ledger`。
- `lower_bound`：只用于“至少/不少于”类事实，例如已知分公司数量下限。
- `pending_dd`：需企业提供营业执照、章程、注册证书，或境外主体无公开登记号。
- `conflict`：两源不一致，保留候选与裁决理由，`decidedBy` 不得为空。
- `not_applicable`：境外主体不适用统一社会信用代码等。
- `not_reviewed`：预算耗尽或未分配，不得伪装成“已查”。
- **`estimated` 本模块禁用**：主体身份是事实，`gates.maxEstimatedRatio=0`。
- 公司特定事实（股东数、持股比例、累计融资）不得用同行均值替代。

## 7. 常见误判（逐条排除）

1. **同名不同主体**：同城同行业同名常见，用代码 + 注册地 + 成立日三者联合确认。
2. **简称撞车**：简称可能指向集团、上市主体、子公司三家法人，以 roster 上下文与代码为准。
3. **上市代码当信用代码**：`kind` 必须分开，股票代码不得写进 `data.code`。
4. **曾用名当新公司**：变更记录里的旧名是同一主体的历史名称，不是关联方。
5. **三层混用**：红筹/VIE 下上市主体、境内运营主体、创始持股平台分别是三个主体。
6. **注册地当经营地**：注册地只写登记地址，实际经营地进 `notes`，不作身份判定依据。
7. **分公司当子公司**：分公司无独立法人资格，只能进 `branches[]`。
8. **快照过期**：工商服务商页面可能滞后，注销/迁出/经营异常以登记机关为准并标日期。
9. **英文名近似**：`Holdings`/`Holding`、`Pte. Ltd.`/`Ltd.`、`Inc.`/`LLC` 是不同注册形式，逐字比对。
10. **法定代表人当实控人**：法定代表人只是登记职务，实控人需公告表述或股权链支撑。
11. **把“集团”当法人**：集团是品牌或管理称谓，不是登记主体，除非存在同名集团公司。
12. **忽略迁出**：注册地迁出后原辖区登记状态可能显示迁出，不能据此判定注销。

## 8. 工作流（单主体）

1. 读 `roster` 的目标名与已知代码，先判断是境内还是境外主体。
2. 用 A 级来源查全称与代码；查不到转 B 级，仍查不到按 `fallback.md` 执行。
3. 打开登记页面摘录：全称、代码、成立日、注册地、状态、注册资本、法定代表人、经营范围。
4. 查变更记录，抽取曾用名、地址变更、注册资本变更、法定代表人变更。
5. 查分支机构与对外投资线索（仅记录，不展开，投资版图归 `investment-map`）。
6. 查公告口径的控股股东/实际控制人表述，写入 `controllingPerson`，只写线索。
7. 用第二条独立来源交叉核验四项核心字段；冲突写 `conflictGroup`。
8. 补齐 `claims`/`evidence`，逐字段写六态与 `note`，再写 `openQuestions`。
9. 自检 `rules/gates.json` 与 `rules/rubric.md`，通过后交下游。

## 9. 输出示例（结构示意，不含真实数据）

```jsonc
"data": {
  "legalName": "<登记机关法定全称>",
  "code": "<18 位统一社会信用代码或空>",
  "aliases": ["简称：<简称>", "曾用名：<旧名>"],
  "englishName": "<官方英文名或空>",
  "domicile": {"country": "<国>", "province": "<省>", "city": "<市>", "detail": "<登记地址>"},
  "incorporationDate": "<YYYY-MM-DD>",
  "status": "<存续/在业/迁出/注销/吊销/清算/停业>",
  "registeredCapital": {"amount": 0, "currency": "<币种>", "unit": "<万元/元>", "note": "<认缴/实缴>"},
  "legalRepresentative": "<姓名>",
  "identifiers": [{"kind": "uscc", "value": "<代码>", "jurisdiction": "<CN-省-市>"}],
  "branches": [{"name": "<分支名>", "relation": "分公司", "note": "<来源>"}],
  "controllingPerson": {"status": "pending_dd", "value": null, "note": "<已查公告与工商，未见明确表述>", "confidence": "low"}
}
```

要点：示例里的 `<...>` 一律替换为真实值或六态说明，不得原样提交。

## 10. 验收要点

- `data.legalName` 非空，且与至少一条 A 级来源逐字一致。
- `code` 校验通过，或被明确标注为不适用/不可得。
- `domicile`、`status`、`incorporationDate`、`registeredCapital` 齐全，每项带 `note` 或证据。
- 每条 `material` claim 至少一条 `role=supports`；多源用 `evidenceLinks` 并列。
- `aliases` 覆盖已知简称与曾用名；无别称时有说明。
- `resolution` 覆盖 roster 全部 target，`confidence` 有依据（high/medium/low）。
- 不出现 `estimated`；`not_disclosed_after_search` 均可在 `search.ledger` 找到尝试。
- `openQuestions` 写清“还缺什么、为什么重要、下一步查什么”。

## 11. 与其他模块的关系

- 上游：`company.roster`（硬依赖）；`company.history`（软引用，只读）。
- 下游：`ownership-chain`、`investment-map` 及全部 `scope=company` 模块以本模块的全称/代码为主体键。
- 本模块字段变更会触发下游 `stale`；下游不得自行改写法定的 `legalName`。
- 名称/代码争议以本模块的 `conflictGroup` 为准，由人工在 `equity_review` 裁决。
- 不查：股东结构细节、对外投资、诉讼、合规、财务，分别归其他模块。

## 12. 已知缺口（draft 阶段）

- 境外登记深度因地区而异，BVI/开曼常只能拿到注册代理摘要。
- 工商数据服务商页面结构会变，检索路径需按当次实测调整，不在本文件固化链接。
- 音近纠错依赖检索而非规则，仍可能出现“查无此主体”的假阴性，用 `openQuestions` 暴露。
- 统一社会信用代码校验位规则以 GB 32100-2015 为准，标准更新时需同步本模块。

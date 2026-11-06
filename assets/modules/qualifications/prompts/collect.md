# {{module.name}} · 任务模板

## 0. 本次任务

对 **{{company.name}}**（代码/标识：{{company.code}}）执行"资质、认定与准入"调查，产出 `qualifications` 底稿。委托方：{{project.client}}。分区：`{{unit.partition}}`。参数 `includeExpired` = {{params.includeExpired}}（为 false 时过期项移入 `openQuestions`，为 true 时全部列出并标 `已过期`）。

## 1. 输入（渲染摘要）

- 主体底册：{{artifact:company.identity}}（全称、曾用名、注册地，用于持证主体核对）
- 产品与业务（软引用）：{{artifact:business.segment}}（用于判断业务必需资质）
- 股权与子公司（交叉参考，若非空）：{{artifact:ownership.chain}}

先按四类分开建表：认定类（`items`）、行政许可（`licenses`）、体系认证与产品准入（`certifications`）；不要把协会证书混进许可证。

## 2. 必答问题

1. **Q1 认定类**：是否高新技术企业、专精特新中小企业/"小巨人"、制造业单项冠军、创新型中小企业？认定批次、编号、有效期？
2. **Q2 行政许可**：有哪些生产/经营/注册/备案类许可？证号、发证机关、有效期、许可范围？
3. **Q3 体系认证**：IATF 16949、ISO 9001/14001/45001、AEO 等是否取得？证书号、认证机构、有效期、认证范围（产品/地址）？
4. **Q4 产品准入**：CCC、CE、UL、FCC 等是否取得？覆盖哪些型号？有效期？
5. **Q5 主体一致**：证书上的持证主体是否与公司全称/曾用名一致？不一致时是哪个子公司持有？
6. **Q6 有效期**：哪些已过期、哪些在公示中、哪些被撤销/暂停？与 asOf 逐条比对结果？
7. **Q7 业务必需**：对照产品线，业务必需的资质是否齐备？缺哪一项？

## 3. 检索要求

- 来源优先级：官方认定/许可数据库与公示 > 认证机构公开查询 > 国家企业信用信息公示系统（行政许可信息） > 公司官网/证书扫描件（仅线索）。
- 中文检索词至少覆盖：`高新技术企业`、`专精特新`、`小巨人`、`创新型中小企业`、`单项冠军`、`医疗器械注册证`、`药品生产许可证`、`IATF 16949`、`ISO 9001`、`CCC 认证`、`AEO`、`行政许可`、`资质证书`。
- 英文/境外：`IATF 16949 certificate`、`ISO 9001`、`product certification`、`CE marking`。
- 证书必须在官方库或公示中核验编号；只有官网图片时 `verificationStatus=partial`，不得直接 `verified`。
- 有效期必须取原文；只有公示日期时 `validTo` 写 `pending_dd` 并说明。

## 4. 字段与六态

- 输出 `data.items[]`、`data.certifications[]`、`data.licenses[]`，字段名不得改。
- `items[].number`、`items[].validTo`、`items[].status`、`certifications[].scope`、`licenses[].scope` 必须落六态并带 note：`found` / `not_disclosed_after_search` / `lower_bound` / `pending_dd` / `conflict` / `not_applicable` / `not_reviewed` / `estimated`。
- **资质与许可是登记事实，禁止估算**（`maxEstimatedRatio=0`）；查不到写 `not_disclosed_after_search` 或 `pending_dd`。
- **是否具备某项资质、证书编号、有效期禁止用同行均值或行业惯例替代**。
- 状态只能取：`有效` / `公示中` / `已过期` / `已撤销` / `已注销` / `暂停` / `未披露`。
- 持证主体与公司不一致时，`note` 必须写"由子公司 E01 持有"之类的明确说明。

- `not_disclosed_after_search` 必须关联 `search.ledger` 的尝试记录（查过哪些官方库/公示、哪些词、检索日期），`sourceCoverage.queries` 必须能逐条对应。

## 5. 门与自检（提交前逐条勾）

- 证据：`minEvidence=2`、`minCoverage=0.7`；`data.items` ≥1 行（确无则插 `not_applicable` 占位并说明检索范围）。
- 每条 `items`：名称、发证主体、编号、有效期、状态五要素齐全或有六态说明。
- `validFrom ≤ validTo`；过期项 `status=已过期`（或按参数移入 `openQuestions`）。
- 持证主体已与 `company.identity` 核对，差异已写明。
- 业务必需资质缺失已进 `openQuestions`，并写明依据（哪个产品需要哪项资质）。
- 证书编号唯一，且能在官方库或公示中查到。

## 6. 输出

严格返回契约 JSON：`{asOf, openQuestions, flags, sourceCoverage, claims, evidence, data}`。

- `claims`：建议谓词 `qualification_held`、`qualification_number`、`qualification_valid_to`、`certification_scope`、`license_scope`、`qualification_expired`；每条带 `period`（有效期）与主体。
- `evidence`：`quote` 为公示/证书页片段，`locator` 到公示批次或证书栏；`sourceTier` 用 `regulator`/`registry`/`company`。
- `flags`：资质过期、证书范围不覆盖主力产品、公示中即宣称已获得只写 `attention`/`material` 与核查动作。
- `sourceCoverage.queries` 记录检索词与官方库；`limitations` 写清未核验到编号的证书、未覆盖的子公司、未取得的许可范围原文。

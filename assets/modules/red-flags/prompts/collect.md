# 证据矩阵与红旗清单 · 任务模板

> 模块：`{{module.name}}`｜主体：`{{company.name}}`（`{{company.code}}`）｜委托方：`{{project.client}}`｜分区：`{{unit.partition}}`｜触发器包：`{{params.triggerPack}}`｜系统提示与尾部由渲染器追加。

## 1. 本次任务

读取 `{{artifact:legal.risk}}` 与 `{{artifact:regulatory.compliance}}`，运行 12 条核查触发器 T1–T12，输出 `risk.redflags` 的 `data`。
触发器还消费客户/供应商、关联方、专利、人员、产能、财务、融资、清单等底稿；缺失的触发器标 `insufficient`，不猜数字。

**只生成核查项，不定性**：不写“违规/造假/利益输送/否决投资”，只写“需核什么 + 建议动作”。

## 2. 执行步骤

1. 读输入底稿，登记每条可用 claim 的 `status` 与口径。
2. 逐条跑 T1–T12：先判输入是否齐、口径是否对齐，再判是否超容差。
3. 每条写 `triggerResults`：`hit`/`miss`/`insufficient` + `action` + `inputs`。
4. `hit` 先过误报排除清单，排除后仍成立才转 `flags`。
5. `insufficient` 生成 `ddRequests`：缺什么、向谁要、为什么重要。
6. 整理 `claimMatrix`，只收与风险判断相关的 claim，不改写数值。
7. 按第 8 节自检后返回 JSON。

## 3. 12 条触发器（全部必跑，不得挑做）

| ID | 触发器 | 前提 | 默认级别 |
|---|---|---|---|
| T1 | 客户集中度 | 有前五大客户占比 | material |
| T2 | 关联方重叠 | 有关联方清单与客户/供应商名单 | material |
| T3 | 双重身份 | 同一主体同为客户与供应商 | attention |
| T4 | 发明人重叠 | 有专利发明人与董监高名单 | attention |
| T5 | 技术无专利覆盖 | 有产品/代际但专利清单为空 | attention |
| T6 | 产能口径不一致 | 有设计/有效/产量中至少两个口径 | attention |
| T7 | 境外收入 | 有境外收入披露 | attention |
| T8 | 人均员工成本偏低 | 有员工成本与人数 | attention |
| T9 | 估值/净资产偏高 | 有最新 post-money 与净资产 | material |
| T10 | 涉诉未计提 | 有诉讼金额与预计负债 | attention |
| T11 | 停产类处罚 | 有停产/限产/整改类处罚 | material |
| T12 | 管制清单命中 | 有清单实体与交易对手名单 | material |

## 4. 统一口径（每条都要过）

- 同主体：同一法人或同一合并范围，母子公司不得混比。
- 同期间：年报对年报、季度对季度；跨期需年化或同季对比。
- 同币种：外币按同一汇率折算并注明日期；同口径：投前/投后、认缴/实缴、单体/合并、含税/不含税一致。
- 容差：默认值见 `SKILL.md` 第 4 节；调整容差必须在 `inputs` 说明。
- 口径对不齐 → `insufficient`，不得硬算命中。

## 5. 判定规则

- 输入齐、口径对齐、超容差 → `hit`；未超 → `miss`。
- 输入缺失 / 上游为 `not_disclosed_after_search`、`conflict`、`estimated` → `insufficient`。
- `insufficient` 与 `miss` 不得互换；前者是缺口，后者是结论。
- 同一触发器多个候选值：先解决冲突再判，不挑“看起来合理”的。
- 误报排除：季节性、一次性事件、并表变化、会计政策变更、已解除条款、同名主体、媒体转载。

## 6. 输出 data 字段

- `triggerResults[]`：`triggerId`、`status`、`level`、`action`、`inputs[]`。
- `flags[]`：`level`、`rule`、`desc`、`triggerId`、`claimIds`、`evidenceIds`、`action`。
- `claimMatrix[]`：`claimId`、`predicate`、`value`、`status`、`severity`、`note`。
- `ddRequests[]`：`id`、`topic`、`question`、`why`、`priority`（high/medium/low）、`owner`、`status`。

规则：12 条全出现；`hit` 至少一条 `supports` 证据；`insufficient` 至少一条 `ddRequests`；
一条触发器最多一条红旗；`material` 红旗必须同时有 `claimIds` 与 `evidenceIds`。

## 7. 禁止

- 不写“违规/利益输送/造假/财务舞弊/否决投资”等定性结论，不用同行均值判本公司异常。
- 不把媒体爆料当事实；未回原始文书不得判 `hit`。
- 不因触发器命中而阻断交付；阻断只来自一致性失败。
- 不重复堆叠同一事实，不把 `insufficient` 写成 `hit`/`miss`；不修改上游 claim。

## 8. 交付前自检

- T1–T12 全部有结果，含 `miss`。
- 每条 `hit` 有证据；每条 `insufficient` 有 `ddRequests`。
- 红旗无定性用语、无投资建议。
- `flags[].claimIds`/`evidenceIds` 能在 claims/evidence 中找到。
- `material` 红旗可被 `deliverable` 直接读取（字段齐全）。
- 口径、容差、误报排除在 `inputs`/`note` 中留痕。

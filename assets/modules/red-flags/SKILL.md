---
name: equity-red-flags
module: builtin/red-flags
title: 证据矩阵与红旗清单
status: draft
version: 0.1.0
---

# 证据矩阵与红旗清单（red-flags）

> 模块状态：`draft`。方法论可执行、有门与 rubric，**尚未经过金融专家评审**。
> 不得在交付物中标注 `stable` 或“专家已审”。

## 1. 一句话目标

把已产出的风险类底稿组织成**证据矩阵**，运行 12 条核查触发器 T1–T12，
输出红旗清单、待核清单与核查动作，供摘要与投资决策参考。

### 1.1 定位（先读）

- **触发器只生成核查项**，不做定性：不写“违规”“利益输送”“造假”“否决投资”。
- 每条结果必须回答：查了什么（`inputs`）、命中还是证据不足（`status`）、建议做什么（`action`）。
- **重大风险进摘要首页，但不阻断交付**；只有一致性失败（报告数字≠底稿、同口径矛盾、
  未处理 stale/rejected）才阻断。
- 红旗是“需要核的问题”，不是“已经成立的事实”。

### 1.2 本模块不做

- 不重复各业务模块的取证，只引用它们的 `claimId`/`evidenceId`。
- 不做法律定性、不做行政处罚判断、不做投资建议。
- 不因为触发器 `insufficient` 就补写事实；缺什么写进 `ddRequests`。

## 2. 输入与前置

| 输入 | 必要性 | 缺失时 |
|---|---|---|
| `legal.risk` | 必须（`onMissing: block`） | 不启动；先补诉讼/被执行/失信/处罚底稿 |
| `regulatory.compliance` | 必须（`onMissing: block`） | 不启动；先补处罚/纳税/海关/异常名录底稿 |
| `financials.public` | 软引用 | T7–T10 标 `insufficient`，不猜测财务数字 |
| `ownership.chain` | 软引用 | 本包不直接消费；控制类风险以红旗描述引用 |
| `public.sentiment` | 软引用 | 只在 T10/T11 备注“未做舆情维度” |
| `{{params.triggerPack}}` | 默认 `v1` | 指定版本；阈值变更需重跑并保留旧结果 |

### 2.1 触发器包 v1 消费的底稿

`valuechain.parties`（T1/T3/T12）、`related.parties`（T2）、`ip.portfolio`+`org.people`（T4/T5）、
`supply.capacity`（T6/T11）、`financials.public`（T7–T10）、`workforce.profile`（T8）、
`financing.history`（T9）、`legal.risk`（T10）、`regulatory.compliance`（T11）、`policy.exposure`（T12）。

## 3. 触发器清单（T1–T12）

| 触发器 | 前提（何时才有意义） | 默认级别 |
|---|---|---|
| T1 客户集中度 | 有前五大客户占比（`concentration.c5`） | material |
| T2 关联方重叠 | 有关联方清单，且有客户/供应商名单 | material |
| T3 双重身份 | 同一主体同时出现在客户与供应商名单 | attention |
| T4 发明人重叠 | 有专利发明人，且有董事/核心人员名单 | attention |
| T5 技术无专利覆盖 | 有产品/代际，但专利清单为空 | attention |
| T6 产能口径不一致 | 有设计/有效/实际产量中至少两个口径 | attention |
| T7 境外收入 | 有境外收入披露 | attention |
| T8 人均员工成本偏低 | 有员工成本与人数 | attention |
| T9 估值/净资产偏高 | 有最新 post-money 与净资产 | material |
| T10 涉诉未计提 | 有诉讼金额与预计负债 | attention |
| T11 停产类处罚 | 有处罚事项，且涉及停产/限产/整改 | material |
| T12 管制清单命中 | 有清单实体，且有客户/供应商名单 | material |

### 3.1 如何判定 hit / miss / insufficient

- 输入齐全、口径对齐、达到阈值 → `hit`（先过误报排除）。
- 输入齐全、未达阈值 → `miss`（这是“已核查”的证据，必须写）。
- 输入缺失、口径无法对齐、上游为 `not_disclosed_after_search`/`conflict`/`estimated` → `insufficient`。
- 不得把 `insufficient` 写成 `miss`；前者是缺口，后者是结论。
- 同一触发器出现多个候选值时，先解决 `conflict` 再判，不挑“看起来合理”的值。

## 4. 每条触发器的口径、容差与动作

### T1 客户集中度

- 口径：同一期间、同一合并范围；`concentration.c5` = 前五大客户合计占营业收入比例。
- 阈值：≥70% 判 `hit`；分子分母期间不一致时先对齐，不能对齐则 `insufficient`。
- 误报排除：同一控制下客户合并、经销商与终端口径不同、偶发大单。
- 动作：核对占比分子分母的期间与口径，确认是否含关联方与贸易商。

### T2 关联方重叠

- 口径：同一期间；关联方名称与客户/供应商名称按全称交集，不用简称匹配。
- 阈值：交集非空即 `hit`；名称相同但主体不同（同名不同代码）先核代码。
- 误报排除：已披露并履行审批的关联交易、同一控制下但非关联方的交易。
- 动作：核对是否已披露、交易方向、金额、期间、定价与审批程序。

### T3 双重身份

- 口径：同一期间；同一主体同时为客户与供应商。
- 阈值：交集非空即 `hit`；按全称匹配，简称需回全称核验。
- 误报排除：同一集团不同法人、正常背靠背贸易、委托加工。
- 动作：核对是否同商品、是否背靠背合同、收入按净额还是总额确认。

### T4 发明人重叠

- 口径：专利发明人与董事/核心人员姓名交集，同名需任职单位佐证；交集非空即 `hit`。
- 误报排除：同名不同人、离职后发明、合法兼职。
- 动作：核对任职期间、职务发明制度、保密与竞业、原单位争议。

### T5 技术无专利覆盖

- 口径：产品有代际/品类但专利清单为空；产品有代际且专利数为 0 判 `hit`，专利未公开不等于不存在。
- 误报排除：以商业秘密保护、许可技术、公开技术路线为主的公司。
- 动作：核对技术来源是自研、许可还是公开技术，缺口在哪。

### T6 产能口径不一致

- 口径：设计/有效/实际产量同期比较；最大值与最小值差异 >20% 判 `hit`，不足两个口径则 `insufficient`。
- 误报排除：口径定义不同、技改期、季节性、代工与自产混合。
- 动作：统一设计/有效/在建产能与产量期间后再判断。

### T7 境外收入

- 口径：同一期间、同一合并范围的境外收入与合计数勾稽；有披露即提示核对（提示型，不设比例阈值）。
- 误报排除：正常出口、境外子公司本地销售、汇率折算差异。
- 动作：核对交易路径、收入类型、合并边界、汇率与海关/境外子公司数据。

### T8 人均员工成本偏低

- 口径：同一期间员工成本/人数（注明是否含社保公积金）；人均低于 5 万元/年判 `hit`（默认值，可按行业校准）。
- 误报排除：劳务派遣、退休返聘、境外低人力成本地区、兼职占比高。
- 动作：核对用工结构、并表范围与时点、社保缴纳口径。

### T9 估值/净资产偏高

- 口径：最新 post-money 与同一期末净资产；注明投前/投后与稀释。
- 阈值：P/B >10x 判 `hit`；不同证券、拆股需先调整。
- 误报排除：轻资产公司、刚完成大额融资、净资产为负。
- 动作：比较同种证券、拆股/稀释调整后的历轮价格与 post-money；回购条款另找协议依据。

### T10 涉诉未计提

- 口径：同一期间诉讼金额合计与预计负债；涉诉金额 >0 且预计负债为 0 判 `hit`，不按涉诉额机械计提。
- 误报排除：案件阶段尚早、败诉可能性低、已投保、金额不重大。
- 动作：核对案件阶段、法律评估、会计政策与披露。

### T11 停产类处罚

- 口径：同一主体、同一处罚决定，事项涉及停产/限产/整改；命中即 `hit`，不设金额阈值。
- 误报排除：已完成整改并复产、非生产性主体、历史处罚已过追溯期。
- 动作：核对整改/复产批复、替代产能、影响期间。

### T12 管制清单命中

- 口径：清单实体与客户/供应商按全称匹配，注明名单版本与生效日；交集非空即 `hit`，同名先核代码与注册地。
- 误报排除：名单版本过期、实体同名、仅间接关联且不涉及交易。
- 动作：核对名单规则、实体匹配、适用范围与替代方案。

## 5. 统一口径规则（所有触发器共用）

- **同主体**：比较双方必须是同一法人或同一合并范围；母公司与子公司不得混比。
- **同期间**：年报对年报、季度对季度；跨期比较需年化或同季对比，不得直接比。
- **同币种**：外币按同一汇率基准折算，注明汇率日期；不得直接比较不同币种金额。
- **同口径**：投前/投后、认缴/实缴、单体/合并、含税/不含税必须一致。
- **容差**：默认值写在各触发器；调整容差必须在 `triggerResults[].inputs` 说明；口径对不齐时 `status=insufficient`。

## 6. 误报排除（通用清单）

- 季节性、偶发一次性事件、并表范围变化、同一控制下合并、会计政策/估计变更、汇率与账期差异。
- 已解除/已到期/已豁免的条款，已履行完毕的诉讼与担保。
- 同名主体、员工个人事项、关联方已披露且程序合规。
- 媒体报道与转载：只作线索，未回原始文书不得判 hit。

## 7. 输出结构

| 字段 | 内容 |
|---|---|
| `triggerResults[]` | `triggerId`、`status`（`hit`/`miss`/`insufficient`）、`level`、`action`、`inputs[]` |
| `flags[]` | 命中项转成红旗：`level`、`rule`、`desc`、`triggerId`、`claimIds`、`evidenceIds`、`action` |
| `claimMatrix[]` | 证据矩阵：`claimId`、`predicate`、`value`、`status`、`severity`、`note` |
| `ddRequests[]` | 待核清单：`id`、`topic`、`question`、`why`、`priority`、`owner`、`status` |

规则：

- 12 条必须全部出现；`miss` 也要写，作为“已核查”的证明。
- `hit` 必须有至少一条 `supports` 证据；没有证据的命中降级为 `insufficient`。
- `insufficient` 必须生成 `ddRequests`，写清缺什么、向谁要、为什么重要。
- `flags` 不与 `triggerResults` 重复堆叠：一条触发器最多一条红旗。
- `claimMatrix` 只收与风险判断相关的 claim，不复制全部业务 claim。

### 7.1 红旗写法示例（结构示意）

```jsonc
{
  "triggerId": "T1",
  "status": "hit",
  "level": "material",
  "action": "核对前五大客户占比的分子分母期间与口径，确认是否含关联方与贸易商",
  "inputs": ["valuechain.parties.concentration.c5"]
}
```

红旗文字只写“需核查什么 + 建议动作”，不写“已构成违规”。
`level=material` 时必须同时给出 `claimIds` 与 `evidenceIds`，缺一降级为 `attention`。

## 8. 与摘要和交付的关系

- `level=material` 的红旗必须进入报告摘要首页，由 `deliverable` 读取本模块 `flags`。
- 红旗数量与级别不阻断交付；`deliverable` 的 QA 只对一致性失败阻断。
- 红旗不得写成结论式判断（如“存在利益输送”），只能写“需核查 + 建议动作”。
- `ddRequests` 会成为交付包的《资料请求清单》，必须可执行、可指派。

## 9. 六态与边界

本模块沿用的八种状态（六态命名，实际八值）：

- `found`：上游已确认且有证据。
- `not_disclosed_after_search`：已查未披露，附 `search.ledger`。
- `lower_bound`：只有“至少”类数据，用于下界判断。
- `pending_dd`：需企业内部材料。
- `conflict`：上游多源矛盾，未解决前只能 `insufficient`。
- `not_applicable`：该触发器对主体不适用（如无境外收入）。
- `not_reviewed`：未查或预算耗尽。
- `estimated`：只允许分析型字段；本模块不产出 `estimated`。

判定规则：

- 触发器输入沿用上游六态；上游为 `not_disclosed_after_search` 时，本模块只能 `insufficient`。
- `estimated` 输入不得用于触发命中；若上游为 `estimated`，本模块标 `insufficient` 并说明。
- 本模块自身不产出 `estimated`；`gates.maxEstimatedRatio=0`。
- 红旗 `level` 只有 `attention`/`material`；`material` 必须有证据与动作。

## 10. 常见误判

1. **用同行均值判异常**：同行数据只能作背景，不能替代本公司口径。
2. **期间不一致**：季度与年度直接比、跨年汇率直接比。
3. **币种未换算**：外币担保、境外收入直接与人民币比较。
4. **口径混用**：投前/投后、认缴/实缴、单体/合并混比。
5. **一次性事件当持续**：重组、诉讼和解、资产处置被当作常态。
6. **媒体当事实**：转载、爆料、自媒体解读未回原始文书。
7. **阈值当结论/漏写 miss**：超过容差只说明“需核查”；漏写 `miss` 会让复核人无法判断是否查过。
9. **把 insufficient 写成 miss**：证据不足与确认无误是两件事；同名不核代码也会误导关联方与清单判断。

## 11. 验收要点

- 12 条触发器全部有 `triggerResults`，状态为 `hit`/`miss`/`insufficient` 之一。
- 每条 `hit` 至少一条 `supports` 证据；每条 `insufficient` 至少一条 `ddRequests`。
- `flags` 的 `claimIds`/`evidenceIds` 能在 claims/evidence 中找到。
- 红旗无定性用语、无投资建议、无“违规/造假/利益输送”等结论。
- `claimMatrix` 与上游 claim 的 `value`/`status` 一致；重大红旗可被 `deliverable` 直接读取。

## 12. 与其他模块的关系

- 上游硬依赖：`legal.risk`、`regulatory.compliance`。
- 上游软引用：`valuechain.parties`、`related.parties`、`ip.portfolio`、`org.people`、
  `business.segment`、`supply.capacity`、`workforce.profile`、`financials.public`、
  `financing.history`、`policy.exposure`、`ownership.chain`、`public.sentiment`。
- 下游：`deliverable`（摘要首页、待核清单、资料请求）、`assessment-fit`（风险输入）；本模块不改上游底稿，发现错误走 `openQuestions`/`equity_review`。

## 13. 已知缺口（draft 阶段）

- 触发器阈值是方法学默认值（客户集中度 70%、人均成本 5 万、P/B 10x、产能差异 20%），
  需按行业校准，校准记录进 `triggerPack` 版本说明。
- 财务类触发器依赖 `financials.public` 完整度，缺三表时只能 `insufficient`；境外架构可查性受登记公开程度限制。

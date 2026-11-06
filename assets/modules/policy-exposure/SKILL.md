# policy-exposure · 出口管制与地缘合规（draft 类型）

> 模块状态：**draft**（模块与底稿类型 `policy.exposure` 均为 draft，仅为 deep 预设编译而注册；不得声称 `stable` 或"专家已审"）。
> 输出底稿：`policy.exposure`（scope=company，cardinality=one，partitionKey=`_default`）。
> 一句话目标：核对公司、子公司、关键交易对手是否出现在主要管制清单上，物项与最终用途是否受限，以及有哪些替代路径可查。
> **本模块不自动否决任何交易**：命中只生成核查动作，是否继续由委托方与法律顾问决定。

## 1. 回答什么问题

1. 公司及其子公司、主要股东、关键人是否出现在 BIS/OFAC/EU/UN/中国商务部的管制清单上？
2. 命中的是哪一份清单、哪一条、什么日期版本、命中理由是什么（名称/地址/别名/实体编号）？
3. 公司产品是否受出口管制（ECCN 分类、EAR99、是否受 EAR 管辖）？关键物项是否在中国两用物项清单内？
4. 主要客户与供应商中是否有清单实体？交易是否可能触发 50% 规则或最终用途管制？
5. 已取得或需要哪些许可证（出口许可、两用物项许可、最终用户证明）？
6. 若受限，有哪些可调查的替代路径（许可申请、供应替代、业务重组）？

## 2. 输入、前置与降级

| 关系 | 类型 | 说明 |
|---|---|---|
| 硬输入 | `business.segment` | 产品、技术来源、下游应用，决定是否落入管制物项 |
| 硬输入 | `ip.portfolio` | 专利与技术来源，判断技术是否源自受管制地区 |
| 软引用 | `valuechain.parties` | 客户/供应商名单，用于清单比对 |
| 软引用 | `supply.capacity` | 关键设备与材料来源，用于供应链暴露 |

- 降级：无客户/供应商名单时，只做主体层面比对，交易对手维度写 `pending_dd`。
- 分区：单一 artifact，`{{unit.partition}}` 恒为 `_default`。
- 清单版本：`{{params.listAsOf}}` 为空时以本次检索当日为准，并在 `data.listVersion` 写明每个清单的抓取日。

## 3. 检索计划

### 3.1 来源优先级

| 序 | sourceTier | 典型来源 | 用途 | authority |
|---|---|---|---|---|
| 1 | regulator | BIS Consolidated Screening List（CSL，聚合多份美国清单） | 一次性筛查 | A |
| 2 | regulator | BIS Entity List / Denied Persons / Unverified / MEU 各原始清单 | 确认命中具体清单 | A |
| 3 | regulator | OFAC SDN 与 Consolidated（Non-SDN）名单 | 制裁比对 | A |
| 4 | regulator | 美国联邦公报（Federal Register） | 清单增补的最终规则与生效日 | A |
| 5 | regulator | EU Consolidated Financial Sanctions List、EU 两用物项清单 | 欧盟口径 | A |
| 6 | regulator | UN Security Council Consolidated List | 联合国口径 | A |
| 7 | regulator | 中国商务部：不可靠实体清单、出口管制管控名单、两用物项出口管制清单 | 中国口径 | A |
| 8 | announcement | 公司公告/年报"出口管制与制裁风险"披露 | 公司自述 | B |
| 9 | media | 财经媒体报道 | 线索 | C–D |

### 3.2 检索词

中文：
- `"<公司全称>" 实体清单`、`"<公司全称>" 出口管制`、`"<公司全称>" 制裁`
- `"<公司全称>" 两用物项`、`"<公司全称>" 不可靠实体清单`
- `"<产品名>" ECCN`、`"<产品名>" 出口许可`

英文：
- `"<English name>" Entity List`、`"<English name>" BIS`、`"<English name>" OFAC SDN`
- `"<English name>" denied persons`、`"<English name>" export control`
- `"<product>" ECCN classification`、`"<product>" export license`

### 3.3 必查库与必开页面

- BIS CSL 检索页与各原始清单下载页；
- Federal Register 中 BIS/OFAC 的最终规则与生效日期；
- OFAC Sanctions List Search 与 SDN 文件；
- EU 制裁名单与两用物项清单（Regulation 2021/821 附件一）；
- UN 安理会综合名单；
- 中国商务部出口管制信息发布、两用物项出口管制清单；
- 公司公告中关于出口管制与制裁的风险提示。

### 3.4 检索顺序与预算

1. BIS CSL 主体筛查（约 4 次）；
2. 命中项回原始清单与联邦公报确认（约 4 次）；
3. OFAC/EU/UN 筛查（约 3 次）；
4. 中国清单筛查（约 2 次）；
5. 物项与交易对手（约 5 次）；
6. 许可证与替代路径（约 2 次）。
上限见 `module.yaml` 的 `budget.toolCallsPerUnit=20`。

### 3.5 主要清单速查

| 清单 | 管辖方 | 管什么 | 本模块关注点 |
|---|---|---|---|
| BIS Entity List | 美国 BIS | 特定实体的出口需许可 | 主体命中与许可要求 |
| BIS Denied Persons | 美国 BIS | 剥夺出口特权 | 交易是否被禁止 |
| BIS Unverified | 美国 BIS | 最终用途无法核实 | 需补充尽职调查 |
| BIS MEU List | 美国 BIS | 军事最终用户 | 最终用途管制 |
| OFAC SDN / Non-SDN | 美国财政部 | 资产冻结与交易禁止 | 主体与 50% 传导 |
| EU Consolidated | 欧盟 | 资产冻结与资金限制 | 欧洲业务 |
| UN Consolidated | 联合国 | 成员国立法的共同基础 | 全球口径 |
| 中国两用物项/不可靠实体 | 中国商务部 | 出口许可与反制 | 出口与供应链 |

## 4. 字段与口径

| 字段 | 结构 | 定义 | 算 `found` | 算 `not_disclosed_after_search` |
|---|---|---|---|---|
| `data.listings[]` | `list`/`entity`/`date`/`scope`/`status`/`note` | 清单命中记录 | 清单页面可核 + 实体编号或条目 | 只有媒体称"被列入" |
| `data.exposure[]` | `dimension`/`description`/`level`/`note` | 暴露维度 | 有物项/交易/最终用途依据 | 无产品分类信息 |
| `data.licenses[]` | `kind`/`status`/`note` | 许可证状态 | 有证号或官方核准记录 | 只有"正在申请" |

- `list` 用固定词：`BIS Entity List`/`BIS Denied Persons`/`BIS Unverified`/`BIS MEU`/`OFAC SDN`/`OFAC Non-SDN`/`EU Consolidated`/`UN Consolidated`/`中国不可靠实体清单`/`中国出口管制管控名单`/`其他`。
- `status` 用固定词：`命中`/`未命中`/`待复核`/`已移出`。
- `scope` 写适用范围：`公司本部`/`子公司`/`股东`/`关键人`/`交易对手`/`物项`。
- `exposure[].level` 用 `high`/`medium`/`low`/`unknown`，并必须在 note 写判断依据；不得只给等级不给理由。
- `licenses[].status` 用 `已取得`/`申请中`/`不适用`/`需申请`/`unknown`。

### 4.1 清单版本与日期

每份清单都要写"抓取日 + 清单发布/更新日"。清单是动态的：历史交易要按当时的版本判断，`listings[].date` 写清单条目生效或列入日期，不是本次检索日。Federal Register 的最终规则要看生效日（effective date）与过渡条款。

### 4.2 命中理由

必须写清五要素：清单名称、条目编号（如实体编号）、匹配字段（名称/别名/地址/注册号）、匹配强度（完全一致/近似/无法确认）、适用主体（本部/子公司/同名第三方）。只有"名称近似"的，`status` 写 `待复核`，不得直接写 `命中`。

### 4.3 适用范围

- 直接交易：公司自身与被列实体交易；
- 间接交易：通过经销商、代理商、贸易商间接交付；
- 股权传导：OFAC 50% 规则——被制裁主体直接或间接持股 50% 以上的实体同样受限；
- 最终用途/最终用户：军事最终用户、核、生化、导弹相关用途，即使不在清单上也受限；
- 再出口与视同出口：境外生产含美国技术/软件/设备的物项（de minimis、FDPR）。

### 4.4 物项

先判断产品是否"受 EAR 管辖"：美国原产物项、含美国成分超过 de minimis、直接产品规则覆盖。再判断 ECCN 分类或 EAR99。中国口径看是否列入两用物项出口管制清单及临时管制公告。分类必须引用官方清单条目，不得凭产品名称猜测。

### 4.5 替代方案（只作调查线索）

可调查方向：许可证申请（BIS/OFAC/商务部）、供应链替代（非美系设备与材料）、技术去美化（重新设计、替换 EDA/IP）、业务重组（剥离受限业务）、合同条款（合规承诺、终止权）。**不得给出法律意见或"可行/不可行"的结论**，只写"需法律顾问评估"。

### 4.6 字段填充示例（占位符，不是真实数据）

```jsonc
{
  "listings": [
    {"list": "BIS Entity List", "entity": "E01（示例实体）", "date": "清单条目列入日占位",
     "scope": "子公司", "status": "待复核", "note": "名称近似，地址不一致，需核实体编号"}
  ],
  "exposure": [
    {"dimension": "物项", "description": "核心设备依赖美系供应商，含美国技术比例待核",
     "level": "unknown", "note": "需供应商提供 ECCN 与原产地证明"}
  ],
  "licenses": [{"kind": "两用物项出口许可", "status": "需申请", "note": "仅出口业务适用"}]
}
```

## 5. 六态与边界

- `found`：清单页面或官方文件可核；
- `not_disclosed_after_search`：查过 CSL、OFAC、EU、UN、商务部仍无；
- `lower_bound`：只知道"部分产品受限"而无法确定范围；
- `pending_dd`：需要供应商 ECCN 声明、最终用户证明、法律意见；
- `conflict`：不同清单/不同版本结论不一致，保留两组；
- `not_applicable`：纯境内业务、无受控物项、无涉外交易；
- `not_reviewed`：本轮未查；
- `estimated`：仅允许用于"暴露程度"等分析型判断，必须带 `derivation`；清单命中事实一律不得 estimated。

边界：**不做法律意见**，不判断"是否违反出口管制"，不自动否决交易，不给规避制裁的具体操作方案；不采集个人出行、金融账户等敏感信息；不把媒体报道当命中。

## 6. 常见误判

1. 把 CSL 聚合检索的命中当成"实体清单命中"（CSL 聚合多份清单，需回原始清单）。
2. 名称近似就判定命中（未核对地址、别名、实体编号）。
3. 忽略 50% 股权传导规则。
4. 只看主体清单，忽略最终用途/最终用户管制。
5. 只查美国清单，不查中国、欧盟、联合国口径。
6. 把"未命中"当成"无风险"（ECCN 分类与最终用途仍可能受限）。
7. 用本次检索日代替清单条目生效日。
8. 忽略境外子公司与再出口。
9. 把媒体报道"被列入"当成官方命中。
10. 把技术合作/授权当成不受管制（技术出口同样受控）。

## 7. 验收要点

- 证据：≥5 条；每份主要清单至少 1 条检索记录（含未命中的结论）；
- 覆盖：美国/欧盟/联合国/中国四套口径都查；主体、交易对手、物项三个维度都有结论；
- 版本：`data.listVersion` 写清每份清单的抓取日；
- 必答：①是否命中任何清单；②命中理由与适用范围；③产品是否需要 ECCN/两用物项分类；④主要客户供应商是否命中；⑤现有许可证状态；⑥需法律顾问评估的问题；
- 一致性：与 `qualifications` 的进出口资质一致；与 `supply-capacity` 的关键供应商一致。

## 8. 与其他模块的关系

- 上游（硬）：`business.segment`、`ip.portfolio`；软引用 `valuechain.parties`、`supply.capacity`；
- 下游：`red-flags`（地缘合规触发器）、`assessment-fit`（交易可行性）、`deliverable`；
- 不重复：进出口资质与许可证书归 `qualifications`；行政处罚归 `regulatory-compliance`；技术来源归 `tech-origin`。

## 9. 交付前自检

- [ ] 每份清单都写了抓取日与版本
- [ ] 命中项有清单名称、条目编号、匹配字段、匹配强度
- [ ] 物项分类引用了官方清单条目
- [ ] 没有"违反/合规/可以交易"式结论
- [ ] 替代方案只写"可调查方向"，标注需法律顾问评估
- [ ] 全文无 `stable`、`已审` 字样

## 10. 明确不覆盖

- 出口管制与制裁的法律意见、许可可行性判断；
- 规避方案设计与"去美化"实施路径；
- 具体的 ECCN 分类鉴定（需供应商或第三方鉴定）；
- 个人制裁与旅行限制；
- 交易是否继续的商业决策。

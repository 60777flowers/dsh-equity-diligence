# {{module.name}} · 采集任务：出口管制与地缘合规（draft）

## 任务

对 **{{company.name}}**（代码 {{company.code}}）核对主要管制清单命中、物项分类、交易对手与最终用途暴露。
委托方：{{project.client}}；模块：{{module.name}}；分区：{{unit.partition}}。
本模块类型为 **draft**：只产出核查线索，**不自动否决交易**，不出法律意见。

## 输入

- 业务与技术（产品、下游、技术来源）：{{artifact:business.segment}}
- 知识产权（技术来源与许可）：{{artifact:ip.portfolio}}
- 客户与供应商（软引用）：{{artifact:valuechain.parties}}
- 产能与关键设备（软引用）：{{artifact:supply.capacity}}

## 参数

- 清单版本日期：{{params.listAsOf}}（为空则以本次检索日为准，并逐个清单记录抓取日）
- 剩余预算：{{budget.remaining}}

## 必答问题（每条落到 `data` 或 `openQuestions`）

1. 公司、子公司、主要股东、关键人是否出现在 BIS/OFAC/EU/UN/中国商务部清单上？
2. 命中的是哪一份清单、条目编号、列入日期、命中理由（名称/别名/地址/实体编号）？
3. 命中适用范围是什么（本部/子公司/股东/交易对手/物项）？是否触发股权传导（50% 规则）？
4. 公司产品是否受出口管制？ECCN 分类或 EAR99？是否落入中国两用物项清单？
5. 主要客户与供应商中是否有清单实体？是否涉及最终用途/最终用户管制？
6. 已取得或需要哪些许可证？现有许可证状态？
7. 若受限，有哪些可调查的替代路径（只列方向，标注需法律顾问评估）？

## 检索词起点

- `"<公司全称>" 实体清单` / `"<公司全称>" 出口管制` / `"<公司全称>" 制裁`
- `"<公司全称>" 两用物项` / `"<公司全称>" 不可靠实体清单`
- `"<English name>" Entity List` / `"<English name>" OFAC SDN` / `"<English name>" export control`
- `"<产品名>" ECCN` / `"<产品名>" export license`

## 检索路径（按序执行）

1. BIS Consolidated Screening List 主体筛查（记下命中与未命中）；
2. 命中项回原始清单（Entity List / Denied Persons / Unverified / MEU）与联邦公报最终规则确认；
3. OFAC SDN 与 Non-SDN、EU 综合名单、UN 综合名单；
4. 中国商务部：不可靠实体清单、出口管制管控名单、两用物项出口管制清单；
5. 物项维度：产品是否受 EAR 管辖、ECCN 分类、再出口与视同出口；
6. 交易对手维度：客户/供应商比对，检查 50% 规则与最终用途；
7. 公司公告中"出口管制与制裁风险"披露。

## 输出字段清单

- `data.listings[]`：list / entity / date / scope / status / note
- `data.exposure[]`：dimension / description / level / note
- `data.licenses[]`：kind / status / note
- `data.listVersion`：各清单抓取日与版本说明（附加字段）

## 口径要求

- `list` 用固定词：BIS Entity List / BIS Denied Persons / BIS Unverified / BIS MEU / OFAC SDN / OFAC Non-SDN / EU Consolidated / UN Consolidated / 中国不可靠实体清单 / 中国出口管制管控名单 / 其他；
- `status` 用：命中 / 未命中 / 待复核 / 已移出；
- `scope` 用：公司本部 / 子公司 / 股东 / 关键人 / 交易对手 / 物项；
- `exposure.level` 用 high / medium / low / unknown，且 note 必须写判断依据；
- 命中项必须写清单名称、条目编号、匹配字段、匹配强度、适用主体；
- 只有名称近似的，`status` 写 `待复核`，不得写 `命中`。

## 六态写法

- 只有媒体称"被列入"：`not_disclosed_after_search` 或 `pending_dd`，不写 `命中`；
- 只知道部分产品受限：`lower_bound`；
- 需供应商 ECCN 声明、最终用户证明：`pending_dd`；
- 不同清单/版本结论不一致：`conflict` + 两组值；
- 纯境内无涉外业务：`not_applicable` + 依据；
- 暴露程度：可 `estimated`，必须带 `derivation`；清单命中事实不得 estimated。

## 不要做

- 不出法律意见，不判断"是否违反出口管制"；
- 不自动否决交易，不写"禁止合作"；
- 不给规避制裁的操作方案；
- 不把 CSL 聚合命中当实体清单命中；
- 不把名称近似当命中；
- 不声称已核验或专家已审。

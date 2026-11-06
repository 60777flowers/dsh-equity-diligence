# 报告与附表 · 任务模板

> 模块：`{{module.name}}`｜主体：`{{company.name}}`（`{{company.code}}`）｜委托方：`{{project.client}}`｜分区：`{{unit.partition}}`
> 交付模板：`{{params.template}}`｜是否生成 7+N：`{{params.include7N}}`｜系统提示与尾部由渲染器追加。

## 1. 本次任务

读取已验收底稿并构建交付包：主体 `{{artifact:company.identity}}`、股权 `{{artifact:ownership.chain}}`、
投资版图 `{{artifact:investment.map}}`、红旗 `{{artifact:risk.redflags}}`（缺失的跳过并在 QA 记非阻断）。
输出 `report.deliverable` 与 `dd.request_list`；**这是构建器**，报告只从底稿取事实，不得新增数字、主体、日期与结论。

## 1.1 底稿读取顺序

1. 先读 `company.identity` 与 `ownership.chain`，确定主体与控制结论。
2. 再读 `investment.map` 各平台分区，确定 7+N 行来源。
3. 再读 `risk.redflags`，抽出 `material` 红旗。
4. 最后读业务、财务、合规类底稿，填工作簿页签。
5. 任一底稿为 `stale`/`rejected`：先修复或降级，不进入构建。

## 2. 执行步骤

1. 列底稿清单：类型、revision、contentHash、状态。
2. 有 `stale`/`rejected` 先停下写 issue，除非上游已重跑并 verified。
3. 从 claims 中挑 `material` 与关键事实，按影响排序。
4. 写 5–10 条五段式（事实→影响→证据强度→materiality→下一步），每条挂 `claimId`。
5. 构建工作簿 11 页签，逐单元格 pin `artifactId + revision + contentHash + claimId`。
6. `include7N=true` 时构建 7+N：7 固定 + ≤3 家族 + 说明，行=平台路径×实体。
7. 生成底稿包、证据快照、`manifest.json`、资料请求清单。
8. 跑 QA（阻断项必须为 0），写 `qa`/`signoff`（不填 `approvedBy`）。

## 3. 必答问题

1. 摘要是否 5–10 条？每条五段式齐全并挂 `claimId`？
2. 每条事实能否三跳追溯（报告→claim→evidence）？
3. 工作簿 11 页签是否齐全？列语义是否正确？
4. 7+N 表数、表名、列序、列数是否合规？家族表是否 ≤3？多路径实体是否漏行？
6. 阻断项是否为 0？报告数字是否与底稿逐项一致？有无新事实？

## 4. 摘要规则

- 条数 5–10；少于 5 说明调查不足，多于 10 说明没取舍。
- 每条：事实（带口径）/ 影响（方向，不给建议）/ 证据强度（A–D + 独立源数 + 冲突）/ materiality / 下一步。
- `material` 红旗必须在前三条之一。
- 不写“建议投资/不建议投资/估值偏低”；不把 `estimated` 当确定值。

## 5. 工作簿与专项规则

- 工作簿 11 页签：目录、摘要、主体股权、业务技术、财务、风险、待核、资料请求、来源索引、底稿索引、体检。
- 7+N：7 张固定表 + ≤3 张家族表 + 说明；同一实体多路径在每张涉及表各占一行。
- 列名与顺序固定；清理版删四列后 20 列；不得重命名/换序/增删。
- 标绿只按固定词表规则执行，不由人工判断。
- 每个数字单元格标注 `artifactId + revision + claimId`。

## 6. 资料请求与待核

- 合并各模块 `openQuestions` 与 `red-flags.ddRequests`，去重写入 `dd.request_list.items[]`。
- 每条：`id`、`topic`、`question`、`why`、`priority`、`owner`、`status`。
- 一条只问一件事，可执行；不写“继续关注”“补充调查”。
- 无源事实进待核，不进正文。

## 7. QA 与签发

- 阻断：数字不一致、同口径矛盾、未处理 stale/rejected、血缘缺失、结构不合规、摘要条数越界、红旗失联。
- 非阻断：覆盖不足、证据等级偏低、待核偏多、格式告警；`qa.passed=true` 仅当阻断项为 0。
- `signoff` 只填 `preparedBy` 与 `proposedAt`；`reviewedBy`/`approvedBy`/`signedAt` 由人工通道填写。

## 8. 六态与禁止

- 摘要与工作簿沿用上游六态，不得把 `pending_dd` 写成 `found`。
- `not_disclosed_after_search` 写“已查未披露 + 检索范围”；`conflict` 并列候选；`estimated` 标假设。
- 不新增底稿之外的事实、数字、主体、日期；不修改上游底稿与 claim 状态。
- 不手工标绿、不重命名列、不合并分表、不超额建家族表；不代替人工签发。

## 9. 交付前自检

- `files[]` 覆盖 01–05 与 manifest、QA 记录，`sha256` 齐全。
- `summaryFindings` 5–10 条，字段齐全、挂 `claimId`/`artifactId`。
- 三跳追溯可抽查通过；`cellMap` 无缺 pin。
- 7+N 结构合规；多路径实体无漏行。
- `qa.blocking=0`；非阻塞项已记录；`signoff.preparedBy`/`proposedAt` 已填。

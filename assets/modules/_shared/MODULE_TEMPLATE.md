# 模块内容模板（作者必读）

每个模块目录必须包含：

```
module.yaml            # 已生成，勿手改 id/inputs/outputs；可补 params/status
SKILL.md               # 方法论：查什么、去哪查、怎么判、边界
prompts/collect.md     # 任务模板，含 {{...}} 变量
rules/gates.json       # 声明式门规则
rules/rubric.md        # 审核 rubric（五维，1–5 分）
fallback.md            # 可选；与 assets/fallback-cards.yaml 对应
```

## SKILL.md 结构（建议 120–260 行）

1. **一句话目标**：本模块回答什么问题。
2. **输入与前置**：需要哪些底稿；没有时怎么降级。
3. **检索计划**：来源优先级、中文/英文/当地语言检索词、必查数据库/网站。
4. **字段与口径**：输出 `data` 的每个关键字段怎么定义、什么算 found、什么算 not_disclosed。
5. **六态与边界**：哪些字段允许 estimated；哪些只能 pending_dd；不推断什么。
6. **常见误判**：至少 5 条（例如名称相近、口径混用、把线索当结论）。
7. **验收要点**：证据数、覆盖、交叉源、必须回答的问题。
8. **与其他模块的关系**：上游/下游、软引用。

## prompts/collect.md

用 `{{company.name}}`、`{{company.code}}`、`{{project.client}}`、`{{artifact:<type>}}`、`{{params.<key>}}` 等变量；写清本次任务、必答问题、来源优先级、输出要求。**不要**在任务模板里重复系统提示和共同尾部，渲染器会自动追加。

## rules/gates.json

```json
{
  "minEvidence": 2,
  "minCoverage": 0.7,
  "requiredFields": ["data.legalName"],
  "minItems": {"data.layers": 1},
  "sixStateFields": ["data.controllingPerson"],
  "maxEstimatedRatio": 0.2
}
```

只写本模块真正需要的门；没有就写 `{}`。规则必须可被代码判定，不写“模型认为”。

## rules/rubric.md

五维：事实准确性、引用准确性、完整性、来源质量、对账。每维 1–5 分，写清 3 分/5 分的判据；任一维 ≤2 不通过。不要写空泛的“质量高”。

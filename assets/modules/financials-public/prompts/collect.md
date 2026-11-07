# {{module.name}} · 采集任务：财务质量与勾稽

## 任务

对 **{{company.name}}**（代码 {{company.code}}）的 **{{unit.partition}}** 财年，抽取公开财报数据并完成三表勾稽与口径检查。
委托方：{{project.client}}；模块：{{module.name}}；分区：{{unit.partition}}（财年）。
一个分区只写一个财年，不要在一个 artifact 里混多年。

## 输入

- 业务与分部：{{artifact:business.segment}}
- 客户与供应商（软引用）：{{artifact:valuechain.parties}}
- 产能（软引用）：{{artifact:supply.capacity}}

## 参数

- 回溯参考年限：{{params.yearsBack}}（仅用于口径对照，不改变本分区只写单财年）
- 剩余预算：{{budget.remaining}}

## 必答问题（每条落到 `data` 或 `openQuestions`）

1. `{{unit.partition}}` 的营业收入、营业成本、毛利率、净利润、归母净利润分别是多少？
2. 审计意见是什么类型？有没有强调事项段、持续经营提示、关键审计事项？
3. 会计口径五要素（准则/币种/单位/合并范围/期间）分别是什么？
4. 本财年是否发生会计政策变更、前期差错更正或重述？原始值与重述值差在哪？
5. 合并范围是否变化（新增/处置/同一控制下合并）？
6. 三表勾稽七项逐条是否通过？不通过的差多少、差在哪？
7. 经营现金流与净利润是否背离？应收、存货增速是否异常？
8. 纳税信用等级、海关信用、用电等外部旁证能否取得？

## 检索词起点

- `"<公司全称>" 年度报告 财务报表` / `"<公司全称>" 审计报告 关键审计事项`
- `"<公司全称>" 非经常性损益` / `"<公司全称>" 会计政策变更` / `"<公司全称>" 追溯调整`
- `"<公司全称>" 合并范围` / `"<公司全称>" 商誉 减值`
- `"<公司全称>" 纳税信用` / `"<公司全称>" 海关 信用`

## 检索路径（按序执行）

1. 巨潮资讯网/交易所下载年报全文（正文 + 财务报表 + 附注）；
2. 抽取三表关键科目：总资产、总负债、所有者权益、货币资金、应收账款、存货、营业收入、营业成本、净利润、三类现金流、期末现金；
3. 读审计报告意见段与关键审计事项；
4. 读附注"编制基础""合并范围""会计政策变更""前期差错更正""所有权受限"；
5. 计算七项勾稽并写 `data.recon`；
6. 外部旁证：纳税信用、海关信用、用电/能耗（查不到写 `pending_dd`）。

## 输出字段清单

- `data.fiscalYear`（上市/发债等公众主体必填；非公众主体可省略）、`data.currency`、`data.accountingStandard`、`data.auditOpinion`、`data.consolidation`
- `data.revenue` / `data.netProfit`：amount / currency / unit / note
- `data.grossMargin`（0–1 小数）
- `data.statements`：三表摘要对象
- `data.recon[]`：check / left / right / status / note
- `data.availability`（非公众主体必填）：`status` / `note` / `checkedSources[]`
  - 非上市、未发债、无公开财报义务的主体，先检索至少 2 个独立来源（如国家企业信用信息公示系统、信用中国、裁判文书/交易所披露），仍无财报时写：
    ```json
    {"status":"not_disclosed_after_search","note":"已查公示系统/信用中国/交易所，无公开财务报表","checkedSources":["gsxt","creditchina"]}
    ```
  - 非公众主体的 `status` 只接受 `not_disclosed_after_search`；`pending_dd`、`not_reviewed`、`found` 不得作为交付结论。若确实取得财报，走公众口径并填 `fiscalYear/revenue/netProfit/recon`。
  - 不要用空对象、空数组或“无”代替检索结论；`checkedSources` 至少 2 个。

## 勾稽清单（必须逐条）

1. 资产 = 负债 + 所有者权益
2. 现金流量表期末现金 = 货币资金 − 受限资金
3. 现金流量表补充资料净利润 = 利润表净利润
4. 营业收入 − 营业成本 = 毛利；毛利 ÷ 营业收入 = 毛利率
5. 未分配利润期末 = 期初 + 净利润 − 分配
6. 经营现金流与净利润的方向性差异
7. 应收账款/存货增速 vs 收入/成本增速

`status` 只能是 `pass` / `fail` / `insufficient`；缺表缺科目写 `insufficient`，不得写 `pass`。

## 不要做

- 不做盈利预测、不给估值、不判断"财务造假"，只写"勾稽不通过/异常/需核"；
- 不把数据库终端数字当原始披露；
- 不混用营业收入与营业总收入、净利润与归母净利润；
- 不忽略金额单位与受限资金；
- 不用同行均值替代本公司数字；
- 不声称已核验或专家已审。

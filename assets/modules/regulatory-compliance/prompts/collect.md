# {{module.name}} · 采集任务：行政监管与信用

## 任务

对 **{{company.name}}**（代码 {{company.code}}）及子公司，检索近 {{params.yearsBack}} 年的行政处罚、纳税/海关信用、经营异常与监管问询。
委托方：{{project.client}}；模块：{{module.name}}；分区：{{unit.partition}}。
产出底稿 `regulatory.compliance`，只记录公示事实，不做法律定性。

## 输入

- 主体识别（全称、统一社会信用代码、注册地）：{{artifact:company.identity}}
- 业务与行业（决定主管部门）：{{artifact:business.segment}}

## 参数

- 回溯年限：{{params.yearsBack}} 年（窗口外但未履行/未修复的必须收录）
- 剩余预算：{{budget.remaining}}

## 必答问题（每条落到 `data` 或 `openQuestions`）

1. 近 {{params.yearsBack}} 年公司及子公司有多少行政处罚？谁处罚、什么事、多少钱？
2. 罚款是否已缴纳、整改是否完成？有没有复议、诉讼、撤销？
3. 纳税信用等级是什么（A/B/M/C/D），哪个评价年度？有没有重大税收违法失信？
4. 海关信用等级是什么（高级认证/一般认证/一般信用/失信）？是否有进出口业务？
5. 是否被列入经营异常名录或严重违法失信名单？是否已移出？
6. 有没有监管问询、关注函、警示函、纪律处分（非行政处罚）？
7. 是否有在立案调查但尚未作出处罚决定的事项？

## 检索词起点

- `"<公司全称>" 行政处罚` / `"<公司全称>" 处罚决定书`
- `"<公司全称>" 经营异常` / `"<公司全称>" 严重违法失信`
- `"<公司全称>" 纳税信用` / `"<公司全称>" 重大税收违法`
- `"<公司全称>" 海关 失信` / `"<公司全称>" AEO`
- `"<公司全称>" 警示函` / `"<公司全称>" 监管关注函`

## 检索路径（按序执行）

1. 信用中国：行政处罚、失信被执行人、经营异常、严重违法失信名单；
2. 国家企业信用信息公示系统：行政处罚、经营异常、严重违法失信；
3. 省级税务局：纳税信用等级与 A 级名单、重大税收违法失信主体公布；
4. 海关总署：企业信用信息公示与 AEO 名单；
5. 省/市生态环境局、应急管理局：行政处罚决定书公示；
6. 证监会/交易所：监管措施、纪律处分、问询函；
7. 年报"重大处罚与整改"与公告核对金额与进展。

## 输出字段清单

- `data.penalties[]`：authority / date / matter / amount / status / note
- `data.taxCredit`：level / asOf / note
- `data.customsCredit`：level / asOf / note
- `data.abnormal[]`：reason / date / status / note

## 口径要求

- `penalties.status` 只用：已履行/未履行/复议中/诉讼中/已撤销/unknown；
- `amount` 带币种；无罚款的写 `null` 并在 note 写处罚种类（警告/没收/责令停产/吊销）；
- `taxCredit.level` 取 A/B/M/C/D，查不到填 `not_disclosed_after_search` 并在 note 写检索记录；
- `customsCredit.level` 取 高级认证/一般认证/一般信用/失信，无进出口业务填 `not_applicable`；
- `taxCredit.asOf` 写评价年度（如"2024 年度评价"），不写查询日；
- 每条记录写主体匹配依据（统一社会信用代码优先）。

## 六态写法

- 只有媒体报道：不写入 `data.penalties`，进 `openQuestions`；
- 只知罚款下限：`lower_bound`；
- 需决定书全文/缴款凭证：`pending_dd`；
- 公司披露与公示冲突：`conflict` + 两组值；
- 确认无记录：`not_applicable` + 检索范围与日期；
- 处罚敞口汇总：可 `estimated`，必须带 `derivation`；处罚事实与等级不得 estimated。

## 不要做

- 不做"重大违法行为"的法律认定，只写"需核是否构成发行障碍"；
- 不把监管问询/关注函写成行政处罚；
- 不把经营异常写成处罚；
- 不把子公司记录直接记到母公司名下（note 说明合并口径）；
- 不用罚款金额判断违法严重性；
- 不声称已核验或专家已审。

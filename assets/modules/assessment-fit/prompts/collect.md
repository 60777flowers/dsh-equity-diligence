# {{module.name}} · 评估任务：合作契合度（委托方视角）

## 任务

从委托方 **{{project.client}}** 的视角，评估 **{{company.name}}**（代码 {{company.code}}）的技术/商业合作适配度，并把股权投资判断单独写成 IC 输入。
委托方档案：`{{params.clientProfile}}`；模块：{{module.name}}；分区：{{unit.partition}}。
本模块是 **assess** 类型：以已有底稿为主，只补关键缺口，不重复检索已完成的事实。

## 输入

- 股权与控制链：{{artifact:ownership.chain}}
- 业务、产品与技术路线：{{artifact:business.segment}}
- 投资版图（是否已有关系）：{{artifact:investment.map}}
- 知识产权（软引用）：{{artifact:ip.portfolio}}
- 财务（软引用）：{{artifact:financials.public}}
- 技术来源（软引用）：{{artifact:tech.origin}}

## 参数

- 委托方档案：{{params.clientProfile}}（默认 example；只用项目内背景文件，禁止联网搜索或编造委托方背景）
- 剩余预算：{{budget.remaining}}（本模块预算小，优先复用上游底稿）

## 必答问题（每条落到 `data` 或 `openQuestions`）

1. a 项：产品/技术是否落在委托方所需环节？具体对应哪个环节？
2. b 项：是否已有进入委托方或主流晶圆厂的验证/量产记录？现在处于送样、单项验证、小批量还是量产导入？
3. c 项：是否国产替代直接受益？卡的是哪个环节、为什么难替代？
4. d 项：技术路线是否与委托方工艺兼容（节点、材料体系、接口）？
5. 商务可行性：产能、价格、交付、认证周期、客户关系分别如何？
6. 适合哪种合作方式？理由与下一步分别是什么？
7. 股权投资视角：估值、轮次、股权结构、治理、退出各自是什么状态？还缺什么？

## 检索要求

- 先读上游底稿，**只在缺关键证据时**补检索（≤4 次工具调用）；
- 补检索优先：客户验证公告/供应商目录、产品参数页、招投标或中标记录、专利与标准参与；
- 不得重复查已完成的事实；不得用行业均值替代公司特定事实。

## 输出字段清单

- `data.technologyFit`：六态对象（status / value / note / evidenceIds）
- `data.commercialFit`：六态对象
- `data.equityView`：六态对象
- `data.approach[]`：mode / rationale / nextStep
- `data.conclusion`：technologyCommercial / equityInvestment / basis[] / limitations[]

## 判定口径

- `technologyFit.value` 取 高 / 中 / 低 / 不适合；a/b/c/d 四项逐项写结论，不得只给总分；
- `commercialFit.value` 取 高 / 中 / 低 / 不适合；必须有产能/价格/交付/认证中至少两项依据；
- `equityView.value` 取 具备条件 / 需观察 / 不具备条件 / unknown；
- `approach[].mode` 用固定词：送样验证 / 联合开发（JDA）/ 技术授权 / 代工封测 / 供货 / 合资 / 股权投资；
- `nextStep` 写"谁在什么时间做什么"，不写"加强沟通"；
- 认证周期只能写"按委托方口径的行业认证周期"，不得写成该公司的认证进度。

## 六态写法

- 有证据支撑的判断：`found`；
- 适配度打分等分析判断：可 `estimated`，必须带 `derivation`（方法、输入、可比、假设）；
- 需客户验证报告/产能确认/报价单：`pending_dd`；
- 查过公开渠道仍无：`not_disclosed_after_search` + 检索记录；
- 不同来源判断矛盾：`conflict` + 两方依据；
- 业务完全无关：`not_applicable` + 依据。

## 不要做

- 不给投资建议（不写"建议投资/不建议投资"）；
- 不因为技术对得上就推导"值得投"，也不因为估值贵就否定技术合作；
- 不把送样当验证通过、不把客户名单当已供货；
- 不用同行估值/行业均值替代公司特定事实；
- 不编造委托方背景或合作意向；
- 不承诺合作，不评价委托方战略；
- 不声称已核验或专家已审。

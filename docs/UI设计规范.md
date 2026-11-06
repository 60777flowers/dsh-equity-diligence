# 一级市场调查工作台 · UI 设计规范

> 版本 v1.0 · 2026-11-07 · 状态：设计冻结稿（供内核 / 执行器 / Client UI / 交付 / QA 实现）
> 读者：Client UI 实现者、内核 API 维护者、交付与 QA。
> 依据：`docs/实现契约.md` v1.0（32 类底稿、状态字段（旧称六态，8 个取值）、五页签、`/api/equity/*`）；`../docs/工作计划.md` §9「UI 纲要」（任务书写的 `../../docs/工作计划.md` 不存在，实际文件在插件上一级 `docs/`）；Anthropic Finance skills 的 `3-statement-model` / `comps-analysis` / `datapack-builder` / `ib-check-deck`；DSH `@deepseek-ai/dsh-client-ui-theme` 0.2.1-rc.5 的 `--dsw-*` token 实测值。
> 边界：本文件只定义视觉与交互，不定义数据模型。字段含义、状态机、API 一律以契约为准。

## 1. 设计原则

| 原则 | 含义 | 可检验的做法 |
|---|---|---|
| **只回答三问** | 查了没有＝覆盖与进度；查得对不对＝证据、冲突、审核；能不能交＝QA 与签发 | 每个页签顶部固定一条「三问摘要」，不允许只放统计卡 |
| **信息密度优先** | 一屏能判断，不靠滚动与折叠 | 1440×900 下首屏必须同时出现覆盖矩阵、待人工数、交付阻断数 |
| **克制用色** | 3 蓝 + 1 灰 + 白；彩色面积 ≤ 屏幕 10% | 语义色只用于状态点、左侧 3px 轨、≤14% 透明底；正文与表格永不着色块 |
| **数字可追溯** | 每个数字都能回到 claim 与 evidence | 数字节点带 `data-eq-claim`；单击打开证据抽屉，右键/菜单「复制引用」 |
| **失败显性** | 失败是首屏信息，不是日志细节 | 失败按错误码分组并计数，置顶横幅 + 页签角标，不自动折叠 |
| **不隐藏 stale** | stale 是交付风险，不是缓存问题 | 常驻 stale 计数；行内 badge；详情显示「上游更新，需重跑（N 个单元）」 |
| **单一真相** | UI 与工具调用同一套 `EquityService`，不做第二份缓存判断 | 所有写操作走 `/api/equity/*`；UI 不自行推导 verified/stale |
| **可交付性优先** | 任何页面都要能回答「还差什么才能签发」 | 状态条右侧常驻「交付阻断 N」入口，直达 §4.6 交付页签 |

## 2. 视觉语言

### 2.1 双层用色模型

- **第 1 层（宿主层）**：页面背景、卡片、表头、边框、文字、按钮、输入框、菜单、抽屉、toast、焦点环，**必须**引用 DSH `--dsw-alias-*` / `--dsw-specific-*` / `--dsw-radius-*`，不写死十六进制。宿主切 light/dark 时自动跟随。
- **第 2 层（数据层）**：海军蓝 `#1F4E79`、浅蓝 `#D9E1F2`、浅灰 `#F2F2F2`、强调蓝 `#BDD7EE`，只用于**数据标识**——分组表头、KPI 数字、矩阵表头、区块竖线、导出/打印视图。不得用于按钮填充、链接、焦点、toast。
- 原因：DSH 的 `--dsw-alias-brand-primary` 在浅色是近黑 `#0F1115`、深色是近白 `#F9FAFB`，本身不是蓝色；交互蓝由 `--dsw-alias-state-business-primary` 承担。把海军蓝拿去做主按钮会在深色模式失效，也破坏宿主一致性。

### 2.2 语义映射表（light / dark）

下表 `--eq-*` 只做别名：除成功/警告/错误文字色与 stale 底由 DSH 状态色混合或直接取 DSH static 色外，其余值全部指向 DSH token；括号内为实测解析值（rc.5）。

| 语义 | `--eq-*` | Light（DSH token → 值） | Dark（DSH token → 值） | 用途 |
|---|---|---|---|---|
| 页面底 | `--eq-bg-base` | `--dsw-alias-bg-base` `#FFFFFF` | `#151517` | 工作台背景 |
| 表面 1 | `--eq-surface-1` | `--dsw-alias-bg-layer-1` `#FFFFFF` | `#232324` | 卡片、表格容器 |
| 表面 2 | `--eq-surface-2` | `--dsw-alias-bg-layer-2` `#FFFFFF` | `#2C2C2E` | 抽屉、浮层、表头 |
| 下沉面 | `--eq-surface-sunken` | `--dsw-specific-sidebar-fill` `#F9FAFB` | `#1B1B1C` | 左项目栏、分组行 |
| 细边框 | `--eq-border-subtle` | `--dsw-alias-border-l1` `#0000000A` | `#FFFFFF0F` | 行分隔、表格内线 |
| 边框 | `--eq-border` | `--dsw-alias-border-l2` `#0000001A` | `#FFFFFF1F` | 卡片、输入框、抽屉边 |
| 强边框 | `--eq-border-strong` | `--dsw-alias-border-l4` `#00000029` | `#FFFFFF33` | 选中表、浮层轮廓 |
| 文字一级 | `--eq-text-1` | `--dsw-alias-label-primary` `#0F1115` | `#F9FAFB` | 正文、数字、表头 |
| 文字二级 | `--eq-text-2` | `--dsw-alias-label-secondary` `#61666B` | `#CFD3D6` | 标签、次要说明（≥11px 唯一可用灰） |
| 文字三级 | `--eq-text-3` | `--dsw-alias-label-tertiary` `#81858C` | `#ADB2B8` | 仅 ≥16px 辅助文字 |
| 禁用文字 | `--eq-text-disabled` | `--dsw-alias-label-dimmed` `#E1E5EE` | `#43454A` | 禁用控件，不承载信息 |
| 品牌（宿主） | `--eq-brand-host` | `--dsw-alias-brand-primary` `#0F1115` | `#F9FAFB` | 当前页签下划线、一级导航选中 |
| 交互蓝 | `--eq-brand` / `--eq-running` | `--dsw-alias-state-business-primary` `#4176E6` | `#7AAAFF` | 链接、焦点、running 点/条 |
| 主按钮 | `--eq-action` | `--dsw-alias-button-primary-fill` `#0F1115` | `#F9FAFB` | 主按钮填充（文字用 `label-primary-foreground`） |
| 成功 | `--eq-success` / `--eq-success-fg` | 点 `--dsw-alias-state-success-primary` `#22C55E`；字 `#157A3A` | 点 `#22C55E`；字 `--dsw-static-green-400` `#4ED17E` | 点/条用点色，小字必须用字色 |
| 警告 | `--eq-warn` / `--eq-warn-fg` | 点 `#F59E0B`；字 `#875706` | 点 `#F59E0B`；字 `--dsw-static-amber-400` `#F7AD31` | 点/条用点色，小字必须用字色 |
| 错误 | `--eq-error` / `--eq-error-fg` | 点 `#EC1313`；字 `#C21010` | 点 `--dsw-static-red-400` `#F25A5A`；字同左 | 点/条用点色，小字必须用字色 |
| 中性 | `--eq-neutral` | `--dsw-alias-state-idle-primary` `#D4D4D4` | `#545557` | 未开始、未知 |
| stale | `--eq-stale-bg` / `--eq-stale-fg` | 底 `#FEF1DD`；字 `#875706` | 底 `#392B15`；字 `#F7AD31` | stale badge 底与字 |
| 选中行 | `--eq-selection` | `--dsw-alias-interactive-bg-active` `#2631481A` | `#FFFFFF24` | 表格选中 |
| 遮罩 | `--eq-overlay` | `--dsw-alias-bg-mask-1` `#0000003D` | `#00000080` | 抽屉遮罩 |

**对比度硬约束**：`label-tertiary` 浅色在白色上仅 3.7:1，只允许用于 ≥16px 或纯装饰；11–13px 的次要信息一律用 `--eq-text-2`（5.8:1）。`state-warn-label`（`#DD8629`，2.8:1）与 `state-error-primary`（`#EC1313`，4.49:1）**不得**直接做小字，必须走 `--eq-warn-fg` / `--eq-error-fg`。`label-caption` 浅色仅 2.1:1，本工作台不用于任何可读文案。

### 2.3 数据强调色配额

| 令牌 | Light | Dark | 只允许出现在 |
|---|---|---|---|
| `--eq-navy` | `#1F4E79` | `#9CB6D4`（由海军蓝提亮，非 DSH token） | 区块标题文字、KPI 数字、矩阵表头文字 |
| `--eq-navy-weak` | `#D9E1F2` | `--dsw-static-deepseek-900` `#283142` | 分组表头底、选中列底 |
| `--eq-navy-rule` | `#BDD7EE` | `#3A5673` | 区块下 2px 分隔线、进度完成段 |
| `--eq-grey-fill` | `--dsw-static-neutral-100` `#F5F5F5` | `--dsw-alias-bg-layer-2` `#2C2C2E` | 表头底、统计行底；`#F2F2F2` 只用于导出/打印模板 |

单屏配额：数据色面积 ≤ 25%，语义状态色 ≤ 10%；同屏出现 ≥3 个语义色时，必须同时有文字说明，避免「红绿灯墙」。

### 2.4 焦点、圆角、阴影、层级

- 焦点环：`outline: 2px solid var(--eq-brand); outline-offset: 2px;`。DSH `focus.css` 已提供 `:focus-visible` 兜底（颜色读 `--dsw-focus-ring-color`，缺省回退 `--dsw-alias-state-business-primary`；宽 2px；只给颜色与宽度，样式需组件自己声明 `solid`），但指针模态下该环对非可编辑控件透明，故表格行、矩阵单元必须自带 `data-eq-state="focused"` 的 2px 内描边，键盘与指针都可辨认。禁止 `outline: none` 后不给替代。
- 圆角：badge / 矩阵格 `4px`（`--dsw-radius-xs`）；卡片 / 输入框 / 表格容器 `8px`（`--dsw-radius-sm`）；抽屉 / 对话框 `12px`（`--dsw-radius-md`）。不使用 `panel 28px`，避免与宿主外框抢层级。
- 阴影：卡片默认无阴影，用 `--eq-border` + 必要时 `--dsw-elevation-panel`；抽屉用 `--dsw-elevation-prominent`；toast 用 `--dsw-shadow-lv3`。禁止自定义投影。
- 层级：`--eq-z-sticky:10`、`--eq-z-drawer:30`、`--eq-z-overlay:40`、`--eq-z-dialog:60`、`--eq-z-toast:70`。全部在 `.eq-root` 内，不进入宿主 stacking context。

## 3. 排版与表格

### 3.1 字体栈

| 角色 | 取值 | 说明 |
|---|---|---|
| 正文 / UI | `var(--dsw-font-family)` | 宿主系统栈：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", …` |
| 数字 | `var(--dsw-font-family)` + `font-variant-numeric: tabular-nums` | 不整段用等宽字体，避免中文错位；数字列靠 tnum 对齐 |
| ID / 哈希 / 代码 | `var(--ds-font-family-code)` | `SF Mono, JetBrains Mono, Fira Code, Consolas, …` |
| 品牌字 | 不使用 `--dsw-font-family-brand` | Montserrat 只服务宿主品牌位，工作台内不出现 |

### 3.2 字号阶梯（rem 随浏览器缩放；括号为默认 16px 根字号下的 px）

| Token | rem | px | 行高 | 字重 | 用途 |
|---|---|---|---|---|---|
| `--eq-fs-11` | 0.6875 | 11 | 16 | 400 | 时间戳、来源页脚（配 `--eq-text-2`） |
| `--eq-fs-12` | 0.75 | 12 | 18 | 400 / 500 | 表格正文、badge、标签 |
| `--eq-fs-13` | 0.8125 | 13 | 20 | 400 | 表单、正文默认 |
| `--eq-fs-14` | 0.875 | 14 | 22 | 400 / 600 | 卡片标题、摘要正文 |
| `--eq-fs-16` | 1 | 16 | 24 | 600 | 区块标题、抽屉标题 |
| `--eq-fs-20` | 1.25 | 20 | 28 | 600 | 页面标题、页签名 |
| `--eq-fs-24` | 1.5 | 24 | 32 | 600 | KPI 数字（唯一允许 24px 的位置） |

字重只用 400 / 500 / 600；不用 700，避免密集表格发黑。中文不设 letter-spacing；11–12px 的拉丁标签可设 `0.02em`。正文行宽上限 `760px`，表格与矩阵不受此限。

### 3.3 数字、百分比、金额、日期

| 类型 | 显示 | 规则 |
|---|---|---|
| 百分比 | `42.5%` | 固定 1 位小数；`<0.1%` 原样显示；未知用 `—`，不得写 `0%` |
| 区间 | `3–5 家`、`≥42.5%` | 用 en dash `–`；下限用 `≥` 且字段状态必须是 `lower_bound` |
| 金额（人民币） | `¥1.23 亿`、`¥4,560 万` | 源数据什么币种就显示什么币种；非 CNY 加 `US$` / `HK$` 前缀；单位进表头，不进单元格 |
| 倍数 | `13.5×` | 用 `×`（U+00D7），不用字母 x |
| 计数 | `1,024` | 千分位；整数，不补小数 |
| 日期 / 时间 | `2026-09-30` / `2026-11-07 14:32` | 日期一律 ISO 短格式，期间写 `2026Q3` / `FY2025`；列表用相对时间 `3 天前` + `title` 绝对值；抽屉内给绝对时间 + 时区 |
| 版本 / 哈希 | `r3` · `0.1.0` · `sha256:9f2c…a71d` | 底稿 revision 用 `rN`，模块版本用 semver；哈希前 6 + 后 4，点击复制完整值 |
| 负数 | `−1.2%` | 展示用 U+2212；导出 CSV 用 ASCII `-` |
| 空值 | `—` | 与 `not_applicable`、`not_reviewed` 区分：空值不带 badge，状态值必须带 badge |

数字列右对齐、表头右对齐；文本列左对齐；状态列居中。不要为了「整齐」把文本居中。

### 3.4 表格规范

- 语义：真实 `<table>`，`<caption>` 视觉隐藏；表头 `<th scope="col">`，分组行 `<th scope="rowgroup">`；不使用 div 网格模拟数据表。
- 表头高 `32px`，底 `--eq-grey-fill`，文字 12/18 / 500，粘顶；首列粘左（最多冻结 2 列），`z-index` 用 `--eq-z-sticky`。
- 行高：默认 `28px`；表单型表格 `36px`；矩阵单元 `24px`。单元格内边距 `0 8px`，首列 `0 8px 0 12px`。
- 分隔：只用 `--eq-border-subtle` 的 1px 横线；无竖线、无斑马纹；hover 用 `--dsw-alias-interactive-bg-hover`；选中行左侧 3px `--eq-brand`，底 `--eq-selection`。
- 可追溯：由 claim 派生的单元格带 `data-eq-claim="cl_…"`，单击开证据抽屉，右键菜单「复制 claimId / 复制引用」；计算值带 `data-eq-derivation`。
- 排序：三态（无 / 升 / 降），箭头 12px + `aria-sort`；筛选用 chip，chip 上带计数（`冲突 2`）；清空筛选必须一键可达。
- 统计行：只在数值列有意义时出现（合计、中位、最大），左侧标签「统计」，底 `--eq-grey-fill`；百分比不自动求和。
- 表格底部：`已显示 18 / 32 类 · 2 份 stale`；分页仅在 >100 行时出现。
- 空表体：`<tr><td colspan>` 放空状态（§5.4），不允许只留表头。

### 3.5 密度

| 密度 | 行高 | 使用场景 | 切换 |
|---|---|---|---|
| 紧凑 | 24 | 覆盖矩阵、单元矩阵 | 矩阵固定，不提供切换 |
| 默认 | 28 | 底稿表、Claim 表、QA 清单 | 用户偏好写入 `localStorage.eq.density` |
| 舒适 | 36 | 方案表单、签发表单 | 同上 |

密度切换只影响行高与内边距，不影响字号；不要用缩小字号来「塞下更多」。

## 4. 布局

### 4.1 全屏工作台结构

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ 一级市场调查 · 中际旭创   [标准尽调 ▾]   asOf 2026-09-30 · CNY   [编译] [运行] [交付]  │ 48
├──────────────┬──────────────────────────────────────────────────┬───────────────────┤
│ 项目          │ 总览   方案   底稿   运行   交付                   │ 证据               │
│ ● 中际旭创    │ ┌ KPI ──────────────────────────────────────────┐ │ ev_01J8…           │
│   标准 · 18 模块│ │ 覆盖 27/32  已验证 18  待人工 3  冲突 2  阻断 3│ │ 巨潮资讯 · 公告     │
│ ○ 案例 B      │ └───────────────────────────────────────────────┘ │ “……持股 42.5%……”   │
│ + 新建项目    │  查了没有            查得对不对         能不能交   │ p.4 ¶2   [原文]    │
│              │ ┌ 覆盖矩阵 ────────┐ ┌ 待人工 / 冲突 ──┐ ┌ QA ────┐ │ A · 独立 · 已核     │
│              │ │ 32 类 × 6 主体    │ │ 3 项             │ │ 3 项   │ │ raw sha256:9f2c…   │
│              │ └──────────────────┘ └─────────────────┘ └────────┘ ● running 12/24 · 38% │
├──────────────┴──────────────────────────────────────────────────┴───────────────────┤
│ 就绪 · 离线缓存 2 项 · 上次同步 14:32                          [状态条 28px]          │
└─────────────────────────────────────────────────────────────────────────────────────┘
  280px                         自适应（≥ 640px）                      360px（320–560）
```

尺寸：顶栏 `48`；状态条 `28`；左栏 `280`（面板内自绘，不是宿主 sidebar；宿主侧栏只承载入口图标）；证据抽屉 `360` 默认 / `320` 最小 / `560` 最大；主内容最小 `640`，低于此值抽屉转遮罩。页面内边距 `24`，卡片间距 `16`，卡片内边距 `16`。所有列高 `100%`，仅主内容与抽屉内部滚动，页面本身不出现纵向滚动条。

### 4.2 总览（默认页签）

```
KPI strip（6 列等宽 × 64 高）
┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
│ 覆盖      │ 已验证    │ 待人工    │ 冲突     │ 重大红旗  │ 交付阻断  │
│ 27/32    │ 18       │ 3        │ 2        │ 4        │ 3        │
│ 查了没有  │ 查得对不对 │ 需你裁决  │ 待选源    │ material │ 不能交    │
└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
┌──────────────────────────────┐ ┌──────────────────────────────┐
│ 主体与股权  ●●●◐●○  …        │ │ 待人工 3  [去裁决]            │
│ 业务与技术  ●●○—●●  …        │ │ 冲突 2    [选择来源]          │
│ 财务与融资  ●●○     …        │ │ 交付阻断 3 [看 QA]            │
│ 市场与合规  ◐●!●●●  …        │ │ 最近运行 12/24 · 预算 38%     │
│ 交付与系统  ●●●●    …        │ │ 失败 3 家：限流 2、超时 1     │
└──────────────────────────────┘ └──────────────────────────────┘
```

交互：点矩阵格 → 打开该主体该类底稿详情；点 KPI → 跳到对应页签并带筛选；「待人工」「冲突」是按钮不是数字；首屏不放大盘、不画趋势图、不放插画。

### 4.3 方案

```
[结构] [YAML] [表单]        编译通过 · 18 模块 · 24 家 · 2.1M tokens     [一键重排] [运行]
┌ 1 主体 ───────────────────────────────────────────────────────────────────────────┐
│ ① entity-resolution   builtin@0.1  ·  company.roster → company.identity   ▸参数 2  │
│ ② ownership-chain     builtin@0.1  ·  company.identity → ownership.chain  ▸参数 1  │
├ 2 股权 ───────────────────────────────────────────────────────────────────────────┤
│ ③ investment-map      builtin@0.1  ·  ownership.chain → investment.map    ⚠ 位置   │
│ ④ related-parties     builtin@0.1  ·  company.identity → related.parties           │
└───────────────────────────────────────────────────────────────────────────────────┘
⚠ 3 处依赖问题  ·  investment-map 需要 ownership.chain（第 3 行）  [定位] [一键重排]
```

- 行结构：序号 24px（等宽）+ 模块名 200px + 版本 64px + `输入 → 输出` 弹性 + 参数/门/预算 chips + 拖拽手柄 + 更多菜单。
- 行高 44；分组头 32；分组可折叠，但**错误行所在分组强制展开**。
- 顶部三段控件：`结构`（默认，列表）/ `YAML`（等宽 12px，带行号与错误定位）/ `表单`（模块参数表单）。三者等价，YAML 永远不是唯一入口。
- 编译错误用红色行内条：`错误码 · 字段 · 位置 · 修复建议`，右侧「定位」「一键重排」。错误码用代码字体。
- 底部固定摘要条：`编译通过/失败 · N 模块 · M 家 · 预算 X tokens / Y 分钟`；预算是估算时标注「估算」。
- 模块 `status: draft` 必须在行尾显示 `draft` 灰 badge，避免看起来已稳定。

### 4.4 底稿

```
[类型 ▾ 全部 32] [主体 ▾ 中际旭创] [状态 ▾ 全部] ⚠ 2 份 stale        搜索 /        [导出]
┌ 类型                  主体      版本  状态          更新时间        证据  操作 ┐
│ investment.map        _summary  r3    ✓ 已验证      11-06 23:41     96    …   │
│ legal.risk            co_01     r1    ⚠ stale       11-05 09:12     18    …   │
└──────────────────────────────────────────────────────────────────────────────┘
右侧/下方详情：内容摘要 · 血缘（derivedFrom） · checks · openQuestions · [看证据] [重跑]
```

- 首列类型按 §5.2 的 6 组分组；`legacy` 类型（`company.history`、`ops.risk`）只读，行尾标 `legacy`。
- stale 行：底色 `--eq-stale-bg` 的 40%，左侧 3px `--eq-warn`，文案「上游更新，需重跑」；**不得**把 stale 显示成 verified 的灰色版本。
- 详情用「摘要 / 血缘 / 检查 / 问题」四段，不弹第二层模态；点证据开右侧抽屉，抽屉内容随选中 artifact 切换但不关闭。
- 人工动作：`标记待核`、`裁决冲突`、`重跑`；`rejected` 只能由人工触发，Agent 结果不出现「否决」主按钮。

### 4.5 运行

```
运行 run_01J8…   ● running   12/24   预算 38%   [暂停] [重试失败 3] [取消]
┌ 单元 \ 主体      中际旭创   平台 P01   实体 E01   … 24 家   ┐
│ entity-resolution  ✓ 10:02   ✓ 10:04    ✓ 10:06           │
│ investment-map     ⚠ 待人工   ✕ 限流      · 待开始           │
└──────────────────────────────────────────────────────────────┘
失败 3 · 限流 2 · 超时 1        事件流（最近 20 条，可展开）
```

- 矩阵：行 = 模块实例（按拓扑序分组），列 = 主体 / 平台 / 分区；单元格 `24×24`，内含 12px 图标 + 可选短码；表头粘顶，首列粘左。
- 单元格编码：`✓` accepted（绿）、`◐` running（蓝，带 1.2s 旋转，reduced motion 下静态）、`◷` review（琥珀）、`!` needs_human（琥珀实心）、`✕` failed（红）、`·` todo（灰）。**每个格子必须有 `aria-label` 与 tooltip**。
- 超过 24 列：横向滚动 + 「24 家 / 全部 187 家」切换；不缩小单元格。
- 失败按错误码聚合为可展开组，组头 `限流 2 家 [全部重试]`；`budget_exhausted` 显示为「预算触顶，已保存现场」，不是 failed。
- 实时：按契约的 `GET` 轮询（Web API 无流式端点），页面隐藏时暂停；进度用 `aria-live="polite"` 节流 1 次/秒。

### 4.6 交付

```
交付前检查   阻断 3 · 非阻断 7                               [构建交付包] [体检]
┌ 阻断项 ───────────────────────────────────────────────────────────────────────┐
│ ✕ 一致性：报告数字与底稿不一致 3 处                         [查看差异]          │
│ ✕ stale：5 份底稿未重跑                                     [去重跑]            │
│ ✕ 签发：approvedBy 未填                                     [去签发]            │
├ 非阻断项 ─────────────────────────────────────────────────────────────────────┤
│ ! 红旗 T2 未处理 2 条 · 覆盖 27/32（缺 policy.exposure, draft）                 │
└───────────────────────────────────────────────────────────────────────────────┘
产物：01_管理层摘要.md · 02_综合尽调工作簿.xlsx · 03_专项_投资版图_7+N.xlsx · manifest.json
签发表（§5.1）：preparedBy · reviewedBy · approvedBy · 时间 · 决定 · 意见
```

- 阻断项与「构建」「签发」按钮同屏；阻断未清零时按钮 `disabled` 且 `aria-disabled`，旁边说明缺什么，不做静默禁用。
- 体检结果分「阻断 / 非阻断」两段，默认全展开；每条给「查看差异 / 去修复」。
- 产物行显示文件大小、生成时间、sha256 短码、下载；不显示「重新生成」以外的装饰按钮。
- 签发表单三行 `preparedBy / reviewedBy / approvedBy`，每行姓名 + 时间 + 决定 + 意见；驳回与豁免必填 ≥20 字；Agent 只能「提议」，`approve/signoff/waive` 仅用户通道，二次确认须列出报告名、版本与 hash。

### 4.7 侧栏入口与会话内工具结果卡

- 侧栏：`sidebar.panellist` 注册一项，id `equity-workbench`，图标 16px `currentColor`，label「一级市场调查」，order 40。**不自行向宿主图标叠加角标**；待办数进面板后在页签上显示（`运行 3`）。
- 工具结果卡（`tool.call.toolview`）保持轻量：单层边框、无内嵌卡片、无图表、最大宽 `560`、内边距 `12`、高度 ≤ `96`：

```
┌ equity_run · 已启动 run_01J8…                    [打开工作台] ┐
│ 标准尽调 · 24 单元 · 12/24 运行中 · 预算 38% · 失败 0          │
└──────────────────────────────────────────────────────────────┘
```

- 卡片固定三段：标题（工具名 + 一句话结果）、一行关键数字、1 主 1 次两个动作。失败时标题右侧红色 `✕` + 错误码，主动作变「查看原因」。
- 6 个工具各自一张卡：`equity_project`（项目卡）、`equity_playbook`（编译卡）、`equity_run`（运行卡）、`equity_record`（写入卡）、`equity_review`（裁决卡）、`equity_deliver`（交付卡）。未注册的工具走宿主通用行。

## 5. 组件清单

### 5.1 清单与规格

| 组件 | 结构 / 尺寸 | 关键 token | 状态与交互 |
|---|---|---|---|
| 项目卡 | 248×72（左栏 280 − 2×16）；名称 14/600 + preset 12 + 三问三数字 | `--eq-surface-1`、`--eq-border` | 当前项左侧 3px `--eq-brand`；hover 抬底；点击切换 |
| KPI strip | 6 列等宽（`minmax(0,1fr)`）× 64 高；数字 24/600，标签 12 | `--eq-navy`（数字）、`--eq-text-2` | 可点击跳转；数值 0 时仍显示，不用「—」 |
| 覆盖矩阵 | 行 32 类 × 列 N 主体；格 24×24；行头 180 | 状态语义色 + 文本 | 格点击进详情；键盘方向键；图例常驻 |
| 方案模块行 | 高 44；序号 / 名称 / 版本 / IO / 参数 / 拖拽 | `--eq-border-subtle` | 拖拽排序；错误行红条；draft badge |
| 依赖错误行 | 高 28；`code · 字段 · 位置 · 建议` | `--eq-error-fg` | 点击定位；「一键重排」带确认 |
| 底稿表 | 行 28；类型 / 主体 / 版本 / 状态 / 时间 / 证据 | 表头 `--eq-grey-fill` | 排序、筛选、stale 底色；行点击开详情 |
| Claim 表 | 列：predicate / value / unit / period / status / materiality / 证据数 | 同上 | material 行加粗 predicate；点证据开抽屉 |
| 证据抽屉 | 宽 360（320–560）；四段式 | `--eq-surface-2`、`--eq-overlay` | 可调宽；Esc 关闭；焦点陷阱 |
| 运行单元矩阵 | 格 24；行头 160；列头 96 | 状态语义色 | 格点击开单元详情；失败批量重试 |
| 预算条 | 高 6；三段（已用 / 保留 / 上限）；工具调用、tokens、分钟三项取最小 | `--eq-navy-rule`、`--eq-warn`、`--eq-error` | hover 显示 `已用/上限`；触顶标 `budget_exhausted`，不是 failed |
| 红旗列表 | 行 40；等级 / T1–T12 / 主体 / action / 证据 | `--eq-error`、`--eq-warn` | `material` 置顶，`attention` 次之；点击开证据；可标「已处理」 |
| QA 清单 | 行 32；阻断 / 非阻断两段；勾选态 | `--eq-success`、`--eq-error` | 阻断项不可跳过；非阻断可豁免（需理由） |
| 签发表单 | 三行角色；每行姓名 / 时间 / 决定 / 意见 | 表单 token | Agent 只能「提议」，用户才能「批准」 |
| 空状态 | 居中，最大宽 360；图标 24 + 一句 + 1 主 1 次 | `--eq-text-2` | 不用插画；每个空状态必须有出路 |
| 错误 / 离线 banner | 高 36；全宽；图标 + 文案 + 动作 | `--eq-stale-bg`、`--eq-warn-fg`、`--eq-error-fg` | 不遮挡内容；离线显示快照时间 |
| Toast | 宽 ≤ 360；右下；最多 3 条 | `--dsw-alias-toast-bg` | 成功 4s 自动消失；错误常驻；支持撤销 |

### 5.2 覆盖矩阵

- 行分 6 组：主体与股权（6）、业务与技术（6）、财务与融资（3）、市场与合规（7）、人与关系/评估（4）、交付与系统（6），合计 32 类。
- 列 = 主体（公司/平台/实体），最多同屏 12 列，超出横向滚动；列头显示主体短名 + 类型，`title` 给全名。
- 格编码：`●` verified、`◐` draft、`○` 未开始、`!` conflict、`△` stale、`✕` rejected、`—` not_applicable、`≈` estimated（行尾显示估算占比）。形状优先，颜色辅助。
- 行尾汇总：`已查 5/6 · 1 stale`；列尾汇总：`已验证 18/32`。
- 空组（如 `policy.exposure` 为 draft 且未启用）：整行灰化并标 `draft`，不隐藏。
- 键盘：矩阵一个 tab 停靠点，方向键移动，`Enter` 打开，`Home/End` 到行首尾；`aria-rowindex/colindex` 完整。

### 5.3 证据抽屉

顺序固定（对应契约 §12）：来源与等级 → 标题与 URL → 引文（保留原文，不换行截断）→ 定位 `p.4 ¶2` → 抓取时间与时区 → `rawHash` + 原文快照入口 → 四维评分（authority / independence / verification / confidence，四项平铺，不合并成一个分数）→ `originGroupId` 与同源提示 → 被哪些 claim / artifact 引用（反查）。

- 四维用 4 行小表：标签 12/`text-2`，值 12/600；`unverified` / `unknown` 必须显示为灰 badge，不能留空。
- 同源转载：显示「与 ev_… 同源（og_…），不构成独立双源」；这是警示不是错误。
- 抓取失败：显示 `unreachable` + 尝试时间 + 「重抓」；引文未命中：显示 `matches:false` + 「人工核对」，不得自动判假。
- 抽屉内不出现第二层抽屉；「打开原文」在新标签页，`rel="noopener noreferrer"`。

### 5.4 空状态 / 横幅 / Toast

- 空状态三件套：一句事实（「还没有项目」）+ 一句下一步（「新建项目或打开已有目录」）+ 1 主 1 次按钮。禁止「暂无数据」单独出现。
- 离线 banner：`离线：API 不可达，当前显示 14:32 快照` + `重试`；页面其余部分保持可读，写操作全部禁用并给出原因。
- 权限/错误 banner：`<code> · 该操作仅限用户通道` + `复制错误码`；不弹模态。
- Toast：成功可自动消失，错误/警告必须手动关闭；破坏性操作给「撤销」，撤销窗口 10s；`aria-live="polite"`，错误用 `role="alert"`。

## 6. 状态与文案

### 6.1 字段状态 badge（契约称「六态」，实际枚举 8 值，全部覆盖）

| 值 | 中文 | 形状 + 颜色 | 交互 / 约束 |
|---|---|---|---|
| `found` | 已查实 | `✓` 实心绿 | 必须可追溯到 ≥1 条 supports 证据 |
| `not_disclosed_after_search` | 检索未披露 | `⊘` 灰 + 虚线边 | 必须链到 `search.ledger` 的尝试记录 |
| `lower_bound` | 下限 | `≥` 蓝描边 | 数值旁标「下限」，不得当精确值 |
| `pending_dd` | 待尽调 | `◷` 琥珀描边 | 进资料请求清单；不出现在摘要结论 |
| `conflict` | 冲突 | `!` 红 + 左右分叉图标 | 打开候选对比；未选源不得进交付 |
| `not_applicable` | 不适用 | `—` 灰虚线 | 需 `note` 说明原因 |
| `not_reviewed` | 未复核 | `○` 灰空心 | 不得计入「已验证」 |
| `estimated` | 估算 | `≈` 蓝虚线 | 必须显示 `derivation` 入口 |

未知值：灰 badge 显示原值 + `?`，并上报 `warn`；不得静默丢弃。Badge 统一高 20、内边距 `0 6`、圆角 4、字号 12/18、图标 12、间距 4；文字**始终存在**，颜色只做加速识别。

### 6.2 Artifact 四态

| 状态 | 文案 | 视觉（颜色 + 形状） | 交互 / 附加信息 |
|---|---|---|---|
| `draft` | 草稿 | 灰空心圆；行首 3px 灰 | revision、producedBy、未过门原因 |
| `verified` | 已验证 | 绿实心勾 | `updatedAt`、checks 全过、可入交付 |
| `stale` | 上游更新，需重跑 | 琥珀时钟 + 浅琥珀底 | 变化原因（上游内容/代码/依赖/过期/rejected）、受影响下游数 |
| `rejected` | 已否决 · 人工 | 红实心叉 | 决定人、时间、理由；不可由 Agent 触发 |

`affected` 不是状态：单独一行「受影响：5 个下游单元」灰色文字，不改变自身 badge。

### 6.3 Unit 状态

`todo` 待开始（灰点）· `running` 运行中（蓝旋转，reduced motion 下静态 + 「运行中」文字）· `review` 待复核（琥珀）· `accepted` 已接受（绿勾；幂等跳过时角标「跳过」）· `needs_human` 待人工（琥珀实心手形）· `failed` 失败（红叉 + 错误码）。失败单元必须显示 `errorClass` 与「重试」；`needs_human` 不自动重跑，只能人工裁决。

### 6.4 Run 状态

`queued` 排队 · `running` 运行中（蓝）· `paused` 已暂停（琥珀，可恢复）· `completed` 已完成（绿）· `failed` 已失败（红，附失败单元数）· `cancelled` 已取消（灰）· `budget_exhausted` 预算触顶（琥珀条纹 + 「已保存现场」，**不是 failed**）。终态枚举以内核为准；顶部运行条常驻状态 + 进度 `12/24` + 预算百分比。

### 6.5 Check 状态

`pass` 通过（绿）· `warn` 警告（琥珀）· `fail` 失败（红）· `skip` 跳过（灰）。展示为 `门 3 · 2 通过 · 1 失败`；失败展开显示 `expected / actual / detail`；未运行不显示为 pass。`checks` 与 `gates` 名称用代码字体，12px。

### 6.6 文案规则

- 顺序：**状态 → 原因 → 下一步**。例：`3 家失败：限流 2、超时 1 · 全部重试`。
- 禁止：「出错了」「加载失败」等无信息文案；必须带错误码或对象名。
- 数字必须带单位与口径；「约」「预计」只能用于估算，且与 `estimated` 状态同时出现。
- 不用感叹号、不用「AI 认为」、不写投资建议；结论句必须有 claim 支撑。
- 中文全角标点；中英文之间留半角空格；错误码、字段名、类型名保持原样（`company.identity`）。

## 7. 可访问性与响应式

**键盘与焦点**：`Tab` 顺序为顶栏 → 左栏 → 页签 → 主内容 → 抽屉；表格用 roving tabindex（方向键移动、`Enter` 打开、`Space` 选中、`Esc` 关闭）；页签 `Alt+1…5`、`/` 聚焦搜索、`?` 帮助；快捷键写入 `aria-keyshortcuts`。焦点环 2px `--eq-brand` + 2px offset；抽屉打开时进入并陷阱，关闭后回到触发元素；不允许 `outline:none`。

**对比度**：正文 ≥ 4.5:1，大字 ≥ 3:1，控件边界/图标 ≥ 3:1；状态不得只靠颜色（形状 + 文字）；灰度打印/色盲模拟下仍可区分 verified 与 stale。

**窄屏**：≥1440 三栏；1280–1439 抽屉转遮罩；1024–1279 左栏收为 56px 图标轨；768–1023 单列，页签横向滚动，表格横向滚动 + 首列冻结；<768 KPI 2×3、状态条精简、次要列隐藏（可展开）。任何断点都不出现页面级横向滚动。

**深色**：只读 `body[data-ds-dark-theme]`，不写 `prefers-color-scheme` 媒体查询；所有颜色走 token；图表/图标用 `currentColor`；首次绘制不得闪白（宿主 boot palette 已处理，插件不得覆盖）。

**Reduced motion**：`@media (prefers-reduced-motion: reduce)` 下关闭旋转、进度动画、抽屉滑入；用静态文案 + 进度条替代；不自动滚动事件流。

**i18n**：语言由宿主 locale 决定，zh-CN 默认、en 次之；日期/数字用 `Intl`；文案 key 放 `locale/*.json` 的 `equity.*` 命名空间；不拼接句子；图标不带文字；`lang` 属性正确。

## 8. 设计禁区

1. **不做通用 DAG 画布**：不引入节点拖拽、连线、缩放；依赖只用分组列表 + 行内提示 + 拓扑序。
2. **不把 YAML 当唯一入口**：结构/表单/YAML 三视图等价；任何人都能在不用 YAML 的情况下完成编译与运行。
3. **第一屏不放装饰性图表**：不放环形图、趋势图、插画、渐变头图；首屏只放判断所需信息。
4. **不隐藏 stale 与失败**：不折叠、不灰化到不可读、不只放在日志里；全局计数常驻。
5. **不让自定义模块看起来像写代码**：默认只暴露表单字段（名称、kind、输入输出、参数、预算），prompt 与 gate 收进「高级」；编辑 YAML 需要显式切换并二次确认。
6. 不做渐变、玻璃拟态、彩色阴影、超大圆角；不用 emoji 当状态图标。
7. 不用模态套模态；确认框只用于不可逆操作。
8. 不显示无来源的精确数字；不把 `estimated` 与 `found` 混排在同一列而不加标记。
9. 不用自动刷新掩盖延迟；任何后台刷新必须有可见的「更新于」时间。
10. 不在宿主侧栏、顶栏、设置页注入自定义 DOM 或全局样式。

## 9. 与 DSH 宿主的一致性

### 9.1 渲染位（slot）

| 宿主能力 | 本插件用法 | 约束 |
|---|---|---|
| `sidebar.panellist` (list) | 注册 `id: equity-workbench`、本地化 label、16px 图标、order 40 | 不自绘角标；选中由宿主管理 |
| root `main` (keyed slot) | 注册 key `equity-workbench`，与入口 id 一致；`ctx.layout.selectPanel('equity-workbench')` 切换 | 不覆盖 `conversation` key |
| `tool.call.toolview` (keyed) | 为 6 个工具名注册卡片；未命中走宿主 fallback | 只读 `phase/block`，不重建 transcript |
| `shell.bottom` | **不使用** | 避免压缩三列；状态条放面板内 |
| `rightbar` | **不使用** | 证据抽屉在面板内，避免抢占会话文件预览 |
| `ctx.theme` | 只读快照 + `--dsw-*` token | 不注册第三方主题，不改 palette |
| `ctx.locale` | 注册 `equity` 命名空间 | 不覆盖宿主 key |
| `ctx.connection.fetch` | `/api/equity/*`，统一 `{ok,data,error,warnings}` | 不另建 SSE/WS 私有协议，除非契约扩展 |

### 9.2 宿主硬约束

- **不用 iframe**：会断 token、焦点、locale、快捷键与 CSP；用同文档 React 组件。
- **不覆盖 app root**：不改 `#root`、`body` 背景、`html` 字号；不写全局 `*` 选择器；样式全部限定在 `.eq-root` 下。
- **不 portal 到 body**：抽屉、对话框、toast 挂到 `.eq-root` 内的容器，保持主题与 stacking context。
- **不调用宿主私有 DOM**：不查询 `.dsh-*` / CSS module 哈希类名；只用公开 slot 与 token。
- **不复制宿主内部组件**：宿主若暴露 `dsh-client-ui-primitives` 则复用其按钮/输入/菜单/tooltip；未暴露时用原生语义元素 + `--eq-*` token 自建，不查询、不复制宿主私有实现。
- **主题不闪**：不设 `body` 背景；首帧依赖宿主 boot palette。

### 9.3 CSS 变量（规范片段，非实现代码）

```css
.eq-root {
  --eq-topbar-h:48px; --eq-statusbar-h:28px; --eq-row-h:28px; --eq-row-h-comfy:36px;
  --eq-rail-w:280px; --eq-rail-w-collapsed:56px; --eq-drawer-w:360px;
  --eq-drawer-min:320px; --eq-drawer-max:560px; --eq-cell-h:24px; --eq-header-h:32px;
  --eq-s1:4px; --eq-s2:8px; --eq-s3:12px; --eq-s4:16px; --eq-s5:24px; --eq-s6:32px; --eq-s7:48px;
  --eq-fs-11:.6875rem; --eq-fs-12:.75rem; --eq-fs-13:.8125rem; --eq-fs-14:.875rem;
  --eq-fs-16:1rem; --eq-fs-20:1.25rem; --eq-fs-24:1.5rem;
  --eq-radius-xs:var(--dsw-radius-xs); --eq-radius-sm:var(--dsw-radius-sm); --eq-radius-md:var(--dsw-radius-md);
  --eq-z-sticky:10; --eq-z-drawer:30; --eq-z-overlay:40; --eq-z-dialog:60; --eq-z-toast:70;
  --eq-dur-fast:var(--ds-transition-duration-fast); --eq-dur:var(--ds-transition-duration); --eq-ease:var(--ds-ease-in-out);
}
```

### 9.4 class 前缀与状态属性

- 前缀 `eq-`，块名用业务名：`.eq-workbench`、`.eq-topbar`、`.eq-rail`、`.eq-tabs`、`.eq-kpi`、`.eq-matrix`、`.eq-table`、`.eq-row`、`.eq-badge`、`.eq-drawer`、`.eq-banner`、`.eq-toast`、`.eq-toolcard`。
- 元素用 `__`，修饰用 `--`：`.eq-kpi__value`、`.eq-drawer--pinned`；状态一律走属性，不新增类：`data-eq-state="draft|verified|stale|rejected|todo|running|review|accepted|needs_human|failed|selected|focused"`、`data-eq-tone="success|warn|error|neutral"`、`data-eq-density="compact|default|comfortable"`。
- 动态尺寸只允许内联 CSS 变量（预算条宽度、抽屉宽度），不允许内联颜色与字号。

### 9.5 与 API 的契约

- 读：`GET /api/equity/state|playbook|artifact|evidence|modules|file`；写：`POST /api/equity/project|playbook|run|record|review|deliver`。
- 错误统一渲染为：`错误码 · 人话 · requestId（可复制） · 重试`；`warnings[]` 用琥珀条展示，最多 2 条 + 「全部」。
- `approve / signoff / waive` 只从用户通道发起；UI 上 Agent 结果只能出现「提议」按钮，且需二次确认。已知待确认：Run 终态枚举、`sidebar.panellist` badge 能力、stale 专用 token（§2.3）。

## 10. 验收清单

### A. 视觉（10）

- [ ] 组件样式中无硬编码颜色，全部引用 `--dsw-*` 或 `--eq-*`（token 定义处除外）。
- [ ] 1440×900 首屏同时出现覆盖、待人工、交付阻断，无图表与插画。
- [ ] 文字层级不超过三级，11/12/13px 未使用 `label-tertiary` 承载信息。
- [ ] 所有数字列 tnum 右对齐，百分比 1 位小数，金额带币种，日期 ISO。
- [ ] 表头粘顶、首列冻结；默认行高 28；无竖线、无斑马纹。
- [ ] 语义色面积 ≤ 10%，数据色 ≤ 25%，无渐变与自定义阴影。
- [ ] light/dark 直接切换无闪烁，所有表面、边框、文字可读。
- [ ] 空状态均有一句事实 + 一个出路，无死胡同。
- [ ] badge 圆角 4、高 20；卡片圆角 8；抽屉 12。
- [ ] 导出/打印视图与屏幕语义一致，不依赖颜色。

### B. 交互（10）

- [ ] 五页签可键盘到达，`Alt+1…5` 生效，当前页签写入 URL。
- [ ] 方案行可拖拽排序，编译错误可「定位」与「一键重排」。
- [ ] 结构/表单/YAML 三视图等价切换，YAML 不是唯一入口。
- [ ] 表格行 `Enter` 开详情，`Esc` 关闭，焦点回到原行。
- [ ] 抽屉 320–560 可调宽，切页签不丢失已打开证据。
- [ ] 矩阵格可打开单元详情；批量重试只作用于 failed。
- [ ] 暂停/恢复幂等；页面隐藏时停止轮询。
- [ ] 交付阻断未清零时按钮禁用并说明原因；豁免必须填理由。
- [ ] 破坏性操作可撤销；错误 toast 不自动消失。
- [ ] 所有异步按钮有 pending 态并防重复提交。

### C. 可访问性（10）

- [ ] 正文 ≥4.5:1，控件边界 ≥3:1。
- [ ] 仅用键盘完成：新建项目 → 运行 → 打开证据 → 签发。
- [ ] 焦点环可见且未被移除；抽屉焦点陷阱与恢复正确。
- [ ] 状态不只靠颜色，灰度截图仍可区分 verified / stale / failed。
- [ ] 数据表有 caption 与 scope；矩阵有 rowindex/colindex。
- [ ] live region 节流 1 次/秒，错误用 `role="alert"`。
- [ ] reduced motion 下无旋转、无滑入、无自动滚动。
- [ ] 400% 缩放不出现页面级横向滚动，内容不丢失。
- [ ] zh/en 切换无截断、无拼句，`lang` 正确。
- [ ] 图标按钮均有 `aria-label`，装饰图标 `aria-hidden`。

### D. 数据状态（10）

- [ ] 8 个字段状态均有 badge + 文案 + note；未知值有兜底。
- [ ] `not_disclosed_after_search` 可跳转到 `search.ledger` 尝试记录。
- [ ] `estimated` 显示 derivation，且不进入「已查实」统计。
- [ ] `conflict` 显示候选、chosen、rationale、decidedBy。
- [ ] stale 在总览、底稿表、详情三处均可见，并显示受影响下游数。
- [ ] `rejected` 只由人工触发，Agent 结果无「否决」主按钮。
- [ ] verified 仅当 checks 全过；失败 check 可展开 expected/actual。
- [ ] 运行失败按错误码分组计数；`budget_exhausted` 不渲染为 failed。
- [ ] 证据抽屉含 URL、引文、抓取时间、rawHash、四维、快照。
- [ ] 每个数字可回到 claim 与 evidence；孤儿数字为 0。

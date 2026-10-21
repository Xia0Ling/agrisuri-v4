# STORY.md — AgriSuri PH: Product Scope & Features

## ① 用户意图对齐

- **目标受众**：学术/项目评审席（panel）与可能的 LGU / DA 利益相关方。场合是产品说明式答辩，不是研究答辩。
- **核心目标**：讲完后观众相信三件事——(1) 这是一个边界清晰、已经做出来的产品，不是一个概念；(2) 它的每个功能都对应一个真实的田间约束；(3) 团队知道自己没做什么、为什么不做。
- **PPT 长度**：19 页。Hero 5 页（封面、产品定义、扫描管线、验证结果、收尾）= 26%。
- **视觉调性**：农业科技、克制、编辑感、深绿底 + 青柠高亮、非 PPT 模板感。
- **内容边界**：
  - 必讲：产品是什么、扫描流程、双模式、三类角色与权限、范围边界、隐私与治理。
  - 只占一页：分类准确率对比（75% / 98%），作为产品可用性的证据，不做研究展开。
  - 不讲：数据集构建细节、模型训练参数、统计显著性、文献综述。
  - 禁碰：编造的田间数据、假的截图、把"初步判读"说成"诊断"。

## ② 页面布局骨架

**章节契约（目录 4 章 ↔ 4 个 section 扉页）**

| 章 | 目录标题 | 扉页页码 | 内容区间 |
| :- | :--- | :--- | :--- |
| 01 | The Product | 03 | 03–05 |
| 02 | How a Scan Works | 06 | 06–09 |
| 03 | Who It Serves | 10 | 10–13 |
| 04 | Scope & Limits | 14 | 14–19 |

**Hero 页**：01 封面 / 05 产品定义 / 07 扫描管线 / 17 验证结果 / 19 收尾。
间隔检查：05↔07 之间隔 06（transition）；07↔17 之间隔 08–16；17↔19 之间隔 18。无相邻 Hero。

**Rhythm 曲线**
01 peak · 02 valley · 03 transition · 04 valley · 05 peak · 06 transition · 07 peak · 08 valley · 09 valley · 10 transition · 11 valley · 12 valley · 13 peak · 14 transition · 15 valley · 16 valley · 17 peak · 18 valley · 19 peak

连续 valley 最多 2 页，无 3 连。

**版式预算**：非对称 15/19 = 79%（≥40% ✅）；`N卡片横排` 0 次；`左大图+右侧文字` + `非对称双栏` = 6 页 = 32%（≤40% ✅）；对称版式仅 3 页（15 上下分栏、17 图表+洞察、19 居中金句），互不相邻。

## ③ 页面大纲

| # | title | type | role | rhythm | layout | visual | visual_role | density | anti_pattern | description |
| :- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 01 | AgriSuri PH | cover | hero | peak | 全幅图+骑线文字 | L1: 深绿底 + 巨型叶片线稿 + logo | anchor | 字数约40 / 图1 / 留白38% | 禁止居中堆叠三行副标题；禁止把 logo 放大当主视觉 | 产品名 + 一句话定位 + 三个事实锚点（2 作物 / 14 类别 / 3 角色）。 |
| 02 | What this covers | catalog | supporting | valley | 左标题+右内容 | L3: logo | evidence | 字数约110 / 图0 / 留白24% | 禁止四宫格等宽卡片 | 四章目录 + 页码范围；右侧一条竖排说明"这份材料讲产品，不讲研究过程"。 |
| 03 | 01 The Product | section | transition | transition | 全幅图+骑线文字 | 巨型章节数字 01 | anchor | 字数约25 / 图0 / 留白45% | 禁止四卡片预览；禁止正文段落 | 章节扉页，只有编号 + 章名 + 一句副标。 |
| 04 | Why it exists | content | supporting | valley | 巨型数字+洞察 | 大数字 14 + 三行问题陈述 | anchor | 字数约200 / 图0 / 留白20% | 禁止等宽卡片横排；禁止把数字塞进角落 | 14 个类别是刻意的窄；右侧三条田间约束：判读来得晚、人手稀薄、信号不上行。 |
| 05 | What AgriSuri is | content | hero | peak | 非对称双栏 65:35 | L1: 左侧巨句 + 右侧四支柱 | anchor | 字数约230 / 图0 / 留白26% | 禁止 50:50 等分；禁止把产品定义写成一段论文摘要 | 一句话定义 + 四根支柱 + "不是诊断"的边界声明。 |
| 06 | 02 How a Scan Works | section | transition | transition | 全幅图+骑线文字 | 巨型章节数字 02 | anchor | 字数约25 / 图0 / 留白45% | 禁止四卡片预览 | 章节扉页。 |
| 07 | Five gates before a diagnosis | content | hero | peak | 上大图+下方卡片 | L1: 全宽 SVG 管线图（占 B 区 62%） | anchor | 字数约180 / 图1 / 留白18% | 禁止把管线画成等高四卡；禁止箭头指向空白 | 质量→取景→形状→纹理→病害，每道闸门可以单独终止扫描；下方三条硬规则。 |
| 08 | Two ways to run a scan | content | supporting | valley | 非对称双栏 60:40 | L1: 双路径对比图 | evidence | 字数约220 / 图1 / 留白22% | 禁止左右等分；禁止把两条路径写成同一张卡的两列 | 离线（设备内模型）与在线（Edge Function + Roboflow）的取舍，以及降级顺序。 |
| 09 | What comes back | content | supporting | valley | 左大图+右侧文字 | L1: 结果卡结构图（占左 56%） | evidence | 字数约200 / 图1 / 留白20% | 禁止把结果页缩成 200×70 贴片 | 结果卡解剖：主判读、置信带、备选、处置、预防、安全提示。 |
| 10 | 03 Who It Serves | section | transition | transition | 全幅图+骑线文字 | 巨型章节数字 03 | anchor | 字数约25 / 图0 / 留白45% | 禁止四卡片预览 | 章节扉页。 |
| 11 | The farmer workspace | content | supporting | valley | 左大图+右侧文字 | L1: 应用外壳示意图（侧栏 + 顶栏 + 视图） | evidence | 字数约210 / 图1 / 留白20% | 禁止用编造的统计数字填示意图 | 三个视图：Dashboard / Scan / Analytics，加双语与可安装。 |
| 12 | The staff console | content | supporting | valley | 左标题+右内容 | L1: 运营台结构图 | evidence | 字数约220 / 图1 / 留白22% | 禁止把四个视图做成等宽卡片 | DA Officer 的四个视图各自回答什么问题；权限边界写在页脚。 |
| 13 | Who can see what | content | supporting | peak | 非对称双栏 70:30 | Table 权限矩阵（深底） | anchor | 字数约160 / 图1 / 留白16% | 禁止用图标堆代替矩阵；禁止模糊权限边界 | 8 条能力 × 3 角色的硬矩阵，右侧一句"UI 隐藏不是控制，RLS 才是"。 |
| 14 | 04 Scope & Limits | section | transition | transition | 全幅图+骑线文字 | 巨型章节数字 04 | anchor | 字数约25 / 图0 / 留白45% | 禁止四卡片预览 | 章节扉页。 |
| 15 | Built, and deliberately not built | content | supporting | valley | 上下分栏 | 双栏清单（上：已建 / 下：未建） | evidence | 字数约240 / 图0 / 留白18% | 禁止只列功能不列取舍 | 已建成 6 项 vs 刻意不做 4 项，每条给理由。 |
| 16 | Trust is a feature | content | supporting | valley | 非对称双栏 60:40 | L1: 四层治理图 | evidence | 字数约220 / 图1 / 留白20% | 禁止把安全写成形容词 | 角色来源、行级权限、坐标精度、照片同意、审计——都是可验证的机制。 |
| 17 | Evidence: mode matters | content | hero | peak | 图表+洞察 | Chart(双柱) 75% vs 98% | anchor | 字数约120 / 图1 / 留白26% | 禁止加误差棒或显著性声明；禁止把两柱做成饼图 | 23 个百分点差距 + 这条结果能证明什么、不能证明什么。 |
| 18 | What ships next | content | supporting | valley | 左标题+右内容 | 五步路线（竖排） | evidence | 字数约190 / 图0 / 留白24% | 禁止时间轴配假日期 | 五步，按依赖排序，不写具体月份。 |
| 19 | Two crops. One photo. | ending | hero | peak | 居中金句/巨型数字 | 巨句 + logo | anchor | 字数约40 / 图1 / 留白40% | 禁止重复摘要；禁止结尾放"谢谢"大字 | 收束金句 + 一句适用范围。 |

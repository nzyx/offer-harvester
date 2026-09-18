# CLAUDE.md

## 项目定位

这个项目是一个**汇报工具**，核心目标是降低用户的阅读成本，同时保证质量的稳定输出。

**三手抓，三手都要硬：**

1. **质量** — Prompt 要精准，AI 输出要对标真实招聘场景，不能泛泛而谈
2. **速度** — 生成内容要快。控制 Prompt 长度（能用 5 句说清楚就别写 10 句），输出靠 Prompt 自身精简指令控制篇幅；代码侧仅以 `max_tokens` 作兜底上限（见技术约束），不设过低上限导致截断
3. **阅读成本** — 用户 5 秒看到结论，1 分钟读完。标题即结论，列表优先于段落，禁止连续大段文字

每次改 Prompt 都问自己：这个改动让结果更好了吗？更快了吗？用户更容易看懂了吗？

## 输出规范

所有 AI 生成内容必须遵守以下规则。违反任一条都是 Bug，需要修 Prompt 或渲染层。

### 用户界面

- **零特殊符号**：用户看到的界面永远不能出现 `**`、`##`、`__`、`*`、`---`、代码块标记等格式化符号。Prompt 里用 `##` 分块是给解析器用的，不是给用户看的。`formatBody` 负责清洗所有漏网的标记。
- **零编号标签**：禁止出现"板块一""板块二""第一部分""第二部分"等序号。内容层次靠标题本身区分，不需要数字编号。
- **零半截话**：有问必答，有陈述必展开。反问句后面必须跟答案，结论后面必须跟依据。不能像谜语人一样只给关键词不给解释。
- **零分隔线**：AI 输出中禁止出现 `---`。
- **零反问用户**：禁止输出"你是否需要""要不要我帮你""可以进一步"等反问或追问。直接给结论和内容，不要问用户问题。

### 内容质量

- **标题即结论**：每个板块的标题直接点明核心信息，不铺垫、不绕弯。用户 5 秒扫到结论，1 分钟读完所有板块。
- **列表必须完整**：所有列表项必须全部列出，不允许只写了第 1 条就中断。出现截断时精简 Prompt 输出要求，让 AI 自己收敛篇幅。
- **话术直接能用**：给用户的答案必须是完整的句子，包含场景 + 做法 + 示例。不说"要注意项目经验的表达"，要说"面试官问项目时，这样回答：我当时负责了 X，遇到了 Y 问题，做了 Z 决策，数据提升了 N%"。
- **大白话，不写论文**：像个有经验的同行在给你讲，不说"赋能""闭环""抓手"等套话。

### 技术约束

- **纯文本解析**：所有 Prompt 的 AI 输出格式统一为 `## 标题\n正文`。禁止要求 AI 输出 JSON、XML 或任何结构化格式。
- **结构化抽取也是纯文本**（`prompts/resume-extract.md`）：输出格式为 `## 分组名` + 每组内 `字段名：值` 行，多条经历就重复写同名分组。解析在 `profile.js` 的 `parseProfileText()`，字段名用中文标签匹配（含别名表），认不出的行按上一字段续行处理，认不出的分组直接丢弃——**宁缺勿错，绝不猜**。解析失败时抛出错误，由调用方降级到本地规则解析，不让用户卡住。
  - **只输出有值的字段，空字段整行省略，整组为空则整组省略**。留 `姓名：` 这种空行占位对解析毫无帮助，只会白白消耗输出额度、更容易撞上长度上限。这条约束让输出 token 少了约一半。
  - 提示词里有「常见排版与切分方法」一节，专门教模型处理**真实简历的排版**：一行里挤着「时间 + 公司 + 职位」怎么拆、条目下方的「小标题 + 要点」整段归给工作内容、项目角色单独占一行、荣誉奖项要拆开并按含金量排序。**本地规则与 AI 两边都要认识同一批排版**，改了一边务必同步另一边。
- **表单语义映射也是纯文本**（`prompts/form-map.md`）：AI 只从固定语义枚举（85 个 id）里选一个，输出 `序号<TAB>语义` 或 `序号<TAB>?`。解析在 `popup.js` 的 `parseFormMapResponse()`，语义不在枚举里的一律丢弃。**AI 只决定「这个字段是什么意思」，填什么值完全由本地 `form-fill.js` 取值层决定**——因为值取错是事实性错误，语义判错只是少填一项。AI 的判断以 `hint` 形式参与打分，不直接覆盖本地结果。
  - ⚠️ **枚举清单必须与 `FILL_RULES` 同步，`tests/form-fill.test.js` 第 20 节盯着这件事**（语义不能漏、不能多、12 个分组不能缺）。这条断言是为一次真实事故加的：`FILL_RULES` 从 41 条扩到 85 条时提示词还停在旧的 24 个语义上，而没有任何测试看着它 —— AI 映射只能返回旧词，新分组的字段一律救不回来，而且不报错。新增字段规则后必须同步 `prompts/form-map.md` 的枚举段落。
- **max_tokens 按 Prompt 分配**：岗位分析 2500、面试准备 4000、打招呼语 800、优化简历 5000、结构化抽取 8000、表单语义映射 2000。数值作为硬上限兜底，实际输出靠 Prompt 内字数约束控制。结构化抽取给到 8000 是因为字段表扩到 12 组后条目明显变多，6000 有截断风险。
- **截断问题双管齐下**：Prompt 侧限制字数范围 + 代码侧设 max_tokens 兜底。两者配合，既不让 AI 失控写太长，也不截断关键内容。
- **思考模式必须关闭（不只是 DeepSeek）**：结构化抽取、字段语义映射、连接诊断都不需要推理，而思考过程会占满 `max_tokens`，`finish_reason` 变成 `length` 且正文为空。统一走 `common.js` 的 `applyThinkingOff()`：Qwen 系列发 `enable_thinking: false`，DeepSeek / GLM / 豆包 / 混元发 `thinking: {type: 'disabled'}`，**白名单以外一律不发**——给不支持的平台发未知参数会直接 400，那比思考吃光配额更糟。
- **截断自愈**：空正文 + `finish_reason === 'length'` + 无 `reasoning_content` 时，`requestCompletion` 自动把上限放大到 `max(2×, 8000)` 重试一次。用户不该被迫理解 max_tokens 是什么——设置页里根本没有这个入口，旧文案「请调大该模型的输出上限」是个做不到的建议。有 `reasoning_content` 时不重试（重试也一样吃光，白花钱）。
- **AI 失败一律降级，不把用户卡住**：`parseProfile` 捕获 AI 的任何失败（截断 / 超时 / 额度 / 网络 / 格式）后走本地规则，并把失败原因如实写进结果横幅。**只有用户主动取消才不降级**——否则「取消」会被伪装成「解析成功」。
- **连接诊断不能只看 HTTP 200**：推理模型可能返回 200 但正文为空。诊断必须检查 `choices[0].message.content` 是否非空，否则会误报「连接正常」，用户在真正生成时才发现失败。诊断的 `max_tokens` 要给足（1024），给 5 会让思考型模型必然失败。

## 文件结构

| 文件 | 职责 |
|---|---|
| `popup.html` / `popup.js` | 侧边栏界面与交互。主线是**向导式三步：1 简历 → 2 岗位 → 3 产出** |
| `styles.css` | 全部样式，黑白 + 红 `#E60012` 设计系统，与导出页同一套视觉语言 |
| `options.html` / `options.js` | 设置页（API 配置 + 连接诊断） |
| `common.js` | 跨页面共用：接口地址补全 `resolveCompletionUrl`、错误翻译 `describeHttpError` / `describeTimeoutError` / `describeNetworkError`、`API_TIMEOUT_MS` |
| `resume-text.js` | **简历文本还原层**（无 DOM 依赖，可在 node 下测试）：把 PDF 片段重建成有行结构的文本 `rebuildPdfLines`、规整 TXT/MD/DOCX 来源 `normalizeResumeText`。**这一层错了后面全错**，详见「简历文本还原约定」 |
| `profile.js` | **网申字段表 · 数据层**（无 DOM 依赖，可在 node 下测试）：**12 组字段 schema**（与网申表单逐栏对齐）、别名归并 `normalizeProfile`、v1→v2 迁移 `migrateProfile`、文本解析 `parseProfileText`、本地规则兜底 `extractProfileLocally`、经历条目解析 `localExtractExperience` / `localExtractProjects` / `localExtractHeaded`、手工改动优先的合并 `mergeProfile`、脏标记 `markProfileDirty` / 删除名单 `markProfileRemoved`、派生回退 `applyProfileDerived`、预填清单 `flattenProfile`、缺失统计 `profileEmptyPaths`、路径读写 `getProfilePath` / `setProfilePath`。约定见「字段表与智能合并约定」 |
| `form-fill.js` | **网申预填语义引擎**（无 DOM 依赖，可在 node 下测试）：**85 条字段规则** `FILL_RULES`（12 组）、打分 `classifyFillField`、阻断 `blockFillField`、取值 `resolveFillValue`、选项匹配 `matchFillOption`、填写计划 `createFillPlan`、原因文案 `FILL_REASONS`。顶层禁止副作用（被 `new Function` 加载测试）。不依赖 `profile.js`：分组是对象还是列表由 `Array.isArray` 判断 |
| `form-fill-page.js` | 网申预填的 content script：采集控件特征（`form:scan`）、写入值（`form:fill`）、清除标记（`form:clear`）。三个分支都是同步应答，**不需要 `return true`** |
| `prompts.js` + `prompts/*.md` | 提示词以 Markdown 外置维护，`prompts.js` 负责加载（含 `form-map.md` 表单语义映射） |
| `background.js` | Service Worker，复制保护状态持久化 |
| `jd-extract.js` | **JD 正文提取算法层**（纯函数，可在 node 下测试）：候选打分 `scoreJdCandidate`、选优 `pickBestCandidate`、清洗 `cleanJobText`、候选收集 `collectJdCandidates`。与 `jd-grab.js` 同处一个 isolated world，顶层必须是函数/常量声明、不得有执行副作用 |
| `jd-grab.js` | JD 抓取的 content script：只做主 frame 的消息应答（`jd:grab`），依赖 `jd-extract.js` |
| `tests/*.test.js` | 无依赖的验证脚本，见下方「验证方式」 |
| `tests/make-preview.js` | 把向导展开成静态快照 `向导预览.html`，用于在没有扩展环境时检查排版 |

## 向导结构约定

主线是「1 简历 → 2 岗位 → 3 产出」，只做**顺序引导 + 状态可见 + 摘要回看**，不强制走完（简历可选，随时可跳到任意步）。

- **DOM 命名由 `WIZARD_ORDER` 驱动**：每步是 `#step-<name>`，折叠摘要行是 `#step-<name>-collapsed`，摘要文本是 `#step-<name>-summary`。新增步骤只要往 `WIZARD_ORDER` 里加名字并补齐这三处 id，`renderWizard()` 会自动接管。
- **产出卡的前置条件只在 `OUTPUT_CARDS` 里写一遍**（`{ id, stateId, need }`），HTML 里不再写 `data-need`，避免两处写死导致对不上。
- **校验失败必须把用户送到「缺的那一步」**：统一走 `gotoMissingStep(needsResume, message)`，提示写在该步内的 `#job-step-status` / `#resume-step-status`，不能只把错误丢在用户看不见的地方。
- **当前步骤随会话恢复**：`wizard.step` 写进 `chrome.storage.session.wizardStep`，关侧边栏重开不丢进度。
- **⚠️ 顶层 `const` 必须声明在 `loadMemory()` 调用之前**：`chrome.storage.session.get` 的回调在某些环境下会同步触发（`tests/render.test.js` 的存储桩就是同步的），后置声明会让回调里的读取命中 TDZ 直接抛错。这个坑已经踩过两次（`profile`、`OUTPUT_CARDS`），新增顶层状态请一并前移。

## 长流程的反馈约定（以结构化简历解析为范本）

耗时操作（解析、抓取、预填扫描）必须让用户在**视线不动**的前提下知道「好了没有」和「东西在哪」。三要素缺一不可：

- **状态徽标贴着触发按钮**（`#profile-state`）：待处理 / 进行中 / 已就绪 / 无结果，用 `data-state` 驱动。用户点完按钮视线就停在按钮附近，反馈出现在别处等于没有。
- **结果横幅排在内容列表之前**（`#profile-status`）：`data-kind` 驱动 `ok` / `warn` / `error` / `info` 四态。**必须排在会展开的列表（`#profile-groups`）前面**——展开后有几屏高，提示放列表下方会被挤出视口。`tests/render.test.js` 用 HTML 源码位置断言锁死了这一条。
- **常驻说明交代数据的去向**（`#profile-where`）：存在哪、谁会用。用户问「数据在哪里」往往不是找不到界面，而是不知道这次操作产生了什么、会不会丢。

配套规则：

- **自动保存必须可见**（`#profile-savestate`）：编辑 → 「未保存的修改…」，落盘后 → 「已保存到本机」。有自动保存却只留一个手动「保存」按钮，用户既不确定改完存没存，也不敢不点。
- **多分支文案先拼公共部分再各自补尾**：字段数、经历段数这类信息**每个分支都要给**。曾经只在 AI 分支拼了段数，本地分支漏掉——这类「某分支漏了公共信息」的问题在多分支文案里很常见。
- **计数为 0 时不显示 `0`**：`0/8` 看起来像出错。命中为 0 改用明确的空态文案（「简历里没有识别到这一组信息，可直接手动补充」）。
- **破坏性操作与保存拉开距离**：`#profile-clear` 用 `margin-left: auto` 推到右侧，避免误触。
- **恢复缓存数据也要给横幅**：打开侧边栏看到一堆填好的字段，必须说明「已从本机读回 N 项」，否则用户分不清是缓存还是刚解析的结果。

## 简历文本还原约定

**这一层是整条简历链路的入口，错了后面全错，而且不报错**——表现为字段错位、整段经历消失，非常难查。

- **⚠️ 绝不能把所有 PDF 文本片段 `join(' ')` 了事**：那会把**整页压成一行**，行结构彻底丢失，后面所有按行处理的逻辑（本地规则、AI 提示词）同时失效。实测后果是「专业」被填成「手机号码」。必须走 `resume-text.js` 的 `rebuildPdfLines()`：按 y 坐标聚类成行 → 行内按 x 排序。
- **行内按 x 间距补空格**：空格是字段之间的断词依据。少了它「姓名：刘子涵居住地：深圳」会被正则当成一个名字读走。
- **续行合并要同时满足 7 个条件**（见 `joinPdfRows`），缺一个都会把相邻条目粘成一团。其中两条最容易漏：
  - **上一行必须「排满」**（右边界 ≥ 页面内容宽度的 0.9）。这是区分「被换行切断的句子」与「上下相邻的独立条目」的关键——独立条目写不满一行。少了它，连续几行同缩进的短条目会被合并成一整行。
  - **下一行含日期范围时不合并**。紧凑排版下行距与缩进都相同，只能靠日期判断「这是新的一条经历」。
- **PDF 的硬换行会把一句话从中间切断**（`…文档制` + `作，累计输出…`），不合并的话工作内容是断的、主修课程会被截断。
- **改动本层后必须跑 `tests/resume-text.test.js`**（40 条断言，含 5 种不该合并的情况），并拿真实简历跑 `node tests/check-resume.js <pdf>` 复核。

## 经历提取约定（本地规则）

校招简历的经历部分**很少写成「公司：XX」**，本地规则要认识下面这些排版：

| 排版 | 例子 |
|---|---|
| 行首日期 | `2026.06-2026.8 深圳美高创新股份有限公司 产品营销实习生（迷你PC/NAS）` |
| 行尾日期 | `深圳市某某科技有限公司  内容运营实习生  2025.07-2025.10` |
| 字段名式 | `公司：XX有限公司` 换行 `职位：产品实习生`（走 `parseProfileText` 兜底） |

- **日期位置决定头部文字取哪一段**：行首取日期之后，行尾取日期之前（`localHeadTextWithoutDate`）。
- **月份放宽到 3 位**：`2025.012-2026.03` 这种笔误在真实简历里很常见，按意图纠正为 `2025.12`。
- **「小标题 + 要点」整段都属于 `工作内容`**，小标题本身也要保留，用 `；` 连接。判断边界靠「下一个含日期范围的行」或「下一个章节标题」。
- **章节标题判定必须排除含日期范围的行**：否则 `2025.012-2026.03 某机器学习项目` 会因为含「项目」二字被当成「项目经历」标题，**整条经历被消耗掉、什么都不剩**。
- **找不到章节标题时的兜底只认含公司后缀的条目**：少数简历不写章节标题，放宽到全文扫之后，必须靠「有限公司 / 集团 / 研究院」把学校名、项目名挡在外面，否则 `2023.09-2027.06 广东海洋大学 电子信息工程` 会被当成一段实习。
- **项目角色词要整体匹配**：`产品负责人` 要整体识别，只认「负责人」会把「产品」留在项目名里；`学员-TOP20` 要连后缀匹配，否则项目名尾巴上会粘一个孤零零的 `-TOP20`。
- **角色单独占一行时也算角色**（如「独立作者」），且不能混进项目描述；只在首行 ≤ 12 字时才认，避免描述正文里的「负责人」被误判。

## 字段表与智能合并约定

字段表是**网申表单的镜像**，12 组按参考表单的栏目顺序排列，是预填与所有生成的唯一数据源。分组 id 沿用旧英文名（`basic` 不改成 `personal`），这样 `form-fill.js` 的规则表与别名表改动面最小。

| 分组 | 类型 | 说明 |
|---|---|---|
| `basic` 个人信息 / `intent` 求职意向 / `extra` 附加信息 | 对象型 | 一人一份 |
| `education` `experience` `projects` `campusRole` `campusPractice` `skills` `honors` `languages` `certificates` | 列表型 | 可加多条 |

三条不变量（改数据层前先读）：

- **`_id` 是条目的稳定身份**，由 `createEmptyItem()` 生成。**绝不能按数组下标记脏标记** —— 用户删掉中间一条，后面所有下标错位，脏标记会串到别的经历上。
- **`_dirty` 记录「哪些字段是用户手工填的」**，挂在条目上（对象型分组挂在分组上）。`markProfileDirty()` 在 `popup.js` 的 `input` 事件里调用。
- **`_removed` 记录被用户删掉的条目**（按 `PROFILE_MATCH_KEYS` 的对齐键记指纹）。少了它会出现「用户删了某段经历，重新解析又把它拉回来」——用户会以为删除没生效。

重新解析走 `mergeProfile()`，**手工改动优先**：

1. 对象型：`_dirty` 里的 key 保留用户的；其余 key 本次解析有值就用新值，没值保留旧值（不清空）
2. 列表型：按对齐键匹配已有条目后逐字段合并（同样规则），匹配不到的追加为新条目，已有但没被匹配到的原样保留
3. 命中 `_removed` 的条目直接丢弃，不再追加
4. 合并结果必须如实告知更新了几项、保留了几项、新增了几段——沿用「多分支文案先拼公共部分再各自补尾」的老约定

对齐键（`PROFILE_MATCH_KEYS`）：教育用 `school`、实习用 `company`、项目/在校实践/技能/获奖/证书用 `name`、在校职务用 `title`、语言用 `type`。

**派生回退**（`applyProfileDerived`）：`basic` 里的最高学历 / 最高学位 / 专业名称 / 毕业学校留空时，从教育经历里学历最高、时间最近那一条带出。这四项在参考表单里是教育经历的**重复问法**，用户只该填一处。`popup.js` 的 `structuredProfile()` 传给预填的就是派生后的副本，**任何新的预填入口都必须走它**，否则这四个字段会静默变空。

`prompts/resume-extract.md` 里对应地**要求 AI 不要抽取这四项**（只写教育经历那一次），AI 抽了反而会和生产环境的派生值打架。

**必填与缺失**（`PROFILE_REQUIRED_KEYS`，12 项）：个人信息 5 项（姓名 / 手机号码 / 邮箱 / 性别 / 出生日期）、求职意向 1 项（期望工作城市）、教育经历 6 项。列表型分组的必填对**每一条**生效；整组一条都没有时算作缺这些必填 —— 这比报「0 项」有用，用户一看就知道该先加一条。

## 页面注入约定（JD 抓取 / 网申预填）

复用 `manifest.json` 里已注入的 content script 通道，**不新增任何权限、不做运行时脚本注入**（`permissions` 至今只有 `storage` / `sidePanel` / `tabs`，`host_permissions` 沿用既有的 `http(s)://*/*`）。

- **消息协议按前缀分域**：JD 抓取用 `jd:`，网申预填用 `form:`。
  - `jd:grab` → `{ ok: true, text, site, score, length }` 或 `{ ok: false, reason: 'no-content' | 'too-short' | 'error', detail }`
  - `form:scan` → `{ ok: true, fields: [...特征], count, site, url, title }` 或 `{ ok: false, reason: 'loading' | 'error', detail }`
  - `form:fill` → 入参 `{ items: [{ ref, value }] }`，应答 `{ ok: true, results: [{ ref, ok, reason? }] }`
  - `form:clear` → 应答 `{ ok: true, cleared: N }`
- **只注入主 frame**：`jd-grab.js` 与 `form-fill-page.js` 的 content script 项都设 `all_frames: false`，popup 侧用 `sendMessage(tabId, msg, { frameId: 0 }, cb)`。若将来要覆盖 iframe 内的表单，改这里而不是在脚本里加 `window.top` 判断。
- **必须消费 `chrome.runtime.lastError`**：页面在扩展安装/更新之前就已打开时接收端不存在，不读 `lastError` 会在控制台留下未捕获错误。这种情况的文案要引导用户「刷新网页后重试」，而不是笼统的失败。
- **异步应答必须 `return true`**：`jd-grab.js` 里等 DOM 就绪是异步的，监听器返回 `true` 才能保持消息通道开启，否则 popup 会永远收不到响应。`form-fill-page.js` 的三个分支都是同步的，**不要加 `return true`**。
- **⚠️ 消息入口必须校验 `sender.id`**：所有 `chrome.runtime.onMessage` 监听的第一句都必须是 `if (!sender || sender.id !== chrome.runtime.id) return;`。当前 4 处：`form-fill-page.js` / `jd-grab.js` / `copy-guard.js` / `background.js`。
  - 当前 manifest 没声明 `externally_connectable`，网页和其他扩展都发不进来，所以这道校验**眼下是纯加固**——但它是**唯一一道**。哪天为别的功能开放了外部消息通道，没有它，任意网页就能借 `form:fill` 触发填表、借 `form:scan` 读走整页结构、借 `jd:grab` 读走页面正文。
  - `tests/form-fill-page.test.js` 第 7 节是**源码级**断言（扫源码），查两件事：有没有校验、校验是否排在第一个业务分支之前（排在后面等于没防）。**新增任何 listener 都必须一起加，否则测试立刻红。**
  - 为什么不测行为：这些 listener 只在真实扩展环境注册，node 下没有 `chrome.runtime`，行为测不到，只能靠源码级断言守。
- **抓取不得静默覆盖用户内容**：覆盖前把原文存进 `grabUndo` 并提供「撤销替换」；用户一旦手动改动内容（`jobInput.value !== grabUndo.grabbed`）撤销立即失效，避免撤销把用户刚编辑的内容冲掉。
- **`jd-extract.js` / `form-fill.js` 顶层禁止副作用**：它们同时被 content script 直接执行、被 `tests/*.test.js` 用 `new Function` 包裹执行，所以顶层只能是函数/常量声明。
- **正则一律不带 `g` / `y`**：带 `g` 的正则用于 `.test()` 会推进 `lastIndex`，导致同一正则对相同输入交替返回真假。需要计数时用 `countMatches`（内部新建带 `g` 的副本）。
- **打分阈值有回归测试保护**：`scoreJdCandidate` 的权重改动后必须两侧都仍然成立——JD 容器胜出**且**导航/列表/页脚全部落选。当前实测分隔：JD `73.8` ｜ 导航 `-45.3` ｜ 职位列表 `-0.2` ｜ 页脚 `-42`，阈值 `25`。

## 网申预填约定

**只填不提交**是硬边界：代码里不存在任何点击提交按钮、触发 `form.submit()` 或按回车提交的路径。`form:fill` 消息体只有 `{ ref, value }`，`tests/render.test.js` 对此有断言保护。

- **两层分离**：语义判断在 `form-fill.js`（纯算法，node 下可测），DOM 触达在 `form-fill-page.js`。`scan` 与 `fill` 之间靠 `ref`（`'ff' + 序号`）关联，注册表在页面侧；元素在扫描后脱离文档时如实报 `stale` 而非静默失败。
- **宁缺勿错**：打分低于 `7.5` 不认，与次优解分差小于 `0.9` 判为「不明确」，两者都交给用户手填。认不出的字段必须给出**具体原因文案**（`FILL_REASONS` 每个码都有 `title` + `detail`，测试有断言查缺）。
- **排除词 `not` 只在 `attr` / `label` 层生效**：用于挡住「公司规模」「学校性质」这类被泛词误命中的字段。不看 `near` 层——同区块其它字段的文字会造成误伤。
- **同名词条分处两组时靠章节归组消歧，别删掉任何一侧**：`department` 在教育组是「学院」、在实习组是「部门」；`职务` 在项目组是「项目角色」、在实习组是「职位」；`职务描述` 同理。章节认不出来时会判「含义不明确」交用户手填——这是**有意的**，比随便挑一个填错好。
- **⚠️ 章节关键词搬家时「改一边忘另一边」会在这里炸**：字段表从 6 组扩到 12 组时，`FILL_SECTION_KEYWORDS` 有四处必须跟着搬，否则新老两组会互相抢填同一个表单栏：
  - 「实践经历 / 社会实践 / 校园实践 / 实践项目 / 实践信息」从 `projects` → `campusPractice`
  - 「其他信息 / 补充信息」从 `skills` → `extra`
  - 「技能证书」拆开：「技能」→ `skills`、「证书」→ `certificates`
  - 「获奖情况 / 荣誉奖项 / 语言能力」从 `skills` → `honors` / `languages`
  - 同时 `projects.name` 的「实践名称 / 实践项目 / 实践课题」要移给 `campusPractice.name`，`projects.description` 的「实践描述 / 实践内容」要移给 `campusPractice.description`
  - `tests/form-fill.test.js` 第 15 节是**源码级**回归（扫源码查这些词有没有留在旧组里），改一边忘另一边会立刻报错。
  - 新增章节词时注意别用 `实践` 这种裸词（会误命中「实习实践」），用 `实践经历 / 社会实践 / 校园实践` 这类复合词。
- **⚠️ 个人信息区块的「学历 / 专业名称 / 毕业学校」取的是「最高那一档」，不是第 0 条**：校招简历常见本科在前、硕士在后，按 `education[0]` 取会把硕士填成本科 —— 那是事实性错误，比不填更糟。判定靠**所在章节**（`sectionGroup === 'basic'`），不靠关键词：同一个「专业名称」在教育经历区块里是这一条的专业，在个人信息区块里是最高学历的专业。两个方向都有断言守着（`tests/form-fill.test.js` 第 19 节）。章节认不出来时保持原行为（第 0 条），不猜。
- **「最高学历 / 最高学位」是两个独立的语义**（`basic.degree` / `basic.degreeLevel`），值取派生后的 `basic`。`education.degree` 的 `not` 里必须有 `最高`，否则「最高学历」会落回 `education.degree` 取下第一条经历。
- **「至今」是独立复选框**：`endDate` 值为「至今」时才勾，同时不往结束时间框里写「至今」三个字。没勾不等于缺数据，用 `not-ongoing` 的专门文案说明，别让用户以为漏了。
- **拉丁词必须词边界匹配**：`search` 会误杀 `researchExperience`，所以拉丁阻断词走 `(^|[^a-zA-Z])(...)([^a-zA-Z]|$)`，中文用子串。新增阻断词时两处都要照顾。
- **受控组件写入必须走原型 setter**：`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)` 绕过 React 实例上的 value tracker，再派发冒泡的 `input` + `change`。`el.value = x` 会被记成「值没变」，`onChange` 不触发。`radio` / `checkbox` 优先 `el.click()`（React 正是从 click 推导 onChange）。
- **`displayValue` 必须是人能读懂的**：`<option value="1">男</option>` 写入的是 `"1"`，但清单要显示「男」。核对界面给用户看 value 等于没给核对能力。见 `form-fill.js` 的 `fillDisplayValue()`。
- **敏感字段默认关闭**：`FILL_DEFAULT_SENSITIVE` 兜底，popup 侧传 `PROFILE_SENSITIVE_KEYS`。开关关闭时敏感字段进手动清单，原因码 `sensitive`。
- **禁止程序化写入的两类控件不做无效尝试**：自定义下拉框（div 模拟的 select）与 `input[type=file]`，一律跳过并提示手填，原因码分别是 `custom-select` / `file`。
- **⚠️ 标签解析是这一层最容易出错的地方，改前先看这条**：字段「认不出」有一半以上的原因是**标签压根没读出来**，而不是规则不够。`resolveLabel()` 按可靠性从高到低尝试：`label[for]` → `aria-labelledby` → 包着它的 `<label>` → `aria-label` → `title` → **区块文字反推** → 前一个兄弟节点。
  - 前 5 种都落空时靠 `labelFromBlock()` 反推：**取所在容器里「排在控件之前」的文字**（`textBeforeControl`），由内向外试，取第一个「短且非占位符」的结果。主流组件库（北森 / antd / Element UI）把标签和控件放在同一个 form-item 容器里，标签既不是控件的兄弟、也不是祖先 `<label>`，只能这样反推。**真实的「学校抓不到」就栽在这一步。**
  - **无语义文字必须先剔除，否则会把标签位占住**：`isGenericText()` 判定「请选择 / 请输入 / 请填写 / 选填 / --」。判住之后视为「没找到」继续往下试。反过来，「请输入姓名」这类**含字段名**的占位符要保留——它有信息。北森表单里 40 个字段的标签都被解成了「请选择」，这一条不修，后面所有策略都没机会跑。
  - **兄弟节点「自己就是个控件」时不能当标签**：判据用 `CONTROL_ISH_SELECTOR`。注意要连兄弟自身一起判（`sib.matches(...)`），因为北森的国家选择框是 `<div role="combobox">`，里面没有原生控件，`querySelector` 只看后代就会漏掉它显示的「中国大陆」——实测它被当成了手机号的标签。
  - **标签层的整段匹配要单独给奖励**：`FILL_WHOLE_LABEL_BONUS`。表单给字段起名就是那么短，标签整段等于「邮箱」那它就是邮箱。弱词（`lo`）只能靠它单独成立——只算子串匹配时「邮箱」只有 5.6 分，够不到 7.5。
  - **无语义占位符不得进打分 haystack**：`buildFillHaystacks()` 会用 `isGenericFillText()` 过滤掉「请选择」这类值。它留在标签层会把「整段就是关键词」稀释成「关键词 + 三个无关字」，锚点与整段匹配奖励一并失效。
- **国家/地区选择框必须拦掉**（原因码 `region`）：标签本身只由地区名构成（中国大陆 / 内地 / 香港 / 澳门 / 台湾 / 境内 / 境外 / 海外）或就是国家类词（国家 / 国籍 / 地区 / 区号 / 国家和地区）时判为地区框。实测北森表单第 4 行「中国大陆」被识别成 `basic.phone` 且真的会填进去——那是手机号前面的区号框，把手机号填进去比不填更糟。
- **脚本接管的控件不只靠 `role=combobox` 识别**：`aria-haspopup` / `aria-expanded` 也是判据（北森 `standard-lookup`、antd Select 都带）。当普通文本框写进去会「看起来填上了、其实没选中」，提交时值丢掉。`date` / `month` 等原生类型优先于这两个属性。
- **自定义下拉框要分两种处理，不能一刀切**：
  - **可输入的**（Element UI / antd 的搜索型 Select、北森 `standard-lookup` 的搜索框）→ **填入关键词**触发组件自身的筛选，用户从筛过的候选里点一下即可，比在几百所学校里翻找容易得多。
  - **只读的**（点击才弹窗、输入框不接受键入）→ 真的写不进去，跳过并提示手填。
  - 判据见 `form-fill-page.js` 的 `isSearchableCustomSelect()`：`input` + 非 `readOnly` + 非 `disabled`。div 模拟的 combobox 没有这两个属性，按不可输入处理。
  - 类型加分上 `custom-select` 视同 `combobox`（同一个 ARIA 角色的两种实现），否则会被无谓地按「类型不符」扣分。
  - **`assisted: true` 必须同时体现在清单、结果提示与诊断报告里**：我们只是"帮填了关键词"，用户没点选就不算填好。不标出来用户会以为填好了，直接提交才发现值丢了。
- **⚠️ 字段绝不能无声消失**：所有跳过原因都会进「需你手动处理」清单，且每个原因码必须有 `title` + `detail`（测试有断言查缺）。曾经 `option-not-match` 既没有文案、又被放进静默列表，结果字段在清单里凭空消失、用户完全不知道发生了什么——比多一条提示糟糕得多。`FILL_SILENT_REASONS` 现为空数组，保留常量只为标明这个决定。
- **对象字面量里重复的 key 是静默失效**，JS 取最后一个值且不报错。测试里用正则扫源码查重复原因码，改动 `FILL_REASONS` 后务必跑。
- **诊断详情导出**（`#autofill-detail`）：把「扫描到的全部控件 + 识别结果 + 跳过原因」导成可读报告供用户复制。排查「某个字段没填上」时，**光看那两张清单不够**——控件可能压根没被扫描到（在 iframe 里、被 `isVisible` 过滤、选择器没命中），那种情况两张清单里都不会出现，只有列出「扫描到的全部控件」才能区分「没扫到」与「识别失败」。
  - **报告里必须单独显示 `label`，不能拿 `placeholder` 兜底**：两者混在一起会掩盖「标签根本没读出来」这个关键事实。报告里几十行显示「请选择」时，看不出到底是标签被解成了占位符、还是压根没有标签——而这两种情况的改法完全不同。
  - **必须有一段「未填写控件的原始特征」**：逐个列出 `类型 / 只读 / role / label / placeholder / aria-label / name / nearby / 章节`。上一轮排查「学校抓不到」时，报告只说「未能识别」，最后是**靠报告里的分数反推出真实特征**才定位的——这段就是为此加的，让下一次不需要反推。
  - **重复的手动原因要合并计数**（`×N`），否则 40 行一模一样的「未能识别」会把真正要看的那几行淹掉。
- **无 AI 也必须能用**：本地规则是主路径，AI 映射是可选增强。AI 未配置、超时或返回不合法 → 退回纯本地，并在状态行如实说明「有 N 个字段本地认不出，连接 AI 后可提高识别率」，不让用户以为功能坏了。
- **切换标签页必须清空计划**：侧边栏常驻，`autofillScan` 是按页面来的。不清空会让用户把上一页的清单当成本页的，点「确认填写」后写入的却可能是新页面的字段。

## 验证方式

改动数据结构、解析逻辑或渲染层后，跑这几个脚本（无需安装任何依赖）：

```bash
node tests/common.test.js      # 共用层：关思考平台白名单、地址补全、错误文案
node tests/resume-text.test.js # 文本还原：PDF 行重建、行内空格、续行合并（5 种不该合并的情况）
node tests/profile.test.js     # 数据层：12 组结构、字段规整、分组内别名、v1→v2 迁移不丢字段、派生回退、智能合并、
                              #        脏标记与删除名单、必填与缺失统计、文本解析、本地兜底、经历提取（两种日期排版）、
                              #        提示词与 schema 一致性
node tests/form-fill.test.js   # 预填算法：正向必认出、反向必认不出、阻断规则、选项匹配、经历推进、新旧字段互斥、
                              #        章节关键词搬家（源码级）、「至今」勾选、个人信息区块取「最高那一档」、
                              #        form-map.md 与 FILL_RULES 枚举一致性、真机报告驱动用例
node tests/form-fill-page.test.js # 内容脚本：标签解析（区块反推）、无语义文字识别、控件类型判定、
                              #        消息入口的 sender 校验（源码级，覆盖 4 个 listener）
node tests/render.test.js      # 渲染层：DOM 桩里真实执行 popup.js，验面板渲染、转义安全、向导流转、字段表折叠与必填标记、
                              #        补充引导的缺失统计、重新解析时手工内容保留与删除不复活、抓取与预填状态机、
                              #        请求重试与降级、诊断报告
node tests/jd-extract.test.js  # JD 提取：打分权重回归（JD 必须胜出、导航/列表/页脚必须落选）、清洗规则
node tests/make-preview.js     # 可选：生成 向导预览.html，肉眼检查向导排版
```

另外有一个诊断工具（不是断言脚本，不入 CI）：

```bash
node tests/check-resume.js 简历.pdf          # 端到端体检：PDF → 行重建 → 结构化提取，报出提取率
node tests/check-resume.js 简历.pdf --text   # 额外打印重建后的文本，用来判断问题出在
                                             # 「文本没还原好」还是「提取规则不认识这种写法」
```

**改了 `resume-text.js` 或 `profile.js` 的提取逻辑后，除了跑单元测试，还要拿几份真实简历跑 `check-resume.js`。** 单元测试能锁住规则本身，锁不住「这份简历抽出了多少」——本次改造中「项目经历整段丢失」「专业被填成手机号码」都是靠真实简历才暴露的。

`tests/form-fill-page.test.js` 用最小 DOM 桩在 node 下跑内容脚本（`form-fill-page.js` 末尾有 `module.exports` 测试出口，`chrome.runtime` 的监听注册也做了环境判断）。以前这一层一行测试都没有，而「学校抓不到」恰好出在这里——**改动 `resolveLabel()` 或区块反推逻辑后必须跑它**。加桩时注意：`readonly` / `disabled` 属性要映射成同名属性，`textContent` 必须提供，否则相关策略会静默返回空、测试假绿。

`tests/render.test.js` 的脚本加载列表必须与 `popup.html` 的 `<script>` 顺序一致（当前 6 个：`common.js` → `profile.js` → `resume-text.js` → `form-fill.js` → `prompts.js` → `popup.js`）。新增共享脚本时两处都要加，漏了会在运行时才暴露 `xxx is not defined`。

所有脚本都用 `console.log` 逐条打印 ✓ / ✗ 并以退出码反映结果。**新增字段或改动解析规则时必须同步补断言**——这些脚本已经在开发中抓出过「专业名被章节词表误杀」「本地解析与 AI 解析产出两种结构」「下拉框清单显示 option value 而非选项文字」这类只有跑真数据才暴露的问题。

## 隐私与安全边界（改动前必读）

完整审查见 `项目安全审查报告.md`（v1.6.1 版）。以下几项是不可破坏的底线，任何改动都不能让它们退化：

- **不配 API Key → 简历解析必须走纯本地、零外发**：`popup.js` 的 `useAi = Boolean(settings.apiUrl && settings.apiKey && RESUME_EXTRACT_PROMPT)` 分支走 `extractProfileLocally()`，AI 失败也回退它（`local-fallback`）。这是本项目最强的隐私开关，**不能让「必须联网」成为使用前提**。
- **最小外发**：AI 字段映射只发页面控件结构（`buildFormMapPrompt`：类型 / 标签 / placeholder / name / id / 选项文字），绝不含用户数据；`form:fill` 只发已匹配的 `{ ref, value }`，**不发整个字段表**。预填链路（`form-fill.js` / `form-fill-page.js`）内**零 `fetch`**。
- **敏感字段默认关闭**：4 项 —— 身份证 `basic.idCard` / 银行卡 `basic.bankAccount` / 家庭住址 `basic.homeAddress` / 紧急联系人 `basic.emergencyContact`，由 `sensitive: true` 标记经 `PROFILE_SENSITIVE_KEYS` 动态收集。**新增敏感字段只加标记，别硬编码清单。**
- **真网络请求只有 2 处**：AI 调用（`popup.js`）与设置页连接诊断（`options.js`）。两处都必须带 `redirect: 'error'` 和 `referrer: 'no-referrer'`（旧审查报告的 P0，已修，**别回退**）。其余 `fetch` 都是 `chrome.runtime.getURL` 读扩展内部文件，不是网络。
- **存储边界**：字段表落 `storage.local`（明文持久，用户知情 —— 这是「换简历只改差异」的必然代价），简历原文 / JD / 生成结果落 `storage.session`（关浏览器清空）。**往 `local` 加新数据前先问：它真的需要持久吗？**

## 设计原则

**地基不稳的房子，装修再好迟早会塌。** 做技术选型时优先检查底层方案是否可靠：

- AI 输出解析：优先用文本标记（如 `## 标题` 分割），避免让 AI 输出 JSON——AI 本质是文本生成器，JSON 格式要求太严格，一丁点逗号引号错误就全炸
- 修 Bug 之前先问：这个 Bug 是偶然的错还是方案本身的缺陷？如果是方案缺陷，换方案而不是打补丁
- 用户要的效果应该用最简单最可靠的方式实现，而不是最"炫"的方案
- 如果用 JSON.parse 兜底修复超过两次，说明该换解析方式了
- **用户看到的界面不能出现任何特殊符号**（`**`、`##`、`__`、`*`、代码块标记等）。所有格式化标记必须在渲染前被清洗或转换。Prompt 里用于分块的标记符号（如 `##`）是给解析器用的，不是给用户看的
- **生成内容中禁止出现"板块一""板块二""第一部分""第二部分"等编号文字**。板块划分是 Prompt 内部指令，用户可以感知到内容层次但不应该看到编号标签

## 代码规范

**每增加一行代码都必须规范书写，保持项目风格统一。**

### 通用规则

- 缩进统一使用 2 个空格（HTML / JS），CSS / JSON 使用格式化工具默认风格
- 每条属性、每个标签独占一行，禁止将多条规则压缩到同一行
- 运算符两侧加空格，逗号后加空格
- 文件末尾保留一个空行

### HTML

- 嵌套标签必须缩进
- 属性较多时换行书写

### CSS

- 每个选择器块独立，属性分行书写
- 相关规则用 `/* ── 区块名 ── */` 注释分隔
- 颜色使用小写 hex，必要时使用 `rgba()`

### JavaScript

- 函数之间用空行 + 分区注释隔开
- 优先使用 `const`，需要重新赋值时用 `let`，禁止 `var`
- 字符串优先使用单引号
- 回调保持清晰层级，不过度嵌套

### JSON

- 标准 2 空格缩进
- 数组元素换行书写

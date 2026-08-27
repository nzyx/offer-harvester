# 面邀收割机（Chrome / Edge 扩展）

[![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4)](https://developer.chrome.com/docs/extensions/mv3)
[![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge-34A853)](https://github.com/nzyx/Job-Interview-Assistant)
[![Built with](https://img.shields.io/badge/Built%20with-Vanilla%20JS-FF7139)](https://developer.mozilla.org/docs/Web/JavaScript)
[![Zero Build](https://img.shields.io/badge/Build-Zero%20Config-000000)](https://github.com/nzyx/Job-Interview-Assistant)
[![Privacy](https://img.shields.io/badge/Privacy-100%25%20Local-9F1D20)](https://github.com/nzyx/Job-Interview-Assistant)
[![AI API](https://img.shields.io/badge/AI-OpenAI%20Compatible-412991)](https://platform.openai.com/docs/api-reference)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

> 粘贴岗位 JD、上传简历，侧边栏里一键生成**面试准备、打招呼语、简历优化**三类内容。纯前端、零构建、数据不上传，可在 Chrome / Edge 里像原生功能一样随手用。

---

## 📑 目录

- [核心特性](#核心特性)
- [三种产出模式](#三种产出模式)
- [导出可视化 HTML](#导出可视化-html)
- [安装与使用](#安装与使用)
- [支持的 AI 服务商](#支持的-ai-服务商)
- [数据与隐私](#数据与隐私)
- [项目结构](#项目结构)
- [常见问题](#常见问题)
- [技术栈](#技术栈)
- [许可证](#许可证)

---

## 核心特性

- **两步串联，质量更高**：先「岗位分析」拆解 JD，再基于分析结果生成「面试准备」——不是凭空编题，而是真正对齐岗位要求。
- **三种产出模式**：面试准备 / 打招呼语 / 简历优化，各适配不同的求职场景。
- **简历文件上传**：支持 `TXT / MD / PDF / DOCX` 本地解析，文件**不上传**，只在本地参与生成。
- **网页复制保护**：一键解除网页复制限制，方便摘录参考资料（侧边栏关闭即失效）。
- **内容记忆**：关闭侧边栏后输入与结果自动保留，浏览器关闭后自动清空（会话级）。
- **一键导出**：任意一份结果都能导出为**自包含的可视化 HTML 网页**，可直接分享或打印成 PDF。

---

## 三种产出模式

### ① 面试准备（岗位分析 + 面试准备）

分两段，且第二段基于第一段的分析结果：

- **岗位分析**：给岗位一句话定位（竞争力评估）→「JD 重点精读」→「关键技能解读」（结构化拆解每项能力 + 行业真实要求）→「隐藏要求挖掘」→「业务背景补充」（含行业术语解释）。
- **面试准备**：「高频面试问题」——预测 6–8 道题目并附**完整参考答案**（STAR + 数字）→「面试现场要点」——被问住时的缓冲话术、反问环节高质量三问、闭环思维表达等实战技巧。

> 关键句会用红色高亮标出，一眼抓住重点。

### ② 打招呼语（Cold Outreach）

- **专业版**：偏完整、体现经历与匹配度的联系 HR 话术。
- **简洁版**：更短、更轻量，适合评论区 / 私信场景。
- **注意事项**：指出你简历与 JD 之间的匹配缺口，并给出「立刻能做的一件事」来补上短板。

### ③ 简历优化（Resume Optimization）

- **匹配度评分**：大号百分比直观展示岗位契合度，附评分依据与明显缺口。
- **经历改写卡**：按「动作 / 方法 / 技术 / 解决问题 / 成果」键值网格重组你的项目经历，像简历条目一样清晰。
- **关键词植入**：建议添加的关键词 + 植入位置，单层编号清单。
- **成品话术**：版本一 / 版本二 两份可直接复制粘贴的完整成稿，与「分析建议」区分开。

---

## 导出可视化 HTML

每份生成结果右上角都有「**导出 HTML**」按钮，点一下下载一个**自包含网页文件**（无需联网、无外部依赖）：

- 杂志专访页风格：红色 eyebrow + 衬线大标题 + 超大章节编号 + 关键句红色高亮；
- 简历优化模式有专属版式（评分卡 / 经历卡 / 成品话术卡），不与面试准备混用同一套编号；
- 打印友好：导出的 HTML 在打印时自动转成白底、红下划线高亮，适合直接存成 PDF 发给别人；
- 安全：导出文件内**无脚本、无外链**，可放心分享。

---

## 安装与使用

1. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`；
2. 开启右上角「**开发人员模式**」；
3. 点击「**加载已解压的扩展程序**」，选择本项目文件夹；
4. 点击工具栏中的「面邀收割机」图标打开侧边栏；
5. 在侧边栏右上角「**设置**」里填写 AI 服务商的**接口地址、API Key、模型名称**，保存即可。

> 未配置 API 时会展示本地演示内容，方便先确认整体流程。

---

## 支持的 AI 服务商

OpenAI / DeepSeek / Moonshot (Kimi) / 智谱 GLM / 通义千问 / 豆包 / Anthropic (Claude)，以及**任何其他兼容 OpenAI Chat Completions 协议的接口**。

接口地址需填完整的 `.../v1/chat/completions` 路径；本地部署的模型（如 `http://127.0.0.1:8080`）同样支持。

---

## 数据与隐私

- 无后端服务器，纯前端运行；
- **API Key** 存本地浏览器存储（磁盘持久）；岗位描述、简历内容、生成结果存**会话级存储**，浏览器关闭后自动清空；
- 网络请求**仅**发给你自行配置的 AI 接口，不发给任何第三方；
- 导出的 HTML 文件完全在本地生成，不含任何脚本或外链。

---

## 项目结构

```
Job-Interview-Assistant/
├── manifest.json            # Manifest V3 配置（side_panel / content_scripts）
├── popup.html / popup.js / styles.css   # 侧边栏界面与逻辑
├── options.html / options.js            # 设置页（接口/Key/模型 + 协议校验）
├── background.js            # Service Worker + 复制保护协调
├── copy-guard.js            # 内容脚本（ISOLATED 世界，清理拦截器）
├── copy-guard-main.js       # 内容脚本（MAIN 世界，改写 preventDefault）
├── common.js                # 共享：错误说明 / 地址白名单校验
├── prompts.js               # 加载 prompts/*.md
├── prompts/                 # 四个模式的提示词
│   ├── jd-analysis.md
│   ├── interview-prep.md
│   ├── greeting.md
│   └── resume-optimize.md
├── lib/                     # 第三方依赖：pdf.js / mammoth.js
├── assets/                  # 图标
└── README.md / CLAUDE.md / CODE-REVIEW.md
```

---

## 常见问题

**Q：没有 API Key 能用吗？**
能。未配置时会展示本地演示内容，方便先确认流程；但要生成真实内容需填入你自己的 AI 接口。

**Q：支持本地模型吗？**
支持。只要接口兼容 OpenAI Chat Completions 协议（如本地 `127.0.0.1:8080`），在设置里填对应地址即可。

**Q：复制保护会被商店拒吗？**
复制保护内容脚本覆盖 `<all_urls>` 且改写 `Event.preventDefault`，能力较强，适合自用；若上架 Chrome Web Store 需收窄作用域。

**Q：导出的 HTML 安全吗？**
安全。文件内无 `<script>`、无外链，纯静态，可放心分享。

---

## 技术栈

- Chrome / Edge **Manifest V3** 侧边栏扩展（side panel）
- 原生 **HTML / CSS / JavaScript**，零框架、零构建工具
- PDF 解析 `pdf.js`、DOCX 解析 `mammoth.js`
- AI 输出采用纯文本 `## 标题` 分块解析，不依赖 JSON
- 提示词以 `prompts/*.md` 维护，运行时加载

---

## 许可证

本项目以 [MIT License](./LICENSE) 开源。

---

> ⚠️ 免责声明：本工具生成的内容由 AI 根据 JD 与简历推断，仅供参考，请结合真实经历审阅后使用；面试与求职结果由使用者自行负责。

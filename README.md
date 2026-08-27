# 面邀收割机（Chrome / Edge 扩展）

[![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4)](https://developer.chrome.com/docs/extensions/mv3)
[![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge-34A853)](https://github.com/nzyx/Job-Interview-Assistant)
[![Built with](https://img.shields.io/badge/Built%20with-Vanilla%20JS-FF7139)](https://developer.mozilla.org/docs/Web/JavaScript)
[![Zero Build](https://img.shields.io/badge/Build-Zero%20Config-000000)](https://github.com/nzyx/Job-Interview-Assistant)
[![Privacy](https://img.shields.io/badge/Privacy-100%25%20Local-9F1D20)](https://github.com/nzyx/Job-Interview-Assistant)
[![AI API](https://img.shields.io/badge/AI-OpenAI%20Compatible-412991)](https://platform.openai.com/docs/api-reference)

粘贴岗位 JD，一键生成面试准备方案、高频问题预测、打招呼语和简历优化建议。支持 7 家主流 AI 服务，所有数据本地存储，不上传任何服务器。

## 功能

- **岗位分析 + 面试准备**：粘贴 JD 自动拆解技能要求、隐藏条件、行业背景，预测 6-8 个高频面试问题并附参考答案，给出现场话术和避坑技巧
- **打招呼语**：根据 JD 和简历生成专业版、简洁版两套联系 HR 的话术，附一条匹配度行动建议，可直接复制
- **简历优化**：匹配度评分、经历改写（动作+方法+结果）、JD 关键词植入建议、两个自我评价版本，附整体投递建议
- **简历文件上传**：支持 TXT / MD / PDF / DOCX 本地解析，文件不上传
- **网页复制保护**：一键解除网页复制限制，方便复制参考资料
- **内容记忆**：关闭侧边栏后输入内容和生成结果自动保留，浏览器关闭后自动清空

## 使用

1. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`
2. 开启「开发人员模式」，点击「加载已解压的扩展程序」
3. 选择本项目文件夹
4. 点击工具栏中的「面邀收割机」打开侧边栏
5. 在「设置」中填写 AI 服务商的接口地址、API Key 和模型名称

未配置 API 时会展示本地演示内容，方便先确认流程。

## 支持的 AI 服务商

OpenAI / DeepSeek / Moonshot (Kimi) / 智谱 GLM / 通义千问 / 豆包 / Anthropic (Claude)，以及其他兼容 OpenAI Chat Completions 协议的任意服务。

## 数据与隐私

- 无后端服务器，纯前端运行
- API Key 存本地浏览器存储（磁盘持久）；岗位描述、简历内容、生成结果存内存级存储，浏览器关闭后自动清空
- 网络请求仅发给用户自行配置的 AI 接口，不发给任何第三方

## 技术

- Chrome / Edge Manifest V3 侧边栏扩展
- 原生 HTML / CSS / JavaScript，零框架、零构建工具
- PDF 解析用 pdf.js、DOCX 解析用 mammoth.js
- AI 输出采用纯文本 `## 标题` 分块解析，不依赖 JSON

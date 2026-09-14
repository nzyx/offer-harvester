// 生成「向导预览.html」：把 popup.html 展开成三步同时可见的静态快照，
// 用于在没有浏览器扩展环境时检查向导的排版与状态样式。
// 用法：node tests/make-preview.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');

// 1) 去掉所有 hidden，让三步都能看见
html = html.replace(/\s+hidden(?=[\s>])/g, '');
// 2) 去掉脚本，避免预览里报 chrome is undefined
html = html.replace(/<script[\s\S]*?<\/script>/g, '');

// 2b) 撤销按钮只在「抓取覆盖了已有内容」之后出现，预览里没有覆盖动作，恢复为隐藏
html = html.replace(
  '<button id="grab-undo" class="text-button" type="button">',
  '<button id="grab-undo" class="text-button" type="button" hidden>'
);

// 3) 结构化面板填示例内容（真实数据由 profile.js 渲染，这里只为看排版）
html = html.replace(
  '<p class="profile-summary" id="profile-summary">尚未解析</p>',
  '<p class="profile-summary" id="profile-summary">已填 18 项 · 教育 1 段 · 实习/工作 2 段 · 项目 1 个</p>'
);
html = html.replace('<span id="profile-meter-bar"></span>', '<span id="profile-meter-bar" style="width:62%"></span>');

// 3a) 解析状态的可视化：状态徽标 + 「数据在哪里」常驻说明
html = html.replace(
  '<span class="profile-state" id="profile-state" data-state="idle">待解析</span>',
  '<span class="profile-state" id="profile-state" data-state="ready">已解析</span>'
);
html = html.replace(
  '<p class="profile-where" id="profile-where">解析结果保存在本机，网申预填与后续生成都读它</p>',
  '<p class="profile-where" id="profile-where">已存在本机，网申预填与后续生成都读它</p>'
);
// 3b) 解析中与结果横幅互斥，预览展示「解析完成」那一个瞬间
html = html.replace(
  '<div id="profile-progress" class="generating-status">',
  '<div id="profile-progress" class="generating-status" hidden>'
);
html = html.replace(
  '<div id="profile-status" class="profile-result" data-kind="info">',
  '<div id="profile-status" class="profile-result" data-kind="ok">'
);
html = html.replace(
  '<strong id="profile-status-title"></strong>',
  '<strong id="profile-status-title">解析完成 · 已保存到本机 18 项</strong>'
);
html = html.replace(
  '<p id="profile-status-detail"></p>',
  '<p id="profile-status-detail">教育 1 段 · 实习/工作 2 段 · 项目 1 个｜未连接 AI，本次用本地规则解析。到「设置」连接 AI 后重新解析会更准更全。</p>'
);
html = html.replace(
  '<span class="profile-savestate" id="profile-savestate"></span>',
  '<span class="profile-savestate" id="profile-savestate" data-kind="ok">已保存到本机</span>'
);

// 3c) 分组命中数：一眼看到「解析出了什么」
const count = (n, total) => `<span class="pf-group-count">${n}/${total}</span>`;
const groups = `<section class="pf-group"><div class="pf-group-head"><h4>基础信息${count(7, 8)}</h4></div><div class="pf-rows">
<div class="pf-row"><label>姓名</label><input class="pf-input" value="张三"></div>
<div class="pf-row"><label>性别</label><input class="pf-input" value="男"></div>
<div class="pf-row"><label>出生日期</label><input class="pf-input" value="2002.05"></div>
<div class="pf-row"><label>手机号</label><input class="pf-input" value="13800000000"></div>
<div class="pf-row"><label>邮箱</label><input class="pf-input" value="zhangsan@example.com"></div>
<div class="pf-row"><label>现居城市</label><input class="pf-input" value="深圳"></div>
<div class="pf-row"><label>籍贯</label><input class="pf-input" value="广东汕头"></div>
<div class="pf-row"><label>生源地</label><input class="pf-input" value="广东汕头"></div>
<div class="pf-row"><label>政治面貌</label><input class="pf-input" value="共青团员"></div>
</div></section>
<section class="pf-group"><div class="pf-group-head">
<h4>求职意向${count(2, 5)}</h4></div><div class="pf-rows">
<div class="pf-row"><label>期望岗位</label><input class="pf-input" value="产品运营"></div>
<div class="pf-row"><label>期望城市</label><input class="pf-input" value="深圳 / 广州"></div>
<div class="pf-row"><label>期望薪资</label><input class="pf-input" value=""></div>
<div class="pf-row"><label>到岗时间</label><input class="pf-input" value=""></div>
<div class="pf-row"><label>求职类型</label><input class="pf-input" value=""></div>
</div></section>
<section class="pf-group"><div class="pf-group-head">
<h4>教育经历${count(6, 8)}</h4>
<button class="pf-add" type="button" data-group="education">+ 添加一条</button></div>
<article class="pf-item"><div class="pf-item-head"><span class="pf-item-idx">01</span><span class="pf-item-title">教育经历</span>
<button class="pf-remove" type="button" title="删除这一条">×</button></div>
<div class="pf-rows">
<div class="pf-row"><label>学校</label><input class="pf-input" value="广东海洋大学"></div>
<div class="pf-row"><label>专业</label><input class="pf-input" value="新闻学"></div>
<div class="pf-row"><label>学历</label><input class="pf-input" value="本科"></div>
<div class="pf-row"><label>开始时间</label><input class="pf-input" value="2022.09"></div>
<div class="pf-row"><label>结束时间</label><input class="pf-input" value="2026.06"></div>
<div class="pf-row"><label>GPA</label><input class="pf-input" value="3.7/4.0"></div>
<div class="pf-row"><label>专业排名</label><input class="pf-input" value="专业前 20%"></div>
<div class="pf-row"><label>主修课程</label><textarea class="pf-input" rows="2">数字电子技术、模拟电子技术、Python 程序设计</textarea></div>
<div class="pf-row"><label>培养方式</label><input class="pf-input" value="全日制"></div>
</div></article>
</section>
<section class="pf-group"><div class="pf-group-head">
<h4>技能与补充${count(3, 5)}</h4></div><div class="pf-rows">
<div class="pf-row"><label>技能标签</label><input class="pf-input" value="SQL、Figma、内容运营"></div>
<div class="pf-row"><label>语言等级</label><input class="pf-input" value="英语 CET-6"></div>
<div class="pf-row"><label>证书</label><input class="pf-input" value=""></div>
<div class="pf-row"><label>荣誉奖项</label><textarea class="pf-input" rows="2">国家励志奖学金、校级三好学生</textarea></div>
<div class="pf-row"><label>自我评价</label><textarea class="pf-input" rows="2"></textarea></div>
<div class="pf-row"><label>作品 / 主页链接</label><input class="pf-input" value=""></div>
</div></section>`;
html = html.replace('<div id="profile-groups" class="profile-groups"></div>', `<div id="profile-groups" class="profile-groups">${groups}</div>`);

// 4) 第 1 步保持展开 → 收起它的折叠摘要行
html = html.replace('<div class="step-collapsed" id="step-resume-collapsed">', '<div class="step-collapsed" id="step-resume-collapsed" hidden>');

// 5) 第 2 步演示折叠态（实际使用中走过一步就长这样）
html = html.replace('<section class="wizard-step" id="step-job"', '<section class="wizard-step is-collapsed" id="step-job"');
html = html.replace(
  '<p class="step-collapsed-text" id="step-job-summary"></p>',
  '<p class="step-collapsed-text" id="step-job-summary">26 字 · 招聘产品运营，负责用户增长与数据分析…</p>'
);

// 6) 产出卡：同时展示「可以生成」与「需先补」两种状态
html = html.replace('<span class="output-state" id="state-interview"></span>', '<span class="output-state is-ready" id="state-interview">可以生成</span>');
html = html.replace('<span class="output-state" id="state-greeting"></span>', '<span class="output-state" id="state-greeting">需先补简历</span>');
html = html.replace('<span class="output-state" id="state-optimize"></span>', '<span class="output-state" id="state-optimize">需先补简历</span>');
html = html.replace('<span class="output-state" id="state-autofill"></span>', '<span class="output-state is-ready" id="state-autofill">可以填写</span>');

// 6b) 网申预填面板填示例内容（真实数据由 popup.js 渲染，这里只为看排版）
html = html.replace('<p class="autofill-site" id="autofill-site"></p>', '<p class="autofill-site" id="autofill-site">app.mokahr.com</p>');
html = html.replace(
  '<p class="autofill-summary" id="autofill-summary"></p>',
  '<p class="autofill-summary" id="autofill-summary">扫描到 24 个可编辑控件 · 可自动填 15 项 · 需你处理 9 项</p>'
);
html = html.replace('<span id="autofill-fill-count"></span>', '<span id="autofill-fill-count">15 项</span>');
html = html.replace('<span id="autofill-manual-count"></span>', '<span id="autofill-manual-count">9 项</span>');

const afItem = (label, value, right, sub) =>
  `<div class="af-item"><span class="af-item-label">${label}</span>`
  + `<span class="af-item-meta"><span class="af-item-value">${value}</span>`
  + (right ? `<span class="af-item-right">${right}</span>` : '')
  + `</span>${sub ? `<span class="af-item-sub">${sub}</span>` : ''}</div>`;

const fillItems = [
  afItem('姓名', '张三', '姓名'),
  afItem('手机号码', '13800000000', '手机号'),
  afItem('电子邮箱', 'zhangsan@example.com', '邮箱'),
  afItem('性别', '男', '性别'),
  afItem('期望岗位', '产品运营', '期望岗位'),
  afItem('学校名称', '广东海洋大学', '学校'),
  afItem('专业名称', '新闻学', '专业'),
  afItem('最高学历', '本科（全日制）', '学历', '选项按近似匹配为「本科（全日制）」，请核对'),
  afItem('入学时间', '2022-09', '入学时间'),
  afItem('公司名称', '鹅创营', '公司'),
  afItem('职位名称', '产品实习生', '职位')
].join('');
html = html.replace('<div class="autofill-list" id="autofill-fill-list"></div>', `<div class="autofill-list" id="autofill-fill-list">${fillItems}</div>`);

const manualItems = [
  afItem('身份证号', '敏感字段', '', '默认不写入网申页面。需要时打开敏感字段开关后重试。'),
  afItem('现居住城市', '已有内容', '', '页面上这项已经有内容，未覆盖。'),
  afItem('上传简历附件', '文件上传', '', '浏览器不允许脚本写入文件，请手动选择文件。'),
  afItem('期望城市', '自定义下拉框', '', '这类下拉框由页面脚本模拟，写入不会生效，请手动选择。'),
  afItem('开始时间', '含义不明确', '', '这个字段可能对应多项信息，为避免填错请手动确认。'),
  afItem('兴趣爱好', '未能识别', '', '无法判断这个字段该填什么，请手动填写。')
].join('');
html = html.replace('<div class="autofill-list" id="autofill-manual-list"></div>', `<div class="autofill-list" id="autofill-manual-list">${manualItems}</div>`);
html = html.replace(
  '<p id="autofill-status" class="status-message"></p>',
  '<p id="autofill-status" class="status-message">仅用本地规则识别；填写位置会用红框标出，请核对后自行提交。</p>'
);

// 7) 步骤标记展示「已填写」态 + 顶部预览说明
html = html.replace('<span class="step-tag" id="step-resume-tag">可选</span>', '<span class="step-tag is-ok" id="step-resume-tag">已填写</span>');
html = html.replace('<span class="step-tag" id="step-job-tag">必填</span>', '<span class="step-tag is-ok" id="step-job-tag">已填写</span>');
const notice = '<p style="margin:10px 0 0;padding:9px 12px;border:1px solid #ECECEC;border-left:3px solid #E60012;border-radius:8px;background:#FAFAFA;font-size:12px;line-height:1.6;color:#2B2B2B">静态预览：实际使用时三步依次展开，走过的步骤收成一行摘要（第 2 步这里就是折叠态）。</p>\n    ';
html = html.replace('<nav class="steps"', notice + '<nav class="steps"');

const out = path.join(root, '向导预览.html');
fs.writeFileSync(out, html, 'utf8');
console.log('已生成 向导预览.html（' + html.length + ' 字符）');

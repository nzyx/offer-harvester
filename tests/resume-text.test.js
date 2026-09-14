// resume-text.js 验证：PDF 文本行重建与续行合并
// 用法：node tests/resume-text.test.js
//
// 为什么这个模块必须重点测：它一旦出错，后面所有按行处理的逻辑（本地提取规则、
// AI 提示词）同时失效，而且失效方式很隐蔽 —— 表现为字段错位、整段经历消失，
// 不会抛任何错误。改动这里之后务必跑本文件。
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, '..');
const api = new Function(
  fs.readFileSync(path.join(root, 'resume-text.js'), 'utf8')
  + ';return { rebuildPdfLines, groupPdfRows, joinPdfRows, normalLineGap, normalizeResumeText };'
)();

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}

// 构造一个 pdf.js 文本片段。transform 的 [4]=x、[5]=y（PDF 原点在左下，y 越大越靠上）
function piece(str, x, y, width) {
  return { str, transform: [1, 0, 0, 1, x, y], width: width === undefined ? str.length * 12 : width };
}
const rowsOf = (text) => text.split('\n');

console.log('=== 1. 行结构重建（原先整页压成一行）===');
// 原先的实现是 items.map(i => i.str).join(' ')，会把整页变成一行。
// 这里必须有换行，否则后续按行处理的逻辑全部失效。
const basic = api.rebuildPdfLines([
  piece('PERSONAL RESUME', 300, 800, 120),
  piece('姓名：刘子涵', 58, 760, 70),
  piece('居住地：广东省深圳市', 58, 738, 110),
  piece('广东海洋大学 电子信息工程', 58, 716, 160)
]);
check('不同 y 的片段分成多行', rowsOf(basic).length === 4, rowsOf(basic));
check('y 降序 = 从上到下', rowsOf(basic)[0] === 'PERSONAL RESUME' && rowsOf(basic)[1].startsWith('姓名'), rowsOf(basic));
check('末行内容正确', rowsOf(basic)[3] === '广东海洋大学 电子信息工程', rowsOf(basic)[3]);

console.log('\n=== 2. 行内按 x 排序，并按间距补空格 ===');
// 空格是字段之间的断词依据：少了它「姓名：刘子涵居住地：深圳」会被正则读成一个名字
const inline = api.rebuildPdfLines([
  piece('姓名：', 58, 700, 24),
  piece('刘子涵', 82, 700, 30),        // 与上一片段紧邻（gap = 0）→ 不加空格
  piece('居住地：', 200, 700, 36),     // 前面有 88 的间距 → 加空格
  piece('深圳', 236, 700, 20)
]);
check('紧邻片段直接拼接', inline.includes('姓名：刘子涵'), inline);
check('分出列的片段之间留空格', inline.includes('刘子涵 居住地：深圳'), inline);
check('整行只有一行', rowsOf(inline).length === 1, rowsOf(inline));

// 片段顺序打乱也能按 x 还原
const unsorted = api.rebuildPdfLines([
  piece('深圳', 236, 700, 20),
  piece('居住地：', 200, 700, 36),
  piece('刘子涵', 82, 700, 30),
  piece('姓名：', 58, 700, 24)
]);
check('片段乱序时按 x 还原顺序', unsorted === inline, unsorted);

// 同一行 y 有零点几像素差异也要归为一行
const nearSameY = api.rebuildPdfLines([
  piece('姓名：', 58, 700.0, 24),
  piece('刘子涵', 82, 699.4, 30)
]);
check('y 相差不到 3 视为同一行', rowsOf(nearSameY).length === 1, rowsOf(nearSameY));

console.log('\n=== 3. 续行合并（PDF 硬换行会把一句话切断）===');
// 不合并的话「工作内容」是断的，主修课程会被截断
const wrap = api.rebuildPdfLines([
  piece('实习经历', 50, 700, 60),
  piece('2026.06-2026.8 某公司 实习生', 50, 680, 200),
  piece('负责产品文档制作与数据整理，参与规格书编', 60, 660, 400),
  piece('写，累计输出 8 篇文档。', 60, 640, 140),
  piece('协助需求沟通。', 60, 620, 100),
  piece('2025.09-2025.10 另一公司 专员', 50, 600, 200)
]);
const wrapRows = rowsOf(wrap);
check('被切断的长句合并成一行', wrap.includes('负责产品文档制作与数据整理，参与规格书编写，累计输出 8 篇文档。'), wrapRows);
check('合并后行数减少', wrapRows.length === 5, wrapRows);
check('句末标点的行不与其下合并', wrapRows.includes('协助需求沟通。'), wrapRows);

console.log('\n=== 4. 五种不该合并的情况 ===');
// 跨行合并最容易出的错是「把相邻条目粘成一团」，每种情况各有一条断言
const sameGap = 20;
const rowAt = (text, x, y) => piece(text, x, y, text.length * 9);

// ① 条目头 + 描述首句：不能合并（否则项目名会吞掉描述第一句）
const headThenBody = api.rebuildPdfLines([
  rowAt('填充行一', 50, 760), rowAt('填充行二', 50, 740), rowAt('填充行三', 50, 720),
  rowAt('2026.03-2026.06 腾讯研习生专项 学员-TOP20', 50, 700),
  rowAt('AI Agent 介入下品牌触达路径变化研究', 50, 700 - sameGap * 2)
]);
check('条目头不吞掉其后的描述首句',
  rowsOf(headThenBody).some(r => r === '2026.03-2026.06 腾讯研习生专项 学员-TOP20') && rowsOf(headThenBody).some(r => r === 'AI Agent 介入下品牌触达路径变化研究'),
  rowsOf(headThenBody));

// ② 「字段名：值」：不能合并（否则 GPA 那行会吞掉主修课程）
const twoFields = api.rebuildPdfLines([
  rowAt('填充行一', 50, 760), rowAt('填充行二', 50, 740), rowAt('填充行三', 50, 720),
  rowAt('GPA：3.7（专业前20%）', 50, 700),
  rowAt('主修课程：嵌入式Linux系统，数字电子技术', 50, 680)
]);
check('字段行不吞掉下一个字段行',
  rowsOf(twoFields).some(r => r === 'GPA：3.7（专业前20%）') && rowsOf(twoFields).some(r => r.startsWith('主修课程：')),
  rowsOf(twoFields));

// ③ 缩进不同：小标题与正文的左缩进不一样
const diffIndent = api.rebuildPdfLines([
  rowAt('填充行一', 50, 760), rowAt('填充行二', 50, 740), rowAt('填充行三', 50, 720),
  rowAt('产品文档与需求支持', 50, 700),
  rowAt('将产品硬件参数转化为产品语言', 68, 680)
]);
check('缩进不同的小标题与正文不合并',
  rowsOf(diffIndent).some(r => r === '产品文档与需求支持') && rowsOf(diffIndent).some(r => r === '将产品硬件参数转化为产品语言'),
  rowsOf(diffIndent));

// ④ 段落间距明显大于正常行距
const bigGap = api.rebuildPdfLines([
  rowAt('填充行一', 50, 760), rowAt('填充行二', 50, 740), rowAt('填充行三', 50, 720),
  rowAt('2023.09-2027.06 广东海洋大学 电子信息工程', 50, 700),
  rowAt('GPA：3.7（专业前20%）', 50, 670)   // 间距 30 > 20*1.15
]);
check('段落间距大时不合并',
  rowsOf(bigGap).some(r => r === 'GPA：3.7（专业前20%）'),
  rowsOf(bigGap));

// ⑤ 下一行含日期范围 → 是新的一条经历
const nextItem = api.rebuildPdfLines([
  rowAt('填充行一', 50, 760), rowAt('填充行二', 50, 740), rowAt('填充行三', 50, 720),
  rowAt('某公司 产品专员', 50, 700),
  rowAt('2025.012-2026.03 可解释机器学习在电信客户流失预测中的应用', 50, 680)
]);
check('含日期范围的下一行独立成行',
  rowsOf(nextItem).some(r => r === '2025.012-2026.03 可解释机器学习在电信客户流失预测中的应用'),
  rowsOf(nextItem));

console.log('\n=== 5. 异常与边界输入 ===');
check('空数组返回空串', api.rebuildPdfLines([]) === '', api.rebuildPdfLines([]));
check('null 不崩', api.rebuildPdfLines(null) === '');
check('undefined 不崩', api.rebuildPdfLines(undefined) === '');
check('全空白片段被丢弃', api.rebuildPdfLines([piece('   ', 10, 10), piece('\n', 10, 10)]) === '', api.rebuildPdfLines([piece('   ', 10, 10)]));
check('缺少 transform 不崩', api.rebuildPdfLines([{ str: '兜底' }]) === '兜底', api.rebuildPdfLines([{ str: '兜底' }]));
check('缺少 width 不崩', api.rebuildPdfLines([{ str: 'a', transform: [1, 0, 0, 1, 10, 20] }, { str: 'b', transform: [1, 0, 0, 1, 30, 20] }]).includes('a'), api.rebuildPdfLines([{ str: 'a', transform: [1, 0, 0, 1, 10, 20] }, { str: 'b', transform: [1, 0, 0, 1, 30, 20] }]));
check('单个片段也能处理', api.rebuildPdfLines([piece('只有一行', 10, 20, 40)]) === '只有一行');
check('trailing 空白被去掉', api.rebuildPdfLines([piece('末尾有空白   ', 10, 20, 90)]) === '末尾有空白', JSON.stringify(api.rebuildPdfLines([piece('末尾有空白   ', 10, 20, 90)])));

console.log('\n=== 6. 正常行距的计算 ===');
const gapRows = api.groupPdfRows([
  piece('a', 10, 300, 8), piece('b', 10, 280, 8), piece('c', 10, 260, 8),
  piece('d', 10, 240, 8), piece('e', 10, 200, 8)
]);
check('取出现次数最多的行距', api.normalLineGap(gapRows) === 20, api.normalLineGap(gapRows));
check('行距全不相同时有兜底值', api.normalLineGap(api.groupPdfRows([piece('a', 10, 300, 8), piece('b', 10, 250, 8)])) > 0);

console.log('\n=== 7. 纯文本来源的规整 ===');
check('CRLF 统一为 LF', api.normalizeResumeText('a\r\nb') === 'a\nb', JSON.stringify(api.normalizeResumeText('a\r\nb')));
check('单独的 CR 也统一', api.normalizeResumeText('a\rb') === 'a\nb');
check('去掉行尾空白', api.normalizeResumeText('a   \nb\t') === 'a\nb', JSON.stringify(api.normalizeResumeText('a   \nb\t')));
check('折叠多余空行', api.normalizeResumeText('a\n\n\n\nb') === 'a\n\nb', JSON.stringify(api.normalizeResumeText('a\n\n\n\nb')));
check('保留段落空行', api.normalizeResumeText('a\n\nb') === 'a\n\nb');
check('首尾空白被裁掉', api.normalizeResumeText('\n\n  a  \n\n') === 'a', JSON.stringify(api.normalizeResumeText('\n\n  a  \n\n')));
check('空输入返回空串', api.normalizeResumeText('') === '' && api.normalizeResumeText(null) === '');
check('不动行内的空格', api.normalizeResumeText('a  b') === 'a  b');

console.log('\n=== 8. 真实简历片段的整体还原 ===');
// 用用户简历里的真实排版，串起上面所有规则
const realish = api.rebuildPdfLines([
  piece('教育背景 Educational background', 67, 700, 200),
  piece('2023.09-2027.06（准大四） 广东海洋大学 电子信息工程专业', 37, 680, 340),
  piece('GPA：3.7（专业前20%）', 37, 660, 130),
  piece('主修课程：嵌入式Linux系统，云计算与大数据，数字电子技术，模拟', 37, 640, 470),
  piece('电子技术，单片机原理与应用，Python设计。', 37, 620, 240),
  piece('实习经历 Internship experience', 67, 580, 210),
  piece('2026.06-2026.8 深圳美高创新股份有限公司 产品营销实习生（迷你PC/NAS）', 37, 560, 420),
  piece('产品文档与需求支持', 37, 540, 110),
  piece('将产品硬件参数及产品能力转化为市场可理解的产品语言，参与产品规格书、培训材料等文档制', 56, 520, 470),
  piece('作，累计输出 8 篇产品文档及培训资料。', 56, 500, 220)
]);
const realRows = rowsOf(realish);
check('GPA 与主修课程是两行', realRows.includes('GPA：3.7（专业前20%）'), realRows);
check('主修课程跨行被接回', realRows.some(r => r.includes('数字电子技术，模拟电子技术，单片机原理与应用，Python设计。')), realRows);
check('实习条目头完整保留', realRows.some(r => r === '2026.06-2026.8 深圳美高创新股份有限公司 产品营销实习生（迷你PC/NAS）'), realRows);
check('条目头没吞掉小标题', realRows.includes('产品文档与需求支持'), realRows);
check('描述跨行被接回', realRows.some(r => r.includes('培训材料等文档制作，累计输出 8 篇产品文档及培训资料。')), realRows);
check('小标题与其正文不被合并', !realRows.some(r => r.startsWith('产品文档与需求支持将产品')), realRows);

console.log(`\n──────── 结果：${pass} 通过 / ${fail} 失败 ────────`);
process.exit(fail ? 1 : 0);

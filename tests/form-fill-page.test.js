// form-fill-page.js 验证：标签解析与「无信息量文字」识别
// 用法：node tests/form-fill-page.test.js
//
// 为什么必须单独测这一层：内容脚本原本一行测试都没有，而「学校抓不到」
// 这个真实报障恰好就出在这里 —— 学校字段其实被扫描到了，但标签位上
// 拿到的是占位符「请选择」，于是永远认不出。语义层（form-fill.js）再好，
// 也救不回一个没拿到标签的字段。
//
// 用最小 DOM 桩在 node 下跑：只实现这几个函数真正用到的那点能力
// （childNodes / textContent / parentElement / previousElementSibling /
// getAttribute / closest / matches / querySelector），不引入任何依赖。
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, '..');
const api = require(path.join(root, 'form-fill-page.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}

// ── 最小 DOM 桩 ────────────────────────────────

const SIMPLE_RE = /^([a-zA-Z]+)?(?:\[([^\]=]+)(?:=["']?([^"'\]]*)["']?)?\])?$/;

function matchesSimple(node, simple) {
  const m = SIMPLE_RE.exec(String(simple).trim());
  if (!m || !node || node.nodeType !== 1) return false;
  const tag = m[1];
  const attr = m[2];
  const value = m[3];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (attr) {
    const actual = node.getAttribute(attr);
    if (actual === null) return false;
    if (value !== undefined && value !== '' && actual !== value) return false;
  }
  return true;
}

function matchesSelector(node, selector) {
  return String(selector).split(',').some(s => matchesSimple(node, s));
}

function descendants(node, out) {
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    out.push(child);
    descendants(child, out);
  }
  return out;
}

function makeNode(tag, attrs, children) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    attrs: attrs || {},
    childNodes: [],
    parentElement: null,
    previousElementSibling: null,
    isConnected: true,
    getAttribute(k) { return this.attrs[k] === undefined ? null : String(this.attrs[k]); },
    hasAttribute(k) { return this.attrs[k] !== undefined; },
    matches(sel) { return matchesSelector(this, sel); },
    closest(sel) {
      let cur = this;
      while (cur) { if (matchesSelector(cur, sel)) return cur; cur = cur.parentElement; }
      return null;
    },
    contains(other) {
      if (other === this) return true;
      return this.childNodes.some(c => c.nodeType === 1 && c.contains(other));
    },
    querySelector(sel) { return descendants(this, []).find(n => matchesSelector(n, sel)) || null; },
    querySelectorAll(sel) { return descendants(this, []).filter(n => matchesSelector(n, sel)); },
    // textOf() 读的就是 textContent，桩里必须提供，否则所有走 textOf 的
    // 策略（兄弟文本、label[for]、legend）都会静默返回空
    get textContent() {
      let out = '';
      for (const child of this.childNodes) out += child.nodeType === 3 ? child.nodeValue : child.textContent;
      return out;
    },
    get id() { return this.attrs.id === undefined ? '' : String(this.attrs.id); }
  };
  for (const child of children || []) attach(node, child);
  return node;
}

function text(value) {
  return { nodeType: 3, nodeValue: value, childNodes: [], contains: () => false };
}

function attach(parent, child) {
  child.parentElement = parent;
  parent.childNodes.push(child);
  return child;
}

// 补上 previousElementSibling（按父节点里的元素顺序）
function finalize(node) {
  const elements = node.childNodes.filter(c => c.nodeType === 1);
  for (let i = 0; i < elements.length; i++) {
    elements[i].previousElementSibling = i > 0 ? elements[i - 1] : null;
    finalize(elements[i]);
  }
  return node;
}

const docStub = { querySelector: () => null, getElementById: () => null };

function input(attrs) {
  const node = makeNode('input', Object.assign({ type: 'text' }, attrs || {}), []);
  // 真实 DOM 里 readonly / disabled 属性会反映成同名属性，
  // 桩里补上这层映射，否则 isSearchableCustomSelect 读 el.readOnly 永远拿到 undefined
  node.readOnly = node.attrs.readonly !== undefined;
  node.disabled = node.attrs.disabled !== undefined;
  return node;
}

// ── 1. 「无信息量文字」识别 ────────────────────

console.log('\n=== 1. 无信息量文字 ===');
const { isGenericText } = api;

check('「请选择」是占位符', isGenericText('请选择') === true);
check('「请输入」是占位符', isGenericText('请输入') === true);
check('「请填写」是占位符', isGenericText('请填写') === true);
check('「请选择日期」是占位符（只有类型没有字段名）', isGenericText('请选择日期') === true);
check('「请输入内容」是占位符', isGenericText('请输入内容') === true);
check('「选填」是占位符', isGenericText('选填') === true);
check('「(选填)」去掉括注后仍是占位符', isGenericText('(选填)') === true);
check('字数统计器「0/2000」是占位符', isGenericText('0/2000') === true, isGenericText('0/2000'));
check('纯数字「12345」是占位符', isGenericText('12345') === true);

// ── 1b. 用章节标记兜底字段名（pickFieldLabel）──
// 依据：第二轮真实报告里 28 个标签为空的控件，sectionTexts 第一条几乎全
// 是它自己的字段名 —— 字段名元素同时被 [class*="title"] 命中成了章节标记。
const { pickFieldLabel } = api;
const realSections = [
  ['出生日期', '出生日期 / 保密 / 女'],
  ['最高学历', '最高学历 / 证件照 / 证件号码'],
  ['生源地', '生源地 / 毕业学校 / 民族'],
  ['期望工作城市', '期望工作城市 / 期望月薪(税前) / 生源地'],
  ['学校名称', '学校名称 / 到岗时间 / 期望工作城市'],
  ['学历', '学历 / 专业名称 / 学院名称'],
  ['语言类型', '语言类型 / 获奖描述 / 获奖级别'],
  ['获得时间', '获得时间 / 证书名称 / 掌握程度']
];
for (const [want, joined] of realSections) {
  check('「' + want + '」从章节标记兜底', pickFieldLabel('', joined.split(' / ')) === want,
    pickFieldLabel('', joined.split(' / ')));
}
check('已有标签时不覆盖', pickFieldLabel('身份证', ['证件号码 / 出生日期 / 保密']) === '身份证');
check('全是占位符时兜底为空', pickFieldLabel('', ['请选择', '请输入']) === '');
check('纯数字标记不当标签', pickFieldLabel('', ['0/2000', '实习内容']) === '实习内容');
check('空章节列表兜底为空', pickFieldLabel('', []) === '');
check('「--」是占位符', isGenericText('--') === true);
check('空字符串是占位符', isGenericText('') === true);
check('null 是占位符', isGenericText(null) === true);
check('带空格换行仍是占位符', isGenericText(' 请 选 择 ') === true);

// 关键分辨：带字段名的占位符有信息，必须留下
check('「请输入姓名」不是占位符（含字段名）', isGenericText('请输入姓名') === false);
check('「请输入手机号码」不是占位符', isGenericText('请输入手机号码') === false);
check('「学校」不是占位符', isGenericText('学校') === false);
check('「中国大陆」不是占位符', isGenericText('中国大陆') === false);
check('「搜索职位关键词」不是占位符', isGenericText('搜索职位关键词') === false);
check('「毕业院校」不是占位符', isGenericText('毕业院校') === false);

// ── 2. 区块反推标签（本次报障的核心）──────────

console.log('\n=== 2. 从区块文字反推标签 ===');

// 北森 / antd / Element UI 的典型结构：标签和控件是同一个 form-item 的兄弟，
// 标签既不是控件的直接兄弟、也不是包着它的 <label>
function formItem(labelText, inputAttrs, extraBeforeInput) {
  const el = input(inputAttrs);
  const control = makeNode('div', { class: 'control' },
    [makeNode('div', { class: 'select-value' }, [text('请选择')]), el]);
  const children = [makeNode('div', { class: 'label' }, [text(labelText)])];
  if (extraBeforeInput) children.push(extraBeforeInput);
  children.push(control);
  const item = makeNode('div', { class: 'form-item' }, children);
  finalize(item);
  return { el, item };
}

const school = formItem('学校', { placeholder: '请选择' });
check('北森式 form-item 能反推出「学校」', api.labelFromBlock(school.el) === '学校', api.labelFromBlock(school.el));

const major = formItem('专业名称', { placeholder: '请选择' });
check('「专业名称」同样能反推', api.labelFromBlock(major.el) === '专业名称', api.labelFromBlock(major.el));

const gpa = formItem('成绩(GPA)', { placeholder: '请选择' });
check('带括号的「成绩(GPA)」能反推', api.labelFromBlock(gpa.el) === '成绩(GPA)', api.labelFromBlock(gpa.el));

// 只有占位符、没有真标签时不能瞎猜
const bareBox = makeNode('div', { class: 'form-item' }, [
  makeNode('div', { class: 'control' }, [input({ placeholder: '请选择' })])
]);
finalize(bareBox);
const bareInput = bareBox.querySelector('input');
check('只有占位符时反推为空（宁可认不出也不猜）', api.labelFromBlock(bareInput) === '', api.labelFromBlock(bareInput));

// 内层优先：外层容器一次装好几个字段时，不能把两个标签粘成一串
const row = makeNode('div', { class: 'row' }, [
  formItem('姓名', { placeholder: '请输入姓名' }).item,
  formItem('邮箱', { placeholder: '请输入邮箱' }).item
]);
finalize(row);
const emailInput = row.querySelectorAll('input')[1];
check('外层容器含多个字段时取字段自己的标签', api.labelFromBlock(emailInput) === '邮箱', api.labelFromBlock(emailInput));

// 标签排在控件后面（右置标签）也要能拿到
const rightLabel = makeNode('div', { class: 'form-item' }, [
  makeNode('div', { class: 'control' }, [input({ placeholder: '请选择' })]),
  makeNode('div', { class: 'label' }, [text('学历')])
]);
finalize(rightLabel);
const rightInput = rightLabel.querySelector('input');
check('标签排在控件后面时也能拿到', api.labelFromBlock(rightInput) === '学历', api.labelFromBlock(rightInput));

// 手机号前面挂着国家选择框：标签里会混进「中国大陆」，但必须仍含「手机」
const phoneItem = makeNode('div', { class: 'form-item' }, [
  makeNode('div', { class: 'label' }, [text('手机')]),
  makeNode('div', { class: 'country', role: 'combobox' },
    [makeNode('span', {}, [text('中国大陆')])]),
  makeNode('div', { class: 'control' }, [input({ placeholder: '请输入手机号码' })])
]);
finalize(phoneItem);
const phoneInput = phoneItem.querySelector('input');
const phoneLabel = api.labelFromBlock(phoneInput);
check('手机号能拿到含「手机」的标签', phoneLabel.includes('手机'), phoneLabel);

// 字数统计器渲染在控件前面（北森的 textarea 都带「0/2000」）。
// 它曾被反推成标签，把真正的「实习内容」顶掉 —— 工作内容因此全部识别不到。
const counterItem = makeNode('div', { class: 'form-item' }, [
  makeNode('div', { class: 'label' }, [text('实习内容')]),
  makeNode('span', { class: 'counter' }, [text('0/2000')]),
  makeNode('textarea', { placeholder: '请输入' }, [])
]);
finalize(counterItem);
const counterInput = counterItem.querySelector('textarea');
check('字数统计器不会顶掉真正的标签', api.labelFromBlock(counterInput) === '实习内容', api.labelFromBlock(counterInput));
check('resolveLabel 同样拿到「实习内容」',
  api.resolveLabel(counterInput, docStub, 'textarea').fieldLabel === '实习内容',
  api.resolveLabel(counterInput, docStub, 'textarea'));

// ── 3. 兄弟元素自己就是控件时不能当标签 ────────

console.log('\n=== 3. 兄弟是控件时不当标签 ===');

// 旧实现只看兄弟内部有没有原生控件，而国家选择框是 <div role="combobox">，
// 里面没有 input，于是它显示的「中国大陆」被当成了手机号的标签
const sibAsControl = makeNode('div', { class: 'form-item' }, [
  makeNode('div', { class: 'country', role: 'combobox' }, [makeNode('span', {}, [text('中国大陆')])]),
  makeNode('div', { class: 'control' }, [input({ placeholder: '请输入手机号码' })])
]);
finalize(sibAsControl);
const sibAsControlInput = sibAsControl.querySelector('input');
check('自身是 combobox 的兄弟不被当成标签',
  api.textFromPrecedingSibling(sibAsControlInput) === '',
  api.textFromPrecedingSibling(sibAsControlInput));

// 普通兄弟（纯文字）仍然要能当标签
const sibPlain = makeNode('div', { class: 'form-item' }, [
  makeNode('div', { class: 'label' }, [text('籍贯')]),
  makeNode('div', { class: 'control' }, [input({ placeholder: '请选择' })])
]);
finalize(sibPlain);
const sibPlainInput = sibPlain.querySelector('input');
check('纯文字兄弟仍能当标签', api.textFromPrecedingSibling(sibPlainInput) === '籍贯',
  api.textFromPrecedingSibling(sibPlainInput));

// 兄弟是「请选择」这种占位符，不能被当成标签
const sibPlaceholder = makeNode('div', { class: 'form-item' }, [
  makeNode('div', { class: 'hint' }, [text('请选择')]),
  makeNode('div', { class: 'control' }, [input({ placeholder: '请输入' })])
]);
finalize(sibPlaceholder);
const sibPlaceholderInput = sibPlaceholder.querySelector('input');
check('占位符兄弟不被当成标签', api.textFromPrecedingSibling(sibPlaceholderInput) === '',
  api.textFromPrecedingSibling(sibPlaceholderInput));

// ── 4. resolveLabel 端到端 ─────────────────────

console.log('\n=== 4. 标签解析全链路 ===');

check('北森式 → fieldLabel 是「学校」',
  api.resolveLabel(school.el, docStub, 'text').fieldLabel === '学校',
  api.resolveLabel(school.el, docStub, 'text'));

const labelWrap = makeNode('label', {}, [text('姓名'), input({ placeholder: '请输入姓名' })]);
finalize(labelWrap);
const wrappedInput = labelWrap.querySelector('input');
check('包在 <label> 里能拿到', api.resolveLabel(wrappedInput, docStub, 'text').fieldLabel === '姓名',
  api.resolveLabel(wrappedInput, docStub, 'text'));

const tableCell = makeNode('table', {}, [
  makeNode('tr', {}, [
    makeNode('td', {}, [text('姓名')]),
    makeNode('td', {}, [input({ placeholder: '请输入' })])
  ])
]);
finalize(tableCell);
const tableInput = tableCell.querySelector('input');
check('表格布局能拿到', api.resolveLabel(tableInput, docStub, 'text').fieldLabel === '姓名',
  api.resolveLabel(tableInput, docStub, 'text'));

check('aria-label 优先于区块反推',
  api.resolveLabel(makeNode('input', { 'aria-label': '毕业院校', placeholder: '请选择' }, []), docStub, 'text')
    .fieldLabel === '毕业院校');

// 占位符不能占住标签位：它一旦被当成标签，后面的区块反推就没机会跑了
const genericOnly = formItem('请选择', { placeholder: '请选择' });
check('标签位是占位符时不会被采纳',
  api.resolveLabel(genericOnly.el, docStub, 'text').fieldLabel === '',
  api.resolveLabel(genericOnly.el, docStub, 'text'));

// 区块文字兜底：反推不出来时交给近邻弱信号层，而不是留空
const nearbyOnly = makeNode('div', { class: 'form-item' }, [
  makeNode('div', { class: 'control' }, [input({ placeholder: '请选择' })]),
  makeNode('div', { class: 'label' }, [text('这是一段相当长的说明文字，用来说明该字段应当怎样填写')])
]);
finalize(nearbyOnly);
const nearbyInput = nearbyOnly.querySelector('input');
check('超长文字不进标签位', api.labelFromBlock(nearbyInput) === '', api.labelFromBlock(nearbyInput));
check('但会交给近邻层兜底', api.nearbyTextFromBlock(nearbyInput).includes('说明文字'),
  api.nearbyTextFromBlock(nearbyInput));

// ── 5. 不引入回归：真实站点的常见排版 ──────────

console.log('\n=== 5. 常见排版不回归 ===');

const cases = [
  ['姓名', { placeholder: '请输入姓名' }],
  ['电子邮箱', { placeholder: '请输入' }],
  ['手机号码', { placeholder: '请输入手机号码' }],
  ['毕业院校', { placeholder: '请选择' }],
  ['单位名称', { placeholder: '请输入单位名称' }],
  ['职位名称', { placeholder: '请输入' }],
  ['项目名称', { placeholder: '请输入' }],
  ['实习内容', { placeholder: '请输入' }]
];
for (const [label, attrs] of cases) {
  const built = formItem(label, attrs);
  check('「' + label + '」标签解析正确', api.labelFromBlock(built.el) === label, api.labelFromBlock(built.el));
}

// ── 6. 控件类型判定：脚本接管的控件不能被当成普通文本框 ──

console.log('\n=== 6. 控件类型判定 ===');
const { fieldTypeOf, isSearchableCustomSelect } = api;

check('普通输入框是 text', fieldTypeOf(input({ placeholder: '请输入姓名' })) === 'text');
check('role=combobox 是自定义下拉框', fieldTypeOf(input({ role: 'combobox' })) === 'custom-select');
check('role=combobox + list 是 datalist，按 text 处理',
  fieldTypeOf(input({ role: 'combobox', list: 'schools' })) === 'text');
check('单行文本不会因为容器里有个下拉框就被判成下拉框',
  fieldTypeOf(input({ placeholder: '请输入' })) === 'text');
// 北森的 lookup（选学校/部门）带 aria-haspopup：它不是自由输入框，
// 当普通文本框写进去会「看起来填上了、其实没选中」，提交时值丢掉
check('aria-haspopup 是脚本接管的控件', fieldTypeOf(input({ 'aria-haspopup': 'listbox' })) === 'custom-select');
check('aria-expanded 同理', fieldTypeOf(input({ 'aria-expanded': 'false' })) === 'custom-select');
check('date 类型优先于 popup 标记（日期框仍按日期处理）',
  fieldTypeOf(input({ type: 'date', 'aria-haspopup': 'dialog' })) === 'date');
check('可键入的自定义下拉框判为可搜索',
  isSearchableCustomSelect(input({ 'aria-haspopup': 'listbox' }), 'custom-select') === true);
check('只读的自定义下拉框判为不可输入',
  isSearchableCustomSelect(input({ 'aria-haspopup': 'listbox', readonly: '' }), 'custom-select') === false);

// ── 7. 消息入口只接受本扩展的消息（源码级回归）──

console.log('\n=== 7. 消息入口的 sender 校验 ===');

// 这些 listener 只在真实扩展环境里注册（node 下没有 chrome.runtime），行为测不到，
// 所以改为扫源码：凡注册了 onMessage 的文件，都必须在函数体开头校验 sender.id。
// 与 form-fill.test.js 第 15 节同一思路 —— 这类「防回退」约束只能靠源码级断言守住。
//
// 为什么必须有它：网页脚本够不到 chrome.runtime，manifest 也没声明 externally_connectable，
// 所以这道校验眼下是纯加固。但它是唯一一道 —— 哪天为了别的功能开放外部消息通道，
// 没有它，任意网页就能借 form:fill 触发填表、借 form:scan 读走整页结构、借 jd:grab 读走正文。
const listenerFiles = ['form-fill-page.js', 'jd-grab.js', 'copy-guard.js', 'background.js'];
for (const file of listenerFiles) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const at = src.indexOf('chrome.runtime.onMessage.addListener');
  check(file + ' 注册了消息监听', at >= 0);
  if (at < 0) continue;
  // 只看监听回调这一段，避免文件里别处的同名字符串蒙混过关
  const body = src.slice(at, at + 700);
  const guardAt = body.search(/sender\.id\s*!==\s*chrome\.runtime\.id/);
  check(file + ' 的消息入口校验 sender.id', guardAt >= 0, body.slice(0, 140));
  // 校验必须在第一个业务分支之前，否则等于没防（后面照样会执行）
  const firstTypeUse = body.search(/message\.type/);
  check(file + ' 的校验排在业务分支之前',
    guardAt >= 0 && (firstTypeUse < 0 || guardAt < firstTypeUse), [guardAt, firstTypeUse]);
}

console.log(`\n──────── 结果：${pass} 通过 / ${fail} 失败 ────────`);
process.exit(fail ? 1 : 0);

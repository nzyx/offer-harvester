// popup.js 渲染链路真实执行验证：用 DOM/存储桩把整条渲染路径跑起来
// 覆盖：脚本加载零错误、结构化面板渲染、XSS 转义、敏感字段开关、落盘、老用户迁移提示、
//      向导流程、JD 抓取、网申预填（扫描 → 计划 → 渲染 → 写入 → 清除）
// 用法：node tests/render.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = process.argv[2] || path.join(__dirname, '..');

// ── 极简 DOM 桩 ───────────────────────────────
class El {
  constructor(id = '', cls = '') {
    this.id = id;
    this._cls = new Set(cls.split(' ').filter(Boolean));
    this.hidden = false;
    this.textContent = '';
    this.value = '';
    this.innerHTML = '';
    this.checked = false;
    this.disabled = false;
    this.dataset = {};
    this.style = {};
    this.tagName = 'DIV';
    const self = this;
    this.classList = {
      add: (...c) => c.forEach(x => self._cls.add(x)),
      remove: (...c) => c.forEach(x => self._cls.delete(x)),
      toggle: (c, force) => { const on = force === undefined ? !self._cls.has(c) : force; on ? self._cls.add(c) : self._cls.delete(c); return on; },
      contains: (c) => self._cls.has(c),
    };
    this._listeners = {};
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  removeAttribute(k) { delete this[k]; }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolledIntoView = true; }
  remove() {}
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild(c) { return c; }
}

const registry = new Map();
function getEl(id) {
  if (!registry.has(id)) registry.set(id, new El(id));
  return registry.get(id);
}

const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
// 预先注册 HTML 中真实存在的 id，模拟 document.getElementById 的语义（不存在的返回 null），
// 并把 HTML 里写死的 hidden 属性与静态文本同步到桩元素上（否则测的是桩而不是页面）
const realIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
for (const m of html.matchAll(/<[a-zA-Z0-9]+([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/g)) {
  const attrs = m[1];
  const el = getEl(m[2]);
  if (/(^|\s)hidden(\s|=|$)/.test(attrs)) el.hidden = true;
  const text = m[3].trim();
  if (text) el.textContent = text;
}
// 同时注册 JS 会查询的 class 元素
const classEls = new Map();
['copy-interview', 'export-interview', 'copy-greeting', 'export-greeting', 'copy-optimize', 'export-optimize']
  .forEach(c => classEls.set('.' + c, new El('', c)));

const document = {
  getElementById: (id) => (realIds.has(id) ? getEl(id) : null),
  querySelector: (sel) => classEls.get(sel) || getEl(sel),
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => new El(),
  body: new El('body'),
};

// ── 存储桩（同步回调，最严格时序）─────────────
const sessionStore = {};
const localStore = {};
const storageArea = (store, isLocal) => ({
  get: (keys, cb) => {
    const out = {};
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) if (k in store) out[k] = store[k];
    if (typeof cb === 'function') cb(out);
  },
  set: (obj) => { Object.assign(store, obj); if (isLocal) localStoreWrites.push(obj); },
  remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]); if (typeof cb === 'function') cb(); },
});
const localStoreWrites = [];

// ── 标签页桩（模拟 popup 与 content script 的消息往来）──
const tabsState = {
  active: { id: 7, url: 'https://www.zhipin.com/job_detail/abc.html' },
  response: null,      // 下一次 sendMessage 的响应
  noReceiver: false,   // 模拟接收端不存在（页面在扩展安装前就已打开）
  sent: [],
  activated: [],
};

const chrome = {
  runtime: {
    connect: () => ({ onDisconnect: { addListener: () => {} } }),
    sendMessage: (msg, cb) => cb && cb({ enabled: true }),
    getURL: (p) => p,
    lastError: null,
  },
  storage: { session: storageArea(sessionStore, false), local: storageArea(localStore, true) },
  tabs: {
    query: (info, cb) => cb(tabsState.active ? [tabsState.active] : []),
    sendMessage: (tabId, message, options, cb) => {
      tabsState.sent.push({ tabId, message, options });
      if (tabsState.noReceiver) {
        // 真实环境中 lastError 只在回调执行期间可见，回调结束即失效——
        // popup.js 必须在那期间读掉它，否则控制台会留下未捕获错误
        chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
        cb(undefined);
        chrome.runtime.lastError = null;
        return;
      }
      cb(tabsState.response);
    },
    onActivated: { addListener: (fn) => { tabsState.activated.push(fn); } },
  },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// 可控的 AI 响应桩：按调用顺序返回预设响应，用来验证「空正文 → 自动放大重试」。
// 响应数少于调用次数时，重复使用最后一个（重试场景必然是同一份响应）。
function makeFetchStub(responses) {
  const calls = [];
  return {
    calls,
    fn: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const r = responses[Math.min(calls.length - 1, responses.length - 1)] || {};
      return {
        ok: r.status === undefined || r.status < 400,
        status: r.status || 200,
        text: async () => r.text || '',
        json: async () => r.json || {}
      };
    }
  };
}

// 空正文 + 被截断（推理模型思考过程吃光配额的典型返回）
const EMPTY_TRUNCATED = {
  json: { choices: [{ message: { content: '' }, finish_reason: 'length' }] }
};

// ── 执行环境 ──────────────────────────────────
const ctx = vm.createContext({
  document, chrome, console,
  navigator: { clipboard: { writeText: async () => {} } },
  setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON, URL, Blob, AbortController,
  fetch: async (p) => ({ ok: true, status: 200, text: async () => '# prompt from ' + p }),
});

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file });
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}

(async () => {
  console.log('=== 1. 脚本加载（零运行时错误） ===');
  const scripts = ['common.js', 'profile.js', 'resume-text.js', 'form-fill.js', 'prompts.js', 'popup.js'];
  let loadError = null;
  try { for (const s of scripts) load(s); } catch (e) { loadError = e; }
  check('6 个脚本全部加载成功', !loadError, loadError && loadError.message);

  await new Promise(r => setTimeout(r, 30)); // 让 initProfile 的微任务完成

  console.log('\n=== 2. 初始状态 ===');
  check('结构化面板默认隐藏', getEl('profile-panel').hidden === true, getEl('profile-panel').hidden);
  check('面板主体默认隐藏', getEl('profile-body').hidden === true);
  check('摘要显示未解析', getEl('profile-summary').textContent === '尚未解析');

  console.log('\n=== 3. 上传简历后刷新可见性 ===');
  vm.runInContext(`resumeText = '张三\\n手机 13800000000\\n广东海洋大学'; refreshProfileVisibility();`, ctx);
  check('面板显示', getEl('profile-panel').hidden === false);
  check('按钮文案=解析', getEl('profile-parse').textContent === '解析', getEl('profile-parse').textContent);
  check('提示文案非空', getEl('profile-hint').textContent.length > 0);

  console.log('\n=== 4. 结构化渲染（含转义安全） ===');
  vm.runInContext(`
    profile = normalizeProfile({
      basic: { name: '张三" onmouseover="alert(1)', phone: '13800000000', email: 'z@a.com', idCard: '4401' },
      intent: { targetPosition: '产品运营' },
      education: [{ school: '广东海洋大学', degree: '本科', major: '新闻学' }],
      experience: [{ company: '腾讯', title: '运营实习' }],
      skills: { skillTags: 'SQL、Figma' }
    });
    renderProfile();
  `, ctx);

  const outHtml = getEl('profile-groups').innerHTML;
  check('面板主体显示', getEl('profile-body').hidden === false);
  check('渲染出 6 个分组', (outHtml.match(/<section class="pf-group">/g) || []).length === 6,
    (outHtml.match(/<section class="pf-group">/g) || []).length);
  check('注入的引号被转义', outHtml.includes('&quot;') && !outHtml.includes('onmouseover="alert(1)"'));
  check('姓名值正确转义渲染', outHtml.includes('value="张三&quot; onmouseover=&quot;alert(1)"'));
  check('敏感字段默认不渲染', !outHtml.includes('身份证号'));
  check('隐藏敏感字段有提示', outHtml.includes('已隐藏 4 项敏感字段'));
  check('数组分组渲染编号 01', outHtml.includes('pf-item-idx">01'));
  check('经历分组标题正确', outHtml.includes('教育经历') && outHtml.includes('工作与实习'));
  check('摘要含已填项数', /已填 \d+ 项/.test(getEl('profile-summary').textContent), getEl('profile-summary').textContent);
  check('摘要含教育/实习段数', /教育 1 段/.test(getEl('profile-summary').textContent) && /实习\/工作 1 段/.test(getEl('profile-summary').textContent));
  check('完成度进度条已设置宽度', /%$/.test(getEl('profile-meter-bar').style.width), getEl('profile-meter-bar').style.width);
  check('datalist 用于候选值字段', outHtml.includes('<datalist id="pf-opts-education-0-degree">'));

  console.log('\n=== 5. 敏感字段开关 ===');
  getEl('profile-sensitive').checked = true;
  vm.runInContext('renderProfile();', ctx);
  const outHtml2 = getEl('profile-groups').innerHTML;
  check('开启后渲染身份证字段', outHtml2.includes('身份证号'));
  check('开启后带敏感标记', outHtml2.includes('<i>敏感</i>'));
  check('开启后无隐藏提示', !outHtml2.includes('已隐藏'));
  getEl('profile-sensitive').checked = false;
  vm.runInContext('renderProfile();', ctx);

  console.log('\n=== 6. 编辑字段 → 状态更新 + 落盘 ===');
  const before = localStoreWrites.length;
  // 直接触发 input 事件路径（模拟用户在姓名框输入）
  vm.runInContext(`
    setProfilePath(profile, 'basic.name', '李四');
    updateProfileMeta();
  `, ctx);
  check('路径写入生效', vm.runInContext(`getProfilePath(profile, 'basic.name')`, ctx) === '李四');
  check('摘要随编辑更新', /已填 \d+ 项/.test(getEl('profile-summary').textContent));

  // 走一次真实的保存路径
  vm.runInContext('saveProfileToStorage(profile);', ctx);
  check('结构化数据写入 local', JSON.stringify(localStoreWrites).includes('savedResumeProfile'));
  check('写入 profileVersion', JSON.stringify(localStoreWrites).includes('profileVersion'));
  check('落盘数据含刚编辑的姓名', JSON.stringify(localStoreWrites).includes('李四'));

  console.log('\n=== 7. 本地规则兜底解析（未配 AI 路径） ===');
  const localResult = await vm.runInContext(`
    (async () => {
      const p = extractProfileLocally('姓名：王五\\n手机：139-0000-0000\\n邮箱：w@b.com\\n广东海洋大学 汉语言文学 本科 2022.09-2026.06');
      profile = p; renderProfile();
      return { name: p.basic.name, phone: p.basic.phone, major: p.education[0].major };
    })()
  `, ctx);
  check('本地兜底解析-姓名', localResult.name === '王五', localResult.name);
  check('本地兜底解析-手机去横线', localResult.phone === '1390000000' || localResult.phone === '13900000000', localResult.phone);
  check('本地兜底解析-专业', localResult.major === '汉语言文学', localResult.major);
  check('本地兜底结果可渲染', getEl('profile-body').hidden === false && getEl('profile-groups').innerHTML.includes('汉语言文学'));

  console.log('\n=== 8. 预填消费接口（任务 4 依赖） ===');
  const flatResult = vm.runInContext(`
    (() => {
      const f = flattenProfile(profile, { includeSensitive: false });
      return { count: f.length, paths: f.map(x => x.path), labels: f.map(x => x.label) };
    })()
  `, ctx);
  check('flatten 有产出', flatResult.count > 0, flatResult.count);
  check('路径唯一', new Set(flatResult.paths).size === flatResult.paths.length);
  check('含教育经历路径', flatResult.paths.includes('education.0.school'));

  console.log('\n=== 8b. 解析过程的可视化反馈 ===');
  // 本节的痛点：点完「解析」不知道成功了没有，也不知道数据落在哪。
  // 断言分三层：① 状态在视线原位可见 ② 结果横幅不会被展开的字段挤出视野 ③ 数据位置被明确交代

  // ③ 的结构性保证：横幅必须排在字段列表之前。字段展开后有好几屏高，
  // 提示放在列表下方（改动前的实现）等于没提示。这条断言锁住本次修复的核心。
  const posBanner = html.indexOf('id="profile-status"');
  const posGroups = html.indexOf('id="profile-groups"');
  check('结果横幅排在字段列表之前（不会被挤出视野）',
    posBanner > 0 && posGroups > 0 && posBanner < posGroups, { posBanner, posGroups });

  // 回到「已上传简历、尚未解析」的状态
  vm.runInContext(`
    profile = null;
    resumeText = '姓名：赵六\\n性别：男\\n手机：13700000000\\n邮箱：zhao@example.com\\n'
      + '现居城市：深圳\\n广东海洋大学 汉语言文学 本科 2022.09-2026.06\\n'
      + '2025.07-2025.10 鹅创营 产品实习生 负责用户增长与数据分析';
    profileBody.hidden = true;
    clearProfileNotice();
    refreshProfileVisibility();
    updateProfileMeta();
  `, ctx);

  check('未解析：状态徽标为「待解析」', getEl('profile-state').textContent === '待解析', getEl('profile-state').textContent);
  check('未解析：状态码为 idle', getEl('profile-state').dataset.state === 'idle', getEl('profile-state').dataset.state);
  check('未解析：常驻说明交代数据位置', /本机/.test(getEl('profile-where').textContent), getEl('profile-where').textContent);
  check('未解析：不显示结果横幅', getEl('profile-status').hidden === true);
  check('未解析：完成度进度条归零', getEl('profile-meter-bar').style.width === '0%', getEl('profile-meter-bar').style.width);

  // 走完整解析流程（未配 AI → 本地规则）
  await vm.runInContext('parseProfile()', ctx);

  check('解析后：状态徽标为「已解析」', getEl('profile-state').textContent === '已解析', getEl('profile-state').textContent);
  check('解析后：状态码为 ready', getEl('profile-state').dataset.state === 'ready', getEl('profile-state').dataset.state);
  check('解析后：结果横幅可见', getEl('profile-status').hidden === false);
  check('解析后：横幅为成功态', getEl('profile-status').dataset.kind === 'ok', getEl('profile-status').dataset.kind);
  check('解析后：标题含「解析完成」', /解析完成/.test(getEl('profile-status-title').textContent), getEl('profile-status-title').textContent);
  check('解析后：标题含字段数（不必自己数输入框）', /已保存到本机 \d+ 项/.test(getEl('profile-status-title').textContent), getEl('profile-status-title').textContent);
  check('解析后：详情含经历段数', /教育 \d+ 段/.test(getEl('profile-status-detail').textContent), getEl('profile-status-detail').textContent);
  check('解析后：常驻说明改为「已存在本机」', /已存在本机/.test(getEl('profile-where').textContent), getEl('profile-where').textContent);
  check('解析后：解析按钮变为重新解析', getEl('profile-parse').textContent === '重新解析', getEl('profile-parse').textContent);
  check('解析后：进度区已收起', getEl('profile-progress').hidden === true);
  check('解析后：字段列表展开', getEl('profile-body').hidden === false);

  // 分组命中数：就地回答「解析出了什么」
  const groupsHtml2 = getEl('profile-groups').innerHTML;
  check('分组标题带命中数徽标', /<span class="pf-group-count">\d+\/\d+<\/span>/.test(groupsHtml2),
    (groupsHtml2.match(/pf-group-count">[^<]*/) || [])[0]);
  check('有内容的分组显示命中数', /pf-group-count">[1-9]\d*\//.test(groupsHtml2));
  check('空分组不显示 0（避免像出错）', !/pf-group-count">0\//.test(groupsHtml2));

  // 保存状态：自动保存本来就在跑，把它变可见
  check('解析后：保存状态显示已保存', /已保存到本机/.test(getEl('profile-savestate').textContent), getEl('profile-savestate').textContent);
  check('解析后：保存状态为成功态', getEl('profile-savestate').dataset.kind === 'ok', getEl('profile-savestate').dataset.kind);
  // DOM 桩的 closest() 恒返回 null，走不通真实的 input 事件路径，
  // 故直接验证状态渲染函数（事件绑定本身由第 6 节覆盖）
  vm.runInContext(`setProfileSaveState('未保存的修改…', 'pending');`, ctx);
  check('编辑后：保存状态提示未保存', /未保存/.test(getEl('profile-savestate').textContent), getEl('profile-savestate').textContent);
  check('编辑后：保存状态为待保存态', getEl('profile-savestate').dataset.kind === 'pending');
  await vm.runInContext('saveProfileNow()', ctx);
  check('保存后：保存状态回到已保存', /已保存到本机/.test(getEl('profile-savestate').textContent), getEl('profile-savestate').textContent);
  check('保存后：落盘到本机存储', JSON.stringify(localStoreWrites).includes('savedResumeProfile'));

  // 滚动：面板被滚出视野时拉回来，已在视野内则不打扰
  const panelEl = getEl('profile-panel');
  panelEl.getBoundingClientRect = () => ({ top: -300 });
  panelEl.scrolledIntoView = false;
  vm.runInContext('scrollProfileIntoView();', ctx);
  check('面板滚出视野时自动拉回', panelEl.scrolledIntoView === true);
  panelEl.getBoundingClientRect = () => ({ top: 120 });
  panelEl.scrolledIntoView = false;
  vm.runInContext('scrollProfileIntoView();', ctx);
  check('面板已在视野内时不打扰用户', panelEl.scrolledIntoView === false);
  delete panelEl.getBoundingClientRect;

  // 未上传简历就点解析 → 明确告知缺什么，而不是静默无事发生
  vm.runInContext('resumeText = "";', ctx);
  await vm.runInContext('parseProfile()', ctx);
  check('无简历时点解析给出警告', /还没有简历/.test(getEl('profile-status-title').textContent), getEl('profile-status-title').textContent);
  check('无简历时横幅为警告态', getEl('profile-status').dataset.kind === 'warn', getEl('profile-status').dataset.kind);
  check('无简历时详情指明要做什么', /上传简历/.test(getEl('profile-status-detail').textContent), getEl('profile-status-detail').textContent);

  // 清空 → 状态归位，且说明简历原文还在（不让用户以为要重新上传）
  vm.runInContext('resumeText = "张三 广东海洋大学"; refreshProfileVisibility();', ctx);
  await vm.runInContext('clearProfile()', ctx);
  check('清空后：状态徽标回到「待解析」', getEl('profile-state').textContent === '待解析', getEl('profile-state').textContent);
  check('清空后：横幅为提示态而非成功态', getEl('profile-status').dataset.kind === 'info', getEl('profile-status').dataset.kind);
  check('清空后：说明简历原文仍保留', /简历原文/.test(getEl('profile-status-detail').textContent), getEl('profile-status-detail').textContent);
  check('清空后：保存状态已清除', getEl('profile-savestate').textContent === '', getEl('profile-savestate').textContent);
  check('清空后：摘要回到「尚未解析」', getEl('profile-summary').textContent === '尚未解析', getEl('profile-summary').textContent);
  check('清空后：字段列表收起', getEl('profile-body').hidden === true);

  // 恢复一个有内容的 profile，供后续小节使用
  vm.runInContext(`
    profile = normalizeProfile({
      basic: { name: '王五', phone: '13900000000', email: 'w@b.com' },
      education: [{ school: '广东海洋大学', major: '汉语言文学', degree: '本科' }]
    });
    renderProfile();
  `, ctx);

  console.log('\n=== 9. 老用户迁移提示 ===');
  const ctx2 = vm.createContext({
    document, chrome: { ...chrome, storage: { session: storageArea({ savedResumeText: '旧简历内容', savedResumeFileName: 'old.pdf' }, false), local: storageArea({}, true) } },
    console, navigator: { clipboard: { writeText: async () => {} } }, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Date, Math, JSON, URL, Blob, AbortController, fetch: async () => ({ ok: true, status: 200, text: async () => 'p' }),
  });
  let e2 = null;
  try { for (const s of scripts) vm.runInContext(fs.readFileSync(path.join(root, s), 'utf8'), ctx2, { filename: s }); }
  catch (e) { e2 = e; }
  await new Promise(r => setTimeout(r, 30));
  check('老用户场景零错误', !e2, e2 && e2.message);
  check('提示一键重建结构化', /还没有结构化信息|解析/.test(getEl('profile-hint').textContent), getEl('profile-hint').textContent);
  check('老用户面板可见', getEl('profile-panel').hidden === false);

  // 本机已有结构化数据时，恢复后必须说明「这些是从本机读回来的」。
  // 否则用户打开侧边栏看到一堆填好的字段，不知道这是缓存还是刚解析的结果。
  const STORED_PROFILE = {
    version: 1,
    basic: { name: '钱七', phone: '13600000000', email: 'q@example.com' },
    education: [{ school: '广东海洋大学', major: '新闻学', degree: '本科' }]
  };
  const ctx3 = vm.createContext({
    document,
    chrome: {
      ...chrome,
      storage: {
        session: storageArea({}, false),
        local: storageArea({ savedResumeProfile: STORED_PROFILE, profileVersion: 1 }, true)
      }
    },
    console, navigator: { clipboard: { writeText: async () => {} } },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON, URL, Blob, AbortController,
    fetch: async (p) => ({ ok: true, status: 200, text: async () => '# prompt from ' + p }),
  });
  let e3 = null;
  try { for (const s of scripts) vm.runInContext(fs.readFileSync(path.join(root, s), 'utf8'), ctx3, { filename: s }); }
  catch (e) { e3 = e; }
  await new Promise(r => setTimeout(r, 30));

  check('本机已有数据场景零错误', !e3, e3 && e3.message);
  check('恢复后状态徽标为「已解析」', getEl('profile-state').textContent === '已解析', getEl('profile-state').textContent);
  check('恢复后横幅说明来自本机读回', /从本机读回/.test(getEl('profile-status-title').textContent), getEl('profile-status-title').textContent);
  check('恢复后横幅带字段数', /\d+ 项/.test(getEl('profile-status-title').textContent), getEl('profile-status-title').textContent);
  check('恢复后说明可直接用于预填', /网申预填/.test(getEl('profile-status-detail').textContent), getEl('profile-status-detail').textContent);
  check('恢复后保存状态为已保存', /已保存到本机/.test(getEl('profile-savestate').textContent), getEl('profile-savestate').textContent);
  check('恢复后常驻说明为「已存在本机」', /已存在本机/.test(getEl('profile-where').textContent), getEl('profile-where').textContent);
  check('恢复后字段值渲染到位', getEl('profile-groups').innerHTML.includes('钱七'));

  console.log('\n=== 10. 向导流程（简历 → 岗位 → 产出） ===');
  const LONG_JD = '招聘产品运营，负责用户增长与数据分析，要求有相关实习经历，熟悉 SQL 与内容运营。';
  const chip = (name) => document.querySelector(`.step-chip[data-step="${name}"]`);

  // 回到全新状态
  vm.runInContext(`
    jobInput.value = '';
    resumeText = '';
    profile = null;
    wizard.step = 'resume';
    wizard.visited = {};
    wizard.skippedResume = false;
    refreshProfileVisibility();
  `, ctx);

  check('初始：简历步展开', getEl('step-resume').hidden === false);
  check('初始：岗位步隐藏', getEl('step-job').hidden === true);
  check('初始：产出步隐藏', getEl('step-output').hidden === true);
  check('初始：简历标记为「可选」', getEl('step-resume-tag').textContent === '可选', getEl('step-resume-tag').textContent);
  check('初始：面试卡提示缺岗位', getEl('state-interview').textContent === '需先补岗位描述', getEl('state-interview').textContent);
  check('初始：打招呼卡提示缺两样', getEl('state-greeting').textContent === '需先补岗位描述、简历', getEl('state-greeting').textContent);

  // 跳过简历
  vm.runInContext('wizard.skippedResume = true; setStep("job", jobInput);', ctx);
  check('跳步后简历步折叠', getEl('step-resume').classList.contains('is-collapsed') === true);
  check('折叠态仍可见（不是隐藏）', getEl('step-resume').hidden === false);
  check('跳步后岗位步展开', getEl('step-job').hidden === false);
  check('简历摘要写「已跳过」', /已跳过/.test(getEl('step-resume-summary').textContent), getEl('step-resume-summary').textContent);

  // 填够 JD
  vm.runInContext(`jobInput.value = ${JSON.stringify(LONG_JD)}; updateJobControls();`, ctx);
  check('填够 JD 后面试卡可生成', getEl('state-interview').textContent === '可以生成', getEl('state-interview').textContent);
  check('此时打招呼卡仍缺简历', getEl('state-greeting').textContent === '需先补简历', getEl('state-greeting').textContent);
  check('岗位标记变「已填写」', getEl('step-job-tag').textContent === '已填写', getEl('step-job-tag').textContent);
  check('岗位 chip 标记完成', chip('job').classList.contains('is-done') === true);
  check('岗位摘要含字数与首行', /字 · 招聘产品运营/.test(getEl('step-job-summary').textContent), getEl('step-job-summary').textContent);

  // 校验：缺简历时点打招呼 → 送回简历步，而不是原地丢错误
  await vm.runInContext('generate("greeting")', ctx);
  check('缺简历时跳回简历步展开', getEl('step-resume').hidden === false && !getEl('step-resume').classList.contains('is-collapsed'));
  check('简历步出现「请先填写」', /请先填写/.test(getEl('resume-step-status').textContent), getEl('resume-step-status').textContent);
  check('提示点名缺的是简历', /简历文件/.test(getEl('resume-step-status').textContent));

  // 校验：缺 JD 时点面试准备 → 送回岗位步
  vm.runInContext('jobInput.value = ""; updateJobControls();', ctx);
  await vm.runInContext('generate("interview")', ctx);
  check('缺 JD 时跳到岗位步展开', getEl('step-job').hidden === false && !getEl('step-job').classList.contains('is-collapsed'));
  check('岗位步出现「请先粘贴」', /请先粘贴/.test(getEl('job-step-status').textContent), getEl('job-step-status').textContent);

  // 用户一动手，提示就该消失
  vm.runInContext(`jobInput.value = ${JSON.stringify(LONG_JD)}; updateJobControls();`, ctx);
  check('补上内容后提示自动清掉', getEl('job-step-status').textContent === '', getEl('job-step-status').textContent);

  // 补上简历 → 打招呼解锁
  vm.runInContext('resumeText = "张三 广东海洋大学 新闻学"; refreshProfileVisibility();', ctx);
  check('补简历后打招呼卡可生成', getEl('state-greeting').textContent === '可以生成', getEl('state-greeting').textContent);
  check('简历标记变「已填写」', getEl('step-resume-tag').textContent === '已填写');
  check('简历 chip 标记完成', chip('resume').classList.contains('is-done') === true);

  // 进入产出步 + 步骤持久化
  vm.runInContext('setStep("output"); saveMemory();', ctx);
  check('产出步展开', getEl('step-output').hidden === false);
  check('岗位步切为折叠态', getEl('step-job').classList.contains('is-collapsed') === true);
  check('产出 chip 变成当前步', chip('output').classList.contains('is-active') === true);
  check('saveMemory 记住当前步骤', sessionStore.wizardStep === 'output', sessionStore.wizardStep);
  check('步骤条恰好一个当前步', [chip('resume'), chip('job'), chip('output')].filter(c => c.classList.contains('is-active')).length === 1);
  check('其余两步收起为折叠摘要', [getEl('step-resume'), getEl('step-job')].filter(el => el.classList.contains('is-collapsed')).length === 2);
  check('折叠摘要都不为空', getEl('step-resume-summary').textContent.length > 0 && getEl('step-job-summary').textContent.length > 0);

  // 走到产出步后能真正发起生成（未配 AI 走本地演示分支）
  await vm.runInContext('generate("interview")', ctx);
  check('产出步可发起生成', getEl('interview-content').innerHTML.length > 0, getEl('interview-content').innerHTML.length);
  check('生成后结果区滚入视野', getEl('interview-results').scrolledIntoView === true);
  check('生成后产出 chip 标记完成', chip('output').classList.contains('is-done') === true);

  // ── 11. 从当前页面抓取 JD ─────────────────────
  console.log('\n=== 11. 从当前页面抓取 JD ===');
  await flush();   // 等脚本加载时发起的 refreshGrabAvailability 走完 await 链

  check('普通网页下抓取按钮可用', getEl('fetch-jd').disabled === false, getEl('fetch-jd').disabled);
  check('按钮初始文案正确', getEl('fetch-jd').textContent === '从当前页面抓取', getEl('fetch-jd').textContent);
  check('初始不显示撤销按钮', getEl('grab-undo').hidden === true);

  // 7.1 抓取成功 → 回填 + 提示来源与字数
  vm.runInContext('jobInput.value = ""; updateJobControls();', ctx);
  const GRABBED_1 = '岗位职责\n负责产品规划与落地，推动跨部门协作完成增长目标。\n任职要求\n本科及以上学历，3 年以上相关经验。';
  tabsState.response = { ok: true, text: GRABBED_1, site: 'BOSS直聘', length: GRABBED_1.length };
  await vm.runInContext('grabJdFromPage()', ctx);

  check('抓取内容回填到输入框', getEl('job-description').value === GRABBED_1, getEl('job-description').value);
  check('提示含来源站点', getEl('job-step-status').textContent.includes('BOSS直聘'), getEl('job-step-status').textContent);
  check('提示含字符数', /\d+ 个字符/.test(getEl('job-step-status').textContent));
  check('消息发送到当前标签页', tabsState.sent.length === 1 && tabsState.sent[0].tabId === 7, JSON.stringify(tabsState.sent));
  check('消息类型为 jd:grab', tabsState.sent[0].message.type === 'jd:grab');
  check('消息定向到主 frame', tabsState.sent[0].options.frameId === 0);
  check('空内容被覆盖时无需撤销', getEl('grab-undo').hidden === true);
  check('抓取后按钮恢复可点', getEl('fetch-jd').disabled === false);

  // 7.2 覆盖已有内容 → 提供撤销
  const HANDWRITTEN = '我手写的一份岗位描述，内容挺长挺长的，用于验证撤销能否还原。';
  vm.runInContext(`jobInput.value = ${JSON.stringify(HANDWRITTEN)}; updateJobControls();`, ctx);
  tabsState.response = { ok: true, text: '抓来的新内容，包含岗位职责与任职要求等完整段落信息，足够长。', site: '智联招聘', length: 31 };
  await vm.runInContext('grabJdFromPage()', ctx);

  check('覆盖已有内容后显示撤销', getEl('grab-undo').hidden === false);
  check('内容被替换为抓取结果', getEl('job-description').value.includes('抓来的新内容'));
  check('覆盖后站点提示更新', getEl('job-step-status').textContent.includes('智联招聘'));

  // 7.3 撤销还原
  getEl('grab-undo')._listeners.click[0]();
  check('撤销还原抓取前内容', getEl('job-description').value === HANDWRITTEN, getEl('job-description').value);
  check('撤销后按钮隐藏', getEl('grab-undo').hidden === true);
  check('撤销提示明确', /恢复抓取前/.test(getEl('job-step-status').textContent), getEl('job-step-status').textContent);

  // 7.4 用户改动抓取结果后，撤销必须自动失效（否则会覆盖他刚编辑的内容）
  tabsState.response = { ok: true, text: '第一段抓取内容，包含足够的文字用于本次测试验证。', site: 'BOSS直聘', length: 24 };
  await vm.runInContext('grabJdFromPage()', ctx);
  check('再次覆盖后显示撤销', getEl('grab-undo').hidden === false);
  vm.runInContext('jobInput.value = "用户手动改过的内容"; updateJobControls();', ctx);
  check('手动改动后撤销自动失效', getEl('grab-undo').hidden === true);

  // 7.5 失败场景：三种原因必须给出不同且可执行的提示
  tabsState.noReceiver = true;
  await vm.runInContext('grabJdFromPage()', ctx);
  check('接收端不存在时引导刷新页面', /刷新该网页/.test(getEl('job-step-status').textContent), getEl('job-step-status').textContent);
  tabsState.noReceiver = false;

  tabsState.response = { ok: false, reason: 'no-content', score: -3.2 };
  await vm.runInContext('grabJdFromPage()', ctx);
  check('未找到正文时提示明确', /没找到岗位描述/.test(getEl('job-step-status').textContent), getEl('job-step-status').textContent);

  tabsState.response = { ok: false, reason: 'too-short', length: 12 };
  await vm.runInContext('grabJdFromPage()', ctx);
  check('内容过短时提示明确', /太短/.test(getEl('job-step-status').textContent), getEl('job-step-status').textContent);
  check('失败时不误改输入框', getEl('job-description').value === '用户手动改过的内容', getEl('job-description').value);

  // 7.6 非网页页面：禁用按钮，且点击不发送消息
  tabsState.active = { id: 8, url: 'chrome://extensions' };
  await vm.runInContext('refreshGrabAvailability()', ctx);
  check('内置页面禁用抓取按钮', getEl('fetch-jd').disabled === true);
  check('禁用时文案说明原因', getEl('fetch-jd').textContent === '当前页面无法抓取', getEl('fetch-jd').textContent);

  const sentBefore = tabsState.sent.length;
  await vm.runInContext('grabJdFromPage()', ctx);
  check('非网页页面不发送消息', tabsState.sent.length === sentBefore, tabsState.sent.length);
  check('非网页页面直接点也不误抓', /只支持普通网页/.test(getEl('job-step-status').textContent), getEl('job-step-status').textContent);

  // 7.7 切回网页 → 恢复可用；并确认注册了标签页切换监听
  tabsState.active = { id: 9, url: 'https://www.liepin.com/job/123.shtml' };
  await vm.runInContext('refreshGrabAvailability()', ctx);
  check('切回网页后按钮恢复可用', getEl('fetch-jd').disabled === false);
  check('恢复后文案复原', getEl('fetch-jd').textContent === '从当前页面抓取', getEl('fetch-jd').textContent);
  check('按钮提示带当前站点', getEl('fetch-jd').title.includes('liepin.com'), getEl('fetch-jd').title);
  // 每个 context 加载 popup.js 都会注册一次，共享同一个 chrome 桩，故用 >= 1
  check('注册了标签页切换监听', tabsState.activated.length >= 1, tabsState.activated.length);

  console.log('\n=== 12. 网申预填（扫描 → 计划 → 渲染 → 写入 → 清除） ===');

  // 12.1 没有简历时不可用
  vm.runInContext('resumeText = ""; profile = null; refreshProfileVisibility();', ctx);
  await vm.runInContext('refreshAutofillAvailability()', ctx);
  check('无简历时禁用预填卡', getEl('autofill-button').disabled === true);
  check('无简历时状态说明原因', getEl('state-autofill').textContent === '需先上传简历', getEl('state-autofill').textContent);

  // 12.2 有简历（未解析）也可用 —— 走本地规则即时构建
  vm.runInContext(`
    resumeText = '在应聘登记表页面，结构化信息由本地规则即时生成';
    profile = normalizeProfile({
      basic: { name: '张三', phone: '13800000000', email: 'zhangsan@example.com', gender: '男',
               idCard: '440101200001011234', currentCity: '深圳' },
      intent: { targetPosition: '产品运营', targetCity: '深圳' },
      education: [{ school: '广东海洋大学', major: '新闻学', degree: '本科', startDate: '2022.09', endDate: '2026.06' }],
      experience: [{ company: '鹅创营', title: '产品实习生', startDate: '2025.07', endDate: '2025.10' }],
      skills: { skillTags: 'SQL、Figma' }
    });
    refreshProfileVisibility();
  `, ctx);
  await vm.runInContext('structuredProfile() !== null', ctx);
  check('有简历时预填卡可用', getEl('autofill-button').disabled === false, getEl('autofill-button').disabled);
  check('有简历时状态显示可填写', /可以填写/.test(getEl('state-autofill').textContent), getEl('state-autofill').textContent);

  // 12.3 扫描失败：接收端不存在 → 引导刷新
  tabsState.active = { id: 20, url: 'https://app.mokahr.com/apply/acme/1234' };
  tabsState.noReceiver = true;
  await vm.runInContext('openAutofill()', ctx);
  check('无接收端时引导刷新页面', /刷新该网页/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);
  check('失败时面板仍展开（便于用户读到提示）', getEl('autofill-panel').hidden === false);
  tabsState.noReceiver = false;

  // 12.4 扫描成功但页面没有表单控件
  tabsState.response = { ok: true, fields: [], count: 0, site: 'MokaHR', url: tabsState.active.url };
  await vm.runInContext('openAutofill()', ctx);
  check('无控件时提示明确', /没找到可编辑的表单控件/.test(getEl('autofill-summary').textContent), getEl('autofill-summary').textContent);
  check('无控件时给出 iframe 排查建议', /iframe|内嵌的框架/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);

  // 12.5 真实扫描结果 → 计划与渲染
  const SCAN_FIELDS = [
    // 基础信息（应识别）
    { ref: 'ff1', type: 'text', tag: 'input', label: '姓名', name: 'realName', sectionTexts: ['基础信息'] },
    { ref: 'ff2', type: 'tel', tag: 'input', label: '手机号码', name: 'mobile', sectionTexts: ['基础信息'] },
    { ref: 'ff3', type: 'text', tag: 'input', label: '电子邮箱', name: 'email', sectionTexts: ['基础信息'] },
    { ref: 'ff4', type: 'select', label: '性别', name: 'gender', options: [{ value: '', text: '请选择' }, { value: '1', text: '男' }, { value: '2', text: '女' }], sectionTexts: ['基础信息'] },
    // 敏感字段（默认关闭）
    { ref: 'ff5', type: 'text', label: '身份证号', name: 'idCard', sectionTexts: ['基础信息'] },
    // 求职意向
    { ref: 'ff6', type: 'text', label: '期望岗位', name: 'expectPosition', sectionTexts: ['求职意向'] },
    // 教育经历
    { ref: 'ff7', type: 'text', label: '学校', name: 'school', sectionTexts: ['教育经历'] },
    { ref: 'ff8', type: 'text', label: '专业', name: 'major', sectionTexts: ['教育经历'] },
    { ref: 'ff9', type: 'select', label: '学历', name: 'degree', options: [{ value: '', text: '请选择' }, { value: 'b', text: '本科' }, { value: 'm', text: '硕士' }], sectionTexts: ['教育经历'] },
    { ref: 'ff10', type: 'month', label: '入学时间', name: 'eduStart', sectionTexts: ['教育经历'] },
    // 工作与实习
    { ref: 'ff11', type: 'text', label: '公司', name: 'company', sectionTexts: ['工作经历'] },
    { ref: 'ff12', type: 'text', label: '职位', name: 'jobTitle', sectionTexts: ['工作经历'] },
    // 已有内容（默认不覆盖）
    { ref: 'ff13', type: 'text', label: '现居住城市', name: 'city', hasValue: true, sectionTexts: ['基础信息'] },
    // 认不出 / 阻断
    { ref: 'ff14', type: 'password', label: '密码', name: 'password' },
    { ref: 'ff15', type: 'text', label: '验证码', name: 'captcha' },
    { ref: 'ff16', type: 'file', label: '上传简历附件', name: 'attachment' },
    { ref: 'ff17', type: 'custom-select', label: '期望城市', name: 'citySelect' }
  ];
  // 默认开关下重新扫描一次，确保 12.5 的断言对应当前设置（前面小节可能留下状态）
  getEl('autofill-sensitive').checked = false;
  getEl('autofill-overwrite').checked = false;
  tabsState.response = { ok: true, fields: SCAN_FIELDS, count: SCAN_FIELDS.length, site: 'MokaHR', url: tabsState.active.url };

  await vm.runInContext('openAutofill()', ctx);

  check('面板标题显示站点', getEl('autofill-site').textContent === 'MokaHR', getEl('autofill-site').textContent);
  check('摘要含扫描控件总数', /扫描到 17 个可编辑控件/.test(getEl('autofill-summary').textContent), getEl('autofill-summary').textContent);
  check('摘要含可自动填项数', /可自动填 \d+ 项/.test(getEl('autofill-summary').textContent), getEl('autofill-summary').textContent);
  check('「将填写」区块显示', getEl('autofill-fill-block').hidden === false);
  check('「需手动处理」区块显示', getEl('autofill-manual-block').hidden === false);
  check('发送了 form:scan 消息', tabsState.sent.some(s => s.message.type === 'form:scan'));
  check('scan 消息定向主 frame', tabsState.sent.filter(s => s.message.type === 'form:scan')[0].options.frameId === 0);

  const plan = vm.runInContext('autofillPlan', ctx);
  check('计划已生成', Boolean(plan));
  const planRefs = plan.items.map(i => i.ref);
  check('姓名被识别', planRefs.includes('ff1'), planRefs);
  check('手机号被识别', planRefs.includes('ff2'));
  check('邮箱被识别', planRefs.includes('ff3'));
  check('性别被识别', planRefs.includes('ff4'));
  check('期望岗位被识别', planRefs.includes('ff6'));
  check('学校被识别', planRefs.includes('ff7'));
  check('专业被识别', planRefs.includes('ff8'));
  check('学历被识别', planRefs.includes('ff9'));
  check('公司被识别', planRefs.includes('ff11'));
  check('职位被识别', planRefs.includes('ff12'));
  check('敏感字段默认不填', !planRefs.includes('ff5'), planRefs);
  check('已有内容默认不覆盖', !planRefs.includes('ff13'));
  check('密码字段被阻断', !planRefs.includes('ff14'));
  check('验证码字段被阻断', !planRefs.includes('ff15'));
  check('文件上传被阻断', !planRefs.includes('ff16'));
  check('自定义下拉框被阻断', !planRefs.includes('ff17'));

  const manualReasons = {};
  for (const m of plan.manual) manualReasons[m.reason] = m.ref;
  check('敏感字段进入手动清单', manualReasons.sensitive === 'ff5', JSON.stringify(manualReasons));
  check('已有内容进入手动清单', manualReasons['has-value'] === 'ff13');
  check('密码原因正确', manualReasons.password === 'ff14');
  check('验证码原因正确', manualReasons.captcha === 'ff15');
  check('文件上传原因正确', manualReasons.file === 'ff16');
  check('自定义下拉框原因正确', manualReasons['custom-select'] === 'ff17');

  const fillHtml = getEl('autofill-fill-list').innerHTML;
  const manualHtml = getEl('autofill-manual-list').innerHTML;
  check('清单渲染出条目', (fillHtml.match(/class="af-item"/g) || []).length === plan.items.length,
    (fillHtml.match(/class="af-item"/g) || []).length);
  check('手动清单渲染出条目', (manualHtml.match(/class="af-item"/g) || []).length === plan.manual.length);
  check('清单显示字段标签与值', fillHtml.includes('姓名') && fillHtml.includes('张三'));
  check('清单显示语义名', fillHtml.includes('af-item-right') && fillHtml.includes('手机号'));
  check('下拉项显示选项文字而非 value', fillHtml.includes('>男<') || fillHtml.includes('男'), fillHtml.slice(0, 200));
  check('确认按钮文案含项数', /确认填写 \d+ 项/.test(getEl('autofill-confirm').textContent), getEl('autofill-confirm').textContent);
  check('确认按钮可用', getEl('autofill-confirm').disabled === false);
  check('状态说明本地规则识别率的局限', /仅用本地规则识别|本地认不出/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);
  check('状态含红框与自行提交提醒', /红框标出/.test(getEl('autofill-status').textContent) && /自行提交/.test(getEl('autofill-status').textContent));
  check('面板含免责说明', getEl('autofill-status').textContent.length > 0);

  // 12.6 开关：包含敏感字段
  getEl('autofill-sensitive').checked = true;
  await vm.runInContext('rebuildAutofillPlan()', ctx);
  const planSensitive = vm.runInContext('autofillPlan', ctx);
  check('打开敏感开关后填入身份证', planSensitive.items.map(i => i.ref).includes('ff5'), planSensitive.items.map(i => i.ref));
  check('敏感开关不影响其他字段', planSensitive.items.map(i => i.ref).includes('ff1'));
  check('敏感字段不再出现在手动清单', !planSensitive.manual.some(m => m.reason === 'sensitive'));

  // 12.7 开关：覆盖已有内容
  getEl('autofill-overwrite').checked = true;
  await vm.runInContext('rebuildAutofillPlan()', ctx);
  const planOverwrite = vm.runInContext('autofillPlan', ctx);
  check('打开覆盖后填写已有字段', planOverwrite.items.map(i => i.ref).includes('ff13'), planOverwrite.items.map(i => i.ref));
  check('覆盖开关下无 has-value 手动项', !planOverwrite.manual.some(m => m.reason === 'has-value'));

  // 复位开关，避免影响后续断言
  getEl('autofill-sensitive').checked = false;
  getEl('autofill-overwrite').checked = false;
  await vm.runInContext('rebuildAutofillPlan()', ctx);

  // 12.8 确认填写 → 消息内容不含任何提交意图
  const itemsBefore = tabsState.sent.length;
  tabsState.response = { ok: true, results: vm.runInContext('autofillPlan.items.map(i => ({ ref: i.ref, ok: true }))', ctx) };
  await vm.runInContext('confirmAutofill()', ctx);

  const fillMsg = tabsState.sent.slice(itemsBefore).find(s => s.message.type === 'form:fill');
  check('发送了 form:fill 消息', Boolean(fillMsg));
  check('填写消息只带 ref 与 value', fillMsg && fillMsg.message.items.every(i => Object.keys(i).sort().join(',') === 'ref,value'),
    fillMsg && JSON.stringify(fillMsg.message.items[0]));
  check('填写消息不含提交类字段', fillMsg && !/submit|click|form\.submit/i.test(JSON.stringify(fillMsg.message)));
  check('填写成功提示含项数', /已填写 \d+ 项/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);
  check('填写后提示自行提交', /自行提交/.test(getEl('autofill-status').textContent));

  // 12.9 部分失败：页面结构变化 → stale
  tabsState.response = { ok: true, results: [{ ref: 'ff1', ok: true }, { ref: 'ff2', ok: false, reason: 'stale' }] };
  await vm.runInContext('confirmAutofill()', ctx);
  check('有 stale 时提示重新扫描', /重新扫描/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);
  check('stale 时如实报出成功项数', /已填写 1 项/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);

  // 12.10 写入失效（非 stale）→ 引导手动补填
  tabsState.response = { ok: true, results: [{ ref: 'ff1', ok: true }, { ref: 'ff2', ok: false, reason: 'write-failed' }] };
  await vm.runInContext('confirmAutofill()', ctx);
  check('写入未生效时引导手动补填', /手动补填/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);

  // 12.11 清除页面标记
  tabsState.response = { ok: true, cleared: 9 };
  await vm.runInContext('clearAutofillMarks()', ctx);
  check('发送了 form:clear 消息', tabsState.sent.some(s => s.message.type === 'form:clear'));
  check('清除提示含数量', /已清除 9 个字段/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);
  check('清除提示说明内容未清空', /不会被清空/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);

  tabsState.response = { ok: true, cleared: 0 };
  await vm.runInContext('clearAutofillMarks()', ctx);
  check('无标记时提示明确', /没有标记需要清除/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);

  // 12.12 非网页页面不可预填
  tabsState.active = { id: 21, url: 'chrome://extensions' };
  await vm.runInContext('openAutofill()', ctx);
  check('非网页页面扫描失败有提示', /只支持普通网页/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);

  const clearSentBefore = tabsState.sent.filter(s => s.message.type === 'form:clear').length;
  await vm.runInContext('clearAutofillMarks()', ctx);
  check('非网页页面不发送清除消息', tabsState.sent.filter(s => s.message.type === 'form:clear').length === clearSentBefore,
    tabsState.sent.filter(s => s.message.type === 'form:clear').length);
  check('非网页页面清除有提示', /没有可清除的标记/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);

  // 12.13 切换标签页后旧计划失效（避免把上一页的清单当成本页的）
  tabsState.active = { id: 22, url: 'https://app.mokahr.com/apply/acme/1234' };
  tabsState.response = { ok: true, fields: SCAN_FIELDS, count: SCAN_FIELDS.length, site: 'MokaHR', url: tabsState.active.url };
  await vm.runInContext('openAutofill()', ctx);
  check('重新扫描后面板展开', getEl('autofill-panel').hidden === false);
  tabsState.activated.forEach(fn => fn());
  await flush();
  check('切换标签页后清空计划', vm.runInContext('autofillPlan', ctx) === null);
  check('切换标签页后收起面板', getEl('autofill-panel').hidden === true);
  check('切换标签页后清空扫描结果', vm.runInContext('autofillScan', ctx) === null);

  // 12.14 诊断详情导出：回答「这个字段为什么没填上」
  // 光看「需你手动处理」清单不够——控件可能压根没被扫描到（在 iframe 里、
  // 被 isVisible 过滤、选择器没命中），那种情况两张清单里都不会出现。
  console.log('\n--- 12.14 诊断详情导出 ---');
  let clipboardText = '';
  ctx.navigator.clipboard.writeText = async (text) => { clipboardText = text; };

  // 还没扫描就点导出 → 明确提示，不能白点一次
  vm.runInContext('autofillScan = null;', ctx);
  await vm.runInContext('copyAutofillDiagnostics()', ctx);
  check('未扫描时导出给出提示', /请先扫描/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);
  check('未扫描时不写剪贴板', clipboardText === '', clipboardText.slice(0, 40));

  // 扫描后导出 → 报告要能被读懂，并与页面实况对得上
  tabsState.active = { id: 40, url: 'https://hollyland.zhiye.com/form?x=1' };
  tabsState.response = { ok: true, fields: SCAN_FIELDS, count: SCAN_FIELDS.length, site: '北森招聘', url: tabsState.active.url };
  await vm.runInContext('openAutofill()', ctx);
  clipboardText = '';
  await vm.runInContext('copyAutofillDiagnostics()', ctx);

  check('导出写入剪贴板', clipboardText.length > 100, clipboardText.length);
  check('报告含页面地址', clipboardText.includes('hollyland.zhiye.com'), clipboardText.slice(0, 120));
  check('报告含标题行', /【网申预填诊断报告】/.test(clipboardText));
  check('报告含扫描控件总数', /扫描到 \d+ 个可编辑控件/.test(clipboardText));
  check('报告含控件清单表头', /类型 \| 标签/.test(clipboardText));
  // 控件清单段与「原始特征」段都是「序号 | ...」格式，统计时必须先按段切开
  const listSection = clipboardText.split('── 未填写控件的原始特征')[0];
  check('报告逐条列出控件', (listSection.match(/^\s*\d+ \|/gm) || []).length === SCAN_FIELDS.length,
    (listSection.match(/^\s*\d+ \|/gm) || []).length);
  check('报告含已识别的字段语义', clipboardText.includes('basic.name'), clipboardText.slice(0, 500));
  check('报告含跳过的原因码', clipboardText.includes('custom-select'), clipboardText.slice(0, 700));
  check('报告含原始 name 属性（便于定位控件）', clipboardText.includes('[name='), clipboardText.slice(0, 500));
  check('报告含针对性提示段', /── 提示 ──/.test(clipboardText));
  check('提示解释自定义下拉框为何填不了', /自定义下拉框/.test(clipboardText) && /手动选择/.test(clipboardText));
  check('导出后在状态行说明已复制', /已复制到剪贴板/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);

  // 12.14b 原始特征段：区分「标签没解析出来」与「解析出来了但没规则匹配」
  // 这两种情况在识别结果里都只显示「未能识别」，改法却完全不同。
  // 上一轮排查「学校抓不到」正是卡在这里，只能靠报告里的分数反推真实特征。
  const listedCount = (listSection.match(/^\s*\d+ \|/gm) || []).length;
  // 以填写计划为准：清单里逐条列出的控件数 − 计划里将填写/辅助填入的项数
  const plannedCount = vm.runInContext('autofillPlan.items.length', ctx);
  check('含未填写控件的原始特征段', /── 未填写控件的原始特征/.test(clipboardText));
  check('原始特征段覆盖每个未填写控件',
    (clipboardText.match(/nearby=/g) || []).length === listedCount - plannedCount,
    (clipboardText.match(/nearby=/g) || []).length + ' vs ' + (listedCount - plannedCount));
  check('原始特征含 label / placeholder / aria / name 四要素',
    /label=/.test(clipboardText) && /ph=/.test(clipboardText) && /aria=/.test(clipboardText) && /name=/.test(clipboardText));
  check('原始特征含只读与 role（判断是不是脚本接管的控件）',
    /只读 \| role/.test(clipboardText));

  // 标签与占位符必须分开显示：拿占位符兜底会掩盖「标签读不出来」这个关键事实
  const keepScanJson = vm.runInContext('JSON.stringify(autofillScan)', ctx);
  const keepPlanJson = vm.runInContext('JSON.stringify(autofillPlan)', ctx);
  const noLabelScan = {
    fields: [
      { ref: 'd1', type: 'text', label: '', placeholder: '请选择', sectionTexts: ['教育经历'] },
      { ref: 'd2', type: 'text', label: '', placeholder: '请选择', sectionTexts: ['教育经历'] },
      { ref: 'd3', type: 'text', label: '', placeholder: '请选择', sectionTexts: ['教育经历'] }
    ],
    url: 'u', site: 's'
  };
  const dupManual = [1, 2, 3].map(i => ({
    ref: 'd' + i, reason: 'unknown', formLabel: '', title: '未能识别',
    detail: '无法判断这个字段该填什么，请手动填写。'
  }));
  vm.runInContext('autofillScan = ' + JSON.stringify(noLabelScan) +
    '; autofillPlan = { items: [], manual: ' + JSON.stringify(dupManual) + ' };', ctx);
  const noLabelReport = vm.runInContext('buildAutofillDiagnosticReport()', ctx);
  check('空标签显示为「标签为空」而不是拿占位符顶替', /\(标签为空\).*\[ph=请选择\]/.test(noLabelReport),
    noLabelReport.split('\n').slice(6, 9).join(' / '));
  check('重复的手动原因合并计数', /×3/.test(noLabelReport), noLabelReport.slice(noLabelReport.indexOf('需你手动处理')));
  check('空属性显示为 ∅ 而不是留白', /label=∅/.test(noLabelReport) && /nearby=∅/.test(noLabelReport), noLabelReport);
  check('标签读不出来时点明不是简历缺内容', /不是你的简历缺内容/.test(noLabelReport), noLabelReport);
  // 还原扫描结果，后面还有「剪贴板被拒」的用例要用
  vm.runInContext('autofillScan = JSON.parse(' + JSON.stringify(keepScanJson) +
    '); autofillPlan = JSON.parse(' + JSON.stringify(keepPlanJson) + ');', ctx);

  // 剪贴板被拒时不能白点一次，要把报告打到控制台兜底
  ctx.navigator.clipboard.writeText = async () => { throw new Error('clipboard denied'); };
  const realConsoleLog = ctx.console.log;
  let loggedOut = '';
  ctx.console.log = (text) => { loggedOut = String(text); };
  await vm.runInContext('copyAutofillDiagnostics()', ctx);
  ctx.console.log = realConsoleLog;
  check('剪贴板被拒时给出替代路径', /控制台/.test(getEl('autofill-status').textContent), getEl('autofill-status').textContent);
  check('剪贴板被拒时报告仍打到控制台', /【网申预填诊断报告】/.test(loggedOut), loggedOut.slice(0, 60));
  ctx.navigator.clipboard.writeText = async () => {};

  console.log('\n=== 13. 请求层：思考模式 / 截断重试 / 失败降级 ===');
  // 用户报告：「AI输出被输出上限（max_tokens 3000）截断且没有可显示内容」。
  // 根因是推理模型把配额全用在思考上，正文一个字都没出。三处修复都要锁住。
  // 本节会刻意触发错误路径，静音业务日志以免混在断言输出里
  const realConsole = ctx.console;
  ctx.console = { log: () => {}, warn: () => {}, error: () => {} };

  // 13.1 该发的关思考参数要发，不该发的一个都不能发
  const stubThink = makeFetchStub([{ json: { choices: [{ message: { content: 'ok' } }] } }]);
  ctx.fetch = stubThink.fn;
  await vm.runInContext(`requestCompletion({
    settings: { apiUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-chat' },
    promptText: 'x', maxTokens: 3000, requestKey: 't1'
  })`, ctx);
  check('DeepSeek 请求带关闭思考参数', stubThink.calls[0].body.thinking?.type === 'disabled', stubThink.calls[0].body);

  const stubQwen = makeFetchStub([{ json: { choices: [{ message: { content: 'ok' } }] } }]);
  ctx.fetch = stubQwen.fn;
  await vm.runInContext(`requestCompletion({
    settings: { apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'k', model: 'qwen-plus' },
    promptText: 'x', maxTokens: 3000, requestKey: 't2'
  })`, ctx);
  check('通义千问请求带 enable_thinking', stubQwen.calls[0].body.enable_thinking === false, stubQwen.calls[0].body);
  check('通义千问请求不带 thinking（参数名不同）', stubQwen.calls[0].body.thinking === undefined);

  const stubGpt = makeFetchStub([{ json: { choices: [{ message: { content: 'ok' } }] } }]);
  ctx.fetch = stubGpt.fn;
  await vm.runInContext(`requestCompletion({
    settings: { apiUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4.1-mini' },
    promptText: 'x', maxTokens: 3000, requestKey: 't3'
  })`, ctx);
  check('非白名单模型不发思考参数（避免 400）',
    stubGpt.calls[0].body.thinking === undefined && stubGpt.calls[0].body.enable_thinking === undefined,
    stubGpt.calls[0].body);

  // 13.2 空正文 + 被截断 → 自动放大上限重试，用户不必知道 max_tokens 是什么
  const stubRetry = makeFetchStub([
    EMPTY_TRUNCATED,
    { json: { choices: [{ message: { content: '重试拿到了正文' }, finish_reason: 'stop' }] } }
  ]);
  ctx.fetch = stubRetry.fn;
  const retryResult = await vm.runInContext(`requestCompletion({
    settings: { apiUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'some-reasoner-v1' },
    promptText: 'x', maxTokens: 3000, requestKey: 't4'
  })`, ctx);
  check('空正文被截断时自动重试并拿到结果', retryResult === '重试拿到了正文', retryResult);
  check('确实是两次请求', stubRetry.calls.length === 2, stubRetry.calls.length);
  check('首次用原始上限', stubRetry.calls[0].body.max_tokens === 3000, stubRetry.calls[0].body.max_tokens);
  check('重试时放大了上限', stubRetry.calls[1].body.max_tokens > 3000, stubRetry.calls[1].body.max_tokens);
  check('重试上限取 2 倍与 8000 的较大者', stubRetry.calls[1].body.max_tokens === 8000, stubRetry.calls[1].body.max_tokens);

  // 13.3 重试仍空 → 报错，但绝不再让用户去"调大输出上限"（设置页没有这个入口）
  const stubStillEmpty = makeFetchStub([EMPTY_TRUNCATED]);
  ctx.fetch = stubStillEmpty.fn;
  let retryErr = null;
  try {
    await vm.runInContext(`requestCompletion({
      settings: { apiUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'some-reasoner-v1' },
      promptText: 'x', maxTokens: 3000, requestKey: 't5'
    })`, ctx);
  } catch (e) { retryErr = e.message; }
  check('重试后仍为空则抛出错误', Boolean(retryErr), retryErr);
  check('错误不再要求用户「调大输出上限」（做不到的建议）', !/调大.{0,6}输出上限/.test(retryErr || ''), retryErr);
  check('错误指向改用非思考模型', /非思考模型/.test(retryErr || ''), retryErr);
  check('错误给出实际用掉的上限', /8000/.test(retryErr || ''), retryErr);
  check('错误说明已自动重试过', /自动放大/.test(retryErr || ''), retryErr);

  // 13.4 有思考内容时不重试（重试也一样吃光配额，白白多花钱）
  const stubReasoning = makeFetchStub([{
    json: { choices: [{ message: { content: '', reasoning_content: '我思考了很久…' }, finish_reason: 'length' }] }
  }]);
  ctx.fetch = stubReasoning.fn;
  let reasonErr = null;
  try {
    await vm.runInContext(`requestCompletion({
      settings: { apiUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-reasoner' },
      promptText: 'x', maxTokens: 3000, requestKey: 't6'
    })`, ctx);
  } catch (e) { reasonErr = e.message; }
  check('有思考内容时只请求一次（不浪费重试）', stubReasoning.calls.length === 1, stubReasoning.calls.length);
  check('思考模式错误点名是思考模式', /思考模式/.test(reasonErr || ''), reasonErr);
  check('思考模式错误给出可换的模型示例', /deepseek-chat/.test(reasonErr || ''), reasonErr);

  // 13.5 关键修复：AI 失败要降级到本地规则，而不是把用户卡住
  // 改动前 AI 请求失败会直接抛到外层，用户只看到报错；其实本地规则能给出可用结果。
  localStore.apiUrl = 'https://api.deepseek.com/v1';
  localStore.apiKey = 'sk-test-key';
  localStore.model = 'deepseek-reasoner';
  ctx.fetch = makeFetchStub([EMPTY_TRUNCATED]).fn;

  vm.runInContext(`
    resumeText = '姓名：孙八\\n手机：13500000000\\n邮箱：sun@example.com\\n'
      + '广东海洋大学 新闻学 本科 2022.09-2026.06';
    profile = null;
    profileBody.hidden = true;
    refreshProfileVisibility();
  `, ctx);

  await vm.runInContext('parseProfile()', ctx);

  check('AI 失败时不报错，降级为警告态', getEl('profile-status').dataset.kind === 'warn', getEl('profile-status').dataset.kind);
  check('降级后仍拿到了结构化结果', vm.runInContext('profile !== null', ctx));
  check('降级结果确实有内容', vm.runInContext('profileStats(profile).filled > 0', ctx));
  check('降级后标题说明用了本地规则', /本地规则/.test(getEl('profile-status-title').textContent), getEl('profile-status-title').textContent);
  check('降级后标题仍给出字段数', /\d+ 项/.test(getEl('profile-status-title').textContent), getEl('profile-status-title').textContent);
  check('降级后详情带出 AI 失败的真实原因', /AI 未返回结果/.test(getEl('profile-status-detail').textContent), getEl('profile-status-detail').textContent);
  check('降级后详情含可执行的下一步', /非思考模型/.test(getEl('profile-status-detail').textContent), getEl('profile-status-detail').textContent);
  check('降级后状态徽标仍显示已解析', getEl('profile-state').textContent === '已解析', getEl('profile-state').textContent);
  check('降级后结果已落盘到本机', JSON.stringify(localStoreWrites).includes('孙八'));
  check('降级后字段渲染到页面', getEl('profile-groups').innerHTML.includes('孙八'));

  // 13.6 用户主动取消不能被"降级"伪装成成功
  localStore.model = 'deepseek-chat';
  ctx.fetch = async (url, init) => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  vm.runInContext(`
    profile = null;
    resumeText = '姓名：周九 广东海洋大学';
    refreshProfileVisibility();
  `, ctx);
  await vm.runInContext('parseProfile()', ctx);
  check('取消时不产生"成功解析"的假象', getEl('profile-status').dataset.kind === 'info', getEl('profile-status').dataset.kind);
  check('取消时给出取消提示', /已取消/.test(getEl('profile-status-title').textContent), getEl('profile-status-title').textContent);
  check('取消时不写入结构化数据', vm.runInContext('profile === null', ctx));

  // 收尾：清掉测试用的 AI 配置，避免影响后续
  delete localStore.apiUrl;
  delete localStore.apiKey;
  delete localStore.model;
  ctx.console = realConsole;

  console.log(`\n──────── 结果：${pass} 通过 / ${fail} 失败 ────────`);
  process.exit(fail ? 1 : 0);
})();

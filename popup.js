const $ = (id) => document.getElementById(id);

const jobInput = $('job-description');
const interviewResults = $('interview-results');
const interviewContent = $('interview-content');
const greetingResults = $('greeting-results');
const greetingContent = $('greeting-content');
const optimizeResults = $('optimize-results');
const optimizeContent = $('optimize-content');

// 缓存最近一次生成的板块，供"导出 HTML"复用（避免重复调用 API）
const lastSections = { interview: null, greeting: null, optimize: null };

let resumeText = '';
let interviewPlainText = '';
let greetingPlainText = '';
let optimizePlainText = '';
let topTimer = null;
let resumeTimer = null;
let activeRequests = {};
let activeResumeModes = new Set();
let resumeModelName = '';

// 抓取 JD 状态（同样需提前声明：updateJobControls 会在顶层被立即调用，其中会读 grabUndo）
let grabUndo = null;    // { previous, grabbed }：抓取覆盖前的原文，供撤销
let grabBusy = false;

// 结构化简历状态（提前声明：loadMemory 的存储回调会读取 profile）
let profile = null;
let profileParsing = false;
let profileTimer = null;
let profileFromCache = false;   // AI 语义映射的行式缓存：同一页面重复扫描时不再请求

// 网申预填状态（提前声明：refreshAutofillAvailability 会在顶层被立即调用）
let autofillScan = null;        // 最近一次扫描结果 { fields, site, url, ... }
let autofillPlan = null;        // 最近一次填写计划（含 items 与 manual）
let autofillBusy = false;
let autofillAiFailed = false;   // AI 映射失败过 → 提示用户，并允许手动重试
let autofillProgressTimer = null;

// 向导状态（同样需提前声明：loadMemory 的存储回调会调用 renderWizard 同步求值）
const WIZARD_ORDER = ['resume', 'job', 'output'];
const wizard = { step: 'resume', visited: {}, skippedResume: false };

// 产出卡与它们各自的前置条件（单一真相：HTML 里不再重复写一遍）
const OUTPUT_CARDS = [
  { id: 'analyze-button', stateId: 'state-interview', need: ['job'] },
  { id: 'greeting-button', stateId: 'state-greeting', need: ['job', 'resume'] },
  { id: 'resume-button', stateId: 'state-optimize', need: ['job', 'resume'] },
  { id: 'autofill-button', stateId: 'state-autofill', need: ['resume'] }
];

// ── 防重复提交：同模式生成中忽略再次点击 ──────
const generating = { interview: false, greeting: false, optimize: false };
const MODE_BTN = { interview: 'analyze-button', greeting: 'greeting-button', optimize: 'resume-button' };

// ── 工具：防抖 ────────────────────────────────
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const interviewLines = [
  '正在拆解岗位要求，提炼核心考察点…',
  '匹配你的经历和岗位技能要求…',
  '分析面试官可能追问的方向…',
  '生成针对性的面试策略和建议…'
];

const resumeLines = [
  '正在分析岗位与简历的匹配度…',
  '优化技能描述和项目经历表达…',
  '提取岗位关键词提升匹配度…',
  '马上就好，正在生成最终版本…'
];

// ── 生成进度 ──────────────────────────────────

function updateResumeLabel() {
  const el = $('resume-generation-model');
  if (!el) return;
  const modes = [...activeResumeModes];
  if (modes.length === 0) return;
  const suffix = resumeModelName ? `（${resumeModelName}）` : '';
  if (modes.length === 2) {
    el.textContent = `正在生成打招呼语和优化简历${suffix}`;
  } else if (modes[0] === 'greeting') {
    el.textContent = `正在生成打招呼语${suffix}`;
  } else {
    el.textContent = `正在生成优化简历${suffix}`;
  }
}

function rotateMsg(el, lines) {
  let i = 0;
  el.textContent = lines[0];
  return setInterval(() => {
    i = (i + 1) % lines.length;
    el.textContent = lines[i];
  }, 5000);
}

function startGenerationProgress(modelName, zone, mode) {
  const isTop = zone === 'top';
  const box = $(isTop ? 'generating-status' : 'resume-generating-status');
  const modelEl = $(isTop ? 'generation-model' : 'resume-generation-model');
  const msgEl = $(isTop ? 'generation-message' : 'resume-generation-message');
  const lines = isTop ? interviewLines : resumeLines;

  if (isTop) {
    $('cancel-button').hidden = false;
    modelEl.textContent = `正在使用：${modelName}`;
    clearInterval(topTimer);
    topTimer = rotateMsg(msgEl, lines);
  } else {
    resumeModelName = modelName;
    activeResumeModes.add(mode);
    updateResumeLabel();
    $('resume-cancel-button').hidden = false;
    clearInterval(resumeTimer);
    resumeTimer = rotateMsg(msgEl, lines);
  }
  box.hidden = false;
}

function stopGenerationProgress(mode) {
  if (mode && mode !== 'interview') {
    activeResumeModes.delete(mode);
    if (activeResumeModes.size > 0) {
      updateResumeLabel();
      return;
    }
    clearInterval(resumeTimer);
    resumeTimer = null;
    $('resume-generating-status').hidden = true;
    $('resume-cancel-button').hidden = true;
    resumeModelName = '';
    return;
  }
  clearInterval(topTimer);
  clearInterval(resumeTimer);
  topTimer = null;
  resumeTimer = null;
  $('generating-status').hidden = true;
  $('resume-generating-status').hidden = true;
  $('cancel-button').hidden = true;
  $('resume-cancel-button').hidden = true;
  activeResumeModes.clear();
  resumeModelName = '';
}

// ── 简历区取消生成 ────────────────────────────

function cancelResumeGeneration() {
  Object.keys(activeRequests).forEach(k => {
    if (k !== 'interview') activeRequests[k].abort();
  });
  ['greeting', 'optimize'].forEach(k => delete activeRequests[k]);
  clearInterval(resumeTimer);
  resumeTimer = null;
  $('resume-generating-status').hidden = true;
  $('resume-cancel-button').hidden = true;
  activeResumeModes.clear();
  resumeModelName = '';
  $('resume-status').textContent = '已取消本次生成。';
}

// ── 复制保护 ──────────────────────────────────

function updateCopyState(active) {
  $('copy-state').textContent = active
    ? '网页复制保护已开启，仅在侧边栏打开期间生效'
    : '当前页面不支持解除复制限制';
}

function setCopyGuard(enabled) {
  chrome.runtime.sendMessage(
    { type: enabled ? 'copyGuard:enable' : 'copyGuard:disable' },
    (reply) => {
      if (chrome.runtime.lastError) { updateCopyState(false); return; }
      updateCopyState(Boolean(reply?.enabled));
    }
  );
}

const sidePanelPort = chrome.runtime.connect({ name: 'sidePanel' }); // 维持长连接，关闭侧边栏时 port.onDisconnect 触发后台清理复制保护
setCopyGuard(true);

// ── 记忆恢复 ──────────────────────────────────

function saveMemory() {
  chrome.storage.session.set({
    savedJob: jobInput.value,
    savedResumeText: resumeText,
    savedResumeFileName: $('file-label').textContent !== '上传简历' ? $('file-label').textContent : '',
    wizardStep: wizard.step
  });
}

function saveResults(mode, sections) {
  chrome.storage.session.get(['savedResults'], (data) => {
    const results = data.savedResults || {};
    results[mode] = sections;
    chrome.storage.session.set({ savedResults: results });
  });
}

function loadMemory() {
  chrome.storage.session.get(['savedJob', 'savedResumeText', 'savedResumeFileName', 'generationInProgress', 'savedResults', 'wizardStep'], (data) => {
    // 回到上次所在的步骤：关侧边栏重开不丢进度，中断提示也才出现在用户看得见的那一步
    if (WIZARD_ORDER.includes(data.wizardStep)) {
      wizard.step = data.wizardStep;
      wizard.visited[data.wizardStep] = true;
    }
    if (data.savedJob) {
      jobInput.value = data.savedJob;
      updateJobControls();
    }
    if (data.savedResumeText) {
      resumeText = data.savedResumeText;
      if (data.savedResumeFileName) {
        $('file-label').textContent = data.savedResumeFileName;
        $('file-note').textContent = `已加载 ${resumeText.length} 个字符（上次上传）`;
      }
    }
    refreshProfileVisibility();
    // 老用户迁移提示：有简历原文但没有结构化信息 → 明确告知可一键重建，不静默丢弃。
    // 若结构化数据在本机存储里（initProfile 稍后恢复），下面这行会被 refreshProfileVisibility 覆盖为正确文案。
    if (!profile && resumeText) {
      $('profile-hint').textContent = '检测到已上传的简历，但还没有结构化信息。点「解析」即可生成，用于网申自动预填。';
    }
    if (data.generationInProgress) {
      $('status-message').textContent = '上次生成被中断（关闭侧边栏会导致生成中断），内容已恢复，请重新生成。';
      chrome.storage.session.remove('generationInProgress');
    }
    if (data.savedResults) {
      if (data.savedResults.interview) renderSections(data.savedResults.interview, 'interview');
      if (data.savedResults.greeting) renderSections(data.savedResults.greeting, 'greeting');
      if (data.savedResults.optimize) renderSections(data.savedResults.optimize, 'optimize');
    }
    // 结果恢复完再刷一次：步骤条上的「产出」完成态依赖 lastSections
    renderWizard();
  });
}

loadMemory();

// ── 岗位描述 ──────────────────────────────────

function updateJobControls() {
  $('word-count').textContent = `${jobInput.value.length} / 12000`;
  $('clear-job').hidden = !jobInput.value.length;
  // 用户开始补内容后，之前那句「请先填写」就该消失
  if ($('job-step-status').textContent) $('job-step-status').textContent = '';
  renderWizard();
  syncGrabUndo();
}

const saveMemoryDebounced = debounce(saveMemory, 300);
jobInput.addEventListener('input', () => { updateJobControls(); saveMemoryDebounced(); });

$('clear-job').addEventListener('click', () => {
  jobInput.value = '';
  updateJobControls();
  jobInput.focus();
  saveMemory();
});

function cancelGeneration() {
  if (activeRequests['interview']) activeRequests['interview'].abort();
  delete activeRequests['interview'];
  clearInterval(topTimer);
  topTimer = null;
  $('generating-status').hidden = true;
  $('cancel-button').hidden = true;
  interviewContent.innerHTML = '';
  interviewResults.hidden = true;
  interviewPlainText = '';
  if (!greetingPlainText && !optimizePlainText) {
    $('empty-state').hidden = false;
  }
  $('status-message').textContent = '已取消本次生成。';
}

$('cancel-button').addEventListener('click', cancelGeneration);
$('resume-cancel-button').addEventListener('click', cancelResumeGeneration);

updateJobControls();

// ── 简历文件 ──────────────────────────────────

try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; } catch (e) { console.warn('PDF.js 未加载'); }

// ⚠️ 行结构还原在 resume-text.js（纯算法层，可在 node 下测）。
// pdf.js 只给片段坐标，不给「行」；直接 join(' ') 会把整页压成一行，
// 导致「专业」被填成「手机号码」这类错位，项目经历整段消失。
async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument(buf).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(rebuildPdfLines(content.items));
  }
  return pages.join('\n');
}

$('resume-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $('file-label').textContent = file.name;
  $('file-note').textContent = '正在读取文件…';

  // 根据文件类型切换图标
  const icon = $('upload-icon');
  const ext = file.name.split('.').pop().toLowerCase();
  icon.className = 'upload-icon';
  if (ext === 'pdf') {
    icon.classList.add('type-pdf');
    icon.textContent = 'P';
  } else if (ext === 'doc' || ext === 'docx') {
    icon.classList.add('type-word');
    icon.textContent = 'W';
  } else if (ext === 'md') {
    icon.classList.add('type-md');
    icon.textContent = 'M';
  } else if (ext === 'txt') {
    icon.classList.add('type-txt');
    icon.textContent = 'T';
  }

  try {
    if (/\.(txt|md)$/i.test(file.name)) {
      resumeText = normalizeResumeText(await file.text());
    } else if (/\.pdf$/i.test(file.name)) {
      resumeText = normalizeResumeText(await extractPdfText(file));
    } else if (/\.docx$/i.test(file.name)) {
      const buf = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer: buf });
      resumeText = normalizeResumeText(result.value);
    } else {
      resumeText = `[用户上传了 ${file.name}，请将其作为简历附件参考。]`;
      $('file-note').textContent = '已附加文件。为获得更精准匹配，建议上传 TXT、MD、PDF 或 DOCX 格式的简历。';
      return;
    }
    if (!resumeText.trim()) {
      $('file-note').textContent = '未能提取到文字内容，请确认文件包含可读文本。';
      return;
    }
    $('file-note').textContent = `已读取 ${resumeText.length} 个字符，将用于匹配你的真实经历。`;
    saveMemory();
    refreshProfileVisibility();
  } catch (e) {
    // 解析失败不留无效文本：避免结构化解析与 AI 生成拿到脏输入
    resumeText = '';
    $('file-note').textContent = `文件解析失败（${e.message}），请改上传 TXT / DOCX，或确认文件不是扫描图片。`;
    refreshProfileVisibility();
  }
});

$('clear-resume').addEventListener('click', (e) => {
  e.preventDefault();
  $('resume-file').value = '';
  resumeText = '';
  $('file-label').textContent = '上传简历';
  $('file-note').textContent = '';
  const icon = $('upload-icon');
  icon.className = 'upload-icon';
  icon.textContent = '↑';
  saveMemory();
  refreshProfileVisibility();
  // 结构化信息是本机资产，不随文件一起删除
  if (profile) $('profile-hint').textContent = '简历文件已移除，结构化信息仍保留在本机，可继续使用或手动清空。';
});

// ── 结构化简历（网申预填的数据源）──────────────
// 流程：简历原文 → AI 抽取六组字段 → 可编辑预览 → 存 chrome.storage.local
// 隐私：结构化结果只存本机；未连接 AI 时用本地规则粗解析，不外发任何内容

const profileBody = $('profile-body');
const profileGroupsEl = $('profile-groups');

const PROFILE_LINES = [
  '正在通读简历原文…',
  '抽取基础信息与求职意向…',
  '整理教育与实习经历…',
  '汇总技能与证书…',
  '马上就好，正在生成结构化预览…'
];

// 本地规则的可信字段：格式固定、几乎不会误判，用于给 AI 结果补空缺
const LOCAL_TRUSTED_KEYS = ['phone', 'email'];

function profileSummaryText() {
  if (!profile) return '尚未解析';
  const s = profileStats(profile);
  const parts = [`已填 ${s.filled} 项`];
  if (s.educationCount) parts.push(`教育 ${s.educationCount} 段`);
  if (s.experienceCount) parts.push(`实习/工作 ${s.experienceCount} 段`);
  if (s.projectCount) parts.push(`项目 ${s.projectCount} 个`);
  if (s.sensitiveFilled) parts.push(`敏感 ${s.sensitiveFilled} 项`);
  return parts.join(' · ');
}

// ── 解析状态的可视化反馈 ───────────────────────
//
// 用户的两个疑问必须在视线上得到回答，不能靠"仔细看会发现"：
//   ① 成功了没有 → 解析按钮旁的常驻状态徽标 + 紧贴头部的结果横幅
//   ② 数据在哪里 → 常驻的落库说明 + 分组命中数 + 实时保存状态
//
// 关键约束：结果横幅必须在 #profile-groups **之前**。字段展开后有好几屏高，
// 把提示放在列表下方等于没提示。

const PROFILE_STATE = {
  idle: { text: '待解析' },
  parsing: { text: '解析中' },
  ready: { text: '已解析' },
  empty: { text: '未识别到内容' }
};

function setProfileState(state) {
  const el = $('profile-state');
  if (!el) return;
  const info = PROFILE_STATE[state] || PROFILE_STATE.idle;
  el.dataset.state = state;
  el.textContent = info.text;
}

// 「数据在哪里」常驻说明。不写死文案，跟随实际状态变化
function setProfileWhere(state) {
  const el = $('profile-where');
  if (!el) return;
  if (state === 'ready') el.textContent = '已存在本机，网申预填与后续生成都读它';
  else el.textContent = '解析结果保存在本机，网申预填与后续生成都读它';
}

// 结果横幅。kind: ok | warn | error | info
function setProfileNotice(kind, title, detail) {
  const box = $('profile-status');
  if (!box) return;
  box.dataset.kind = kind || 'info';
  box.hidden = false;
  $('profile-status-title').textContent = title || '';
  $('profile-status-detail').textContent = detail || '';
}

function clearProfileNotice() {
  const box = $('profile-status');
  if (!box) return;
  box.hidden = true;
  box.dataset.kind = 'info';
  $('profile-status-title').textContent = '';
  $('profile-status-detail').textContent = '';
}

// 保存状态。自动保存本来就在跑，把它变得可见即可消除「我改了到底存没存」的疑虑。
// 不用定时器清除：常驻一行小字比一闪而过的提示更让人安心。
function setProfileSaveState(text, kind) {
  const el = $('profile-savestate');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.kind = kind || '';
}

// 只更新摘要、完成度与状态，不重绘整个列表（避免打断用户输入）
function updateProfileMeta() {
  if (!profile) {
    $('profile-summary').textContent = '尚未解析';
    $('profile-meter-bar').style.width = '0%';
    setProfileState('idle');
    setProfileWhere('idle');
    return;
  }
  const stats = profileStats(profile);
  $('profile-summary').textContent = profileSummaryText();
  $('profile-meter-bar').style.width = stats.percent + '%';
  setProfileState(stats.filled ? 'ready' : 'empty');
  setProfileWhere(stats.filled ? 'ready' : 'idle');
}

// 解析完成后把面板带进视野。只在面板确实被滚出视野时才动，避免无谓的跳动。
// getBoundingClientRect 在测试桩里不存在，故做存在性判断。
function scrollProfileIntoView() {
  const panel = $('profile-panel');
  if (!panel || typeof panel.getBoundingClientRect !== 'function') return;
  if (typeof panel.scrollIntoView !== 'function') return;
  let rect;
  try {
    rect = panel.getBoundingClientRect();
  } catch (e) {
    return;
  }
  const viewport = (typeof window !== 'undefined' && window.innerHeight) || 800;
  // 面板顶部已经在视口上方，或掉到视口下半部分之外 → 拉回视野
  const outOfView = rect.top < 0 || rect.top > viewport * 0.6;
  if (outOfView) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderProfileField(field, path, value) {
  const attrs = `class="pf-input" data-path="${escapeHtml(path)}"`;
  if (field.type === 'textarea') {
    return `<textarea ${attrs} rows="2" placeholder="${escapeHtml(field.ph || '')}">${escapeHtml(value)}</textarea>`;
  }
  if (!field.options) {
    return `<input ${attrs} type="text" placeholder="${escapeHtml(field.ph || '')}" value="${escapeHtml(value)}">`;
  }
  // 有候选值时用 datalist：给建议但不限制填写
  const listId = `pf-opts-${path.replace(/\./g, '-')}`;
  return `<input ${attrs} type="text" list="${listId}" placeholder="${escapeHtml(field.ph || '')}" value="${escapeHtml(value)}">`
    + `<datalist id="${listId}">${field.options.map(o => `<option value="${escapeHtml(o)}"></option>`).join('')}</datalist>`;
}

// 分组命中数：让用户一眼看到「解析出了什么」，而不是自己数输入框。
// 命中为 0 时不上徽标，改用明确的空态文案，避免出现「0」这种像出错的提示。
function groupCountBadge(filled, total) {
  if (!filled) return '';
  return `<span class="pf-group-count">${filled}/${total}</span>`;
}

function renderProfileObjectGroup(group, includeSensitive) {
  const visible = group.fields.filter(f => includeSensitive || !f.sensitive);
  const filledCount = visible.filter(f => profile?.[group.id]?.[f.key]).length;
  const rows = visible.map(field => {
    const path = `${group.id}.${field.key}`;
    const value = getProfilePath(profile, path) || '';
    return `<div class="pf-row${field.sensitive ? ' is-sensitive' : ''}">
      <label>${escapeHtml(field.label)}${field.sensitive ? '<i>敏感</i>' : ''}</label>
      ${renderProfileField(field, path, value)}
    </div>`;
  }).join('');
  const hiddenCount = group.fields.filter(f => f.sensitive && !includeSensitive).length;
  const notes = [];
  if (hiddenCount) notes.push(`已隐藏 ${hiddenCount} 项敏感字段（默认不写入网申页面）`);
  if (!filledCount) notes.push('简历里没有识别到这一组信息，可直接在下面手动补充。');
  const note = notes.length ? `<p class="pf-note">${notes.join(' ')}</p>` : '';
  return `<section class="pf-group">
    <div class="pf-group-head">
      <h4>${escapeHtml(group.label)}${groupCountBadge(filledCount, visible.length)}</h4>
    </div>
    <div class="pf-rows">${rows}</div>${note}
  </section>`;
}

function renderProfileListGroup(group) {
  const items = Array.isArray(profile[group.id]) ? profile[group.id] : [];
  const filledCount = items.reduce((sum, item) => (
    sum + group.fields.filter(field => item[field.key]).length
  ), 0);
  const cards = items.map((item, index) => {
    const rows = group.fields.map(field => {
      const path = `${group.id}.${index}.${field.key}`;
      return `<div class="pf-row">
        <label>${escapeHtml(field.label)}</label>
        ${renderProfileField(field, path, item[field.key] || '')}
      </div>`;
    }).join('');
    return `<article class="pf-item">
      <div class="pf-item-head">
        <span class="pf-item-idx">${String(index + 1).padStart(2, '0')}</span>
        <span class="pf-item-title">${escapeHtml(group.itemLabel)}</span>
        <button class="pf-remove" type="button" data-group="${group.id}" data-index="${index}" title="删除这一条">×</button>
      </div>
      <div class="pf-rows">${rows}</div>
    </article>`;
  }).join('');
  const empty = items.length
    ? ''
    : `<p class="pf-note">简历里没有识别到${escapeHtml(group.label)}，可点「+ 添加一条」手动补充。</p>`;
  return `<section class="pf-group">
    <div class="pf-group-head">
      <h4>${escapeHtml(group.label)}${groupCountBadge(filledCount, items.length * group.fields.length)}</h4>
      <button class="pf-add" type="button" data-group="${group.id}">+ 添加一条</button>
    </div>
    ${cards}${empty}
  </section>`;
}

function renderProfile() {
  if (!profile) { profileBody.hidden = true; return; }
  const includeSensitive = $('profile-sensitive').checked;
  profileGroupsEl.innerHTML = PROFILE_GROUPS
    .map(group => group.kind === 'list'
      ? renderProfileListGroup(group)
      : renderProfileObjectGroup(group, includeSensitive))
    .join('');
  profileBody.hidden = false;
  updateProfileMeta();
}

// 编辑即自动保存（600ms 防抖）。自动保存本来就在跑，把它变可见就够了 ——
// 原先只有手动「保存修改」按钮，用户既不知道改完存没存，也不敢不点。
const saveProfileNow = async () => {
  if (!profile) return;
  await saveProfileToStorage(profile);
  setProfileSaveState('已保存到本机', 'ok');
};

const saveProfileDebounced = debounce(saveProfileNow, 600);

profileGroupsEl.addEventListener('input', (e) => {
  const el = e.target.closest('[data-path]');
  if (!el || !profile) return;
  setProfilePath(profile, el.dataset.path, el.value);
  updateProfileMeta();
  setProfileSaveState('未保存的修改…', 'pending');
  saveProfileDebounced();
});

profileGroupsEl.addEventListener('click', (e) => {
  if (!profile) return;
  const removeBtn = e.target.closest('.pf-remove');
  if (removeBtn) {
    const group = groupById(removeBtn.dataset.group);
    if (!group) return;
    profile[group.id].splice(Number(removeBtn.dataset.index), 1);
    renderProfile();
    saveProfileNow();
    return;
  }
  const addBtn = e.target.closest('.pf-add');
  if (addBtn) {
    const group = groupById(addBtn.dataset.group);
    if (!group) return;
    profile[group.id].push(createEmptyItem(group));
    renderProfile();
    saveProfileNow();
    // 聚焦到新条目的第一个输入框
    const inputs = profileGroupsEl.querySelectorAll('.pf-input');
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  }
});

$('profile-sensitive').addEventListener('change', () => {
  renderProfile();
});

// AI 抽取结果的可信度补丁：只补「格式固定」的字段，不做语义猜测
function mergeProfileGaps(primary, fallback) {
  for (const group of PROFILE_GROUPS) {
    if (group.kind === 'list') {
      if (!primary[group.id]?.length && fallback[group.id]?.length) {
        primary[group.id] = fallback[group.id];
      }
      continue;
    }
    for (const field of group.fields) {
      if (LOCAL_TRUSTED_KEYS.includes(field.key) && !primary[group.id][field.key] && fallback[group.id][field.key]) {
        primary[group.id][field.key] = fallback[group.id][field.key];
      }
    }
  }
  return primary;
}

function refreshProfileVisibility() {
  const hasText = Boolean(resumeText && resumeText.trim());
  // 用即时查询而非缓存引用：本函数会被记忆恢复的异步回调触发，早于顶层 const 初始化
  $('profile-panel').hidden = !hasText && !profile;
  // hint 讲「这一步是干什么的」，where 讲「数据在哪」——两者分工不重复
  if (profile) {
    $('profile-parse').textContent = '重新解析';
    $('profile-hint').textContent = '逐项核对后即可用于网申预填与后续生成。改完会自动保存。';
  } else if (hasText) {
    $('profile-parse').textContent = '解析';
    $('profile-hint').textContent = '点「解析」把简历拆成姓名、学历、实习等标准字段。未连接 AI 时用本地规则粗解析。';
  } else {
    $('profile-hint').textContent = '';
  }
  // 简历状态变了，向导的摘要、步骤条与产出可用性都要跟着走
  renderWizard();
}

async function parseProfile() {
  if (profileParsing) return;
  if (!resumeText || !resumeText.trim()) {
    setProfileNotice('warn', '还没有简历', '请先用上方区域上传简历文件，再点「解析」。');
    return;
  }
  profileParsing = true;
  $('profile-parse').textContent = '取消解析';
  // 解析中：清掉上一次的结果横幅，改为显示进度；状态徽标同步成「解析中」
  clearProfileNotice();
  setProfileState('parsing');
  $('profile-progress').hidden = false;
  clearInterval(profileTimer);
  profileTimer = rotateMsg($('profile-progress-message'), PROFILE_LINES);

  const previous = profile;
  try {
    if (!promptsReady) { try { await promptsLoaded; } catch (e) { /* 走本地兜底 */ } }

    const settings = await getSettings();
    let extracted;
    let source;
    let aiFailure = '';
    const useAi = Boolean(settings.apiUrl && settings.apiKey && RESUME_EXTRACT_PROMPT);

    if (!useAi) {
      extracted = extractProfileLocally(resumeText);
      source = 'local';
    } else {
      $('profile-progress-model').textContent = `正在使用：${settings.model || 'gpt-4.1-mini'}`;
      try {
        const raw = await requestCompletion({
          settings,
          promptText: `${RESUME_EXTRACT_PROMPT}\n\n【简历原文】\n${resumeText.slice(0, 12000)}`,
          maxTokens: 6000,
          temperature: 0,
          requestKey: 'profile'
        });
        extracted = mergeProfileGaps(parseProfileText(raw), extractProfileLocally(resumeText));
        source = 'ai';
      } catch (aiError) {
        // 用户主动取消 → 交给外层统一处理，不要偷偷用本地规则把取消变成"成功"
        if (aiError.name === 'AbortError') throw aiError;
        // AI 的任何失败（被截断 / 超时 / 额度 / 网络 / 不按格式返回）都不该让用户卡住：
        // 本地规则能给出可用结果，如实说明失败原因即可，这比丢一个报错强得多
        console.warn('AI 抽取失败，回退本地规则', aiError);
        extracted = extractProfileLocally(resumeText);
        source = 'local-fallback';
        aiFailure = aiError.message;
      }
    }

    if (!profileHasValue(extracted)) {
      profile = previous;
      if (previous) renderProfile();
      // AI 失败 + 本地规则也抽不到 → 两个原因都要说，否则用户只会看到"没识别到"，
      // 误以为是简历的问题，实际可能是模型配置的问题
      const reason = aiFailure ? `AI 未返回结果：${aiFailure}本地规则也没能从这份简历里抽到字段。` : '';
      setProfileNotice('warn', '没有识别到有效信息',
        `${reason}若文件是扫描件或纯图片，建议换用 TXT / DOCX 重新上传。`);
      return;
    }

    profile = extracted;
    $('profile-sensitive').checked = false;
    renderProfile();
    saveProfileToStorage(profile);

    // 成功横幅带字段计数与经历段数：用户不必自己数输入框就知道"抽到了多少"
    const stats = profileStats(profile);
    const shapeParts = [];
    if (stats.educationCount) shapeParts.push(`教育 ${stats.educationCount} 段`);
    if (stats.experienceCount) shapeParts.push(`实习/工作 ${stats.experienceCount} 段`);
    if (stats.projectCount) shapeParts.push(`项目 ${stats.projectCount} 个`);
    const shape = shapeParts.join(' · ');

    // 三个来源各自补齐「接下来该注意什么」，但字段数/段数这三个分支都要给
    let tail;
    if (source === 'ai') {
      tail = '逐项核对，AI 抽取可能有偏差。';
    } else if (source === 'local-fallback') {
      // 把 AI 到底为什么失败如实带出来（截断 / 超时 / 额度 / 网络），
      // 用户才知道该换模型、检查 Key 还是缩短简历
      tail = aiFailure ? `AI 未返回结果：${aiFailure}本次已改用本地规则。` : 'AI 未返回结果，本次已改用本地规则。';
    } else {
      tail = '未连接 AI，本次用本地规则解析。到「设置」连接 AI 后重新解析会更准更全。';
    }
    const fellBack = source === 'local-fallback';
    setProfileNotice(
      fellBack ? 'warn' : 'ok',
      fellBack ? `已用本地规则解析 ${stats.filled} 项` : `解析完成 · 已保存到本机 ${stats.filled} 项`,
      [shape, tail].filter(Boolean).join('｜')
    );
    setProfileSaveState('已保存到本机', 'ok');
    scrollProfileIntoView();
  } catch (error) {
    profile = previous;
    if (previous) renderProfile();
    if (error.name === 'AbortError') {
      setProfileNotice('info', '已取消解析', '');
    } else {
      setProfileNotice('error', '解析失败', error.message);
    }
  } finally {
    profileParsing = false;
    clearInterval(profileTimer);
    profileTimer = null;
    $('profile-progress').hidden = true;
    refreshProfileVisibility();
    updateProfileMeta();
  }
}

async function clearProfile() {
  profile = null;
  await clearProfileFromStorage();
  profileBody.hidden = true;
  $('profile-sensitive').checked = false;
  setProfileSaveState('');
  setProfileNotice('info', '已清空结构化信息', '简历原文仍然保留，随时可以重新解析。');
  refreshProfileVisibility();
  updateProfileMeta();
}

$('profile-parse').addEventListener('click', () => {
  if (profileParsing) {
    if (activeRequests['profile']) activeRequests['profile'].abort();
    return;
  }
  parseProfile();
});

$('profile-clear').addEventListener('click', clearProfile);

$('profile-save').addEventListener('click', () => {
  if (!profile) return;
  saveProfileToStorage(profile);
  setProfileSaveState('已保存到本机 · 刚刚', 'ok');
  const btn = $('profile-save');
  btn.textContent = '已保存';
  setTimeout(() => { btn.textContent = '保存修改'; }, 1500);
});

// 启动时恢复结构化简历；老用户只有纯文本时提示一键重建（不静默丢弃）
(async function initProfile() {
  const stored = await loadProfileFromStorage();
  if (stored && profileHasValue(stored)) {
    profile = stored;
    renderProfile();
    // 恢复后明确告知：这些字段是从本机存储读回来的，不是刚解析的
    const stats = profileStats(profile);
    setProfileNotice('ok', `已从本机读回 ${stats.filled} 项结构化信息`,
      '上次解析的结果，可直接用于网申预填。需要更新请点「重新解析」。');
    setProfileSaveState('已保存到本机', 'ok');
  }
  refreshProfileVisibility();
  updateProfileMeta();
})();



// ── 向导：1 简历 → 2 岗位 → 3 产出 ─────────────
// 只做「顺序引导 + 状态可见 + 摘要回看」，不强制走完：简历可选，随时能跳步。

function hasResume() {
  // 只传了简历原文没解析过也能预填：结构化简历在这里即时生成，不额外要求用户点「解析」
  return Boolean((resumeText && resumeText.trim()) || profile);
}

function structuredProfile() {
  if (profile && profileHasValue(profile)) return profile;
  if (!resumeText || !resumeText.trim()) return null;
  try {
    const local = extractProfileLocally(resumeText);
    return profileHasValue(local) ? local : null;
  } catch (e) {
    return null;
  }
}

function jobReady() {
  return jobInput.value.trim().length >= 20;
}

function stepDone(name) {
  if (name === 'resume') return hasResume();
  if (name === 'job') return jobReady();
  return Boolean(lastSections.interview || lastSections.greeting || lastSections.optimize);
}

function stepSummary(name) {
  if (name === 'resume') {
    if (!hasResume()) {
      return wizard.skippedResume
        ? '已跳过（简历可选，仅影响打招呼语与简历优化）'
        : '尚未上传简历（可选）';
    }
    const parts = [];
    const fileName = $('file-label').textContent;
    if (fileName && fileName !== '上传简历') parts.push(fileName);
    if (profile) parts.push(profileSummaryText());
    else parts.push(`已读取 ${resumeText.length} 字，网申预填时用本地规则粗解析`);
    return parts.join(' · ');
  }
  if (name === 'job') {
    const job = jobInput.value.trim();
    if (!job) return '尚未粘贴岗位描述';
    const title = job.split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
    return `${job.length} 字 · ${title.slice(0, 24)}${title.length > 24 ? '…' : ''}`;
  }
  return '';
}

// 产出卡可用性：把「缺什么」写在卡片上，用户不必点错才知道
function updateOutputCards() {
  const ready = { job: jobReady(), resume: hasResume() };
  for (const card of OUTPUT_CARDS) {
    const btn = $(card.id);
    if (!btn) continue;
    const missing = [];
    if (card.need.includes('job') && !ready.job) missing.push('岗位描述');
    if (card.need.includes('resume') && !ready.resume) missing.push('简历');
    const stateEl = $(card.stateId);
    if (stateEl) {
      stateEl.textContent = missing.length ? `需先补${missing.join('、')}` : '可以生成';
      stateEl.classList.toggle('is-ready', missing.length === 0);
    }
  }
}

function renderWizard() {
  for (const name of WIZARD_ORDER) {
    const panel = $(`step-${name}`);
    const active = name === wizard.step;
    // 当前步展开；进过的步骤折叠成摘要行；没进过的步骤不显示
    const collapsed = !active && Boolean(wizard.visited[name]);
    if (panel) {
      panel.hidden = !active && !collapsed;
      panel.classList.toggle('is-collapsed', collapsed);
    }
    const collapsedBox = $(`step-${name}-collapsed`);
    if (collapsedBox) collapsedBox.hidden = !collapsed;
    const summary = $(`step-${name}-summary`);
    if (summary) summary.textContent = stepSummary(name);
    const chip = document.querySelector(`.step-chip[data-step="${name}"]`);
    if (chip) {
      chip.classList.toggle('is-active', active);
      chip.classList.toggle('is-done', stepDone(name));
      if (active) chip.setAttribute('aria-current', 'step');
      else if (typeof chip.removeAttribute === 'function') chip.removeAttribute('aria-current');
    }
  }
  const resumeTag = $('step-resume-tag');
  if (resumeTag) {
    resumeTag.textContent = hasResume() ? '已填写' : '可选';
    resumeTag.classList.toggle('is-ok', hasResume());
  }
  const jobTag = $('step-job-tag');
  if (jobTag) {
    jobTag.textContent = jobReady() ? '已填写' : '必填';
    jobTag.classList.toggle('is-ok', jobReady());
  }
  updateOutputCards();
  // 预填卡的可用性依赖「结构化简历是否存在」，而它有三种来源（已解析/本地粗解析/都没有），
  // 判断逻辑集中在 refreshAutofillAvailability 一处，这里只负责触发刷新
  refreshAutofillAvailability();
}

function setStep(name, focusEl) {
  if (!WIZARD_ORDER.includes(name)) return;
  if (wizard.step && wizard.step !== name) wizard.visited[wizard.step] = true;
  wizard.step = name;
  wizard.visited[name] = true;
  renderWizard();
  if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
}

// 校验失败时把用户送到「缺的那一步」，而不是只丢一句错误在原地
function gotoMissingStep(needsResume, message) {
  if (needsResume) {
    setStep('resume');
    $('resume-step-status').textContent = message;
  } else {
    setStep('job', jobInput);
    $('job-step-status').textContent = message;
  }
}

// 生成完成后滚到结果区（结果在向导之外，避免被步骤折叠藏起来）
function scrollToResults(mode) {
  const el = mode === 'interview' ? interviewResults : mode === 'greeting' ? greetingResults : optimizeResults;
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── 从当前页面抓取 JD ─────────────────────────
// 复用已注入的 content script 通道（manifest 里的 jd-extract.js / jd-grab.js），
// 不需要新增权限，也不做运行时脚本注入。

const GRAB_LABEL = '从当前页面抓取';
const GRAB_LABEL_BLOCKED = '当前页面无法抓取';

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '当前页面';
  }
}

function getActiveTab() {
  return new Promise((resolve) => {
    if (!chrome.tabs || typeof chrome.tabs.query !== 'function') {
      resolve(null);
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        resolve(tabs[0]);
        return;
      }
      // 侧边栏场景下 currentWindow 可能取不到，用最近聚焦窗口兜底
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (fallback) => {
        resolve((fallback && fallback[0]) || null);
      });
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    if (!chrome.tabs || typeof chrome.tabs.sendMessage !== 'function') {
      resolve(null);
      return;
    }
    try {
      // 指定 frameId 0：只有主 frame 注入了 jd-grab.js
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
        // 页面在扩展安装/更新之前就已打开时，接收端不存在。
        // 必须读取 lastError 才会被消费掉，否则控制台会出现未捕获错误。
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

// 撤销只在「内容仍是抓取结果」时有意义：用户一旦改动，撤销就会覆盖他刚编辑的内容
function syncGrabUndo() {
  const btn = $('grab-undo');
  if (!btn) return;
  btn.hidden = !(grabUndo && jobInput.value === grabUndo.grabbed);
}

function grabFailureMessage(res) {
  if (res.reason === 'too-short') {
    return '抓到的内容太短，可能不是职位详情页。若详情被折叠，先点开「职位详情」再试，或手动复制粘贴。';
  }
  if (res.reason === 'error') {
    return `抓取时出错：${res.detail || '未知原因'}。可手动复制粘贴。`;
  }
  return '这个页面里没找到岗位描述。若详情被折叠，先点开「职位详情」再试；若内容以图片渲染，请手动复制粘贴。';
}

function applyGrabbedJd(res, tab) {
  const before = jobInput.value;
  const text = res.text;

  // 先记撤销信息：下面的 updateJobControls 会调用 syncGrabUndo 读取它
  grabUndo = (before.trim() && before.trim() !== text.trim())
    ? { previous: before, grabbed: text }
    : null;

  jobInput.value = text;
  if (typeof jobInput.scrollTop === 'number') jobInput.scrollTop = 0;
  updateJobControls();
  saveMemory();

  const site = res.site || hostOf(tab && tab.url);
  $('job-step-status').textContent = `已从 ${site} 抓取 ${text.length} 个字符，请核对首尾是否完整。`;
}

async function refreshGrabAvailability() {
  const btn = $('fetch-jd');
  if (!btn) return;

  if (grabBusy) {
    btn.disabled = true;
    btn.textContent = '正在抓取…';
    return;
  }

  const tab = await getActiveTab();
  const url = (tab && tab.url) || '';
  const ok = /^https?:/i.test(url);

  btn.disabled = !ok;
  btn.textContent = ok ? GRAB_LABEL : GRAB_LABEL_BLOCKED;
  btn.title = ok
    ? `从 ${hostOf(url)} 当前页面抓取岗位描述`
    : '只支持普通网页（http/https）。浏览器内置页面、扩展页面与本地文件无法抓取。';
}

async function grabJdFromPage() {
  if (grabBusy) return;

  const status = $('job-step-status');
  const tab = await getActiveTab();
  const url = (tab && tab.url) || '';

  if (!tab || !/^https?:/i.test(url)) {
    status.textContent = '当前页面无法抓取：只支持普通网页。请切到招聘网站的职位详情页，或手动粘贴。';
    return;
  }

  grabBusy = true;
  await refreshGrabAvailability();
  status.textContent = '正在读取当前页面…';

  try {
    const res = await sendTabMessage(tab.id, { type: 'jd:grab' });

    if (!res) {
      status.textContent = '无法与当前页面通信。刚安装或更新扩展后需要刷新该网页一次，再点抓取。';
      return;
    }
    if (!res.ok) {
      status.textContent = grabFailureMessage(res);
      return;
    }
    applyGrabbedJd(res, tab);
  } catch (error) {
    status.textContent = `抓取失败：${(error && error.message) || error}`;
  } finally {
    grabBusy = false;
    await refreshGrabAvailability();
  }
}

$('fetch-jd').addEventListener('click', grabJdFromPage);

$('grab-undo').addEventListener('click', () => {
  if (!grabUndo) return;
  const restore = grabUndo.previous;
  grabUndo = null;
  jobInput.value = restore;
  updateJobControls();
  saveMemory();
  $('job-step-status').textContent = '已恢复抓取前的内容。';
});

// 侧边栏常驻：切换标签页后按钮可用性必须跟着变，否则会指向错误的页面
if (chrome.tabs && chrome.tabs.onActivated && typeof chrome.tabs.onActivated.addListener === 'function') {
  chrome.tabs.onActivated.addListener(() => {
    refreshGrabAvailability();
    // 换了页面之前扫的表单就失效了：清掉计划并收起面板，避免用户把旧清单当成本页的
    if (autofillScan) {
      autofillScan = null;
      autofillPlan = null;
      const panel = $('autofill-panel');
      if (panel && !panel.hidden) {
        panel.hidden = true;
        autofillStatus('');
      }
    }
    refreshAutofillAvailability();
  });
}

refreshGrabAvailability().catch(() => {});

// ── 网申预填 ──────────────────────────────────
//
// 设计要点（按需求文档定稿）：
//   · 只填不提交。代码里不存在任何点击提交按钮的路径，这是硬边界。
//   · 通用语义引擎，不做逐站适配器：本地 41 条规则打分 + 可选 AI 语义映射。
//   · 宁缺勿错。认不出的字段一律进「需你手动处理」清单，并如实说明原因。
//   · 敏感字段（身份证/银行卡/住址/紧急联系人）默认关闭。
//   · 自定义下拉框与文件上传无法程序化写入，跳过并提示，不做无效尝试。
//
// AI 的角色被刻意限制为「从固定语义枚举里选一个」，填什么值完全由本地
// 取值层决定。AI 没配、超时或返回不合法 → 自动退回纯本地规则，不卡住用户。

const AUTOFILL_STATUS = 'autofill-status';
const AUTOFILL_PANEL = 'autofill-panel';

// 扫描阶段的进度文案（本地规则几乎瞬时完成，所以只有 AI 那一轮需要转圈）
const AUTOFILL_AI_LINES = [
  '正在读取页面表单结构…',
  '让 AI 判断每个字段该填什么…',
  '对照你的简历逐项取值…',
  '整理需你手动确认的部分…'
];

const AUTOFILL_AI_MAX_FIELDS = 120;

function autofillStatus(text) {
  const el = $(AUTOFILL_STATUS);
  if (el) el.textContent = text || '';
}

// ── AI 语义映射 ────────────────────────────────
// 只把「本地认不出」的字段交给 AI。本地已经确定的字段不再消耗 token，
// 也避免 AI 把已经判对的结果改错。

// 字段特征以单行摘要呈现，噪音（长文本、多余属性）在这里就滤掉，
// 既省 token 也让模型更容易抓住标签名。
// toSingleLine / FILL_RULES 复用 form-fill.js，不另起一套。
function buildFormMapPrompt(fields) {
  const oneLine = (value, limit) => toSingleLine(value).replace(/\s+/g, ' ').slice(0, limit);
  const lines = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const parts = [`[${i}] 类型=${f.type}`];
    if (f.label) parts.push(`标签="${oneLine(f.label, 40)}"`);
    if (f.optionText) parts.push(`本项文字="${oneLine(f.optionText, 20)}"`);
    if (!f.label && f.placeholder) parts.push(`placeholder="${oneLine(f.placeholder, 40)}"`);
    if (f.name) parts.push(`name=${oneLine(f.name, 40)}`);
    if (f.id && f.id !== f.name) parts.push(`id=${oneLine(f.id, 40)}`);
    if (f.autocomplete && f.autocomplete !== 'off') parts.push(`autocomplete=${oneLine(f.autocomplete, 20)}`);
    if (f.dataHints) parts.push(`data提示="${oneLine(f.dataHints, 40)}"`);
    if (Array.isArray(f.sectionTexts) && f.sectionTexts.length) {
      parts.push(`所在区块="${f.sectionTexts.map(t => oneLine(t, 20)).join(' / ')}"`);
    }
    if (f.type === 'select' && Array.isArray(f.options) && f.options.length) {
      const texts = f.options
        .map(o => oneLine(o.text, 16))
        .filter(Boolean)
        .slice(0, 12);
      if (texts.length) parts.push(`选项=[${texts.join('|')}]`);
    }
    lines.push(parts.join(' '));
  }
  return `【页面表单控件】\n${lines.join('\n')}`;
}

// 解析 AI 返回的「序号<TAB>语义」。容错：制表符/空格/冒号/逗号分隔都能认；
// 语义不在枚举里的一律丢弃（返回 undefined → 该字段退回本地判定）。
function parseFormMapResponse(raw, semanticIds) {
  const out = {};
  const allowed = {};
  for (const id of semanticIds) allowed[id] = true;
  const text = String(raw || '').replace(/\r/g, '');

  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/^[-*•]\s*/, '').replace(/^```.*$/, '');
    if (!trimmed) continue;
    const match = trimmed.match(/^\[?(\d{1,4})\]?\s*[\s:：,，\t|]+\s*([A-Za-z][A-Za-z0-9_.]*|\?|？)\s*$/);
    if (!match) continue;
    const index = Number(match[1]);
    const value = match[2];
    if (!Number.isInteger(index) || index < 0) continue;
    if (value === '?' || value === '？') { out[index] = null; continue; }
    // 模型可能写成 basic.phone / Basic.Phone / basic_phone，统一归一
    const normalized = value.trim().replace(/_/g, '.').toLowerCase();
    if (allowed[normalized]) out[index] = normalized;
    else if (allowed[value]) out[index] = value;
  }
  return out;
}

async function requestFormMap(settings, fields) {
  const sub = fields.slice(0, AUTOFILL_AI_MAX_FIELDS);
  const promptText = `${FORM_MAP_PROMPT}\n\n${buildFormMapPrompt(sub)}`;
  try {
    // 超时与取消由 requestCompletion 统一兜底（API_TIMEOUT_MS），此处不重复造一套
    const raw = await requestCompletion({
      settings,
      promptText,
      maxTokens: 2000,
      temperature: 0,
      requestKey: 'formmap'
    });
    return { hint: parseFormMapResponse(raw, FILL_RULES.map(r => r.id)), count: sub.length };
  } catch (error) {
    return { hint: {}, count: sub.length, error };
  }
}

// ── 计划构建 ──────────────────────────────────

function autofillOptions() {
  const overwriteEl = $('autofill-overwrite');
  const sensitiveEl = $('autofill-sensitive');
  return {
    overwrite: Boolean(overwriteEl && overwriteEl.checked),
    includeSensitive: Boolean(sensitiveEl && sensitiveEl.checked),
    sensitiveKeys: PROFILE_SENSITIVE_KEYS
  };
}

// 扫描进度：只在扫描/识别期间占用摘要行，停止时立刻交还给渲染函数。
// 用 generation 计数防止已经排队的 tick 在停止后仍然改写摘要（否则会把结果文案冲掉）。
let autofillProgressGen = 0;

function autofillProgress(on, text) {
  const el = $('autofill-summary');
  clearInterval(autofillProgressTimer);
  autofillProgressTimer = null;
  autofillProgressGen += 1;

  if (!on) return;
  const gen = autofillProgressGen;
  if (el && text) el.textContent = text;
  if (!el || typeof setInterval !== 'function') return;

  let i = 0;
  el.textContent = text || AUTOFILL_AI_LINES[0];
  autofillProgressTimer = setInterval(() => {
    // 停止后再响的 tick 一律丢弃
    if (gen !== autofillProgressGen) return;
    i = (i + 1) % AUTOFILL_AI_LINES.length;
    const target = $('autofill-summary');
    if (target) target.textContent = AUTOFILL_AI_LINES[i];
  }, 1600);
}

// 扫描与计划分离：开关切换、重新扫描都走这两个函数，职责单一
async function scanAutofillPage() {
  const tab = await getActiveTab();
  const url = (tab && tab.url) || '';
  if (!tab || !/^https?:/i.test(url)) {
    return { ok: false, reason: 'no-tab', detail: '只支持普通网页（http/https）。浏览器内置页面与扩展页面无法读取表单。' };
  }
  const res = await sendTabMessage(tab.id, { type: 'form:scan' });
  if (!res) {
    return { ok: false, reason: 'no-channel', detail: '无法与当前页面通信。刚安装或更新扩展后需要刷新该网页一次，再点扫描。' };
  }
  if (!res.ok) {
    return { ok: false, reason: res.reason || 'error', detail: res.detail || '扫描失败。' };
  }
  return { ok: true, tab, url, site: res.site || hostOf(url), fields: res.fields || [], title: res.title || '' };
}

// 本地规则只处理它认得出的字段；认不出的成批交给 AI（若已连接），
// AI 的判断作为「语义提示」参与打分，而不是直接覆盖取值。
async function buildAutofillPlan(profileData) {
  const fields = (autofillScan && autofillScan.fields) || [];
  const options = autofillOptions();

  // 1) 先跑一遍纯本地，拿到「已确定」与「待定」两组
  const local = createFillPlan(fields, profileData, options);
  const resolvedRefs = {};
  for (const item of local.items) resolvedRefs[item.ref] = true;

  const uncertain = fields.filter(f => !resolvedRefs[f.ref]);
  if (!uncertain.length) {
    autofillAiFailed = false;
    return { plan: local, aiUsed: false, aiPending: 0 };
  }

  const settings = await getSettings();
  if (!settings.apiUrl || !settings.apiKey || !FORM_MAP_PROMPT) {
    autofillAiFailed = false;
    return { plan: local, aiUsed: false, aiSkipped: true, aiPending: uncertain.length };
  }

  const mapped = await requestFormMap(settings, uncertain);
  autofillAiFailed = Boolean(mapped.error);

  const hint = {};
  for (const index of Object.keys(mapped.hint)) {
    const semantic = mapped.hint[index];
    if (!semantic) continue;
    const field = uncertain[Number(index)];
    if (field && field.ref != null) hint[field.ref] = semantic;
  }

  if (!Object.keys(hint).length) {
    return { plan: local, aiUsed: false, aiFailed: Boolean(mapped.error), aiPending: uncertain.length };
  }

  const plan = createFillPlan(fields, profileData, Object.assign({}, options, { hint }));
  return { plan, aiUsed: true, aiFailed: Boolean(mapped.error), aiPending: uncertain.length };
}

// ── 渲染 ──────────────────────────────────────

function autofillSummaryText(info) {
  const { plan, scan } = info;
  const parts = [`扫描到 ${plan.stats.total} 个可编辑控件`];
  if (plan.stats.fillable) parts.push(`可自动填 ${plan.stats.fillable} 项`);
  if (plan.stats.manual) parts.push(`需你处理 ${plan.stats.manual} 项`);
  if (!plan.stats.fillable) parts.push('这次没有可自动填写的字段');
  return parts.join(' · ');
}

function renderAutofillList(targetId, entries) {
  const el = $(targetId);
  if (!el) return;
  el.innerHTML = entries.map(entry => {
    const label = entry.label || '（无标签字段）';
    const right = entry.right ? `<span class="af-item-right">${escapeHtml(entry.right)}</span>` : '';
    const sub = entry.sub ? `<span class="af-item-sub">${escapeHtml(entry.sub)}</span>` : '';
    return `<div class="af-item">
      <span class="af-item-label">${escapeHtml(label)}</span>
      <span class="af-item-meta"><span class="af-item-value">${escapeHtml(entry.value || '')}</span>${right}</span>
      ${sub}
    </div>`;
  }).join('');
}

function renderAutofillPanel(info) {
  const panel = $(AUTOFILL_PANEL);
  if (!panel || !info) return;

  const plan = info.plan || { items: [], manual: [], stats: { total: 0, fillable: 0, manual: 0 } };
  const site = (autofillScan && autofillScan.site) || '当前页面';

  panel.hidden = false;
  $('autofill-site').textContent = site;
  $('autofill-summary').textContent = autofillSummaryText(info);

  // 将填写
  const fillBlock = $('autofill-fill-block');
  const items = plan.items || [];
  fillBlock.hidden = !items.length;
  $('autofill-fill-count').textContent = items.length ? `${items.length} 项` : '';
  renderAutofillList('autofill-fill-list', items.map(item => ({
    label: item.formLabel || item.semanticLabel,
    value: item.displayValue || '',
    right: item.semanticLabel,
    sub: item.note || ''
  })));

  // 需手动
  const manualBlock = $('autofill-manual-block');
  const manual = plan.manual || [];
  manualBlock.hidden = !manual.length;
  $('autofill-manual-count').textContent = manual.length ? `${manual.length} 项` : '';
  renderAutofillList('autofill-manual-list', manual.map(entry => ({
    label: entry.formLabel || '（无标签字段）',
    value: entry.title,
    sub: entry.detail
  })));

  const confirmBtn = $('autofill-confirm');
  if (confirmBtn) {
    confirmBtn.disabled = !items.length;
    confirmBtn.textContent = items.length ? `确认填写 ${items.length} 项` : '没有可填写的字段';
  }

  // 如实告知 AI 的参与情况，不让用户以为「AI 什么都懂」
  const notes = [];
  if (info.aiFailed) notes.push('AI 判断这一步没成功，本次仅用本地规则识别，可点「重新扫描」再试');
  else if (info.aiUsed) notes.push('已结合 AI 判断字段含义');
  else if (info.aiSkipped && info.aiPending) notes.push(`有 ${info.aiPending} 个字段本地认不出，到「设置」连接 AI 后可提高识别率`);
  else notes.push('仅用本地规则识别');
  notes.push('填写位置会用红框标出，请核对后自行提交');
  autofillStatus(notes.join('；') + '。');
}

function autofillFailureMessage(res) {
  const detail = res.detail || '';
  if (res.reason === 'no-tab') return detail || '只支持普通网页（http/https）。';
  if (res.reason === 'no-channel') return detail || '无法与当前页面通信，请刷新网页后重试。';
  if (res.reason === 'loading') return detail || '页面还在加载，请等页面显示完整后再扫描。';
  return `扫描失败：${detail || '未知原因'}`;
}

// ── 主流程 ────────────────────────────────────

async function refreshAutofillAvailability() {
  const btn = $('autofill-button');
  if (!btn) return;

  if (autofillBusy) {
    btn.disabled = true;
    $('state-autofill').textContent = '正在扫描…';
    return;
  }
  btn.disabled = false;

  const stateEl = $('state-autofill');
  const structured = structuredProfile();
  if (!structured) {
    if (stateEl) {
      stateEl.textContent = '需先上传简历';
      stateEl.classList.remove('is-ready');
    }
    btn.disabled = true;
    return;
  }
  if (stateEl) {
    stateEl.textContent = profile ? '可以填写' : '可以填写（本地规则）';
    stateEl.classList.add('is-ready');
  }
}

async function openAutofill() {
  if (autofillBusy) return;

  const panel = $(AUTOFILL_PANEL);
  if (panel) panel.hidden = false;

  const structured = structuredProfile();
  if (!structured) {
    gotoMissingStep(true, '网申预填需要先上传简历。');
    autofillStatus('请先在第 1 步上传简历，再回来填网申表单。');
    return;
  }

  autofillBusy = true;
  autofillAiFailed = false;
  autofillScan = null;
  autofillPlan = null;
  $('autofill-fill-block').hidden = true;
  $('autofill-manual-block').hidden = true;
  $('autofill-confirm').disabled = true;
  $('autofill-site').textContent = '';
  autofillProgress(true);
  await refreshAutofillAvailability();

  try {
    const scan = await scanAutofillPage();
    if (!scan.ok) {
      autofillProgress(false);
      autofillStatus(autofillFailureMessage(scan));
      $('autofill-summary').textContent = '';
      return;
    }
    autofillScan = scan;
    $('autofill-site').textContent = scan.site;

    if (!scan.fields.length) {
      autofillProgress(false);
      $('autofill-summary').textContent = '这个页面里没找到可编辑的表单控件';
      autofillStatus('若表单在页面内嵌的框架（iframe）里，或还没点开「填写申请表」，请展开后重新扫描。');
      return;
    }

    const built = await buildAutofillPlan(structured);
    autofillProgress(false);
    autofillPlan = built.plan;
    renderAutofillPanel({ plan: built.plan, scan, aiUsed: built.aiUsed, aiFailed: built.aiFailed, aiSkipped: built.aiSkipped, aiPending: built.aiPending });
  } catch (error) {
    autofillProgress(false);
    autofillStatus(`扫描出错：${(error && error.message) || error}`);
  } finally {
    autofillBusy = false;
    await refreshAutofillAvailability();
  }
}

// 开关与「重新扫描」都会重算计划。已在页面上填过的值不会因此丢失，
// 因为重算只是重新识别字段，不触碰页面。
async function rebuildAutofillPlan() {
  if (autofillBusy || !autofillScan) return;
  const structured = structuredProfile();
  if (!structured) return;

  autofillBusy = true;
  autofillProgress(true, '正在重新识别字段…');
  await refreshAutofillAvailability();
  try {
    const built = await buildAutofillPlan(structured);
    autofillProgress(false);
    autofillPlan = built.plan;
    renderAutofillPanel({ plan: built.plan, scan: autofillScan, aiUsed: built.aiUsed, aiFailed: built.aiFailed, aiSkipped: built.aiSkipped, aiPending: built.aiPending });
  } catch (error) {
    autofillProgress(false);
    autofillStatus(`重新识别失败：${(error && error.message) || error}`);
  } finally {
    autofillBusy = false;
    await refreshAutofillAvailability();
  }
}

async function confirmAutofill() {
  if (autofillBusy || !autofillScan) return;
  const plan = autofillPlan;
  if (!plan || !plan.items.length) {
    autofillStatus('没有可填写的字段。');
    return;
  }

  const tab = await getActiveTab();
  if (!tab || !/^https?:/i.test((tab && tab.url) || '')) {
    autofillStatus('当前页面不可写入，请切回网申页面再试。');
    return;
  }

  autofillBusy = true;
  const btn = $('autofill-confirm');
  if (btn) { btn.disabled = true; btn.textContent = '正在写入…'; }
  await refreshAutofillAvailability();

  try {
    // 只发「值」，不发任何提交意图
    const payload = plan.items.map(item => ({ ref: item.ref, value: item.value }));
    const res = await sendTabMessage(tab.id, { type: 'form:fill', items: payload });

    if (!res) {
      autofillStatus('无法与当前页面通信。刚安装或更新扩展后需要刷新该网页一次，再重新扫描。');
      return;
    }
    if (!res.ok) {
      autofillStatus(res.detail ? `写入失败：${res.detail}` : '写入失败，请重新扫描后再试。');
      return;
    }

    const summary = summarizeFillResult(res.results || []);
    // 可搜索下拉框只是把关键词填了进去，还没真正选中 —— 必须说清楚，
    // 否则用户以为填好了直接提交，那个值会丢
    const assistedCount = plan.items.filter(item => item.assisted).length;
    const assistedNote = assistedCount
      ? `其中 ${assistedCount} 项是可搜索的下拉框，已填入关键词，请从下拉候选里点选确认。`
      : '';
    if (!summary.failed) {
      autofillStatus(`已填写 ${summary.ok} 项，页面上用红框标出。${assistedNote}请逐项核对后自行提交。`);
    } else if (summary.stale) {
      autofillStatus(`已填写 ${summary.ok} 项，另有 ${summary.stale} 项因页面结构变化未填写。请重新扫描后再试。`);
    } else {
      autofillStatus(`已填写 ${summary.ok} 项，${summary.other} 项写入未生效，请手动补填。${assistedNote}`);
    }
  } catch (error) {
    autofillStatus(`写入出错：${(error && error.message) || error}`);
  } finally {
    autofillBusy = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = plan.items.length ? `确认填写 ${plan.items.length} 项` : '没有可填写的字段';
    }
    await refreshAutofillAvailability();
  }
}

async function clearAutofillMarks() {
  const tab = await getActiveTab();
  if (!tab || !/^https?:/i.test((tab && tab.url) || '')) {
    autofillStatus('当前页面没有可清除的标记。');
    return;
  }
  const res = await sendTabMessage(tab.id, { type: 'form:clear' });
  if (!res || !res.ok) {
    autofillStatus('无法与当前页面通信，未能清除标记。');
    return;
  }
  autofillStatus(res.cleared
    ? `已清除 ${res.cleared} 个字段的红框标记（字段内容不会被清空）。`
    : '页面上没有标记需要清除。');
}

// 面板占位（HTML 里已预留 #autofill-panel，此处仅做防御性检查）
if (!$('autofill-button')) {
  console.warn('产出卡 #autofill-button 缺失，网申预填将不可用');
}

// ── 诊断详情导出 ──────────────────────────────
//
// 用于回答「这个字段为什么没填上」。用户在真实页面上点一下，
// 就能拿到每个控件的原始特征（标签 / name / 类型）+ 识别结果 + 跳过原因。
//
// 为什么需要它：光看「需你手动处理」清单不够 —— 控件可能压根没被扫描到
// （在 iframe 里、被 isVisible 过滤、选择器没命中），那种情况两张清单里都不会出现，
// 只有把「扫描到的全部控件」列出来才能区分「没扫到」和「识别失败」。

function buildAutofillDiagnosticReport() {
  const scan = autofillScan;
  if (!scan) return '';
  const plan = autofillPlan || { items: [], manual: [] };
  const fields = scan.fields || [];

  const itemByRef = {};
  for (const item of plan.items) itemByRef[item.ref] = item;
  const manualByRef = {};
  for (const entry of plan.manual) manualByRef[entry.ref] = entry;

  const lines = [];
  lines.push('【网申预填诊断报告】');
  lines.push('页面：' + (scan.url || ''));
  lines.push('站点：' + (scan.site || ''));
  lines.push('时间：' + new Date().toLocaleString('zh-CN'));
  lines.push('扫描到 ' + fields.length + ' 个可编辑控件｜将填写 ' + plan.items.length + '｜需手动 ' + plan.manual.length);
  lines.push('');
  lines.push('── 控件清单（按页面顺序，含未识别与已跳过的）──');
  lines.push('序号 | 类型 | 标签 / name | 识别结果 | 处置');

  fields.forEach((field, index) => {
    // 这里刻意只显示 label，不拿 placeholder 兜底。
    // 两者混在一起会掩盖「标签根本没读出来」这个关键事实：报告里几十行
    // 显示「请选择」时，看不出到底是标签被解成了占位符，还是压根没有标签。
    // 排查这两者的改法完全不同，所以必须分开显示。
    const label = field.label || '(标签为空)';
    const phPart = field.placeholder ? ' [ph=' + field.placeholder + ']' : '';
    const namePart = field.name ? ' [name=' + field.name + ']' : '';
    let semantic = '—';
    let action = '未识别';
    if (itemByRef[field.ref]) {
      semantic = itemByRef[field.ref].semantic + '(' + itemByRef[field.ref].score + ')';
      // 可搜索的下拉框只是帮用户填了关键词，还没真正选中 —— 报告里要能看出来
      action = itemByRef[field.ref].assisted ? '填入关键词(待点选)' : '将填写';
    } else if (manualByRef[field.ref]) {
      semantic = manualByRef[field.ref].reason;
      action = '跳过：' + manualByRef[field.ref].title;
    }
    lines.push([
      String(index + 1).padStart(3),
      String(field.type || '').padEnd(14),
      (label + phPart + namePart).slice(0, 48).padEnd(48),
      semantic.slice(0, 26).padEnd(26),
      action
    ].join(' | '));
  });

  if (plan.manual.length) {
    lines.push('');
    lines.push('── 需你手动处理的原因 ──');
    // 同一原因出现几十次时合并计数。不合并的话，40 行几乎一模一样的
    // 「未能识别」会把真正要看的那几行淹掉。
    const grouped = new Map();
    for (const entry of plan.manual) {
      const key = entry.reason + '\u0000' + (entry.formLabel || '') + '\u0000' + entry.title;
      const hit = grouped.get(key);
      if (hit) hit.count += 1;
      else grouped.set(key, { entry, count: 1 });
    }
    for (const record of grouped.values()) {
      const entry = record.entry;
      lines.push('- [' + entry.reason + '] ' + (entry.formLabel || '(无标签)') +
        (record.count > 1 ? ' ×' + record.count : '') + '：' + entry.title + ' — ' + entry.detail);
    }
  }

  // 未填写控件的原始特征。
  //
  // 这一段的用处是区分「标签没解析出来」与「标签解析出来了但没有规则匹配」——
  // 只看识别结果永远是「未能识别」，两种情况看着一模一样，改法却完全不同。
  // 上一轮排查「学校抓不到」就是卡在这里：只能靠报告里的分数反推出真实特征。
  const unfilled = fields.filter(field => !itemByRef[field.ref]);
  if (unfilled.length) {
    lines.push('');
    lines.push('── 未填写控件的原始特征（排查用）──');
    lines.push('序号 | 类型 | 只读 | role | 标签与属性 | 章节');
    unfilled.forEach((field) => {
      lines.push([
        String(fields.indexOf(field) + 1).padStart(3),
        String(field.type || '').padEnd(14),
        (field.readOnly ? '是' : '否').padEnd(4),
        String(field.role || '∅').padEnd(10),
        'label=' + (field.label || '∅') +
        ' | ph=' + (field.placeholder || '∅') +
        ' | aria=' + (field.ariaLabel || '∅') +
        ' | name=' + (field.name || '∅') +
        ' | nearby=' + (field.nearbyText || '∅'),
        '[' + (field.sectionTexts || []).join(' / ') + ']'
      ].join(' | '));
    });
  }

  // 按原因码归类，给出针对性的下一步（用户不需要自己解读原因码）
  const counts = {};
  for (const entry of plan.manual) counts[entry.reason] = (counts[entry.reason] || 0) + 1;
  const hints = [];
  const assistedCount = plan.items.filter(item => item.assisted).length;
  if (assistedCount) {
    hints.push('有 ' + assistedCount + ' 个可搜索下拉框：已帮你填入关键词触发页面筛选，请从下拉候选里点选才算选中。');
  }
  if (counts['custom-select']) {
    hints.push('有 ' + counts['custom-select'] + ' 个自定义下拉框：这类控件由页面脚本模拟，扩展无法可靠写入（写了不进组件状态），只能手动选择。');
  }
  const unrecognized = (counts.unknown || 0) + (counts.ambiguous || 0);
  if (unrecognized) {
    hints.push('有 ' + unrecognized + ' 个未能识别或含义不明确：到「设置」连接 AI 后重新扫描可提高识别率。');
  }
  if (counts['no-value']) hints.push('有 ' + counts['no-value'] + ' 个字段在简历里是空的：到第 1 步补充后重新扫描。');
  if (counts['has-value']) hints.push('有 ' + counts['has-value'] + ' 个字段页面上已有内容：需要覆盖请打开「覆盖页面上已有内容」。');
  if (counts.sensitive) hints.push('有 ' + counts.sensitive + ' 个敏感字段被跳过：需要填写请打开「包含敏感字段」。');
  if (counts.region) hints.push('有 ' + counts.region + ' 个国家/地区选择框：这不属于简历内容，请按需手动选择。');
  // 标签读不出来的字段要单独点名。它和「简历里没这项内容」是两回事，
  // 用户看到「未能识别」会以为是自己简历缺东西，其实是我们读不到字段名。
  const noLabel = unfilled.filter(field => !field.label).length;
  if (noLabel) {
    hints.push('有 ' + noLabel + ' 个控件没能读到字段名（label 为空）：不是你的简历缺内容，' +
      '而是这个页面的标签结构扩展读不出来。上面「未填写控件的原始特征」里能看到每个控件实际读到了什么。');
  }
  if (hints.length) {
    lines.push('');
    lines.push('── 提示 ──');
    for (const hint of hints) lines.push('· ' + hint);
  }

  return lines.join('\n');
}

async function copyAutofillDiagnostics() {
  if (!autofillScan) {
    autofillStatus('请先扫描页面，再导出诊断详情。');
    return;
  }
  const report = buildAutofillDiagnosticReport();
  try {
    await navigator.clipboard.writeText(report);
    autofillStatus('诊断详情已复制到剪贴板（' + report.split('\n').length + ' 行）。粘贴出来即可查看每个控件的识别情况。');
  } catch (e) {
    // 剪贴板被拒时不要让用户白点一次，把报告打到控制台兜底
    console.log(report);
    autofillStatus('复制失败（浏览器拒绝了剪贴板权限），诊断详情已输出到控制台。');
  }
}

// ── 结果渲染 ──────────────────────────────────

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

function formatBody(text) {
  if (text == null || text === '') return '';
  let result = escapeHtml(String(text));
  // 去掉残留的 markdown 分隔线和标题标记
  result = result.replace(/^---+\s*$/gm, '');
  result = result.replace(/^#{1,4}\s*/gm, '');
  // **加粗** → <strong>
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // __加粗__ → <strong>
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // *斜体* → <em>
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return result;
}

function renderSections(sections, target) {
  lastSections[target] = sections;
  const plainText = sections
    .map(s => {
      const body = Array.isArray(s.body)
        ? s.body.map(i => typeof i === 'object' ? JSON.stringify(i) : i).join('\n')
        : s.body;
      return `${s.title}\n${body}`;
    })
    .join('\n\n');

  const html = '<div class="result-card">' + sections.map(s => {
    const isDivider = s.title && (s.title.startsWith('第二部分') || /面试准备/.test(s.title));
    const bodyText = Array.isArray(s.body) ? s.body.join(' ') : (s.body || '');
    const isParagraph = target !== 'greeting' && !s.list && bodyText.length < 200 && !isDivider;

    const cls = isDivider ? 'result-section divider'
      : isParagraph ? 'result-section paragraph'
      : s.suggestion ? 'result-section suggestion'
      : 'result-section';

    const rawItems = s.list
      ? (Array.isArray(s.body) ? s.body : String(s.body).split('\n').filter(Boolean))
      : [s.body];
    const body = s.list
      ? `<ul>${rawItems.map(i => `<li>${formatBody(typeof i === 'object' ? JSON.stringify(i) : i)}</li>`).join('')}</ul>`
      : `<p>${formatBody(typeof rawItems[0] === 'object' ? JSON.stringify(rawItems[0]) : rawItems[0])}</p>`;
    const copyBtn = (isDivider || isParagraph) ? '' : `<button class="copy-section" title="复制此板块"><img src="assets/copy.png" alt="复制"></button>`;
    return `<article class="${cls}"><h3>${escapeHtml(s.title)}${copyBtn}</h3>${body}</article>`;
  }).join('') + '</div>';

  if (target === 'interview') {
    interviewPlainText = plainText;
    interviewContent.innerHTML = html;
    interviewResults.hidden = false;
    document.querySelector('.copy-interview').hidden = false;
    document.querySelector('.export-interview').hidden = false;
  } else if (target === 'greeting') {
    greetingPlainText = plainText;
    greetingContent.innerHTML = html;
    greetingResults.hidden = false;
    document.querySelector('.copy-greeting').hidden = false;
    document.querySelector('.export-greeting').hidden = false;
  } else if (target === 'optimize') {
    optimizePlainText = plainText;
    optimizeContent.innerHTML = html;
    optimizeResults.hidden = false;
    document.querySelector('.copy-optimize').hidden = false;
    document.querySelector('.export-optimize').hidden = false;
  }
  $('empty-state').hidden = true;
}

// ── 导出可视化 HTML 文件（杂志专访页气质） ──────────

const MODE_LABEL = { interview: '面试准备', greeting: '打招呼语', optimize: '简历优化' };
const MODE_TITLE = { interview: '岗位分析与面试准备', greeting: '打招呼语', optimize: '简历优化' };
const MODE_KICKER = {
  interview: 'JOB ANALYSIS · INTERVIEW PREP',
  greeting: 'COLD OUTREACH · OPENING MESSAGE',
  optimize: 'RESUME OPTIMIZATION',
};

// 把内联 **bold** 渲染为高亮（mark），斜体保持 em。
function highlightInline(text) {
  if (text == null) return '';
  let r = escapeHtml(text);
  r = r.replace(/\*\*([^*\n][^*]*?)\*\*/g, '<mark>$1</mark>');
  r = r.replace(/__([^_\n][^_]*?)__/g, '<mark>$1</mark>');
  r = r.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, '<em>$1</em>');
  return r;
}

// 把 section body 拆成「子标题 / 段落 / 编号列表」三种块。
function parseExportBody(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r/g, '').split('\n');

  const out = [];
  const listBuf = [];
  const flushList = () => {
    if (listBuf.length) {
      out.push('<ol>' + listBuf.map(i => `<li>${highlightInline(i)}</li>`).join('') + '</ol>');
      listBuf.length = 0;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-*_—]{3,}$/.test(line)) { flushList(); continue; }

    const numMatch = line.match(/^(?:\d+|[一二三四五六七八九十]+)[)\.、]\s+(.+)$/);
    const bulletMatch = line.match(/^[•·\-*+]\s+(.+)$/);

    if (numMatch || bulletMatch) {
      listBuf.push(numMatch ? numMatch[1] : bulletMatch[1]);
      continue;
    }

    flushList();

    const clean = line.replace(/[*_]/g, '').trim();
    const isShort = clean.length >= 2 && clean.length <= 18;
    const noPunct = !/[。？！?!，；：:、]/.test(clean);
    if (isShort && noPunct && /[\u4e00-\u9fff]/.test(clean)) {
      out.push(`<h4 class="subhead">${highlightInline(line)}</h4>`);
    } else {
      out.push(`<p>${highlightInline(line)}</p>`);
    }
  }
  flushList();
  return out.join('\n');
}

function buildExportDoc(mode) {
  const sections = lastSections[mode] || [];
  const label = MODE_LABEL[mode] || mode;
  const title = MODE_TITLE[mode] || label;
  const kicker = MODE_KICKER[mode] || '';
  const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

  const chapters = [];
  let chapterIdx = 0;
  sections.forEach((s) => {
    const isDivider = s.title && (s.title.startsWith('第二部分') || /面试准备/.test(s.title));
    if (isDivider) {
      chapters.push({ kind: 'divider', title: s.title });
      chapterIdx = 0;
      return;
    }
    chapterIdx += 1;
    const idx = String(chapterIdx).padStart(2, '0');
    let body;
    if (s.list) {
      const items = Array.isArray(s.body) ? s.body : String(s.body).split('\n').filter(Boolean);
      body = `<ol>${items.map(i => `<li>${highlightInline(typeof i === 'object' ? JSON.stringify(i) : i)}</li>`).join('')}</ol>`;
    } else {
      const bt = Array.isArray(s.body) ? s.body.join('\n') : (s.body || '');
      body = `<div class="body">${parseExportBody(bt)}</div>`;
    }
    chapters.push({ kind: 'chapter', idx, title: s.title || '未命名板块', body });
  });

  const chaptersHtml = chapters.map(c => {
    if (c.kind === 'divider') {
      return `<div class="divider"><span>${escapeHtml(c.title)}</span></div>`;
    }
    return `<section class="chapter">
  <span class="chapter-num">${c.idx}</span>
  <span class="chapter-kicker">Chapter ${c.idx}</span>
  <h2 class="chapter-title">${escapeHtml(c.title)}</h2>
  ${c.body}
</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>面邀收割机 · ${escapeHtml(title)}</title>
<style>
  :root {
    --paper: #FFFFFF;
    --paper-2: #FBF6E9;
    --ink: #1A1A1A;
    --ink2: #383838;
    --muted: #8E8678;
    --rule: rgba(26,26,26,.18);
    --accent: #E60012;
    --accent-deep: #B8000E;
    --accent-soft: #FCE4E7;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--paper);
    color: var(--ink);
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.85;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  .page {
    max-width: 820px;
    margin: 0 auto;
    padding: 72px 56px 96px;
    background: var(--paper);
  }

  /* ── Cover ───────────────────────────────────── */
  .cover { margin-bottom: 56px; }
  .cover-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .32em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .cover-eyebrow::before { content: ""; width: 32px; height: 1px; background: var(--accent); }
  .cover h1 {
    font-family: "Songti SC", "STSong", "SimSun", "Source Han Serif SC", serif;
    font-size: 46px;
    font-weight: 700;
    letter-spacing: -.012em;
    line-height: 1.18;
    margin: 22px 0 18px;
    color: var(--ink);
  }
  .cover-meta {
    display: flex;
    align-items: center;
    gap: 14px;
    font-size: 12.5px;
    color: var(--muted);
    letter-spacing: .04em;
    margin-bottom: 28px;
  }
  .cover-meta b { color: var(--ink); font-weight: 500; }
  .cover-rule { display: flex; align-items: center; gap: 10px; }
  .cover-rule::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--ink);
  }
  .cover-rule small {
    font-size: 10px;
    letter-spacing: .35em;
    color: var(--ink);
    text-transform: uppercase;
    font-weight: 700;
  }
  .cover-kicker {
    display: block;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .3em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }

  /* ── Chapter ─────────────────────────────────── */
  .chapter {
    position: relative;
    margin: 56px 0 40px;
  }
  .chapter:first-of-type { margin-top: 32px; }
  .chapter-num {
    display: block;
    font-family: "Songti SC", "STSong", "SimSun", serif;
    font-size: 64px;
    font-weight: 700;
    line-height: 1;
    color: var(--accent);
    letter-spacing: -.04em;
    margin-bottom: 12px;
  }
  .chapter-kicker {
    display: block;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: .35em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 10px;
  }
  .chapter-title {
    font-family: "Songti SC", "STSong", "SimSun", "Source Han Serif SC", serif;
    font-size: 24px;
    font-weight: 700;
    line-height: 1.4;
    margin: 0 0 24px;
    color: var(--ink);
    letter-spacing: -.005em;
  }
  .chapter::after {
    content: "";
    display: block;
    width: 48px;
    height: 2px;
    background: var(--ink);
    margin: 28px 0 0;
  }

  /* ── Body ────────────────────────────────────── */
  .body { font-size: 15.5px; color: var(--ink2); line-height: 1.9; }
  .body > p { margin: 0 0 14px; }
  .body > p:first-of-type::first-letter {
    font-family: "Songti SC", "STSong", serif;
    font-size: 38px;
    font-weight: 700;
    float: left;
    line-height: 1;
    margin: 6px 8px 0 0;
    color: var(--accent);
  }

  /* ── Lists ───────────────────────────────────── */
  .body > ol, .body > ul {
    margin: 6px 0 22px;
    padding-left: 0;
    list-style: none;
    counter-reset: item;
  }
  .body > ol li, .body > ul li {
    counter-increment: item;
    position: relative;
    padding: 10px 0 10px 44px;
    font-size: 15px;
    border-bottom: 1px dashed rgba(26,26,26,.12);
  }
  .body > ol li:last-child, .body > ul li:last-child { border-bottom: 0; }
  .body > ol li::before, .body > ul li::before {
    content: counter(item);
    position: absolute;
    left: 0; top: 12px;
    width: 28px; height: 28px;
    border: 1px solid var(--ink);
    background: transparent;
    color: var(--ink);
    font-family: "Songti SC", "STSong", serif;
    font-size: 14px;
    font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    border-radius: 2px;
  }
  .body > ul li::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); top: 18px; left: 9px; }

  /* ── Subheads ────────────────────────────────── */
  .subhead {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .3em;
    text-transform: uppercase;
    color: var(--ink);
    margin: 28px 0 12px;
    padding: 0;
    border: 0;
  }
  .subhead::before {
    content: "";
    width: 7px; height: 7px;
    background: var(--accent);
    border-radius: 50%;
  }

  /* ── Inline highlights (replaces <strong> in export) ── */
  mark {
    background: var(--accent-soft);
    color: var(--ink);
    padding: 1px 5px;
    margin: 0 1px;
    border-radius: 2px;
    font-weight: 600;
  }
  em { font-style: normal; color: var(--ink); border-bottom: 1px solid var(--muted); padding-bottom: 1px; }

  /* ── Divider (e.g. "第二部分：面试准备") ─────────── */
  .divider {
    display: flex;
    align-items: center;
    gap: 18px;
    margin: 64px 0 36px;
    padding: 18px 24px;
    background: var(--ink);
    color: var(--paper);
    font-family: "Songti SC", "STSong", serif;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: .04em;
    position: relative;
  }
  .divider::before {
    content: "";
    width: 9px; height: 9px;
    border-radius: 50%;
    background: var(--accent);
    flex: 0 0 auto;
  }
  .divider span { flex: 1; }

  /* ── Footer ──────────────────────────────────── */
  .footer {
    margin-top: 80px;
    padding-top: 24px;
    border-top: 1px solid var(--rule);
    text-align: center;
    font-size: 10.5px;
    letter-spacing: .35em;
    text-transform: uppercase;
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
  }
  .footer::before, .footer::after {
    content: "";
    width: 24px; height: 1px;
    background: var(--muted);
  }

  /* ── Print ───────────────────────────────────── */
  @media print {
    body { background: #fff; }
    .page { padding: 18mm 16mm; max-width: none; }
    .chapter { page-break-inside: avoid; }
    .chapter-num, .chapter-title { color: #000; }
    mark { background: transparent; color: #000; border-bottom: 1px solid #E60012; padding-bottom: 0; }
    .divider { background: #000; color: #fff; }
  }

  /* ── Responsive ──────────────────────────────── */
  @media (max-width: 560px) {
    .page { padding: 36px 22px 64px; }
    .cover h1 { font-size: 32px; }
    .chapter-num { font-size: 46px; }
    .chapter-title { font-size: 20px; }
  }
</style>
</head>
<body>
  <div class="page">
    <header class="cover">
      <span class="cover-kicker">${escapeHtml(kicker)}</span>
      <div class="cover-eyebrow">面邀收割机 · ${escapeHtml(label)}</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="cover-meta">
        <b>${date}</b>
        <span>·</span>
        <span>由「面邀收割机」扩展生成，建议结合自身真实经历审阅使用</span>
      </div>
      <div class="cover-rule"><small>— ENDORSED OUTPUT —</small></div>
    </header>
    ${chaptersHtml}
    <footer class="footer">面邀收割机 · 本地生成 · 数据不上传</footer>
  </div>
</body>
</html>`;
}

// ── 简历优化专属导出（按内容语义布局，不套统一大编号）────

const OPT_EXPORT_CSS = `
  :root {
    --paper: #FFFFFF; --ink: #1A1A1A; --ink2: #383838; --muted: #8E8678;
    --rule: rgba(26,26,26,.18); --accent: #E60012; --accent-soft: #FCE4E7;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: var(--paper); color: var(--ink); font-family: "PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,"Segoe UI",Roboto,sans-serif; line-height: 1.85; -webkit-font-smoothing: antialiased; }
  .page { max-width: 820px; margin: 0 auto; padding: 72px 56px 96px; background: var(--paper); }

  .cover { margin-bottom: 48px; }
  .cover-kicker { display: block; font-size: 11px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
  .cover-eyebrow { display: inline-flex; align-items: center; gap: 12px; font-size: 11px; font-weight: 700; letter-spacing: .32em; text-transform: uppercase; color: var(--accent); }
  .cover-eyebrow::before { content: ""; width: 32px; height: 1px; background: var(--accent); }
  .cover h1 { font-family: "Songti SC","STSong","SimSun","Source Han Serif SC",serif; font-size: 46px; font-weight: 700; letter-spacing: -.012em; line-height: 1.18; margin: 22px 0 18px; color: var(--ink); }
  .cover-meta { display: flex; align-items: center; gap: 14px; font-size: 12.5px; color: var(--muted); letter-spacing: .04em; margin-bottom: 28px; }
  .cover-meta b { color: var(--ink); font-weight: 500; }
  .cover-rule { display: flex; align-items: center; gap: 10px; }
  .cover-rule::after { content: ""; flex: 1; height: 1px; background: var(--ink); }
  .cover-rule small { font-size: 10px; letter-spacing: .35em; color: var(--ink); text-transform: uppercase; font-weight: 700; }

  .opt-score { display: flex; gap: 32px; align-items: flex-start; margin: 36px 0; padding: 28px 30px; border: 1px solid var(--rule); border-radius: 16px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.04); }
  .opt-score-num { font-family: "Songti SC","STSong",serif; font-size: 72px; font-weight: 700; line-height: 1; color: var(--accent); letter-spacing: -.04em; flex: 0 0 auto; }
  .opt-score-side { flex: 1; min-width: 0; }
  .opt-score-title { font-size: 17px; font-weight: 700; margin: 0 0 6px; color: var(--ink); }
  .opt-score-basis { font-size: 14.5px; color: var(--ink2); margin: 0 0 10px; }
  .opt-gap { margin: 0; padding-left: 0; list-style: none; }
  .opt-gap li { position: relative; padding: 6px 0 6px 18px; font-size: 14px; color: var(--ink2); border-top: 1px dashed var(--rule); }
  .opt-gap li:first-child { border-top: 0; }
  .opt-gap li::before { content: ""; position: absolute; left: 0; top: 13px; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }

  .exp-card { margin: 28px 0; padding: 22px 24px; border: 1px solid var(--rule); border-left: 3px solid var(--accent); border-radius: 14px; background: #fff; }
  .exp-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .exp-head h2 { font-family: "Songti SC","STSong","SimSun",serif; font-size: 21px; font-weight: 700; margin: 0; color: var(--ink); }
  .exp-intro { font-size: 14.5px; color: var(--ink2); margin: 0 0 12px; }
  .kv-grid { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; }
  .kv-k { font-size: 13px; font-weight: 700; color: var(--accent); white-space: nowrap; padding-top: 2px; }
  .kv-v { font-size: 14.5px; color: var(--ink2); }

  .block-plain { margin: 28px 0; }
  .opt-h2 { font-family: "Songti SC","STSong","SimSun",serif; font-size: 21px; font-weight: 700; margin: 30px 0 12px; color: var(--ink); }
  .body { font-size: 15px; color: var(--ink2); line-height: 1.9; }
  .body > p { margin: 0 0 12px; }
  .kw-list { margin: 6px 0 0; padding-left: 0; list-style: none; counter-reset: kw; }
  .kw-list li { counter-increment: kw; position: relative; padding: 9px 0 9px 40px; font-size: 14.5px; color: var(--ink2); border-bottom: 1px dashed var(--rule); }
  .kw-list li:first-child { border-bottom: 0; }
  .kw-list li::before { content: counter(kw); position: absolute; left: 0; top: 9px; width: 26px; height: 26px; border: 1px solid var(--accent); color: var(--accent); border-radius: 50%; font-size: 13px; font-weight: 700; display: flex; align-items: center; justify-content: center; font-family: "Songti SC",serif; }

  .ver-card { margin: 28px 0; padding: 20px 22px; border: 1px solid var(--rule); border-radius: 14px; background: #FBF6E9; }
  .ver-label { display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--accent); margin-bottom: 8px; }
  .ver-card .opt-h2 { margin-top: 0; }

  mark { background: var(--accent-soft); color: var(--ink); padding: 1px 5px; margin: 0 1px; border-radius: 2px; font-weight: 600; }
  em { font-style: normal; color: var(--ink); border-bottom: 1px solid var(--muted); padding-bottom: 1px; }
  .footer { margin-top: 80px; padding-top: 24px; border-top: 1px solid var(--rule); text-align: center; font-size: 10.5px; letter-spacing: .35em; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; justify-content: center; gap: 12px; }
  .footer::before, .footer::after { content: ""; width: 24px; height: 1px; background: var(--muted); }
  @media print { body { background: #fff; } .page { padding: 18mm 16mm; max-width: none; } .opt-score-num, .opt-h2, .exp-head h2 { color: #000; } mark { background: transparent; color: #000; border-bottom: 1px solid #E60012; padding-bottom: 0; } .exp-card { border-left-color: #000; } }
  @media (max-width: 560px) { .page { padding: 36px 22px 64px; } .cover h1 { font-size: 32px; } .opt-score { flex-direction: column; gap: 12px; } .opt-score-num { font-size: 56px; } }
`;

// 从经历类板块里抽取「维度：内容」键值对（兼容前导编号/项目符号）
function extractKv(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const dimRe = /^(动作|方法|技术|解决问题|成果|背景|做了什么|用了什么|解决了什么|数据成果|项目背景)[\s:：]/;
  const kvPairs = [];
  const introLines = [];
  let seenKv = false;
  for (let l of lines) {
    l = l.replace(/^\d+[)、.]\s*/, '').replace(/^[-–—]\s*/, '');
    const m = l.match(/^(动作|方法|技术|解决问题|成果|背景|做了什么|用了什么|解决了什么|数据成果|项目背景)[\s:：]+(.*)$/);
    if (m) {
      seenKv = true;
      kvPairs.push([m[1], m[2].replace(/^[-–—\s]+/, '')]);
    } else if (!seenKv) {
      introLines.push(l);
    }
  }
  const grid = kvPairs.length
    ? kvPairs.map(([k, v]) => `<div class="kv-k">${escapeHtml(k)}</div><div class="kv-v">${highlightInline(v)}</div>`).join('')
    : '';
  return { intro: introLines.join(' '), grid };
}

// 单板块按语义选择版式
function renderOptimizeSection(s) {
  const title = s.title || '未命名板块';
  const titleHtml = escapeHtml(title);
  const rawBody = Array.isArray(s.body) ? s.body.join('\n') : (s.body || '');
  const bodyText = Array.isArray(s.body) ? s.body.join(' ') : (s.body || '');

  // 1) 匹配评分 → 大号红色百分比 hero
  if (/匹配评分|匹配度|评分/.test(title) || /匹配度\s*\d/.test(bodyText)) {
    const m = (title + ' ' + bodyText).match(/(\d{1,3})\s*%/);
    const score = m ? m[1] : '';
    const rest = (title + '\n' + rawBody)
      .replace(/匹配度\s*\d{1,3}\s*%/g, '')
      .replace(/^#.*$/gm, '')
      .trim();
    const lines = rest.split('\n').map(l => l.trim()).filter(Boolean);
    const basis = lines[0] || '';
    const gaps = lines.slice(1).filter(l => /缺口|缺|建议补充|不足/.test(l) || /^[-*•]/.test(l));
    return `<section class="opt-score">
  <div class="opt-score-num">${score ? score + '%' : '—'}</div>
  <div class="opt-score-side">
    <h2 class="opt-score-title">${titleHtml}</h2>
    ${basis ? `<p class="opt-score-basis">${highlightInline(basis)}</p>` : ''}
    ${gaps.length ? `<ul class="opt-gap">${gaps.map(g => `<li>${highlightInline(g.replace(/^[-*•]\s*/, ''))}</li>`).join('')}</ul>` : ''}
  </div>
</section>`;
  }

  // 2) 经历卡（实习/项目/经历优化）
  if (/经历优化|实习|项目|经历/.test(title) || /动作|方法|技术|解决问题|成果/.test(bodyText)) {
    const kv = extractKv(rawBody);
    const listHtml = s.list
      ? `<ol class="kw-list">${s.body.map(i => `<li>${highlightInline(i)}</li>`).join('')}</ol>`
      : '';
    return `<section class="exp-card">
  <div class="exp-head"><h2>${titleHtml}</h2></div>
  ${kv.intro ? `<p class="exp-intro">${highlightInline(kv.intro)}</p>` : ''}
  ${kv.grid ? `<div class="kv-grid">${kv.grid}</div>` : listHtml}
</section>`;
  }

  // 3) 关键词清单
  if (/关键词/.test(title)) {
    const items = s.list ? s.body : rawBody.split('\n').map(l => l.replace(/^[-*•]\s*/, '')).filter(Boolean);
    return `<section class="block-plain">
  <h2 class="opt-h2">${titleHtml}</h2>
  <ol class="kw-list">${items.map(i => `<li>${highlightInline(i)}</li>`).join('')}</ol>
</section>`;
  }

  // 4) 版本 / 自我评价 → 成品话术卡
  if (/版本|自我评价/.test(title)) {
    return `<section class="ver-card">
  <span class="ver-label">成品话术</span>
  <h2 class="opt-h2">${titleHtml}</h2>
  <div class="body">${parseExportBody(rawBody)}</div>
</section>`;
  }

  // 5) 兜底：散文
  return `<section class="block-plain">
  <h2 class="opt-h2">${titleHtml}</h2>
  <div class="body">${parseExportBody(rawBody)}</div>
</section>`;
}

function buildOptimizeDoc() {
  const sections = lastSections.optimize || [];
  const label = MODE_LABEL.optimize;
  const title = MODE_TITLE.optimize;
  const kicker = MODE_KICKER.optimize;
  const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const cards = sections.map(renderOptimizeSection).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>面邀收割机 · ${escapeHtml(title)}</title>
<style>${OPT_EXPORT_CSS}</style>
</head>
<body>
  <div class="page">
    <header class="cover">
      <span class="cover-kicker">${escapeHtml(kicker)}</span>
      <div class="cover-eyebrow">面邀收割机 · ${escapeHtml(label)}</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="cover-meta">
        <b>${date}</b>
        <span>·</span>
        <span>由「面邀收割机」扩展生成，建议结合自身真实经历审阅使用</span>
      </div>
      <div class="cover-rule"><small>— ENDORSED OUTPUT —</small></div>
    </header>
    ${cards}
    <footer class="footer">面邀收割机 · 本地生成 · 数据不上传</footer>
  </div>
</body>
</html>`;
}

function exportHtml(mode) {
  const sections = lastSections[mode];
  if (!sections || !sections.length) return;
  const doc = mode === 'optimize' ? buildOptimizeDoc() : buildExportDoc(mode);
  const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `面邀收割机_${MODE_LABEL[mode] || mode}_${date}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportWithFeedback(mode) {
  exportHtml(mode);
  const btn = document.querySelector('.export-' + mode);
  if (btn) { btn.textContent = '已导出'; setTimeout(() => btn.textContent = '导出 HTML', 1500); }
}

// ── 本地演示逻辑 ──────────────────────────────

function fallback(type, job) {
  const focus = job.includes('产品')
    ? '用户需求、版本推进和跨团队协作'
    : job.includes('数据')
      ? '指标口径、数据分析和业务判断'
      : job.includes('运营')
        ? '用户增长、内容策略和复盘能力'
        : '岗位核心职责、协作方式和交付结果';

  if (type === 'optimize') return [
    { title: '综合匹配评分', body: '演示数据无法给出真实评分。连接AI服务后，将根据您的简历与岗位进行精确匹配分析。', list: false, suggestion: false },
    { title: '岗位核心要求拆解', list: true, body: [`岗位方向：${focus}`, '重要程度：根据JD中出现的频率和位置判断', '匹配说明：需连接AI服务进行简历内容分析'], suggestion: false },
    { title: '当前不足分析', list: true, body: ['演示模式无法读取简历细节', '请连接AI服务获取针对性优化建议', '上传简历并填写岗位职责后点击"优化简历"'], suggestion: true },
    { title: '求职建议', body: '目前是演示内容。到"设置"连接AI服务后，可生成包含匹配评分、技能拆解、项目优化、关键词分析、完整优化简历和求职建议的详细报告。', list: false, suggestion: true }
  ];

  if (type === 'greeting') return [
    { title: '正式专业版', body: `您好，我目前主要关注${focus}方向。了解到贵公司正在招聘相关岗位，与我过往的学习和项目经历比较匹配，希望能有机会进一步沟通，谢谢。`, list: false, suggestion: false },
    { title: '自然沟通版', body: `您好，我看到贵司正在招聘的岗位和我的经历比较匹配。之前我主要接触过${focus}相关内容，希望有机会和您进一步交流。`, list: false, suggestion: false },
    { title: '突出优势版', body: `您好，我的主要方向是${focus}。看到贵司岗位后，发现岗位重点与我的项目经验比较契合，希望能够进一步了解岗位需求，也期待有机会加入团队。`, list: false, suggestion: false },
    { title: '推荐分析', body: ['推荐：自然沟通版，适合大多数求职场景', '匹配点：岗位方向与用户经历基本吻合', '注意：演示内容仅供体验，连接API后可获得真实分析'], list: true, suggestion: true }
  ];

  return [
    { title: '岗位深度拆解', body: `这个岗位的核心是做${focus}相关的工作。JD里反复提到要能独立推进业务，说明团队希望找一个来了就能上手的人，不是来学习的。你需要重点准备：你对这个方向的理解到底有多深，以及你有什么案例能证明你做过。面试前把这公司产品用一遍，找个具体问题准备你的看法，面试时主动说出来。`, list: false, suggestion: false },
    { title: '核心技能逐个分析', list: true, body: [`${focus} — ★★★ 必问 — JD提了好几次，这是核心中的核心。别光说会，准备一个你主导的具体案例，讲清楚你做了什么、怎么做的、结果怎样`, '推进能力 — ★★ 高频 — 面试官想看到你不是只会执行，而是能把一件事从开始推到结束。准备一个遇到困难但没放弃的例子', '沟通协作 — ★★ 高频 — 这个岗位大概率要跟多个部门打交道。准备一个你跟别人意见不合但最终达成一致的例子', '数据意识 — ★ 加分 — 这个做好了能拉开差距。你准备的项目案例里，能用数字的地方都用数字说话'], suggestion: false },
    { title: '竞争力评估', body: '光看JD的话，这个岗位竞争不会小。你的优势在于能把事情讲清楚、有案例可讲。建议重点打磨3个最能打的案例，面试时翻来覆去就用这三个打。', list: false, suggestion: false },
    { title: '高频面试问题', list: true, body: ['"讲一个你最有挑战的项目" → 别流水账从头讲到尾，直接说遇到了什么困难、你做了什么决策、最后怎么样了', '"你对这个岗位的理解" → 别复述JD，用你自己的话讲这个岗位到底要解决什么问题', '"为什么离开上一家" → 一句话带过就行，重点说为什么选这家、你来了能干什么', '"你怎么看我们产品" → 面试前必须用，说不出一两条建议就太被动了', '"你有什么想问我们的" → 问"团队目前最大的挑战是什么""这岗位做到什么程度算优秀"'], suggestion: false },
    { title: '面试现场技巧', list: true, body: ['进门先微笑打招呼，坐下了别急着说话，等面试官先开口', '被问到不会的：别说"不知道"，说"这块我之前接触不多，我的理解是XXX，您看对不对"', '面试官追问细节说明他对你感兴趣，这是好事，多展开讲讲', '面完当天或第二天发个消息，简单说句感谢，提一下面试里聊过的具体话题', '工资等对方先开口。问到了就说"想先了解一下这个岗位的薪资结构和预算范围"'], suggestion: false }
  ];
}

// ── API 调用 ──────────────────────────────────

async function getSettings() {
  return new Promise(resolve => chrome.storage.local.get(['apiUrl', 'apiKey', 'model'], resolve));
}

// ── 统一请求层 ────────────────────────────────
// 从 generate() 中提出来，供「生成」与「结构化抽取」共用：
// 超时兜底、取消、错误翻译、截断重试都只有这一处实现，避免两套逻辑走偏。
// 地址补全用 common.js 的 resolveCompletionUrl，关闭思考用 common.js 的 applyThinkingOff。

async function requestCompletion({ settings, promptText, maxTokens, temperature, requestKey }) {
  const completionUrl = resolveCompletionUrl(settings.apiUrl);
  const controller = new AbortController();
  activeRequests[requestKey] = controller;

  // 超时兜底：模型长时间无响应时主动中断，避免界面永久转圈
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_TIMEOUT_MS);

  // 发一次请求，返回 choices[0]。放大 max_tokens 重试时复用同一套请求构造。
  const post = async (limit) => {
    const body = {
      model: settings.model || 'gpt-4.1-mini',
      messages: [{ role: 'user', content: promptText }]
    };
    if (limit) body.max_tokens = limit;
    if (temperature != null) body.temperature = temperature;
    applyThinkingOff(body, body.model);

    const response = await fetch(completionUrl, {
      method: 'POST', signal: controller.signal, redirect: 'error', referrer: 'no-referrer',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(describeHttpError(response.status, detail, settings.model));
    }

    const data = await response.json();
    return { first: data.choices?.[0], choiceCount: data.choices?.length };
  };

  try {
    let limit = maxTokens;
    let { first, choiceCount } = await post(limit);
    let content = first?.message?.content;
    let reasoning = first?.message?.reasoning_content;

    // 空正文 + 被截断：几乎可以确定是思考过程把配额吃光了。
    // 自动放大上限再试一次，而不是把 max_tokens 这个概念甩给用户 —— 设置页里根本没这个入口。
    if (!content && !reasoning && first?.finish_reason === 'length') {
      const bigger = Math.max((limit || 3000) * 2, 8000);
      console.warn('输出被截断且无正文，自动放大上限重试', {
        model: settings.model, from: limit, to: bigger
      });
      const second = await post(bigger);
      first = second.first;
      choiceCount = second.choiceCount;
      content = first?.message?.content;
      reasoning = first?.message?.reasoning_content;
      limit = bigger;
    }

    if (!content) {
      console.error('API返回空内容', {
        model: settings.model,
        promptLen: promptText.length,
        reasoningPresent: !!reasoning,
        finish_reason: first?.finish_reason,
        choices: choiceCount,
        maxTokens: limit
      });
      if (reasoning) {
        throw new Error(
          `${settings.model} 开启了思考模式，${limit} tokens 的输出配额全被思考过程占用。`
          + '请到「设置」改用非思考模型（如 deepseek-chat、gpt-4.1-mini、qwen-plus）。'
        );
      }
      if (first?.finish_reason === 'length') {
        throw new Error(
          `${settings.model} 用完了 ${limit} tokens 却没输出正文（已自动放大上限重试过一次）。`
          + '请到「设置」改用非思考模型，或缩短简历内容。'
        );
      }
      throw new Error('AI返回内容为空：请确认模型名称正确、账号额度充足，或尝试更换模型。');
    }
    if (first?.finish_reason === 'length') {
      console.warn('输出被 max_tokens 截断', { model: settings.model, maxTokens: limit });
    }
    return content;
  } catch (error) {
    // 用户主动取消：原样抛出，交给上层静默处理
    if (error.name === 'AbortError') {
      if (timedOut) throw new Error(describeTimeoutError());
      throw error;
    }
    // 网络层 / 响应体异常：翻译成人话
    if (error instanceof TypeError || error.name === 'SyntaxError') {
      throw new Error(describeNetworkError(error));
    }
    throw error;
  } finally {
    clearTimeout(timeoutTimer);
  }
}

async function generate(mode) {
  if (!promptsReady) {
    try { await promptsLoaded; } catch (e) { console.error(e); }
  }
  if (!promptsReady) {
    const msg = '提示词加载失败，请重新加载扩展后重试。';
    if (mode === 'interview') $('status-message').textContent = msg;
    else $('resume-status').textContent = msg;
    return;
  }
  const job = jobInput.value.trim();

  // ── 校验：面试模式 ────────────────────────────

  if (mode === 'interview' && job.length < 20) {
    gotoMissingStep(false, '请先粘贴至少 20 个字的岗位职责或任职要求。');
    return;
  }

  // ── 校验：打招呼语 / 优化简历 ────────────────

  if ((mode === 'greeting' || mode === 'optimize') && (job.length < 20 || !hasResume())) {
    const missing = [];
    if (job.length < 20) missing.push('岗位描述');
    if (!hasResume()) missing.push('简历文件');
    // 岗位更靠前，先补岗位；岗位齐了才把用户指回简历那一步
    gotoMissingStep(job.length >= 20, `请先填写：${missing.join('、')}。`);
    return;
  }

  // ── 防重复提交保护 ────────────────────────
  if (generating[mode]) return;
  generating[mode] = true;
  let _btn = MODE_BTN[mode] ? $(MODE_BTN[mode]) : null;
  if (_btn) _btn.disabled = true;
  try {

  if (mode === 'interview') $('status-message').textContent = '正在整理岗位信息…';
  if (mode !== 'interview') $('resume-status').textContent = '正在生成…';
  $('empty-state').hidden = true;
  chrome.storage.session.set({ generationInProgress: true });

  if (mode === 'interview') {
    interviewContent.innerHTML = $('loading-template').innerHTML + $('loading-template').innerHTML;
    interviewResults.hidden = false;
  } else if (mode === 'greeting') {
    greetingContent.innerHTML = $('loading-template').innerHTML;
    greetingResults.hidden = false;
    document.querySelector('.copy-greeting').hidden = true;
    document.querySelector('.export-greeting').hidden = true;
  } else if (mode === 'optimize') {
    optimizeContent.innerHTML = $('loading-template').innerHTML;
    optimizeResults.hidden = false;
    document.querySelector('.copy-optimize').hidden = true;
    document.querySelector('.export-optimize').hidden = true;
  }

  const settings = await getSettings();
  const modelName = settings.apiUrl ? (settings.model || 'gpt-4.1-mini') : '本地演示逻辑';
  const progressZone = mode === 'interview' ? 'top' : 'resume';
  startGenerationProgress(modelName, progressZone, mode);

  if (!settings.apiUrl || !settings.apiKey) {
    if (mode === 'interview') {
      renderSections(fallback('interview', job), 'interview');
      $('status-message').textContent = '目前是演示内容。到"设置"连接 AI 服务后即可生成真实结果。';
    } else if (mode === 'greeting') {
      renderSections(fallback('greeting', job), 'greeting');
      $('resume-status').textContent = '目前是演示内容。到"设置"连接 AI 服务后即可生成真实结果。';
    } else if (mode === 'optimize') {
      renderSections(fallback('optimize', job), 'optimize');
      $('resume-status').textContent = '目前是演示内容。到"设置"连接 AI 服务后即可生成真实结果。';
    }
    stopGenerationProgress(mode);
    // 演示分支也要同步向导状态：否则步骤条与结果滚动会与实际产出不一致
    renderWizard();
    scrollToResults(mode);
    return;
  }

  // ── 构建 Prompt 列表（面试模式分两步）──────────

  let promptList = [];
  if (mode === 'interview') {
    let step1 = `${JD_ANALYSIS_PROMPT}\n\n用户输入岗位JD：\n${job}`;
    if (resumeText) {
      step1 += `\n\n用户已上传简历，请在标题中结合简历给出匹配度（例如"匹配度约70%"）。简历内容仅用于评估匹配度，不要写入输出正文。\n用户简历：\n${resumeText}`;
    } else {
      step1 += `\n\n用户未上传简历，标题不要输出匹配度或匹配分，只基于 JD 本身分析。`;
    }
    // 第1步：岗位分析；第2步在循环里拿到第1步结果后再拼装（见下方 loop）
    promptList.push({ text: step1, tokens: 2500, temperature: 0.3, isAnalysis: true });
    promptList.push({ text: '', tokens: 4000, temperature: 0.6 });
  } else if (mode === 'greeting') {
    promptList.push({ text: `${GREETING_PROMPT}\n\n【目标岗位名称】\n${job.slice(0, 60)}\n\n【岗位职责JD】\n${job}\n\n【用户简历】\n${resumeText}`, tokens: 800, temperature: 0.7 });
  } else if (mode === 'optimize') {
    promptList.push({ text: `${RESUME_OPTIMIZE_PROMPT}\n\n【目标岗位名称】\n${job.slice(0, 60)}\n\n【岗位职责JD】\n${job}\n\n【用户当前简历】\n${resumeText}`, tokens: 5000, temperature: 0.3 });
  }

  // ── API 请求 ──────────────────────────────────

  function parseSections(raw) {
    const text = raw.replace(/```[\s\S]*?```/g, '').trim();
    if (!text) throw new Error('AI返回为空，请重试');

    // 按 ## 标题分块（兼容有无换行前缀）
    const blocks = text.split(/\n(?=## )|(?<=.)(?=## )/);
    if (blocks.length === 1 && !text.startsWith('#')) {
      // 整个文本没有 ## 标题，作为单个板块
      const lines = text.split('\n').filter(Boolean);
      return [{ title: lines[0] || '分析结果', body: lines.slice(1).join('\n'), list: false, suggestion: false }];
    }

    const sections = [];
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const title = lines[0].replace(/^#{1,4}\s*/, '').trim();
      if (!title) continue;

      const bodyLines = lines.slice(1)
        .map(l => l.trim().replace(/^#{1,4}\s*/, ''))
        .filter(Boolean);
      const isList = bodyLines.length > 0 && bodyLines[0].startsWith('- ');

      sections.push({
        title: title,
        body: isList
          ? bodyLines.map(l => l.replace(/^-\s*/, ''))
          : bodyLines.join('\n'),
        list: isList,
        suggestion: ['建议补充', '推荐分析', '注意事项', '当前不足'].some(k => title.includes(k))
      });
    }

    if (sections.length === 0) throw new Error('未找到有效板块');
    return sections;
  }

  try {
    const allSections = [];
    let analysisRaw = '';
    for (const step of promptList) {
      let text = step.text;
      // 面试第2步：把第1步的岗位分析作为上下文喂进去，让准备方案真正"基于分析"
      if (mode === 'interview' && !step.isAnalysis && analysisRaw) {
        text = `${INTERVIEW_PREP_PROMPT}\n\n【岗位分析参考】\n${analysisRaw}\n\n用户输入岗位JD：\n${job}`;
      }
      const raw = await requestCompletion({
        settings, promptText: text, maxTokens: step.tokens,
        temperature: step.temperature, requestKey: mode
      });
      const sections = parseSections(raw);
      allSections.push(...sections);
      if (step.isAnalysis) analysisRaw = raw;
    }

    delete activeRequests[mode];
    chrome.storage.session.remove('generationInProgress');
    saveResults(mode, allSections);
    if (mode === 'interview') {
      renderSections(allSections, 'interview');
      $('status-message').textContent = '已生成。建议逐条核对真实经历再使用。';
    } else if (mode === 'greeting') {
      renderSections(allSections, 'greeting');
      $('resume-status').textContent = '已生成。';
    } else if (mode === 'optimize') {
      renderSections(allSections, 'optimize');
      $('resume-status').textContent = '已生成。建议逐条核对真实经历再使用。';
    }
    stopGenerationProgress(mode);
    renderWizard();
    scrollToResults(mode);
  } catch (error) {
    delete activeRequests[mode];
    chrome.storage.session.remove('generationInProgress');
    if (error.name === 'AbortError') return;

    // 错误消息已在 common.js 中翻译为「发生了什么 + 该怎么办」，此处直接呈现，不再叠加笼统建议
    const errorInfo = [{ title: '生成失败', body: error.message, list: false, suggestion: false }];

    if (mode === 'interview') {
      renderSections(errorInfo, 'interview');
      $('status-message').textContent = '生成失败，请检查设置后重试。';
    } else if (mode === 'greeting') {
      renderSections(errorInfo, 'greeting');
      $('resume-status').textContent = '生成失败，请检查设置后重试。';
    } else if (mode === 'optimize') {
      renderSections(errorInfo, 'optimize');
      $('resume-status').textContent = '生成失败，请检查设置后重试。';
    }
    stopGenerationProgress(mode);
  }
  } finally {
    generating[mode] = false;
    if (_btn) _btn.disabled = false;
  }
}

// ── 结果折叠/展开 & 单板块复制 ─────────────────

document.addEventListener('click', async (e) => {
  // 单板块复制
  const copyBtn = e.target.closest('.copy-section');
  if (copyBtn) {
    e.stopPropagation();
    const section = copyBtn.closest('.result-section');
    const title = section.querySelector('h3').textContent;
    const body = section.querySelector('p, ul');
    const text = body ? `${title}\n${body.textContent}` : title;
    await navigator.clipboard.writeText(text);
    copyBtn.classList.add('copied');
    setTimeout(() => copyBtn.classList.remove('copied'), 1200);
    return;
  }
  // 折叠/展开
  const section = e.target.closest('.result-section');
  if (!section) return;
  if (e.target.closest('.result-section h3')) {
    section.classList.toggle('collapsed');
  }
});

// ── 事件绑定 ──────────────────────────────────

$('analyze-button').addEventListener('click', () => generate('interview'));
$('greeting-button').addEventListener('click', () => generate('greeting'));
$('resume-button').addEventListener('click', () => generate('optimize'));
$('autofill-button').addEventListener('click', openAutofill);

// 网申预填面板
$('autofill-rescan').addEventListener('click', openAutofill);
$('autofill-confirm').addEventListener('click', () => confirmAutofill());
$('autofill-clear').addEventListener('click', () => clearAutofillMarks());
$('autofill-detail').addEventListener('click', () => copyAutofillDiagnostics());
$('autofill-overwrite').addEventListener('change', rebuildAutofillPlan);
$('autofill-sensitive').addEventListener('change', rebuildAutofillPlan);

document.querySelector('.copy-interview').addEventListener('click', async () => {
  await navigator.clipboard.writeText(interviewPlainText);
  const btn = document.querySelector('.copy-interview');
  btn.textContent = '已复制';
  setTimeout(() => btn.textContent = '复制全部', 1500);
});

document.querySelector('.copy-greeting').addEventListener('click', async () => {
  await navigator.clipboard.writeText(greetingPlainText);
  const btn = document.querySelector('.copy-greeting');
  btn.textContent = '已复制';
  setTimeout(() => btn.textContent = '复制全部', 1500);
});

document.querySelector('.copy-optimize').addEventListener('click', async () => {
  await navigator.clipboard.writeText(optimizePlainText);
  const btn = document.querySelector('.copy-optimize');
  btn.textContent = '已复制';
  setTimeout(() => btn.textContent = '复制全部', 1500);
});

document.querySelector('.export-interview').addEventListener('click', () => exportWithFeedback('interview'));
document.querySelector('.export-greeting').addEventListener('click', () => exportWithFeedback('greeting'));
document.querySelector('.export-optimize').addEventListener('click', () => exportWithFeedback('optimize'));

// ── 向导事件绑定 ──────────────────────────────

document.querySelectorAll('.step-chip').forEach(chip => {
  chip.addEventListener('click', () => setStep(chip.dataset.step));
});

$('skip-resume').addEventListener('click', () => {
  wizard.skippedResume = true;
  setStep('job', jobInput);
});

$('step-resume-next').addEventListener('click', () => {
  if (!hasResume()) wizard.skippedResume = true;
  setStep('job', jobInput);
});

$('step-resume-edit').addEventListener('click', () => setStep('resume'));
$('step-job-back').addEventListener('click', () => setStep('resume'));
$('step-job-next').addEventListener('click', () => setStep('output'));
$('step-job-edit').addEventListener('click', () => setStep('job', jobInput));

// 首屏：把初始步骤状态刷到 DOM 上（loadMemory 是异步的，这里保证不依赖它）
renderWizard();

// 首屏检查当前标签页是否可预填（只读 URL，不注入任何脚本）
refreshAutofillAvailability().catch(() => {});

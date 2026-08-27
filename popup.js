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
    savedResumeFileName: $('file-label').textContent !== '上传简历' ? $('file-label').textContent : ''
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
  chrome.storage.session.get(['savedJob', 'savedResumeText', 'savedResumeFileName', 'generationInProgress', 'savedResults'], (data) => {
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
    if (data.generationInProgress) {
      $('status-message').textContent = '上次生成被中断（关闭侧边栏会导致生成中断），内容已恢复，请重新生成。';
      chrome.storage.session.remove('generationInProgress');
    }
    if (data.savedResults) {
      if (data.savedResults.interview) renderSections(data.savedResults.interview, 'interview');
      if (data.savedResults.greeting) renderSections(data.savedResults.greeting, 'greeting');
      if (data.savedResults.optimize) renderSections(data.savedResults.optimize, 'optimize');
    }
  });
}

loadMemory();

// ── 岗位描述 ──────────────────────────────────

function updateJobControls() {
  $('word-count').textContent = `${jobInput.value.length} / 12000`;
  $('clear-job').hidden = !jobInput.value.length;
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

async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument(buf).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
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
      resumeText = await file.text();
    } else if (/\.pdf$/i.test(file.name)) {
      resumeText = await extractPdfText(file);
    } else if (/\.docx$/i.test(file.name)) {
      const buf = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer: buf });
      resumeText = result.value;
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
  } catch (e) {
    resumeText = `[用户上传了 ${file.name}，但无法解析内容：${e.message}]`;
    $('file-note').textContent = '文件解析失败，请尝试粘贴简历文本或上传 TXT 格式。';
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
});

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

function getCompletionUrl(input) {
  const base = input.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  if (/api\.openai\.com$/i.test(base)) return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
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
    $('status-message').textContent = '请先粘贴至少 20 个字的岗位职责或任职要求。';
    jobInput.focus();
    return;
  }

  // ── 校验：打招呼语 / 优化简历 ────────────────

  if ((mode === 'greeting' || mode === 'optimize') && (job.length < 20 || !resumeText)) {
    const missing = [];
    if (job.length < 20) missing.push('岗位职责');
    if (!resumeText) missing.push('简历文件');
    $('resume-status').textContent = `请先填写：${missing.join('、')}。`;
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

  async function callApi(promptText, maxTokens, temperature) {
    const completionUrl = getCompletionUrl(settings.apiUrl);
    const controller = new AbortController();
    activeRequests[mode] = controller;
    const body = { model: settings.model || 'gpt-4.1-mini', messages: [{ role: 'user', content: promptText }] };
    if (maxTokens) body.max_tokens = maxTokens;
    if (temperature != null) body.temperature = temperature;
    if (/deepseek/i.test(body.model)) body.thinking = { type: 'disabled' };

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
    const first = data.choices?.[0];
    const content = first?.message?.content;
    if (!content) {
      const reasoning = first?.message?.reasoning_content;
      console.error('API返回空内容', {
        model: settings.model,
        promptLen: promptText.length,
        reasoningPresent: !!reasoning,
        finish_reason: first?.finish_reason,
        choices: data.choices?.length
      });
      if (reasoning) {
        throw new Error(`AI返回内容为空：${settings.model} 开启了思考模式，输出配额全被思考过程占用。请在模型文档中关闭思考模式，或更换为非思考模型。`);
      }
      throw new Error('AI返回内容为空，请检查模型名称是否正确，或尝试更换模型');
    }
    return content;
  }

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
      const raw = await callApi(text, step.tokens, step.temperature);
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
  } catch (error) {
    delete activeRequests[mode];
    chrome.storage.session.remove('generationInProgress');
    if (error.name === 'AbortError') return;

    const errorInfo = [{ title: '生成失败', body: `调用AI服务时出错：${error.message}。请检查接口地址、API Key 和模型名称是否正确，或者稍后重试。`, list: false, suggestion: false }];

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

// ── 顶部标签切换（岗位分析 / 简历工具）──────────

(function initTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const panels = { analysis: $('tab-analysis'), resume: $('tab-resume') };
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      tabs.forEach(t => {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      Object.keys(panels).forEach(k => { panels[k].hidden = (k !== name); });
    });
  });
})();

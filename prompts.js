// ── Prompt 加载器 ──────────────────────────────
// 提示词存放在 prompts/*.md，便于跨设备维护。
// 用 fetch + cache:'no-cache' 异步加载（替代已废弃的同步 XHR）。

let JD_ANALYSIS_PROMPT = '';
let INTERVIEW_PREP_PROMPT = '';
let RESUME_OPTIMIZE_PROMPT = '';
let GREETING_PROMPT = '';
let RESUME_EXTRACT_PROMPT = '';
let FORM_MAP_PROMPT = '';
let promptsReady = false;

async function loadPrompt(path) {
  const res = await fetch(chrome.runtime.getURL(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error('Prompt 加载失败：' + path + ' (' + res.status + ')');
  return await res.text();
}

const promptsLoaded = (async () => {
  try {
    const [jd, prep, opt, greet, extract, formMap] = await Promise.all([
      loadPrompt('prompts/jd-analysis.md'),
      loadPrompt('prompts/interview-prep.md'),
      loadPrompt('prompts/resume-optimize.md'),
      loadPrompt('prompts/greeting.md'),
      loadPrompt('prompts/resume-extract.md'),
      loadPrompt('prompts/form-map.md'),
    ]);
    JD_ANALYSIS_PROMPT = jd;
    INTERVIEW_PREP_PROMPT = prep;
    RESUME_OPTIMIZE_PROMPT = opt;
    GREETING_PROMPT = greet;
    RESUME_EXTRACT_PROMPT = extract;
    FORM_MAP_PROMPT = formMap;
    promptsReady = true;
  } catch (e) {
    console.error('提示词加载失败：', e);
  }
})();

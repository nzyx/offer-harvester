// ── JD 抓取：content script ───────────────────
//
// 依赖 jd-extract.js 中定义的算法函数（同一 isolated world 共享全局作用域，
// 因此在 manifest 的 js 数组里必须排在 jd-extract.js 之后）。
//
// 本脚本只在主 frame 注入（manifest 里 all_frames: false），
// 配合 popup 侧 sendMessage 的 { frameId: 0 }，无需再做 window.top 判断。
//
// 已知边界：JD 若被渲染在 iframe 内部（少数自建招聘站），主 frame 取不到。
// 这类页面会得到「没找到岗位描述」的提示并引导用户手动粘贴，不做无效重试。

(() => {
  const RELOAD_HINT = '请刷新网页后重试';

  // ── 等待 DOM 可用 ───────────────────────────
  // 脚本在 document_start 注入，若用户在页面加载中点击抓取，
  // 此时 body 可能只有部分内容。等待而非直接失败，避免误报「没找到」。

  function ensureDomReady() {
    if (document.readyState !== 'loading') return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(true);
      };
      document.addEventListener('DOMContentLoaded', done, { once: true });
      setTimeout(done, 3000);
    });
  }

  // ── 站点名 ────────────────────────────────────

  function readableSite() {
    try {
      const meta = document.querySelector('meta[property="og:site_name"], meta[name="application-name"]');
      const name = meta && meta.content ? String(meta.content).trim() : '';
      if (name && name.length <= 20) return name;
    } catch (e) {
      // 忽略：下面用域名兜底
    }
    try {
      return new URL(location.href).hostname.replace(/^www\./, '');
    } catch (e) {
      return '当前页面';
    }
  }

  // ── 主流程 ────────────────────────────────────

  async function grabJobText() {
    await ensureDomReady();

    if (!document.body) {
      return { ok: false, reason: 'no-content', detail: RELOAD_HINT };
    }

    const result = extractJobText(document);
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        score: result.score,
        length: result.length
      };
    }

    return {
      ok: true,
      text: result.text,
      score: result.score,
      length: result.length,
      site: readableSite(),
      url: location.href,
      title: document.title || ''
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 只接受本扩展自己发出的消息，理由同 form-fill-page.js：这个是页面文字的出口，
    // 一旦消息通道对外开放，任意网页都能借它读走当前页正文
    if (!sender || sender.id !== chrome.runtime.id) return;
    if (!message || message.type !== 'jd:grab') return;
    grabJobText()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, reason: 'error', detail: String((error && error.message) || error) });
      });
    // 异步响应：必须返回 true 保持消息通道开启
    return true;
  });
})();

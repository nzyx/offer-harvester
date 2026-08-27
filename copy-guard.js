(() => {
  let enabled = false;
  let styleNode = null;
  const originalHandlers = { copy: null, selectstart: null, contextmenu: null };

  // ── 阻止页面的复制拦截器 ────────────────────

  function stopPageBlocker(event) {
    if (enabled) event.stopImmediatePropagation();
  }

  // ── 应用/移除复制保护 ───────────────────────

  function apply(enabledNext) {
    enabled = enabledNext;
    document.documentElement.dataset.interviewCopyGuard = enabled ? 'on' : 'off';
    document.dispatchEvent(new CustomEvent('__interviewCopyGuard', {
      detail: { enabled }
    }));

    if (enabled) {
      if (!styleNode) {
        styleNode = document.createElement('style');
        styleNode.id = '__interview-helper-copy-guard';
        styleNode.textContent = [
          'html,body,*{',
          '  user-select:text!important;',
          '  -webkit-user-select:text!important;',
          '  -moz-user-select:text!important',
          '}'
        ].join('');
        (document.documentElement || document).appendChild(styleNode);
      }
      originalHandlers.copy = originalHandlers.copy ?? document.oncopy;
      originalHandlers.selectstart = originalHandlers.selectstart ?? document.onselectstart;
      originalHandlers.contextmenu = originalHandlers.contextmenu ?? document.oncontextmenu;
      document.oncopy = null;
      document.onselectstart = null;
      document.oncontextmenu = null;
    } else {
      styleNode?.remove();
      styleNode = null;
      document.oncopy = originalHandlers.copy;
      document.onselectstart = originalHandlers.selectstart;
      document.oncontextmenu = originalHandlers.contextmenu;
    }
  }

  // ── 拦截复制相关事件（捕获阶段）─────────────

  document.addEventListener('copy', stopPageBlocker, true);
  document.addEventListener('cut', stopPageBlocker, true);
  document.addEventListener('selectstart', stopPageBlocker, true);
  document.addEventListener('contextmenu', stopPageBlocker, true);

  document.addEventListener('keydown', (event) => {
    if (
      enabled &&
      (event.ctrlKey || event.metaKey) &&
      ['c', 'x', 'a'].includes(event.key.toLowerCase())
    ) {
      event.stopImmediatePropagation();
    }
  }, true);

  // ── 监听后台消息 ────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'copyGuard:set') apply(message.enabled);
  });

  chrome.runtime.sendMessage({ type: 'copyGuard:ready' });
})();

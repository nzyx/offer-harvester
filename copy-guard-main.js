(() => {
  let enabled = document.documentElement?.dataset.interviewCopyGuard === 'on';
  const blockedEvents = new Set([
    'copy', 'cut', 'selectstart', 'contextmenu', 'dragstart'
  ]);
  const nativePreventDefault = Event.prototype.preventDefault;
  const returnValue = Object.getOwnPropertyDescriptor(Event.prototype, 'returnValue');

  // ── 判断是否应该放行该事件 ──────────────────

  function shouldAllow(event) {
    if (!enabled) return false;
    if (blockedEvents.has(event.type)) return true;
    return (
      event.type === 'keydown' &&
      (event.ctrlKey || event.metaKey) &&
      ['a', 'c', 'x'].includes(String(event.key).toLowerCase())
    );
  }

  // ── 拦截 preventDefault ─────────────────────

  Event.prototype.preventDefault = function () {
    if (shouldAllow(this)) return;
    return nativePreventDefault.call(this);
  };

  // ── 拦截 returnValue ────────────────────────

  if (returnValue?.get && returnValue?.set) {
    Object.defineProperty(Event.prototype, 'returnValue', {
      configurable: true,
      enumerable: returnValue.enumerable,
      get: returnValue.get,
      set(value) {
        if (value === false && shouldAllow(this)) return;
        return returnValue.set.call(this, value);
      }
    });
  }

  // ── 监听 ISOLATED 世界广播的状态变更 ────────

  document.addEventListener('__interviewCopyGuard', (event) => {
    enabled = Boolean(event.detail?.enabled);
  }, true);
})();

const $ = (id) => document.getElementById(id);

// 接口地址校验：仅允许 https，或本地 http（127.0.0.1 / localhost / 局域网）
function validateApiUrl(str) {
  let url;
  try { url = new URL(str); } catch { return { ok: false, reason: '接口地址格式不正确。' }; }
  const h = url.hostname;
  const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
    h.startsWith('192.168.') || h.startsWith('10.') || h.endsWith('.local');
  if (url.protocol === 'https:') return { ok: true };
  if (url.protocol === 'http:' && isLocal) return { ok: true };
  return { ok: false, reason: '接口地址必须使用 https（本地大模型可用 http://127.0.0.1）。' };
}

// ── 加载已保存的设置 ──────────────────────────

chrome.storage.local.get(['apiUrl', 'apiKey', 'model', 'enc'], (data) => {
  // 若此前遗留了加密数据但已无明文 Key，清理掉，避免卡在加密态
  if (data.enc && !data.apiKey) chrome.storage.local.remove('enc');
  $('api-url').value = data.apiUrl || '';
  $('api-key').value = data.apiKey || '';
  $('model').value = data.model || '';
});

// ── 预设地址切换 ──────────────────────────────

$('api-preset').addEventListener('change', () => {
  const v = $('api-preset').value;
  if (v) $('api-url').value = v;
});

// ── 保存设置 ──────────────────────────────────

$('save-settings').addEventListener('click', () => {
  const apiUrl = $('api-url').value.trim();
  if (!apiUrl) {
    $('settings-status').textContent = '请填写接口地址。';
    return;
  }
  const check = validateApiUrl(apiUrl);
  if (!check.ok) {
    $('settings-status').textContent = check.reason;
    return;
  }
  chrome.storage.local.remove('enc');
  chrome.storage.local.set({
    apiUrl,
    apiKey: $('api-key').value.trim(),
    model: $('model').value.trim()
  }, () => {
    $('settings-status').textContent = '已保存。关闭这个页面后即可在扩展中使用。';
  });
});

// ── 连接诊断 ──────────────────────────────────
// 不只报"成功/失败"，而是给出分类结论与下一步该做什么。

$('test-connection').addEventListener('click', async () => {
  const apiUrl = $('api-url').value.trim();
  const apiKey = $('api-key').value.trim();
  const model = $('model').value.trim() || 'gpt-4.1-mini';

  if (!apiUrl || !apiKey) {
    $('settings-status').textContent = '请先填写接口地址和 API Key。';
    return;
  }

  const check = validateApiUrl(apiUrl);
  if (!check.ok) {
    $('settings-status').textContent = check.reason;
    return;
  }

  const btn = $('test-connection');
  btn.textContent = '诊断中…';
  btn.disabled = true;
  $('settings-status').textContent = '正在诊断连接…';

  const url = resolveCompletionUrl(apiUrl);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_TIMEOUT_MS);

  // 诊断请求也要给足输出空间：推理模型的思考过程会占满配额，
  // 原先的 max_tokens: 5 会让这类模型必然返回空正文
  const testBody = { model: model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1024 };
  applyThinkingOff(testBody, model);

  try {
    const res = await fetch(url, {
      method: 'POST', signal: controller.signal, redirect: 'error', referrer: 'no-referrer',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(testBody)
    });

    if (!res.ok) {
      const detail = await res.text();
      $('settings-status').textContent = describeHttpError(res.status, detail, model);
      return;
    }

    // HTTP 200 不等于可用：思考型模型可能把输出配额全用在思考上，
    // 返回 200 但没有正文。这种情况必须在这里就报出来，
    // 否则用户会以为配置没问题，直到真正生成时才发现失败。
    const data = await res.json().catch(() => null);
    const first = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const content = first && first.message && first.message.content;
    if (!content) {
      const thinking = first && first.message && first.message.reasoning_content;
      $('settings-status').textContent = thinking
        ? `接口通、Key 有效，但模型「${model}」把输出配额全用在思考过程上了，正文为空。请改用非思考模型（如 deepseek-chat、gpt-4.1-mini、qwen-plus），否则生成与解析都会失败。`
        : `接口与 Key 都正常，但模型「${model}」没有返回正文。请确认模型名与服务商文档完全一致、账号额度充足，或更换模型。`;
      return;
    }
    $('settings-status').textContent = `连接正常：接口与模型「${model}」均可用，保存后即可在侧边栏使用。`;
  } catch (e) {
    $('settings-status').textContent = (e.name === 'AbortError' && timedOut)
      ? describeTimeoutError()
      : describeNetworkError(e);
  } finally {
    clearTimeout(timeoutTimer);
    btn.textContent = '连接诊断';
    btn.disabled = false;
  }
});

// ── 关闭页面 ──────────────────────────────────

$('close-options').addEventListener('click', () => {
  window.close();
});

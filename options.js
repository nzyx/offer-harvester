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

// ── 测试连接 ──────────────────────────────────

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

  $('test-connection').textContent = '测试中…';
  $('test-connection').disabled = true;
  $('settings-status').textContent = '正在测试连接…';

  const base = apiUrl.replace(/\/+$/, '');
  let url = base;
  if (/\/chat\/completions$/i.test(url)) { /* already full */ }
  else if (/\/v1$/i.test(url)) url = `${url}/chat/completions`;
  else if (/api\.openai\.com$/i.test(url)) url = `${url}/v1/chat/completions`;
  else url = `${url}/chat/completions`;

  const testBody = { model: model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 };
  if (/deepseek/i.test(model)) testBody.thinking = { type: 'disabled' };

  try {
    const res = await fetch(url, {
      method: 'POST', redirect: 'error', referrer: 'no-referrer',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(testBody)
    });

    if (res.ok) {
      $('settings-status').textContent = `连接成功！接口和模型 "${model}" 均可用。`;
    } else {
      const detail = await res.text();
      $('settings-status').textContent = describeHttpError(res.status, detail, model);
    }
  } catch (e) {
    $('settings-status').textContent = `连接失败：${e.message}`;
  }

  $('test-connection').textContent = '测试连接';
  $('test-connection').disabled = false;
});

// ── 关闭页面 ──────────────────────────────────

$('close-options').addEventListener('click', () => {
  window.close();
});

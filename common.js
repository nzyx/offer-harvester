// ── 公共错误诊断（popup 与 options 共用）────────
// 职责：把底层失败翻译成「发生了什么 + 你该做什么」。
// 用户不该只看到一句笼统的"生成失败"。

// 单次 AI 请求硬超时：模型长时间无响应时兜底，避免界面永久转圈
const API_TIMEOUT_MS = 90000;

// ── 关闭思考模式（popup 与 options 共用）──────────
//
// 结构化抽取、字段语义映射、连接诊断这类任务都不需要推理，
// 而推理模型的思考过程会占满 max_tokens 配额，导致正文一个字都出不来
// （表现为 finish_reason=length 且 content 为空）。
//
// 各服务商参数名不同，这里用严格白名单：给不支持的平台发未知参数会直接 400，
// 那比"思考吃光配额"更糟。不在白名单里的模型由 max_tokens 与自动重试兜底。

function applyThinkingOff(body, model) {
  const m = String(model || '').toLowerCase();
  if (!m) return;
  // 通义千问 / Qwen 系列（DashScope OpenAI 兼容模式的标准参数）
  if (/qwen|qwq|tongyi/.test(m)) {
    body.enable_thinking = false;
    return;
  }
  // DeepSeek / 智谱 GLM / 豆包 / 混元 等都认这个通用开关
  if (/deepseek|glm|doubao|seed|hunyuan/.test(m)) {
    body.thinking = { type: 'disabled' };
  }
}

// ── 接口地址补全 ──────────────────────────────
// 根地址 / 以 v1 结尾 / 完整 chat/completions 三种写法都能识别

function resolveCompletionUrl(input) {
  const base = (input || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  if (/api\.openai\.com$/i.test(base)) return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
}

// ── HTTP 状态码 → 人话 ────────────────────────

function describeHttpError(status, detail, model) {
  const raw = (detail || '').trim();
  const snippet = raw ? `（服务端返回：${raw.slice(0, 120)}）` : '';
  const lower = raw.toLowerCase();

  switch (status) {
    case 400:
      return lower.includes('model')
        ? `请求被拒（400）：服务端不识别模型「${model}」。请对照服务商文档，确认模型名完全一致。`
        : `请求被拒（400）：请求参数有误。请检查模型「${model}」与请求格式。${snippet}`;
    case 401:
      return '请求被拒（401）：API Key 无效或已失效。请重新复制 Key（注意不要带空格），并确认账号状态正常。';
    case 403:
      return `请求被拒（403）：Key 有效但没有权限。可能是该模型未开通、区域受限，或 Key 权限不足。${snippet}`;
    case 404:
      return '请求被拒（404）：接口地址不存在。请确认地址以 /v1 结尾，或直接填完整的 /v1/chat/completions。';
    case 408:
    case 504:
      return `请求超时（${status}）：服务端响应过慢。请稍后重试，或改用响应更快的模型。`;
    case 429:
      return lower.includes('quota')
        ? '额度已用尽（429）：这是计费问题，不是连接问题。请到服务商后台充值或提升配额。'
        : '触发限流（429）：请求过于频繁。等待约 1 分钟后重试即可。';
    case 500:
    case 502:
    case 503:
      return `AI 服务端故障（${status}）：不是你的配置问题。请稍后重试，持续失败可更换服务商。${snippet}`;
    default:
      return `请求被拒（${status}）：请检查接口地址、API Key 与模型名称。${snippet}`;
  }
}

// ── 超时 → 人话 ───────────────────────────────

function describeTimeoutError() {
  const seconds = Math.round(API_TIMEOUT_MS / 1000);
  return `请求超时（等待 ${seconds} 秒仍无响应）：模型可能负载过高、接口地址不通，或本地推理服务已停止。请稍后重试、更换模型，或确认本地服务仍在运行。`;
}

// ── 网络层异常 → 人话 ─────────────────────────

function describeNetworkError(error) {
  const message = error?.message || String(error);

  if (/failed to fetch|networkerror|network request failed|fetch failed/i.test(message)) {
    return '连不上接口：请检查网络是否正常、接口地址是否写错。若使用本地大模型，请确认推理服务（如 127.0.0.1:8080）已启动。';
  }
  if (/mixed content|insecure/i.test(message)) {
    return '请求被浏览器拦截：https 页面无法访问 http 接口。请改用 https 接口。';
  }
  if (error?.name === 'SyntaxError') {
    return '接口返回的不是有效 JSON：该地址可能指向了网页而不是 API。请检查接口地址是否填对。';
  }
  return `调用失败：${message}`;
}

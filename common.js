// ── 公共错误说明（popup 与 options 共用）────────
// 区分"连接不通"与"请求被服务商拒绝"，给用户可读信息。

function describeHttpError(status, detail, model) {
  const d = (detail || '').slice(0, 140);
  const tail = d ? `（${d}）` : '';
  switch (status) {
    case 400: return `请求被拒（400）：模型名或参数有误，请检查模型「${model}」。`;
    case 401: return `请求被拒（401）：API Key 无效或未授权，请检查 Key 是否正确。`;
    case 403: return `请求被拒（403）：无权限，可能是模型不可用、区域受限或 Key 权限不足。`;
    case 404: return `请求被拒（404）：接口地址不正确，请确认路径为 .../v1/chat/completions。`;
    case 429: return (detail || '').toLowerCase().includes('quota')
      ? `额度已用尽（429）：API 配额不足，请到服务商处充值或提升额度——这不是连接问题。`
      : `触发限流（429）：请求过于频繁，请稍后重试。`;
    default:  return `请求被拒（${status}）。${tail}`;
  }
}

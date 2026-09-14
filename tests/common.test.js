// common.js 纯函数验证：关闭思考模式的平台白名单、地址补全、错误翻译
// 用法：node tests/common.test.js
//
// 为什么单独测这个文件：它是 popup 与 options 共用的诊断层，
// 错误文案是用户唯一能看到的"为什么失败"，改坏了没人会发现。
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'common.js'), 'utf8');
const api = new Function(
  `${src};return { applyThinkingOff, resolveCompletionUrl, describeHttpError, describeTimeoutError, describeNetworkError, API_TIMEOUT_MS };`
)();

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}

console.log('=== 1. 关闭思考模式（平台白名单） ===');
// 结构化抽取、字段映射、连接诊断都不需要推理；而思考过程会占满 max_tokens，
// 导致 finish_reason=length 且正文为空。但给不支持的平台发未知参数会直接 400，
// 所以这里必须严格白名单 —— 两侧都要锁：该发的发、不该发的一个都不发。
const bodyOf = (model) => {
  const body = {};
  api.applyThinkingOff(body, model);
  return body;
};

check('DeepSeek 用 thinking 参数', JSON.stringify(bodyOf('deepseek-chat')) === '{"thinking":{"type":"disabled"}}', bodyOf('deepseek-chat'));
check('DeepSeek 大小写不敏感', bodyOf('DeepSeek-Reasoner').thinking?.type === 'disabled', bodyOf('DeepSeek-Reasoner'));
check('通义千问用 enable_thinking', bodyOf('qwen-plus').enable_thinking === false, bodyOf('qwen-plus'));
check('Qwen3 用 enable_thinking', bodyOf('qwen3-235b-a22b').enable_thinking === false);
check('qwq 用 enable_thinking', bodyOf('qwq-32b').enable_thinking === false);
// 关键：给通义发 thinking 而不是 enable_thinking 可能被拒，两者不能混
check('通义千问不发 thinking（参数名不同）', bodyOf('qwen-plus').thinking === undefined, bodyOf('qwen-plus'));
check('智谱 GLM 用 thinking 参数', bodyOf('glm-4.5').thinking?.type === 'disabled');
check('豆包用 thinking 参数', bodyOf('doubao-seed-1-6').thinking?.type === 'disabled');
check('混元用 thinking 参数', bodyOf('hunyuan-turbos-latest').thinking?.type === 'disabled');

// 不该发的绝对不能发 —— 未知参数会让服务端返回 400，比思考吃光配额更糟
check('GPT 不发任何思考参数', Object.keys(bodyOf('gpt-4.1-mini')).length === 0, bodyOf('gpt-4.1-mini'));
check('Claude 不发任何思考参数', Object.keys(bodyOf('claude-sonnet-4')).length === 0, bodyOf('claude-sonnet-4'));
check('Kimi 不发任何思考参数', Object.keys(bodyOf('kimi-k2-0711-preview')).length === 0, bodyOf('kimi-k2-0711-preview'));
check('本地模型不发任何思考参数', Object.keys(bodyOf('muse-glimmer-30b')).length === 0);
check('空模型名不报错也不发参数', Object.keys(bodyOf('')).length === 0);
check('undefined 模型名不报错', Object.keys(bodyOf(undefined)).length === 0);
check('不改动已有字段', (() => {
  const body = { model: 'qwen-plus', temperature: 0 };
  api.applyThinkingOff(body, body.model);
  return body.temperature === 0 && body.model === 'qwen-plus';
})());

console.log('\n=== 2. 接口地址补全 ===');
check('根地址补 chat/completions', api.resolveCompletionUrl('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/chat/completions');
check('完整地址原样保留', api.resolveCompletionUrl('https://x.com/v1/chat/completions') === 'https://x.com/v1/chat/completions');
check('尾部斜杠被剥掉', api.resolveCompletionUrl('https://x.com/v1/') === 'https://x.com/v1/chat/completions');
check('OpenAI 裸域名补 v1', api.resolveCompletionUrl('https://api.openai.com') === 'https://api.openai.com/v1/chat/completions');
check('本地地址补 chat/completions', api.resolveCompletionUrl('http://127.0.0.1:8080/v1') === 'http://127.0.0.1:8080/v1/chat/completions');
check('本地地址无 v1 也能用', api.resolveCompletionUrl('http://127.0.0.1:8080') === 'http://127.0.0.1:8080/chat/completions');

console.log('\n=== 3. HTTP 错误翻译（每种都要给出可执行的下一步） ===');
const h = (status, detail, model) => api.describeHttpError(status, detail, model || 'gpt-4.1-mini');

const err400model = h(400, '{"error":{"message":"The model `foo` does not exist"}}');
check('400 点名模型名时指向模型名问题', /模型名|模型名完全一致/.test(err400model), err400model);
check('400 模型分支带上用户填的模型名', err400model.includes('gpt-4.1-mini'), err400model);

const err400other = h(400, 'invalid temperature value');
check('400 非模型错时说明是参数问题', /参数|请求格式/.test(err400other), err400other);
check('400 带服务端返回片段', err400other.includes('invalid temperature'), err400other);

check('401 指出 Key 无效并可操作', /Key 无效|重新复制/.test(h(401)), h(401));
check('403 说明是权限而非 Key 无效', /权限/.test(h(403)), h(403));
check('404 指出地址问题并给出正确写法', /chat\/completions/.test(h(404)), h(404));
check('408 说明服务端慢', /服务端响应过慢|稍后重试/.test(h(408)), h(408));
check('504 与 408 同样处理', /超时/.test(h(504)), h(504));

const err429quota = h(429, 'insufficient quota');
check('429 含 quota 时判定为计费问题', /额度已用尽|计费/.test(err429quota), err429quota);
check('429 额度分支不误导为限流', !/请求过于频繁/.test(err429quota), err429quota);

const err429rate = h(429, 'rate limit exceeded');
check('429 不含 quota 时判定为限流', /限流|过于频繁/.test(err429rate), err429rate);

check('500 说明不是用户的配置问题', /不是你的配置问题/.test(h(500)), h(500));
check('503 与 500 同样处理', /服务端故障/.test(h(503)), h(503));
check('未知状态码有兜底文案', /请检查接口地址/.test(h(418)), h(418));
check('无 detail 时不崩且无空括号', h(500, '') && !h(500, '').includes('（）'), h(500, ''));

console.log('\n=== 4. 超时与网络错误 ===');
const timeoutMsg = api.describeTimeoutError();
check('超时文案含具体秒数', /\d+ 秒/.test(timeoutMsg), timeoutMsg);
check('超时秒数与 API_TIMEOUT_MS 一致', timeoutMsg.includes(String(Math.round(api.API_TIMEOUT_MS / 1000))), timeoutMsg);
check('超时文案提到本地推理服务（用户在用）', /本地/.test(timeoutMsg), timeoutMsg);

check('fetch 失败指向网络或地址', /网络|接口地址/.test(api.describeNetworkError(new Error('Failed to fetch'))), api.describeNetworkError(new Error('Failed to fetch')));
check('本地模型连不上时提醒启动服务', /推理服务|127\.0\.0\.1/.test(api.describeNetworkError(new Error('fetch failed'))));
check('混合内容拦截有专门文案', /https/.test(api.describeNetworkError(new Error('Mixed Content: blocked'))), api.describeNetworkError(new Error('Mixed Content: blocked')));
check('返回非 JSON 指向地址填错', /不是有效 JSON|地址/.test(api.describeNetworkError(Object.assign(new Error('bad'), { name: 'SyntaxError' }))));
check('未知错误兜底不崩', /调用失败/.test(api.describeNetworkError(new Error('怪错误'))), api.describeNetworkError(new Error('怪错误')));
check('null 错误不崩', typeof api.describeNetworkError(null) === 'string');

console.log(`\n──────── 结果：${pass} 通过 / ${fail} 失败 ────────`);
process.exit(fail ? 1 : 0);

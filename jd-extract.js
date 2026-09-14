// ── JD 正文提取（纯算法层）────────────────────
//
// 本文件被两处加载：
//   1. content script（isolated world）：与 jd-grab.js 共享全局作用域，直接调用下面的函数
//   2. tests/jd-extract.test.js：以 new Function 包裹后在 node 下执行
// 因此顶层只允许「函数 / 常量声明」，不得出现任何依赖 DOM 或产生副作用的语句。
//
// 正则一律不带 g / y 标志：带 g 的正则用于 .test() 会推进 lastIndex，
// 导致同一正则对相同输入交替返回真假，这类 bug 极难定位。需要计数时统一用 countMatches。

const JD_MIN_TEXT = 60;          // 低于此长度不可能是岗位描述
const JD_MAX_CANDIDATES = 240;   // 候选上限：innerText 会触发排版计算，必须限量

// ── 关键词表（用 includes 匹配，不做正则）──────

const JD_KW_DUTY = [
  '岗位职责', '工作职责', '职位描述', '岗位描述', '工作内容', '职责描述',
  '主要职责', '你将负责', '你要做的事', '工作范围', '岗位内容', '岗位介绍'
];

const JD_KW_REQUIRE = [
  '任职要求', '任职资格', '岗位要求', '职位要求', '招聘要求', '任职条件',
  '我们希望你', '我们希望你有', '你需要具备', '能力要求', '基本要求', '加分项', '优先考虑'
];

const JD_KW_BENEFIT = [
  '薪资', '薪酬', '待遇', '福利', '五险一金', '六险一金', '公积金', '双休',
  '带薪年假', '年终奖', '绩效奖金', '期权', '股权', '补贴', '弹性工作'
];

const JD_KW_EDU = [
  '学历', '本科', '硕士', '大专', '专科', '专业', '工作经验', '技能', '熟练', '掌握'
];

// ── 语义 / 噪音信号（针对元素的 class、id、标签名）──

const JD_SEMANTIC_RE = /job|position|post|vacancy|recruit|desc|detail|duty|require|responsib|content|article|main|text|info/i;
const JD_NOISE_RE = /nav|menu|header|footer|sidebar|comment|recommend|related|crumb|toolbar|search|login|banner|advert|copyright/i;

// ── 噪音行 ────────────────────────────────────

const JD_NOISE_MAX_LEN = 13;

const JD_NOISE_WORDS = [
  '首页', '登录', '注册', '登录/注册', '免费注册',
  '返回顶部', '回到顶部', '分享', '收藏', '分享职位', '收藏职位', '举报', '举报该职位',
  '投递简历', '立即沟通', '立即投递', '立即申请', '申请职位', '马上申请', '一键投递', '在线沟通',
  '查看更多', '展开', '收起', '展开全部', '查看全部', '显示全部',
  '上一页', '下一页', '上一条', '下一条', '上一职位', '下一职位',
  '相关推荐', '热门职位', '相似职位', '猜你喜欢', '为您推荐', '推荐职位',
  '公司简介', '公司信息', '工商信息', '查看工商信息', '招聘方', '查看联系方式',
  '下载APP', '下载App', '关注我们', '意见反馈', '帮助中心', '联系我们',
  '隐私政策', '用户协议', '服务条款', '营业执照', '人力资源服务许可证',
  '微信扫一扫', '扫码查看', '复制链接', '点击复制', '不感兴趣', '已投递',
  '求职安全提示', '谨防诈骗', '安全提示', '职位发布者', '我要举报', '面试评价'
];

const JD_NOISE_WORD_RE = new RegExp('^(?:' + JD_NOISE_WORDS.join('|') + ')$');

const JD_SYMBOL_LINE_RE = /^[\d\s.、·•・\-—_|/\\()（）[\]【】<>《》,，;；:：!！?？*#+~^]+$/;

const JD_LICENSE_LINE_RE = /^(?:©|\(c\)|版权|copyright|[\u4e00-\u9fff]{0,2}ICP备|[\u4e00-\u9fff]{0,2}公网安备|增值电信业务经营许可证|人力资源服务许可证|营业执照)/i;

const JD_CRUMB_LINE_RE = /^(?:首页|主页|职位|职位搜索|您所在的位置)\s*[>›»→/]/;

// ── 关键词计数 ────────────────────────────────

function countKeyword(text, words) {
  let n = 0;
  for (let i = 0; i < words.length; i++) {
    if (text.indexOf(words[i]) !== -1) n++;
  }
  return n;
}

// 每次新建带 g 的正则再统计，避免共享正则的 lastIndex 残留
function countMatches(str, re) {
  if (!str) return 0;
  const flags = re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags;
  const global = new RegExp(re.source, flags);
  const found = str.match(global);
  return found ? found.length : 0;
}

function countParagraphs(text) {
  const lines = String(text).split('\n');
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length >= 12) n++;
  }
  return n;
}

// ── 打分：纯函数，只依赖传入的特征对象 ─────────
//
// features = {
//   text          : 元素的可见文本（innerText）
//   tag / id / className : 元素的语义元信息
//   linkTextLen   : 子孙 <a> 的文本总长度
//   elementCount  : 子孙元素数量
// }

function scoreJdCandidate(f, opts) {
  if (!f) return -9999;
  const relaxed = Boolean(opts && opts.relaxed);
  const text = typeof f.text === 'string' ? f.text : '';
  const len = text.length;

  // 太短的不可能是 JD，直接淘汰而不是给低分，
  // 否则大量碎块会互相竞争把真正的容器比下去
  if (len < JD_MIN_TEXT) return -9999;

  let score = 0;

  // 1) 长度：接近完整 JD 最优；整页（超长）递减，因为它必然混入导航与推荐位
  if (len <= 4000) {
    score += Math.min(len, 2500) / 100;
  } else {
    score += Math.max(25 - (len - 4000) / 400, 4);
  }

  // 2) 关键词：最强的语义信号
  score += Math.min(countKeyword(text, JD_KW_DUTY), 2) * 9;
  score += Math.min(countKeyword(text, JD_KW_REQUIRE), 2) * 9;
  score += Math.min(countKeyword(text, JD_KW_BENEFIT), 2) * 3;
  score += Math.min(countKeyword(text, JD_KW_EDU), 2) * 2;

  // 3) 链接密度：导航栏、职位列表、推荐位的最典型特征
  const linkLen = Math.max(Number(f.linkTextLen) || 0, 0);
  const linkDensity = len ? Math.min(linkLen / len, 1) : 1;
  if (linkDensity > 0.3) score -= 22;
  else if (linkDensity > 0.15) score -= 12;
  else if (linkDensity < 0.05) score += 4;

  // 4) 段落结构：JD 天然是多行多段的
  score += Math.min(countParagraphs(text), 8);

  // 5) 元素语义：class / id / 标签名里的线索
  const meta = (f.id || '') + ' ' + (f.className || '') + ' ' + (f.tag || '');
  score += Math.min(countMatches(meta, JD_SEMANTIC_RE), 3) * 7;
  score -= Math.min(countMatches(meta, JD_NOISE_RE), 2) * 12;

  // 6) 文本密度：正文容器每个元素承载的文字明显多于列表区
  const elementCount = Math.max(Number(f.elementCount) || 0, 1);
  const density = len / elementCount;
  if (density < 3) score -= 6;
  if (density > 30) score += 5;

  // 7) 结构惩罚：body 这类页面级容器文本天然最长，会靠长度优势压过真正的 JD 容器，
  //    结果把导航、页脚、推荐位一起抓进来。给一个温和的惩罚让精确容器胜出。
  //    注意惩罚值刻意小于「JD 容器与 body 的典型分差」，否则整页就是唯一内容来源时
  //    会全部落选——那种情况由 extractJobText 的豁免重试兜底。
  if (!relaxed) {
    if (f.tag === 'body') score -= 12;
    else if (f.tag === 'main' || f.tag === 'html') score -= 3;
  }

  return Math.round(score * 10) / 10;
}

// ── 选最优候选 ────────────────────────────────

function pickBestCandidate(candidates, opts) {
  const list = candidates || [];
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const score = typeof item.score === 'number' ? item.score : scoreJdCandidate(item, opts);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return { candidate: best, score: bestScore === -Infinity ? -9999 : bestScore };
}

// ── 文本清洗 ──────────────────────────────────

function isNoiseLine(line) {
  const t = String(line).trim();
  if (!t) return true;
  if (JD_SYMBOL_LINE_RE.test(t)) return true;
  if (JD_LICENSE_LINE_RE.test(t)) return true;
  if (JD_CRUMB_LINE_RE.test(t)) return true;
  // 短行才按噪音词处理：正文里出现「立即沟通」这类词属于正常表述，不能误删
  if (t.length <= JD_NOISE_MAX_LEN && JD_NOISE_WORD_RE.test(t)) return true;
  return false;
}

function cleanJobText(raw) {
  if (!raw) return '';
  const text = String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u3000]/g, ' ');

  const lines = text.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s+/, '').replace(/\s+$/, '');
    if (!line) {
      // 空行合并：最多保留一个，且不放在开头
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (isNoiseLine(line)) continue;
    // 部分站点会重复渲染同一块内容
    if (out.length && out[out.length - 1] === line) continue;
    out.push(line);
  }

  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

// ── DOM 层：把元素转成打分所需的特征 ───────────

function normalizeClassName(el) {
  const c = el && el.className;
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (typeof c.baseVal === 'string') return c.baseVal;  // SVG 元素
  return String(c);
}

function readElementText(el) {
  let text = '';
  try {
    if (typeof el.innerText === 'string') text = el.innerText;
  } catch (e) {
    text = '';
  }
  // 元素未渲染（或环境不支持 innerText）时退回 textContent
  if (!text) {
    try { text = el.textContent || ''; } catch (e) { text = ''; }
  }
  return String(text).trim();
}

function elementCountOf(el) {
  if (typeof el.querySelectorAll !== 'function') return 1;
  try {
    return Math.min(el.querySelectorAll('*').length, 8000);
  } catch (e) {
    return 1;
  }
}

function linkTextLength(el) {
  if (typeof el.querySelectorAll !== 'function') return 0;
  let n = 0;
  try {
    const links = el.querySelectorAll('a');
    const cap = Math.min(links.length, 200);
    for (let i = 0; i < cap; i++) {
      n += String(links[i].textContent || '').trim().length;
    }
  } catch (e) {
    return 0;
  }
  return n;
}

function buildCandidateFeatures(el) {
  if (!el) return null;
  const text = readElementText(el);
  if (!text) return null;
  return {
    el: el,
    text: text,
    tag: String(el.tagName || '').toLowerCase(),
    id: String(el.id || ''),
    className: normalizeClassName(el),
    linkTextLen: linkTextLength(el),
    elementCount: elementCountOf(el)
  };
}

// ── 候选收集 ──────────────────────────────────
//
// 两级策略：
//   1) 语义选择器命中 job / detail / require 等类名的块（准确率高）
//   2) 兜底：scope 自身、scope 的直接子块、body 与 body 的直接子块
// 第 2 级保证「即使站点类名完全不含语义词，只要 JD 在某个顶层块里就仍能抓到」，
// 因此第 1 级的选择器写漏了也不会导致整页抓取失败——只是准确率下降。

const JD_CONTAINER_SELECTOR = [
  '[class*="job-detail"]', '[class*="jobDetail"]', '[class*="jobDescription"]',
  '[class*="job-desc"]', '[class*="jobDesc"]', '[class*="job-info"]', '[class*="jobInfo"]',
  '[class*="job-require"]', '[class*="jobRequire"]', '[class*="job-content"]',
  '[class*="position-detail"]', '[class*="positionDetail"]', '[class*="pos-detail"]',
  '[class*="position-desc"]', '[class*="vacancy"]', '[class*="recruit"]',
  '[class*="description"]', '[class*="describe"]', '[class*="duty"]',
  '[class*="require"]', '[class*="responsibilit"]', '[class*="detail-content"]',
  '[class*="post-content"]', '[id*="job-detail"]', '[id*="jobDetail"]', '[id*="job-desc"]',
  '[id*="jobDesc"]', '[id*="jobContent"]', '[id*="position-detail"]',
  'article', '[class*="content"]', '[class*="detail"]', '[class*="text"]'
].join(',');

function collectJdCandidates(root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.body) return [];

  let scope = doc.body;
  try {
    scope = doc.querySelector('main, article, [role="main"], #main, .main, #content') || doc.body;
  } catch (e) {
    scope = doc.body;
  }

  const picked = [];
  const seen = [];

  function push(el) {
    if (!el || seen.indexOf(el) !== -1) return;
    seen.push(el);
    picked.push(el);
  }

  // 1) 语义容器
  if (typeof scope.querySelectorAll === 'function') {
    try {
      const nodes = scope.querySelectorAll(JD_CONTAINER_SELECTOR);
      const limit = Math.min(nodes.length, JD_MAX_CANDIDATES);
      for (let i = 0; i < limit; i++) push(nodes[i]);
    } catch (e) {
      // 选择器在异常环境下失败时不应中断流程，兜底候选仍然可用
    }
  }

  // 2) 兜底候选
  push(scope);
  const children = scope.children || [];
  const childLimit = Math.min(children.length, 60);
  for (let i = 0; i < childLimit; i++) push(children[i]);

  if (scope !== doc.body) {
    push(doc.body);
    const bodyChildren = doc.body.children || [];
    const bodyLimit = Math.min(bodyChildren.length, 60);
    for (let i = 0; i < bodyLimit; i++) push(bodyChildren[i]);
  }

  // 3) 采集特征（innerText 触发排版计算，故在此处集中且限量）
  const out = [];
  const cap = Math.min(picked.length, JD_MAX_CANDIDATES + 130);
  for (let i = 0; i < cap; i++) {
    const features = buildCandidateFeatures(picked[i]);
    if (features) out.push(features);
  }
  return out;
}

// ── 端到端：从文档取出清洗后的 JD 文本 ─────────

function extractJobText(doc) {
  const candidates = collectJdCandidates(doc);
  let best = pickBestCandidate(candidates);

  if (!best.candidate || best.score < JD_SCORE_THRESHOLD) {
    // 豁免重试：去掉结构惩罚再判一次。
    // 适用场景是「整页就是一个 JD」的简单页面——此时 body 是唯一的正文来源，
    // 若因惩罚落选就会误报「没找到岗位描述」，这属于明显的误判。
    const relaxed = pickBestCandidate(candidates, { relaxed: true });
    if (relaxed.candidate && relaxed.score >= JD_SCORE_THRESHOLD) {
      best = relaxed;
    } else {
      return { ok: false, reason: 'no-content', score: best.score };
    }
  }

  const text = cleanJobText(best.candidate.text);
  if (text.length < JD_MIN_TEXT) {
    return { ok: false, reason: 'too-short', score: best.score, length: text.length };
  }
  return { ok: true, text: text, score: best.score, length: text.length };
}

// 判定阈值：典型 JD 容器得分在 50 以上，导航 / 推荐位为负分，
// 25 分能挡住「没有语义类名但结构干净的正文块」与「列表页」之间的边界
const JD_SCORE_THRESHOLD = 25;

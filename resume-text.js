// ── 简历文本重建（纯算法层）────────────────────
//
// 职责：把 PDF/DOCX 解析出来的碎片还原成「有行结构、可直接喂给提取器」的文本。
//
// 为什么必须独立成一层：
//   pdf.js 只给每个文本片段的坐标，不提供「行」也不提供「段落」的概念。
//   图省事把所有片段 join(' ') 会把**整页压成一行**，行结构彻底丢失——
//   后续所有按行处理的逻辑（本地规则、AI 提示词）同时失效。
//   实测后果：「专业」字段被填成「手机号码」这种错位，项目经历整段消失。
//
// 本文件不含 DOM，可在 node 下直接加载做单元验证。

// 同一视觉行的 y 容差。PDF 里同一行的片段 y 值可能差零点几像素
const PDF_LINE_TOLERANCE = 3;

// 行内两个片段紧邻到此距离以内，说明是同一词的连续字，不要插空格。
// 空格是字段之间的断词依据：少了它「姓名：刘子涵居住地：深圳」会被读成一个名字
const PDF_TIGHT_GAP = 1.5;

// 续行判定：行距不超过「正常行距」的这个倍数
const PDF_CONTINUE_RATIO = 1.15;

// 续行判定：上一行的右边界要达到页面内容宽度的这个比例，才算「被排满而换行」。
// 这是区分「同一段落的续行」和「上下相邻的两个独立条目」的关键信号 ——
// 独立条目通常写不满一行，只有长句才会被排满后换行。
// 少了这一条，连续几行同缩进的短条目会被错误地合并成一整行。
const PDF_FILL_RATIO = 0.9;

// 续行判定的缩进容差
const PDF_INDENT_TOLERANCE = 3;

// 上一行以这些标点结尾，说明是完整句子/条目，下一行是新条目而非续行
const PDF_SENTENCE_END_RE = /[。！？；!?;：:]$/;

// 下一行以「字段名：」开头时，它是新字段而不是上一行的续行。
// 少了这条判断，「GPA：3.7（专业前20%）」会把下一行的「主修课程：…」一起吞掉，
// 因为上一行以右括号结尾，而右括号不属于句末标点。
const PDF_FIELD_LABEL_RE = /^[\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z\s/]{0,10}[:：]/;

// 以日期范围开头的是「经历条目头」（如「2026.06-2026.8 某某公司 实习生」）。
// 条目头后面跟的第一行是描述的开始，不是它的延续 —— 合并会让项目名把描述首句也吞进去。
// 月份放宽到 3 位：真实简历里「2025.012-2026.03」这种笔误很常见。
const PDF_ITEM_HEAD_RE = /^\s*(?:19|20)\d{2}\s*[.\-/年]?\s*\d{0,3}\s*[-–—~至到]+/;

// 行内任意位置出现日期范围的判定。下一行如果含日期范围，说明它是新的一条经历，
// 绝不能粘在上一行（章节标题）后面 —— 紧凑排版时行距与缩进都相同，光靠行距区分不了
const PDF_CONTAINS_DATE_RANGE_RE = /(?:19|20)\d{2}\s*[.\-/年]?\s*\d{0,3}\s*[-–—~至到]+\s*(?:19|20)\d{2}/;

// 判断续行拼接时是否需要补空格：上一行以 ASCII 字母数字结尾、
// 下一行以 ASCII 字母数字开头时，原排版中间应当有一个空格（英文换行处）
function needsSpaceWhenJoined(prevText, nextText) {
  return /[A-Za-z0-9]$/.test(prevText) && /^[A-Za-z0-9]/.test(nextText);
}

// 把所有片段按 y 聚类成行，行内按 x 排序并用空格分隔
function groupPdfRows(items) {
  const pieces = [];
  for (const item of items || []) {
    const text = String(item && item.str != null ? item.str : '');
    if (!text.trim()) continue;
    const transform = (item && item.transform) || [0, 0, 0, 0, 0, 0];
    pieces.push({
      x: Number(transform[4]) || 0,
      y: Number(transform[5]) || 0,
      width: Number(item.width) || 0,
      text
    });
  }
  if (!pieces.length) return [];

  // PDF 坐标原点在左下角，y 越大越靠上 → y 降序即从上到下
  pieces.sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  let current = null;
  for (const piece of pieces) {
    if (!current || Math.abs(current.y - piece.y) > PDF_LINE_TOLERANCE) {
      current = { y: piece.y, pieces: [piece] };
      rows.push(current);
    } else {
      current.pieces.push(piece);
    }
  }

  return rows.map(row => {
    row.pieces.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    let x = null;
    for (const piece of row.pieces) {
      if (x === null) x = piece.x;
      if (prevEnd !== null && piece.x - prevEnd >= PDF_TIGHT_GAP) text += ' ';
      text += piece.text;
      prevEnd = piece.x + piece.width;
    }
    return {
      x: x === null ? 0 : x,
      y: row.y,
      // 右边界：判断这一行是否「排满」，进而决定它是否可能是续行的前半句
      right: prevEnd === null ? 0 : prevEnd,
      text: text.replace(/\s+$/, '')
    };
  }).filter(row => row.text.trim());
}

// 正常行距 = 相邻行距里出现次数最多的那个值（取整后统计）。
// 用它区分「同一段落内的续行」和「新条目/新章节」。
function normalLineGap(rows) {
  const tally = {};
  let best = 0;
  let gap = 0;
  for (let i = 1; i < rows.length; i++) {
    const value = Math.round(rows[i - 1].y - rows[i].y);
    // 忽略过小的间距（同一行被拆成两行）和负数（并列排版）
    if (value < 5) continue;
    tally[value] = (tally[value] || 0) + 1;
    if (tally[value] > best) { best = tally[value]; gap = value; }
  }
  return gap || 20;
}

// 合并续行。PDF 的硬换行会把一句话从中间切开：
//   「...参与产品规格书、培训材料等文档制」+「作，累计输出 8 篇产品文档」
// 不合并的话，抽取出来的「工作内容」就是断的，主修课程也会被截断。
//
// 七个条件同时成立才合并（缺一不可，否则会把相邻条目粘成一团）：
//   ① 行距 ≈ 正常行距（段落间距更大，说明是新段落）
//   ② 上一行「排满」了（短行说明它是独立条目，不是被换行切断的句子）
//   ③ 起始 x 相同（小标题与正文的左缩进不同）
//   ④ 上一行不以句末标点结尾（完整句子说明是独立条目）
//   ⑤ 下一行不是「字段名：」形式（那是新字段，不是上一行的延续）
//   ⑥ 上一行不是经历条目头（条目头后面是描述的开始，不是它的延续）
//   ⑦ 下一行不含日期范围（含则是新的一条经历，必须独立成行）
function joinPdfRows(rows) {
  const gapLimit = normalLineGap(rows) * PDF_CONTINUE_RATIO;
  // 页面内容宽度。片段宽度不可用（全是 0）时退化为「不做排满判断」，
  // 宁可少判一层也不要因为宽度缺失就整篇不合并
  const maxRight = rows.reduce((max, row) => Math.max(max, Number(row.right) || 0), 0);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const prev = out.length ? out[out.length - 1] : null;
    const prevRow = i > 0 ? rows[i - 1] : null;

    let merge = false;
    if (prev && prevRow) {
      const lineGap = prevRow.y - row.y;
      const normalSpacing = lineGap > 0 && lineGap <= gapLimit;
      const filledLine = maxRight <= 0 || (Number(prevRow.right) || 0) >= maxRight * PDF_FILL_RATIO;
      const sameIndent = Math.abs(prevRow.x - row.x) <= PDF_INDENT_TOLERANCE;
      const continues = !PDF_SENTENCE_END_RE.test(prevRow.text);
      const notNewField = !PDF_FIELD_LABEL_RE.test(row.text);
      const notItemHead = !PDF_ITEM_HEAD_RE.test(prevRow.text);
      const notItemStart = !PDF_CONTAINS_DATE_RANGE_RE.test(row.text);
      merge = normalSpacing && filledLine && sameIndent && continues
        && notNewField && notItemHead && notItemStart;
    }

    if (merge) {
      const glue = needsSpaceWhenJoined(prev.text, row.text) ? ' ' : '';
      prev.text += glue + row.text;
      prev.right = row.right;
    } else {
      out.push({ x: row.x, y: row.y, right: row.right, text: row.text });
    }
  }
  return out;
}

// 入口：PDF 文本片段数组 → 带行结构的纯文本
function rebuildPdfLines(items) {
  return joinPdfRows(groupPdfRows(items)).map(row => row.text).join('\n');
}

// 规整纯文本来源（TXT / MD / DOCX）：
//   · 统一换行符
//   · 去掉行尾空白
//   · 折叠连续空行
// 不合并续行 —— 这类来源本来就有正确的行结构，动它只会引入风险。
function normalizeResumeText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\t ]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

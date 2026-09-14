// ── 网申表单预填：content script（DOM 层）─────
//
// 职责边界：
//   · 本脚本只做「采集控件特征」与「写入值」两件事，不判断字段语义。
//   · 语义识别与填写计划全部在 popup 侧的 form-fill.js 完成，好处是那部分逻辑
//     能在 node 下用真实样本压测试，而这里只剩难以测试的 DOM 触达。
//
// 只在主 frame 注入（manifest 里 all_frames: false），配合 popup 侧 sendMessage 的
// { frameId: 0 }。已知边界：表单若被渲染在 iframe 内部，主 frame 取不到，会提示手动填写。
//
// ⚠️ 写入受控组件（React / Vue / Angular）必须走「原型 setter + 派发事件」：
//   直接 `el.value = x` 会被框架的 value tracker 记录成「值没变」，
//   于是 onChange 不触发，用户点提交时值丢失或校验报错。
//   调 HTMLInputElement.prototype 上的 setter 可以绕过实例上的 tracker，
//   再派发冒泡的 input / change，框架才会读到新值。

(() => {
  const SCAN_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"]';
  const SECTION_MARKER_SELECTOR = 'h1,h2,h3,h4,h5,h6,legend,caption,th,' +
    '[class*="title"],[class*="heading"],[class*="section"],[class*="caption"],[class*="group"]';
  const DATA_HINT_ATTRS = ['data-name', 'data-field', 'data-field-name', 'data-label', 'data-key', 'data-title'];

  // 「本身就是一个控件」的元素。判定标签时必须绕开它们 ——
  // textFromPrecedingSibling 曾经把手机号前面那个国家选择框显示的
  // 「中国大陆」当成了手机号的标签（它不含原生控件，所以没被原有的
  // input/textarea/select 判断挡住），结果手机号被填进了地区选择框。
  const CONTROL_ISH_SELECTOR = 'input,textarea,select,button,[role="combobox"],' +
    '[role="listbox"],[role="button"],[contenteditable="true"],[aria-haspopup]';

  const MAX_SCAN_FIELDS = 600;
  const MAX_SECTION_MARKERS = 800;
  const MAX_SECTION_TEXT = 30;
  const MAX_LABEL_TEXT = 60;
  const MAX_SELECT_OPTIONS = 300;
  const MAX_SECTION_LOOKBACK = 6;   // 每档（章节标题档 / 字段标签档）各回看几条

  const PLACEHOLDER_OPTION_RE = /^(请选择|请选取|请选|请填写|选择|全部|不限|无|暂无|none|select|choose|pick|-+|—+|　*)$/i;

  // 「区块反推标签」的边界：太长的候选多半是整段说明文字而不是标签
  // 深度要给够：北森的选择 / 日期 / lookup 控件外面套了 4~6 层包装，
  // 只找 4 层就够不到 form-item 那一层的标签（实测 25 个控件因此标签为空）
  const LABEL_BLOCK_DEPTH = 9;      // 由内向外最多往上找几层
  const LABEL_BLOCK_MAX = 24;       // 标签长度上限
  const NEARBY_TEXT_MAX = 40;       // 交给近邻弱信号层的长度上限（与 form-fill.js 一致）
  const NOISE_SCAN_MAX = 20;        // 每个容器最多检查几个控件来收集噪声

  const MARK_CLASS = 'offer-harvester-filled';
  const STYLE_ID = 'offer-harvester-fill-style';
  const STYLE_CSS = '.' + MARK_CLASS + ' {' +
    ' outline: 2px solid #E60012 !important;' +
    ' outline-offset: 1px !important;' +
    ' background-color: rgba(230, 0, 18, 0.05) !important;' +
    ' transition: outline-color .4s ease; }';

  // scan 与 fill 之间用 ref 关联控件。页面保持打开时这份引用一直有效；
  // 若扫描后页面重渲染导致元素脱离文档，填充阶段会如实报 stale 而不是静默失败。
  const FIELD_REGISTRY = new Map();
  let refSeq = 0;

  // 「这个容器里装着几个控件」的缓存。一次扫描里 60 个字段会反复问到同一批
  // 祖先节点，不缓存的话外层大容器的 querySelectorAll 会被重复执行很多次。
  const CONTROL_COUNT_CACHE = new Map();

  // ── 文本工具 ──────────────────────────────────

  function textOf(node, limit) {
    if (!node) return '';
    const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > limit ? '' : text;
  }

  // 取容器内「控件之外」的文字。用于 <label>里包着 input 的情况
  // （直接 textContent 会把 select 的 option 全文当成标签）。
  function ownTextOutsideControl(container) {
    if (!container || /^(INPUT|TEXTAREA|SELECT)$/.test(container.tagName)) return '';
    let out = '';
    const walk = (node) => {
      const children = node.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 3) { out += child.nodeValue; continue; }
        if (child.nodeType !== 1) continue;
        if (/^(INPUT|TEXTAREA|SELECT|BUTTON|SCRIPT|STYLE)$/.test(child.tagName)) continue;
        walk(child);
      }
    };
    walk(container);
    return out.replace(/\s+/g, ' ').trim();
  }

  // 容器里「排在控件之前」的文字。标签几乎总在控件前面，而控件自己的
  // 显示值（自定义下拉框里的「请选择」、已选中的「本科」）排在后面。
  // 按文档顺序一刀切，比事后减噪声可靠得多。
  function textBeforeControl(container, control) {
    let out = '';
    let stopped = false;
    const walk = (node) => {
      const children = node.childNodes || [];
      for (let i = 0; i < children.length && !stopped; i++) {
        const child = children[i];
        if (child.nodeType === 1 && (child === control || (child.contains && child.contains(control)))) {
          // 进了控件所在的子树：只保留排在控件前面的文字，然后收工
          out += ' ' + textBeforeControl(child, control);
          stopped = true;
          return;
        }
        if (child.nodeType === 3) { out += ' ' + child.nodeValue; continue; }
        if (child.nodeType !== 1) continue;
        if (/^(INPUT|TEXTAREA|SELECT|BUTTON|SCRIPT|STYLE)$/.test(child.tagName)) continue;
        walk(child);
      }
    };
    walk(container);
    return out.replace(/\s+/g, ' ').trim();
  }

  // 容器内所有控件留下的文字噪声：占位符、选中项、按钮文字。
  // 只在「标签排在控件后面」这种少数排版里才用得上（见 blockTextCandidates）。
  function stripControlNoise(raw, container) {
    let text = String(raw || '');
    const nodes = container.querySelectorAll
      ? container.querySelectorAll('input,textarea,select,button,[role="button"],[aria-haspopup]')
      : [];
    const noise = [];
    for (let i = 0; i < nodes.length && i < NOISE_SCAN_MAX; i++) {
      const node = nodes[i];
      if (node.getAttribute) {
        noise.push(String(node.getAttribute('placeholder') || ''));
        noise.push(String(node.getAttribute('title') || ''));
      }
      if (node.tagName === 'SELECT' && node.options && node.selectedIndex >= 0) {
        const opt = node.options[node.selectedIndex];
        if (opt) noise.push(String(opt.textContent || opt.text || ''));
      }
    }
    // 长的先减，否则短词会把长词切成碎片、减不干净
    noise.sort((a, b) => b.length - a.length);
    for (const item of noise) {
      const token = item.replace(/\s+/g, ' ').trim();
      if (!token || token.length > 30) continue;
      text = text.split(token).join(' ');
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  // 「无信息量」的文字。占位符或标签若只是这类词，等于没说字段是什么。
  //
  // 这是本轮最重要的一条判断。北森表单里 40 个字段的标签都被解成了
  // 「请选择」「请输入」—— 而这类文字不含任何字段语义，直接导致学校、学历、
  // 专业这些字段全部认不出。把「请选择」当成「没找到标签」继续往下试，
  // 才有机会用区块文字反推出真标签。
  //
  // 注意分辨：「请输入姓名」有信息（要留），「请选择」没有（要丢）。
  const GENERIC_TEXT_RE = /^(请)?(选择|选取|选|输入|填写|录入|添加|点击|上传)(或输入|或选择|内容|文本|文字|数字|日期|时间|金额|数量|更多)?$/;
  const GENERIC_EXTRA_RE = /^(必填|选填|可填|非必填|无|暂无|没有|其他|其它|以上都不是)$/i;

  function isGenericText(text) {
    const t = String(text == null ? '' : text)
      .replace(/[\s\u3000]/g, '')
      .replace(/[（(][^）)]*[）)]/g, '')     // 去掉「(选填)」这类括注
      .replace(/[*:：、,，.。/\-—~～|]+/g, '');
    if (!t) return true;
    // 「0/2000」这类字数统计器：斜杠剥掉后剩纯数字。北森把它渲染在
    // 输入框前面，反推标签时会被当成标签、把真正的「实习内容」顶掉。
    if (/^\d+$/.test(t)) return true;
    return GENERIC_TEXT_RE.test(t) || GENERIC_EXTRA_RE.test(t);
  }

  // 「控件旁边的装饰性文字」：字数计数器、纯数字、单位、横线占位……
  // 它们紧挨着控件、长度也很短，不排除掉就会被当成字段标签。
  // 实测北森把 textarea 的标签解成了「0/2000」，于是「实习内容」「项目描述」
  // 「技能描述」这些能用上的字段全部认不出来 —— 这一条是必须的。
  const CHROME_TEXT_RE = /^[\d\s.,%:：*\-—/+]+$|^(最多|最少|至少|限|不超过)\s*\d+|^[\d.]+\s*(字|元|人|个|条|份|年|月|天|小时|万|[kK])$|^(字|元|人|个|条|份)$/;

  function isChromeText(text) {
    const t = String(text == null ? '' : text).replace(/[\s\u3000]/g, '');
    if (!t) return true;
    return CHROME_TEXT_RE.test(t);
  }

  // 一个容器里装着几个控件。只装一个的（字段自己的容器）才可能把字段标签
  // 放在里面；装着好几个的，容器里的文字更可能是章节标题或说明。
  // 结果按容器缓存：同一次扫描里，60 个字段会反复问到同一批祖先节点。
  function controlCountIn(node) {
    if (!node) return 0;
    if (CONTROL_COUNT_CACHE.has(node)) return CONTROL_COUNT_CACHE.get(node);
    let count = 0;
    try {
      count = node.querySelectorAll(CONTROL_ISH_SELECTOR).length;
    } catch (e) {
      count = 0;
    }
    CONTROL_COUNT_CACHE.set(node, count);
    return count;
  }

  // 把候选文字清洗成可用的标签。返回 '' 表示这个候选不能用。
  function cleanLabelCandidate(raw) {
    const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!text || text.length > LABEL_BLOCK_MAX) return '';
    if (isGenericText(text) || isChromeText(text)) return '';
    // 同一行里既有标签又有控件装饰文字时（「实习内容 0/2000」），
    // 按空格切词，把装饰词和无语义词剔掉，剩下的才是标签
    const kept = text.split(' ')
      .filter(part => part && !isGenericText(part) && !isChromeText(part));
    const joined = kept.join(' ').trim();
    if (!joined || joined.length > LABEL_BLOCK_MAX) return '';
    return joined;
  }

  // 由内向外收集所在区块的文字候选。每个候选带上一个「可靠度」标记：
  // 只有「只装着一个控件的容器」里的前置文字，才可能是本字段的标签。
  function blockTextCandidates(el) {
    const out = [];
    let node = el.parentElement;
    for (let depth = 0; depth < LABEL_BLOCK_DEPTH && node; depth++) {
      const own = controlCountIn(node) <= 1;
      const before = textBeforeControl(node, el);
      if (before) out.push({ text: before, own });
      const outside = ownTextOutsideControl(node);
      if (outside && outside !== before) {
        out.push({ text: stripControlNoise(outside, node), own });
      }
      node = node.parentElement;
    }
    return out;
  }

  // 从区块文字反推标签。
  //
  // 主流组件库（北森 / antd / Element UI）都把标签和控件放在同一个
  // form-item 容器里，标签既不是控件的兄弟节点、也不是包着它的 <label>，
  // 前面那几种策略会全部落空。学校这类脚本接管的 lookup 字段就栽在这里：
  // 拿不到标签 → 只剩占位符「请选择」→ 永远认不出。
  //
  // 分两轮挑：先看「专属本字段的容器」，挑不到才退到装着多个字段的容器。
  // 不分轮的话，外层容器里恰好只写着一个章节标题时（如「教育经历」），
  // 它会冒充标签被选中；分轮之后它只作为最后的兜底。
  function labelFromBlock(el) {
    const candidates = blockTextCandidates(el);
    for (const pass of [true, false]) {
      for (const candidate of candidates) {
        if (candidate.own !== pass) continue;
        const cleaned = cleanLabelCandidate(candidate.text);
        if (cleaned) return cleaned;
      }
    }
    return '';
  }

  // 标签确实反推不出来时，把区块文字交给 form-fill.js 的「近邻」弱信号层，
  // 让那一层不再是空转（它的权重很低，只做兜底，不会单独把字段认出来）。
  function nearbyTextFromBlock(el) {
    for (const candidate of blockTextCandidates(el)) {
      const text = String(candidate.text || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > NEARBY_TEXT_MAX) continue;
      if (isGenericText(text) || isChromeText(text)) continue;
      return text;
    }
    return '';
  }

  // 从区块文字反推标签。
  //
  // 主流组件库（北森 / antd / Element UI）都把标签和控件放在同一个
  // form-item 容器里，标签既不是控件的兄弟节点、也不是包着它的 <label>，
  // 前面那几种策略会全部落空。学校这类脚本接管的 lookup 字段就栽在这里：
  // 拿不到标签 → 只剩占位符「请选择」→ 永远认不出。
  function labelFromBlock(el) {
    const candidates = blockTextCandidates(el);
    for (const pass of [true, false]) {
      for (const candidate of candidates) {
        if (candidate.own !== pass) continue;
        const cleaned = cleanLabelCandidate(candidate.text);
        if (cleaned) return cleaned;
      }
    }
    return '';
  }

  // 标签确实反推不出来时，把区块文字交给 form-fill.js 的「近邻」弱信号层，
  // 让那一层不再是空转（它的权重很低，只做兜底，不会单独把字段认出来）。
  function nearbyTextFromBlock(el) {
    for (const candidate of blockTextCandidates(el)) {
      const text = String(candidate.text || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > NEARBY_TEXT_MAX) continue;
      if (isGenericText(text) || isChromeText(text)) continue;
      return text;
    }
    return '';
  }

  // ── 标签解析（按可靠性从高到低）───────────────

  function labelFromAttribute(el, doc) {
    if (!el.id) return '';
    try {
      const node = doc.querySelector('label[for="' + el.id.replace(/["\\]/g, '\\$&') + '"]');
      return node ? textOf(node, MAX_LABEL_TEXT) : '';
    } catch (e) {
      return '';
    }
  }

  function labelFromAriaLabelledBy(el, doc) {
    const ids = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const parts = [];
    for (let i = 0; i < ids.length && i < 3; i++) {
      const node = doc.getElementById(ids[i]);
      if (!node) continue;
      const text = textOf(node, MAX_LABEL_TEXT);
      if (text) parts.push(text);
    }
    return parts.join(' ');
  }

  function labelFromAncestorLabel(el) {
    const wrap = el.closest ? el.closest('label') : null;
    if (!wrap) return '';
    return textOf({ textContent: ownTextOutsideControl(wrap) }, MAX_LABEL_TEXT);
  }

  // 表格布局 <tr><td>姓名</td><td><input></td></tr> 里，标签是「上一级的前一个兄弟」。
  // 逐级上溯并顺带看前两个兄弟，能同时覆盖左右排版与上下排版。
  function textFromPrecedingSibling(el) {
    let node = el;
    for (let depth = 0; depth < 5 && node; depth++) {
      let sib = node.previousElementSibling;
      let hops = 0;
      while (sib && hops < 2) {
        // 兄弟「自己就是个控件」时不能当标签用（那多半是另一个字段或它的显示值）。
        // 注意要连兄弟自身一起判：北森那个国家选择框是 <div role="combobox">，
        // querySelector 只看后代，漏掉自身就还是会把它显示的「中国大陆」当标签。
        const controlIsh = (sib.matches && sib.matches(CONTROL_ISH_SELECTOR)) ||
          (sib.querySelector && sib.querySelector(CONTROL_ISH_SELECTOR));
        if (!controlIsh) {
          const text = textOf(sib, MAX_LABEL_TEXT);
          if (text && !isGenericText(text)) return text;
        }
        sib = sib.previousElementSibling;
        hops++;
      }
      node = node.parentElement;
    }
    return '';
  }

  function resolveLabel(el, doc, type) {
    // radio / checkbox 的「字段名」在分组容器上，本选项的文字另有其处
    if (type === 'radio' || type === 'checkbox') {
      const fromFor = labelFromAttribute(el, doc);
      const fieldset = el.closest ? el.closest('fieldset') : null;
      const legend = fieldset ? textOf(fieldset.querySelector('legend'), MAX_LABEL_TEXT) : '';
      const groupLabel = [legend, labelFromBlock(el), textFromPrecedingSibling(el)]
        .find(c => c && !isGenericText(c)) || '';
      return { fieldLabel: groupLabel, optionText: fromFor };
    }

    // 按可靠性从高到低依次尝试。候选取到「请选择」这类无语义占位符时
    // 视为「没找到」，继续往下试 —— 否则标签位被占位符占住，
    // 后面真正管用的区块反推就没机会跑了。
    const candidates = [
      labelFromAttribute(el, doc),
      labelFromAriaLabelledBy(el, doc),
      labelFromAncestorLabel(el),
      String(el.getAttribute('aria-label') || '').trim(),
      String(el.getAttribute('title') || '').trim()
    ];
    for (const candidate of candidates) {
      if (candidate && !isGenericText(candidate)) return { fieldLabel: candidate, optionText: '' };
    }

    // 最后靠区块文字反推（北森 / antd / Element UI 这类把标签放进容器的排版）
    const block = labelFromBlock(el) || textFromPrecedingSibling(el);
    return { fieldLabel: block && !isGenericText(block) ? block : '', optionText: '' };
  }

  // ── 章节标记 ──────────────────────────────────

  function collectSectionMarkers(root) {
    const nodes = root.querySelectorAll(SECTION_MARKER_SELECTOR);
    const markers = [];
    for (let i = 0; i < nodes.length && markers.length < MAX_SECTION_MARKERS; i++) {
      const node = nodes[i];
      if (node.tagName === 'LABEL') continue;
      // 容器里已经装着表单控件时，它的文字多半是字段组而不是章节标题
      if (node.querySelector && node.querySelector('input,textarea,select')) continue;
      const text = textOf(node, MAX_SECTION_TEXT);
      if (!text) continue;
      // 区分「章节标题」与「字段标签」：字段标签（含单选项的文字，如「保密」「女」）
      // 总是和它那个控件挤在同一个小容器里；真正的章节标题不会。
      // 实测北森表单里，最近的三条标记全是字段标签，章节标题被埋在后面 ——
      // 不做这个区分，reserveSectionGroup 永远看不到真章节名。
      const parent = node.parentElement;
      markers.push({ node, text, own: !parent || controlCountIn(parent) === 0 });
    }
    return markers;
  }

  // 由近及远返回若干条章节标题文本。多条一起给，是为了让 popup 侧的
  // resolveSectionGroup 能在第一条认不出时继续往后试
  // （表单里 [class*=title] 常常命中字段标签本身，那不是章节）。
  //
  // 「不与控件同容器」的标记排前面：它们才可能是章节标题，而字段标签会排在
  // 后面兜底。组内仍按由近及远，所以最近的真章节标题总会被先看到。
  function sectionTextsFor(el, markers) {
    const out = [];

    const fieldset = el.closest ? el.closest('fieldset') : null;
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      const text = textOf(legend, MAX_SECTION_TEXT);
      if (text && !(legend && legend.contains(el))) out.push(text);
    }

    const own = [];
    const nested = [];
    for (let i = markers.length - 1; i >= 0; i--) {
      const marker = markers[i];
      if (marker.own && own.length >= MAX_SECTION_LOOKBACK) continue;
      if (!marker.own && nested.length >= MAX_SECTION_LOOKBACK) continue;
      if (marker.node.contains && marker.node.contains(el)) continue;
      const pos = marker.node.compareDocumentPosition(el);
      // 只看排在元素之前的标记（后面的是下一个区块的标题）
      if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const bucket = marker.own ? own : nested;
      if (bucket.indexOf(marker.text) >= 0 || out.indexOf(marker.text) >= 0) continue;
      bucket.push(marker.text);
    }
    return out.concat(own, nested);
  }

  // ── 控件特征 ──────────────────────────────────

  function fieldTypeOf(el) {
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SELECT') return 'select';
    if (tag === 'INPUT') {
      const type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'radio' || type === 'checkbox' || type === 'file' || type === 'hidden' ||
        type === 'password' || type === 'search' || type === 'date' || type === 'month' ||
        type === 'number' || type === 'tel' || type === 'email' || type === 'url') return type;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'range' || type === 'color' || type === 'time' || type === 'datetime-local') return 'unsupported';
      // role=combobox 的原生 input 分两种：带 list 的是 datalist（可写），
      // 不带的是 Select2 / antd Select / 北森 lookup 那种由脚本接管的控件
      const role = String(el.getAttribute('role') || '').toLowerCase();
      if (role === 'combobox') {
        if (el.hasAttribute('list')) return 'text';
        return 'custom-select';
      }
      // aria-haspopup / aria-expanded 是「点开会弹出候选层」的标准标记。
      // 北森的 lookup（选学校/部门）、antd 的 Select 都会带这两个属性之一。
      // 这类 input 不是自由输入框：直接当普通文本框写进去，会「看起来填上了、
      // 其实没选中」—— 提交时值丢掉，比不填更糟。按脚本接管的控件处理：
      // 能键入的走辅助填入（填关键词触发筛选，用户点一下候选），不能键入的跳过。
      if (el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded')) return 'custom-select';
      return 'text';
    }
    if (el.isContentEditable) return 'contenteditable';
    const role = String(el.getAttribute('role') || '').toLowerCase();
    if (role === 'combobox' || role === 'listbox') return 'custom-select';
    return 'unsupported';
  }

  // 自定义下拉框还要再分两种，因为处理方式完全不同：
  //   · 可输入的（Element UI / antd 的搜索型 Select，或北森 lookup 的搜索框）——
  //     往输入框里填关键词能触发组件自身的筛选，用户只要从筛过的候选里点一下，
  //     比在几百所学校里翻找容易得多。这类值得帮用户一把。
  //   · 只读的（点击弹窗、输入框不接受键盘输入）—— 真的写不进去，只能跳过。
  // 判据用 readOnly / disabled：div 模拟的 combobox 没有这两个属性，按不可输入处理。
  function isSearchableCustomSelect(el, type) {
    if (type !== 'custom-select') return false;
    if (el.tagName !== 'INPUT') return false;
    return !el.readOnly && !el.disabled;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.type === 'hidden') return false;
    const win = el.ownerDocument.defaultView || window;
    if (win.getComputedStyle) {
      const cs = win.getComputedStyle(el);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    }
    return true;
  }

  function selectOptionsOf(el) {
    const out = [];
    const options = el.options || [];
    for (let i = 0; i < options.length && out.length < MAX_SELECT_OPTIONS; i++) {
      out.push({
        value: options[i].value,
        text: String(options[i].textContent || '').trim()
      });
    }
    return out;
  }

  function radioGroupChecked(el) {
    const name = el.getAttribute('name');
    if (!name) return false;
    try {
      const form = el.form || el.ownerDocument;
      const siblings = form.querySelectorAll('input[type="radio"][name="' + name.replace(/["\\]/g, '\\$&') + '"]');
      for (let i = 0; i < siblings.length; i++) if (siblings[i].checked) return true;
    } catch (e) {
      return Boolean(el.checked);
    }
    return false;
  }

  function hasValueOf(el, type) {
    if (type === 'select') {
      const value = String(el.value || '');
      if (!value) return false;
      if (PLACEHOLDER_OPTION_RE.test(value)) return false;
      const option = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      const text = option ? String(option.textContent || '').trim() : '';
      if (text && PLACEHOLDER_OPTION_RE.test(text)) return false;
      return true;
    }
    if (type === 'radio') return radioGroupChecked(el);
    if (type === 'checkbox') return Boolean(el.checked);
    return Boolean(String(el.value || '').trim());
  }

  function dataHintsOf(el) {
    const parts = [];
    for (let i = 0; i < DATA_HINT_ATTRS.length && parts.length < 3; i++) {
      const value = String(el.getAttribute(DATA_HINT_ATTRS[i]) || '').trim();
      if (value && value.length <= 30) parts.push(value);
    }
    return parts.join(' ');
  }

  // 标签彻底读不出来时的最后一道兜底：拿「离控件最近的章节标记」当字段名。
  //
  // 依据来自第二轮真实报告（北森）：28 个标签为空的控件里，sectionTexts 的
  // 第一条几乎全都是它自己的字段名（#17 →「学校名称」、#13 →「生源地」、
  // #56 →「语言类型」）。原因：字段名元素同时被 [class*="title"] 命中成了
  // 章节标记，而它恰好是离控件最近的那个。
  //
  // 误用代价可控：第一条若是真正的章节名（如「教育经历」），没有任何规则
  // 会匹配它，结果仍是「认不出」—— 与不用兜底时一样，不会填错。
  function pickFieldLabel(fieldLabel, sectionTexts) {
    if (fieldLabel) return fieldLabel;
    const list = Array.isArray(sectionTexts) ? sectionTexts : [];
    for (const text of list) {
      const cleaned = cleanLabelCandidate(text);
      if (cleaned) return cleaned;
    }
    return '';
  }

  function buildFeatures(el, doc, markers) {
    const type = fieldTypeOf(el);
    const labels = resolveLabel(el, doc, type);
    const sectionTexts = sectionTextsFor(el, markers);
    const fieldLabel = pickFieldLabel(labels.fieldLabel, sectionTexts);
    refSeq += 1;
    const ref = 'ff' + refSeq;
    FIELD_REGISTRY.set(ref, el);

    return {
      ref,
      type,
      tag: el.tagName.toLowerCase(),
      name: String(el.getAttribute('name') || ''),
      id: String(el.id || ''),
      role: String(el.getAttribute('role') || ''),
      autocomplete: String(el.getAttribute('autocomplete') || ''),
      dataHints: dataHintsOf(el),
      label: fieldLabel,
      optionText: labels.optionText,
      ariaLabel: String(el.getAttribute('aria-label') || ''),
      placeholder: String(el.getAttribute('placeholder') || ''),
      title: String(el.getAttribute('title') || ''),
      maxLength: Number(el.getAttribute('maxlength')) || 0,
      disabled: Boolean(el.disabled),
      readOnly: Boolean(el.readOnly),
      searchable: isSearchableCustomSelect(el, type),
      hasValue: hasValueOf(el, type),
      options: type === 'select' ? selectOptionsOf(el) : [],
      // 标签没解析出来时，把区块文字交给「近邻」弱信号层兜底
      nearbyText: fieldLabel ? '' : nearbyTextFromBlock(el),
      sectionTexts
    };
  }

  function collectFields(doc) {
    FIELD_REGISTRY.clear();
    CONTROL_COUNT_CACHE.clear();
    refSeq = 0;
    const markers = collectSectionMarkers(doc.body || doc.documentElement);
    const nodes = doc.querySelectorAll(SCAN_SELECTOR);
    const fields = [];

    for (let i = 0; i < nodes.length && fields.length < MAX_SCAN_FIELDS; i++) {
      const el = nodes[i];
      const type = fieldTypeOf(el);
      if (type === 'button') continue;
      if (!isVisible(el)) continue;
      fields.push(buildFeatures(el, doc, markers));
    }
    return fields;
  }

  // ── 写入 ──────────────────────────────────────

  function nativeValueProto(el) {
    const win = el.ownerDocument.defaultView || window;
    if (win.HTMLTextAreaElement && el instanceof win.HTMLTextAreaElement) return win.HTMLTextAreaElement.prototype;
    if (win.HTMLSelectElement && el instanceof win.HTMLSelectElement) return win.HTMLSelectElement.prototype;
    if (win.HTMLInputElement && el instanceof win.HTMLInputElement) return win.HTMLInputElement.prototype;
    return null;
  }

  // 关键：用原型上的 setter 而不是 el.value = x。
  // React 会在实例上定义自己的 value 访问器来跟踪变化，直接赋值会被记成「没变」，
  // onChange 就不触发；走原型 setter 绕过实例覆盖，框架才会感知到这次外部写入。
  function setNativeValue(el, value) {
    const proto = nativeValueProto(el);
    if (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        try { desc.set.call(el, value); return true; } catch (e) { /* 落到兜底 */ }
      }
    }
    try { el.value = value; return true; } catch (e) { return false; }
  }

  function setNativeChecked(el, checked) {
    const win = el.ownerDocument.defaultView || window;
    const proto = win.HTMLInputElement && win.HTMLInputElement.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'checked');
    if (desc && desc.set) {
      try { desc.set.call(el, Boolean(checked)); return true; } catch (e) { /* 落到兜底 */ }
    }
    try { el.checked = Boolean(checked); return true; } catch (e) { return false; }
  }

  function fireEvent(el, typeName) {
    let event = null;
    try {
      event = new Event(typeName, { bubbles: true, cancelable: false, composed: true });
    } catch (e) {
      try {
        event = el.ownerDocument.createEvent('Event');
        event.initEvent(typeName, true, false);
      } catch (e2) {
        return;
      }
    }
    el.dispatchEvent(event);
  }

  function writeChecked(el, wanted) {
    if (Boolean(el.checked) === Boolean(wanted)) return true;
    // click() 会走完整的选择行为：更新 checked、取消同组其它选项、派发 input/change，
    // 且 React 正是从 click 推导 checkbox/radio 的 onChange
    try { el.click(); } catch (e) { /* 落到兜底 */ }
    if (Boolean(el.checked) === Boolean(wanted)) return true;
    setNativeChecked(el, wanted);
    fireEvent(el, 'input');
    fireEvent(el, 'change');
    return Boolean(el.checked) === Boolean(wanted);
  }

  function writeValue(el, type, value) {
    if (type === 'radio' || type === 'checkbox') return writeChecked(el, Boolean(value));
    if (!setNativeValue(el, value)) return false;
    // 顺序不能反：先 input 让双向绑定更新，再 change 触发「已变更」相关逻辑
    fireEvent(el, 'input');
    fireEvent(el, 'change');
    if (String(el.value == null ? '' : el.value).length) return true;
    return String(value == null ? '' : value).length === 0;
  }

  // ── 高亮标记 ──────────────────────────────────

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function markField(el) {
    if (!el.classList) return;
    el.classList.add(MARK_CLASS);
  }

  function clearMarks(doc) {
    const nodes = doc.querySelectorAll('.' + MARK_CLASS);
    for (let i = 0; i < nodes.length; i++) nodes[i].classList.remove(MARK_CLASS);
    const style = doc.getElementById(STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
    return nodes.length;
  }

  // ── 站点名 ────────────────────────────────────

  function readableSite() {
    try {
      const meta = document.querySelector('meta[property="og:site_name"], meta[name="application-name"]');
      const name = meta && meta.content ? String(meta.content).trim() : '';
      if (name && name.length <= 20) return name;
    } catch (e) { /* 落到域名兜底 */ }
    try {
      return new URL(location.href).hostname.replace(/^www\./, '');
    } catch (e) {
      return '当前页面';
    }
  }

  // ── 主流程 ────────────────────────────────────

  function scanPage() {
    if (document.readyState === 'loading' || !document.body) {
      return { ok: false, reason: 'loading', detail: '页面还在加载，请等页面显示完整后再扫描。' };
    }
    let fields = [];
    try {
      fields = collectFields(document);
    } catch (error) {
      return { ok: false, reason: 'error', detail: String((error && error.message) || error) };
    }
    return {
      ok: true,
      fields,
      count: fields.length,
      site: readableSite(),
      url: location.href,
      title: document.title || ''
    };
  }

  function applyFill(message) {
    const items = Array.isArray(message.items) ? message.items : [];
    ensureStyle(document);
    const results = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i] || {};
      const el = FIELD_REGISTRY.get(item.ref);
      if (!el || !el.isConnected) {
        results.push({ ref: item.ref, ok: false, reason: 'stale' });
        continue;
      }
      let ok = false;
      try {
        ok = writeValue(el, fieldTypeOf(el), item.value);
      } catch (error) {
        ok = false;
      }
      if (ok) {
        markField(el);
        results.push({ ref: item.ref, ok: true });
      } else {
        results.push({ ref: item.ref, ok: false, reason: 'write-failed' });
      }
    }
    return { ok: true, results };
  }

  // 三个分支都是同步的，因此不需要 return true 保持通道；
  // 与 jd-grab.js 不同（那边要等 DOM 就绪，是异步应答）
  //
  // 这里刻意加了环境判断：本文件同时被 tests/form-fill-page.test.js 在 node 下
  // 引入做纯函数验证，而 node 里没有 chrome.runtime。
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const type = message && message.type;
      if (type === 'form:scan') { sendResponse(scanPage()); return; }
      if (type === 'form:fill') { sendResponse(applyFill(message)); return; }
      if (type === 'form:clear') { sendResponse({ ok: true, cleared: clearMarks(document) }); return; }
    });
  }

  // 供 node 下的测试取用（浏览器里 module 不存在，这段不会执行）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      isGenericText,
      isChromeText,
      cleanLabelCandidate,
      fieldTypeOf,
      isSearchableCustomSelect,
      pickFieldLabel,
      textBeforeControl,
      stripControlNoise,
      ownTextOutsideControl,
      controlCountIn,
      blockTextCandidates,
      labelFromBlock,
      nearbyTextFromBlock,
      textFromPrecedingSibling,
      resolveLabel,
      collectSectionMarkers,
      sectionTextsFor
    };
  }
})();

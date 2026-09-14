// JD 正文提取验证：打分权重、清洗规则、DOM 层端到端
// 运行：node tests/jd-extract.test.js
//
// 这套断言的意义在于「系数回归」：打分公式里任何一个权重被改坏，
// 都可能让 body 压过真正的 JD 容器（抓进一堆导航），或让正文容器落选（误报抓不到）。
// 用例里同时准备了「应当胜出」与「必须落选」两类样本，改权重后必须两侧都仍然成立。

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'jd-extract.js'), 'utf8');

const api = new Function(src + `
  return { JD_MIN_TEXT, JD_MAX_CANDIDATES, JD_SCORE_THRESHOLD,
    scoreJdCandidate, pickBestCandidate, countKeyword, countMatches, countParagraphs,
    cleanJobText, isNoiseLine, extractJobText, collectJdCandidates,
    buildCandidateFeatures, normalizeClassName, readElementText, linkTextLength };
`)();

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++;
  console.log(`✗ ${name}${detail !== undefined ? '  →  ' + detail : ''}`);
}

// ── 真实样本 ──────────────────────────────────

const JD_TEXT = `产品经理（用户增长方向）

岗位职责
1. 负责用户增长方向的产品规划与落地，通过需求调研、竞品分析输出产品方案；
2. 与设计、研发、运营紧密协作，推进版本迭代并跟踪上线后的核心指标表现；
3. 通过数据分析定位增长机会点，持续优化转化漏斗，对最终的增长结果负责。

任职要求
1. 本科及以上学历，3 年以上互联网产品经验，有增长或工具类产品经验优先；
2. 熟练使用 Axure、Figma 等原型设计工具，能独立完成需求文档与原型；
3. 具备较强的数据分析能力，熟悉 SQL、埋点体系与 A/B 实验设计；
4. 沟通表达清晰，推动力强，能在模糊环境中主动拆解问题并推进落地。

加分项
有从 0 到 1 的产品经验，或主导过千万级用户量级产品的增长项目。

薪资待遇
月薪 25-40K，14 薪，五险一金，带薪年假 15 天，弹性工作制。`;

const NAV_TEXT = `首页
职位搜索
我的简历
投递记录
消息中心
收藏夹
企业服务
校园招聘
社会招聘
登录
注册
意见反馈
帮助中心
联系我们
关于我们
App下载`;

const LIST_TEXT = `产品经理 25-40K 深圳·南山区 3-5年 本科
前端开发工程师 20-35K 北京·海淀区 3-5年 本科
后端开发工程师 25-45K 杭州·西湖区 5-10年 本科
测试开发工程师 18-30K 成都·高新区 3-5年 本科
算法工程师 35-60K 北京·朝阳区 3-5年 硕士
数据分析师 20-35K 上海·浦东新区 1-3年 本科
运营专员 12-20K 广州·天河区 1-3年 本科
视觉设计师 15-25K 深圳·福田区 3-5年 本科
用户研究员 18-28K 北京·朝阳区 3-5年 硕士
内容运营 12-18K 上海·静安区 1-3年 本科`;

const FOOTER_TEXT = `关于我们
联系我们
帮助中心
隐私政策
用户协议
营业执照
人力资源服务许可证
© 2020-2026 某某招聘 版权所有
京ICP备12345678号-1
京公网安备 11010502000000号`;

// ── 1. 打分函数 ───────────────────────────────

const jdCandidate = { text: JD_TEXT, tag: 'div', id: 'job-detail', className: 'job-detail-content', linkTextLen: 0, elementCount: 40 };
const navCandidate = { text: NAV_TEXT, tag: 'nav', id: '', className: 'nav-menu', linkTextLen: NAV_TEXT.replace(/\n/g, '').length, elementCount: 20 };
const listCandidate = { text: LIST_TEXT, tag: 'div', id: '', className: 'job-list', linkTextLen: LIST_TEXT.replace(/\n/g, '').length, elementCount: 90 };
const footerCandidate = { text: FOOTER_TEXT, tag: 'footer', id: '', className: 'footer', linkTextLen: FOOTER_TEXT.replace(/\n/g, '').length, elementCount: 25 };
const tinyCandidate = { text: '岗位职责：负责产品', tag: 'div', id: '', className: 'job-detail', linkTextLen: 0, elementCount: 3 };

const sJd = api.scoreJdCandidate(jdCandidate);
const sNav = api.scoreJdCandidate(navCandidate);
const sList = api.scoreJdCandidate(listCandidate);
const sFooter = api.scoreJdCandidate(footerCandidate);

console.log('分数参考：JD', sJd, '｜导航', sNav, '｜列表', sList, '｜页脚', sFooter);

check('JD 容器过阈值', sJd >= api.JD_SCORE_THRESHOLD, sJd);
check('导航区不及格', sNav < api.JD_SCORE_THRESHOLD, sNav);
check('职位列表不及格', sList < api.JD_SCORE_THRESHOLD, sList);
check('页脚不及格', sFooter < api.JD_SCORE_THRESHOLD, sFooter);
check('JD 分数显著高于导航', sJd - sNav > 30, `${sJd} vs ${sNav}`);
check('JD 分数显著高于列表', sJd - sList > 30, `${sJd} vs ${sList}`);

check('过短文本直接淘汰', api.scoreJdCandidate(tinyCandidate) === -9999);
check('空特征返回淘汰值', api.scoreJdCandidate(null) === -9999);
check('空文本返回淘汰值', api.scoreJdCandidate({ text: '', tag: 'div' }) === -9999);

// 关键词是主导信号：去掉关键词后分数应明显下降
const bare = Object.assign({}, jdCandidate, {
  text: '这是一段没有任何岗位关键词的长文本，'.repeat(20)
});
check('关键词是主导信号', sJd - api.scoreJdCandidate(bare) > 25, sJd - api.scoreJdCandidate(bare));

// 链接密度必须显著压制列表区
const dense = Object.assign({}, jdCandidate, { linkTextLen: Math.round(JD_TEXT.length * 0.6) });
check('高链接密度受重罚', api.scoreJdCandidate(dense) < sJd - 20);

// body 结构惩罚：同为 JD 文本时 body 应低于精确容器
const asBody = Object.assign({}, jdCandidate, { tag: 'body', id: '', className: '' });
const asDiv = Object.assign({}, jdCandidate, { tag: 'div', id: '', className: '' });
check('body 受结构惩罚', api.scoreJdCandidate(asBody) === api.scoreJdCandidate(asDiv) - 12,
  `${api.scoreJdCandidate(asBody)} vs ${api.scoreJdCandidate(asDiv)}`);
check('豁免模式去掉结构惩罚',
  api.scoreJdCandidate(asBody, { relaxed: true }) === api.scoreJdCandidate(asDiv));

// ── 2. 选择最优 ───────────────────────────────

const picked = api.pickBestCandidate([navCandidate, listCandidate, jdCandidate, footerCandidate]);
check('选出 JD 容器', picked.candidate === jdCandidate, picked.score);
check('空数组安全', api.pickBestCandidate([]).score === -9999);
check('undefined 安全', api.pickBestCandidate(undefined).score === -9999);

// ── 3. 计数工具 ───────────────────────────────

check('countKeyword 统计命中的词数', api.countKeyword('岗位职责与任职要求如下', ['岗位职责', '任职要求', '薪资福利']) === 2);
check('countKeyword 无命中返回 0', api.countKeyword('完全无关的文本', ['岗位职责']) === 0);
check('countParagraphs 只算长行', api.countParagraphs('短\n这是一行足够长足够长的文本\n再短') === 1);

// 关键回归：连续调用必须结果一致（带 g 的正则会因 lastIndex 残留而交替返回）
const re = /job|detail/i;
const c1 = api.countMatches('job detail job', re);
const c2 = api.countMatches('job detail job', re);
const c3 = api.countMatches('job detail job', re);
check('countMatches 连续调用稳定', c1 === 3 && c2 === 3 && c3 === 3, `${c1}/${c2}/${c3}`);
check('countMatches 不污染原正则', re.lastIndex === 0, re.lastIndex);

// ── 4. 清洗规则 ───────────────────────────────

const dirty = [
  '首页',
  '',
  '产品经理（用户增长方向）',
  '',
  '岗位职责',
  '负责用户增长方向的产品规划与落地，通过需求调研与竞品分析输出产品方案，持续迭代；',
  '立即沟通',
  '投递简历',
  '',
  '相关推荐',
  '查看全部',
  '---------------',
  '产品经理（用户增长方向）',
  '© 2020-2026 某某招聘 版权所有',
  '京ICP备12345678号-1'
].join('\n');

const cleaned = api.cleanJobText(dirty);
check('清洗掉导航词', !cleaned.includes('首页'));
check('清洗掉操作按钮词', !cleaned.includes('立即沟通') && !cleaned.includes('投递简历'));
check('清洗掉推荐位词', !cleaned.includes('相关推荐') && !cleaned.includes('查看全部'));
check('清洗掉分隔线', !cleaned.includes('---'));
check('清洗掉版权与备案', !cleaned.includes('版权所有') && !cleaned.includes('ICP备'));
check('保留正文标题', cleaned.includes('产品经理（用户增长方向）'));
check('保留正文段落', cleaned.includes('负责用户增长方向的产品规划与落地'));
check('无连续空行', !/\n\n\n/.test(cleaned));
check('首尾无空行', cleaned === cleaned.trim());

// 去重只针对「连续重复」：相隔多行的同名标题属于正文结构，必须保留
const dupAdjacent = api.cleanJobText('岗位职责\n负责产品规划与落地执行，推动跨部门协作。\n负责产品规划与落地执行，推动跨部门协作。\n任职要求');
check('去重连续重复行', dupAdjacent.split('负责产品规划与落地执行').length === 2, JSON.stringify(dupAdjacent));
const dupApart = api.cleanJobText('教育经历\n广东海洋大学本科毕业，主修新闻学专业。\n工作经历\n广东海洋大学本科毕业，主修新闻学专业。');
check('相隔的同名行不被去重', dupApart.split('广东海洋大学本科毕业').length === 3);

// 短行保护：正文里出现噪音词但行较长时必须保留
const longLine = '我们需要你能立即沟通客户需求，并推动跨部门协作把方案落地，这需要较强的推动力与同理心。';
check('长行中的噪音词不被误删', api.cleanJobText(longLine).includes('立即沟通'));
check('短行中的噪音词被删除', api.cleanJobText('立即沟通') === '');
check('isNoiseLine 判定长正文行为非噪音', api.isNoiseLine(longLine) === false);
check('isNoiseLine 判定纯符号行为噪音', api.isNoiseLine('——————') === true);
check('isNoiseLine 判定面包屑为噪音', api.isNoiseLine('首页 > 职位 > 产品经理') === true);

check('清洗空输入', api.cleanJobText('') === '');
check('清洗 null 输入', api.cleanJobText(null) === '');
check('清洗保留换行结构', api.cleanJobText('岗位职责\n负责产品规划与落地执行，推动跨部门协作完成目标。').split('\n').length === 2);
check('全角空格被归一', api.cleanJobText('岗位职责\u3000负责').indexOf('\u3000') === -1);

// ── 5. DOM 层端到端（轻量桩）─────────────────

function makeEl(spec) {
  const el = {
    tagName: spec.tag || 'DIV',
    id: spec.id || '',
    className: spec.className || '',
    innerText: spec.text || '',
    textContent: spec.text || '',
    children: spec.children || [],
    _links: (spec.links || []).map((t) => ({ textContent: t })),
    _count: spec.elementCount != null ? spec.elementCount : 10,
    _candidates: spec.candidates || [],
    querySelectorAll(sel) {
      if (sel === '*') return new Array(this._count).fill(null);
      if (sel === 'a') return this._links;
      return this._candidates;
    }
  };
  return el;
}

function makeDoc(body, scopeEl) {
  return {
    body: body,
    querySelector() { return scopeEl || null; }
  };
}

// 场景 A：有 main 容器，JD 容器在 main 内，同时存在导航与页脚
const jdEl = makeEl({ tag: 'DIV', id: 'job-detail', className: 'job-detail-content', text: JD_TEXT, elementCount: 40 });
const navEl = makeEl({ tag: 'NAV', className: 'nav-menu', text: NAV_TEXT, links: NAV_TEXT.split('\n'), elementCount: 20 });
const footerEl = makeEl({ tag: 'FOOTER', className: 'footer', text: FOOTER_TEXT, links: FOOTER_TEXT.split('\n'), elementCount: 25 });
const mainEl = makeEl({ tag: 'MAIN', className: 'main', text: [navEl.innerText, JD_TEXT, footerEl.innerText].join('\n'), children: [navEl, jdEl, footerEl], candidates: [jdEl], elementCount: 200 });
const bodyA = makeEl({ tag: 'BODY', text: mainEl.innerText, children: [navEl, mainEl, footerEl], candidates: [], elementCount: 400 });

const resA = api.extractJobText(makeDoc(bodyA, mainEl));
check('场景A 抓取成功', resA.ok === true, JSON.stringify(resA).slice(0, 160));
check('场景A 抓到 JD 正文', resA.ok && resA.text.includes('负责用户增长方向的产品规划与落地'));
check('场景A 未混入导航', resA.ok && !resA.text.includes('收藏夹'));
check('场景A 未混入页脚', resA.ok && !resA.text.includes('版权所有') && !resA.text.includes('营业执照'));

// 场景 B：无 main，JD 容器无任何语义类名 → 走兜底候选
const bareJdEl = makeEl({ tag: 'DIV', className: 'wrapper-8f3a', text: JD_TEXT, elementCount: 40 });
const bodyB = makeEl({ tag: 'BODY', text: [NAV_TEXT, JD_TEXT, FOOTER_TEXT].join('\n'), children: [navEl, bareJdEl, footerEl], candidates: [], elementCount: 300 });
const resB = api.extractJobText(makeDoc(bodyB, null));
check('场景B 无语义类名仍能抓到', resB.ok === true, JSON.stringify(resB).slice(0, 160));
check('场景B 抓到的是 JD 内容', resB.ok && resB.text.includes('任职要求'));
check('场景B 未退化成整页', resB.ok && !resB.text.includes('京ICP备'));

// 场景 C：职位列表页 → 必须报「没找到」，而不是抓一堆职位标题
const listEl = makeEl({ tag: 'DIV', className: 'job-list-wrapper', text: LIST_TEXT, links: LIST_TEXT.split('\n'), elementCount: 90 });
const bodyC = makeEl({ tag: 'BODY', text: [NAV_TEXT, LIST_TEXT, FOOTER_TEXT].join('\n'), children: [navEl, listEl, footerEl], candidates: [listEl], elementCount: 300 });
const resC = api.extractJobText(makeDoc(bodyC, null));
check('场景C 列表页报没找到', resC.ok === false && resC.reason === 'no-content', JSON.stringify(resC));

// 场景 D：整页就是 JD（无导航无页脚）→ 依赖豁免重试兜底
const bodyD = makeEl({ tag: 'BODY', text: JD_TEXT, children: [], candidates: [], elementCount: 10 });
const resD = api.extractJobText(makeDoc(bodyD, null));
check('场景D 纯 JD 页仍能抓到（豁免重试）', resD.ok === true, JSON.stringify(resD).slice(0, 160));

// 场景 E：空白页 / 无内容
const bodyE = makeEl({ tag: 'BODY', text: '', children: [], candidates: [], elementCount: 3 });
check('场景E 空白页报没找到', api.extractJobText(makeDoc(bodyE, null)).ok === false);
check('场景E 无 body 时安全返回', api.extractJobText({ body: null }).ok === false);
check('场景E 空文档安全返回', api.extractJobText(null).ok === false);

// ── 6. DOM 特征采集 ───────────────────────────

check('normalizeClassName 处理字符串', api.normalizeClassName({ className: 'a b' }) === 'a b');
check('normalizeClassName 处理 SVG 对象', api.normalizeClassName({ className: { baseVal: 'svg-cls' } }) === 'svg-cls');
check('normalizeClassName 处理空值', api.normalizeClassName({}) === '');
check('readElementText 优先 innerText', api.readElementText({ innerText: 'a', textContent: 'b' }) === 'a');
check('readElementText 回退 textContent', api.readElementText({ innerText: '', textContent: 'b' }) === 'b');
check('linkTextLength 累加链接文字', api.linkTextLength({ querySelectorAll: () => [{ textContent: 'ab' }, { textContent: 'cde' }] }) === 5);
check('buildCandidateFeatures 空文本返回 null', api.buildCandidateFeatures({ innerText: '', textContent: '' }) === null);
check('collectJdCandidates 无 body 返回空数组', api.collectJdCandidates({ body: null }).length === 0);

// 候选上限：极端页面不能无节制地调 innerText
const many = [];
for (let i = 0; i < 600; i++) many.push(makeEl({ tag: 'DIV', className: 'content', text: JD_TEXT, elementCount: 30 }));
const bigBody = makeEl({ tag: 'BODY', text: JD_TEXT, children: many, candidates: many, elementCount: 5000 });
const collected = api.collectJdCandidates(makeDoc(bigBody, null));
check('候选数量有上限', collected.length <= api.JD_MAX_CANDIDATES + 130, collected.length);

console.log(`\n──────── 结果：${pass} 通过 / ${fail} 失败 ────────`);
process.exit(fail ? 1 : 0);

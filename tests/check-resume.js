// 简历解析的端到端体检工具：PDF → 行重建 → 本地结构化提取
// 用法：node tests/check-resume.js <简历.pdf> [--text]
//
// 为什么需要它：行重建与提取规则的效果只能拿真实简历看，
// 单元测试能锁住规则本身，锁不住「这份简历抽出了多少」。
// 改了 resume-text.js 或 profile.js 的提取逻辑后，建议拿几份真实简历跑一遍。
//
// 加 --text 会额外打印重建后的文本，用来判断问题出在「文本没还原好」
// 还是「提取规则不认识这种写法」。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pdfArg = process.argv[2];
if (!pdfArg) {
  console.error('用法：node tests/check-resume.js <简历.pdf> [--text]');
  process.exit(1);
}
const showText = process.argv.includes('--text');

const rt = new Function(
  fs.readFileSync(path.join(root, 'resume-text.js'), 'utf8') + ';return { rebuildPdfLines };'
)();
const api = new Function(
  fs.readFileSync(path.join(root, 'profile.js'), 'utf8')
  + ';return { extractProfileLocally, profileStats, flattenProfile };'
)();
const pdfjsLib = require(path.join(root, 'lib', 'pdf.min.js'));
pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(root, 'lib', 'pdf.worker.min.js');

(async () => {
  const data = new Uint8Array(fs.readFileSync(pdfArg));
  const doc = await pdfjsLib.getDocument({
    data, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false, disableFontFace: true
  }).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(rt.rebuildPdfLines(content.items));
  }
  const text = pages.join('\n');

  if (showText) {
    console.log('═══ 重建后的文本 ═══');
    console.log(text);
    console.log('');
  }

  const p = api.extractProfileLocally(text);
  const s = api.profileStats(p);
  console.log('═══ 提取结果 ═══');
  console.log(`页数 ${doc.numPages}｜文本 ${text.length} 字符 / ${text.split('\n').length} 行`);
  console.log(`已填 ${s.filled} 项（完成度 ${s.percent}%）｜教育 ${s.educationCount} 段｜实习/工作 ${s.experienceCount} 段｜项目 ${s.projectCount} 个`);

  const dump = (title, value) => {
    console.log('\n── ' + title + ' ──');
    if (typeof value === 'string') { console.log(value || '（空）'); return; }
    const hasList = Array.isArray(value) && value.length;
    const hasObj = !Array.isArray(value) && Object.values(value).some(Boolean);
    if (!hasList && !hasObj) { console.log('（空）'); return; }
    console.log(JSON.stringify(value, null, 1));
  };
  dump('基础信息', p.basic);
  dump('求职意向', p.intent);
  dump('教育经历', p.education);
  dump('工作与实习', p.experience);
  dump('项目经历', p.projects);
  dump('技能与补充', p.skills);

  // 顺带报一下预填能拿到多少条 —— 这是这层数据的最终用途
  const flat = api.flattenProfile(p, { includeSensitive: false });
  console.log('\n═══ 网申预填可用字段 ═══');
  console.log(`共 ${flat.length} 条（不含敏感字段）`);
})().catch(e => {
  console.error('失败：' + e.message);
  process.exit(1);
});

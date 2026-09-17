// 结构化简历数据层验证（无 DOM 依赖，可直接运行）
// 用法：node tests/profile.test.js
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'profile.js'), 'utf8');

const api = new Function(src + `
  return { PROFILE_GROUPS, PROFILE_SCHEMA_VERSION, PROFILE_REQUIRED_KEYS, PROFILE_MATCH_KEYS,
    createEmptyProfile, normalizeProfile, getProfilePath, setProfilePath, profileStats, profileGroupStats,
    flattenProfile, extractProfileLocally, extractJsonBlock, parseProfileJson, parseProfileText,
    splitProfileBlocks, resolveGroupFromHeading, profileHasValue, resolveProfileKey, resolveProfileKeyInGroup,
    profileFieldLabel, PROFILE_SENSITIVE_KEYS, createEmptyItem, groupById, migrateProfile, needsProfileMigration,
    markProfileDirty, isProfileDirty, markProfileRemoved, isProfileRemoved, clearProfileRemoved, mergeProfile,
    profileResolvedValue, profileDerivedValue, applyProfileDerived, pickHighestEducation, profileEmptyPaths,
    profileMatchFingerprint, splitTagValues, migrateLanguageItem, normKey };
`)();

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const GROUP_IDS = ['basic', 'intent', 'education', 'experience', 'projects', 'campusRole',
  'campusPractice', 'extra', 'skills', 'honors', 'languages', 'certificates'];

// ── 1. 空 profile 结构 ────────────────────────
section('1. 空结构');
const empty = api.createEmptyProfile();
check('schema 版本为 2', api.PROFILE_SCHEMA_VERSION === 2);
check('含全部 12 组', GROUP_IDS.every(k => k in empty), Object.keys(empty));
check('分组顺序与网申表单一致', api.PROFILE_GROUPS.map(g => g.id).join(',') === GROUP_IDS.join(','),
  api.PROFILE_GROUPS.map(g => g.id));
check('数组组为数组', api.PROFILE_GROUPS.filter(g => g.kind === 'list').every(g => Array.isArray(empty[g.id])));
check('对象组字段全部补空', api.PROFILE_GROUPS.filter(g => g.kind === 'object')
  .every(g => g.fields.every(f => empty[g.id][f.key] === '')));
check('profileHasValue(空) === false', api.profileHasValue(empty) === false);
check('空结构 percent = 0', api.profileStats(empty).percent === 0);
check('空结构必填缺口 = 12', api.profileStats(empty).requiredMissing === 12, api.profileStats(empty));
check('必填栏位共 12 个', api.PROFILE_REQUIRED_KEYS.length === 12, api.PROFILE_REQUIRED_KEYS);
check('必填含教育六项', ['school', 'college', 'major', 'degree', 'startDate', 'endDate']
  .every(k => api.PROFILE_REQUIRED_KEYS.includes('education.' + k)));

// ── 2. 脏数据规整：模拟 AI 各种不听话的返回 ────
section('2. 脏数据容错');
const messy = {
  basicInfo: { name: '张三', 手机号码: '138 0000 0000', email: ['a@b.com'], gender: '男', unknownKey: 'x' },
  jobIntent: { 期望职位: '产品经理', jobType: '实习' },
  work_experience: [{ 公司名称: '腾讯', position_title: '运营', desc: '负责A\n负责B', start: '2024.07' }],
  projects: { name: '单对象不是数组' },
  skills: [{ 技能名称: 'SQL' }, { 技能名称: 'Figma', 掌握程度: '熟练' }],
  extraGarbage: 'should be dropped'
};
const norm = api.normalizeProfile(messy);
check('别名分组 basicInfo → basic', norm.basic.name === '张三');
check('别名键 手机号码 → phone', norm.basic.phone === '138 0000 0000', norm.basic.phone);
check('数组值转为字符串', norm.basic.email === 'a@b.com');
check('jobIntent 映射到 intent', norm.intent.targetPosition === '产品经理' && norm.intent.jobType === '实习');
check('work_experience → experience', norm.experience.length === 1 && norm.experience[0].company === '腾讯');
check('desc → description', norm.experience[0].description.includes('负责A'));
check('start → startDate', norm.experience[0].startDate === '2024.07');
check('对象型 projects 被包成单元素数组', norm.projects.length === 1 && norm.projects[0].name === '单对象不是数组');
check('skills 列表规整为两条', norm.skills.length === 2 && norm.skills[0].name === 'SQL', norm.skills);
check('技能掌握程度落到 level', norm.skills[1].level === '熟练', norm.skills[1]);
check('未知顶层键被丢弃', !('extraGarbage' in norm) && !('basicInfo' in norm));
check('未知字段被丢弃', norm.basic.unknownKey === undefined);
check('未手工编辑时不带 _dirty', norm.basic._dirty === undefined);

// ── 3. 分组内优先的键名解析（12 组的同名 key 靠它消歧）──
section('3. 分组内优先的键名解析');
const projGroup = api.groupById('projects');
const honGroup = api.groupById('honors');
const roleGroup = api.groupById('campusRole');
const eduGroup = api.groupById('education');
check('获奖项在获奖组 → name', api.resolveProfileKeyInGroup('获奖项', honGroup) === 'name');
check('获奖项在项目组 → 不认（不落到 name）', api.resolveProfileKeyInGroup('获奖项', projGroup) === null);
check('职务名称在校职务组 → title', api.resolveProfileKeyInGroup('职务名称', roleGroup) === 'title');
check('职务在项目组 → role（不是 title）', api.resolveProfileKeyInGroup('职务', projGroup) === 'role');
check('department 在教育组不当学院', api.resolveProfileKeyInGroup('department', eduGroup) === null,
  api.resolveProfileKeyInGroup('department', eduGroup));
check('学院在教育组 → college', api.resolveProfileKeyInGroup('学院', eduGroup) === 'college');
check('掌握程度在技能组 → level', api.resolveProfileKeyInGroup('掌握程度', api.groupById('skills')) === 'level');
check('获奖级别在获奖组 → level', api.resolveProfileKeyInGroup('获奖级别', honGroup) === 'level');
check('不带分组时仍能全局解析', api.resolveProfileKey('mobile') === 'phone');

// ── 4. 顶层平铺兜底 ──────────────────────────
section('4. 顶层平铺兜底');
const flat = api.normalizeProfile({ name: '李四', phone: '13900000000', ethnicity: '汉族' });
check('平铺 name → basic', flat.basic.name === '李四');
check('平铺 phone → basic', flat.basic.phone === '13900000000');
check('平铺民族 → basic.ethnicity', flat.basic.ethnicity === '汉族');
// 平铺的 skillTags 是 v1 写法，走迁移后落到技能列表
const flatSkill = api.normalizeProfile({ name: '李四', skillTags: 'Excel、SQL' });
check('平铺 skillTags（v1）迁到技能列表', flatSkill.skills.length === 2 && flatSkill.skills[0].name === 'Excel', flatSkill.skills);

// ── 5. 路径读写与脏标记 ──────────────────────
section('5. 路径读写 / 脏标记');
const p = api.createEmptyProfile();
api.setProfilePath(p, 'basic.name', '王五');
api.setProfilePath(p, 'education.0.school', '广海大');
check('object 路径写入', api.getProfilePath(p, 'basic.name') === '王五');
check('list 路径写入', api.getProfilePath(p, 'education.0.school') === '广海大');
check('不存在的路径返回空串', api.getProfilePath(p, 'basic.nothing') === '');
check('非法分组写入返回 false', api.setProfilePath(p, 'nope.x', 1) === false);
check('字段标签解析', api.profileFieldLabel('education.0.school') === '教育经历 · 学校名称',
  api.profileFieldLabel('education.0.school'));
check('新对象默认不脏', api.isProfileDirty(p, 'basic.name') === false);
api.markProfileDirty(p, 'basic.name');
api.markProfileDirty(p, 'education.0.school');
check('标记后为脏', api.isProfileDirty(p, 'basic.name') === true);
check('脏标记挂在条目自己身上（不按数组下标）',
  Array.isArray(p.education[0]._dirty) && p.education[0]._dirty.includes('school'), p.education[0]);
check('对象组的脏标记挂在容器上', Array.isArray(p.basic._dirty) && p.basic._dirty.includes('name'), p.basic._dirty);
check('不存在的路径标记失败', api.markProfileDirty(p, 'basic.nothing') === false);
check('重复标记不重复记录', (() => { api.markProfileDirty(p, 'basic.name'); return p.basic._dirty.length === 1; })());

// ── 6. 删除名单（重新解析不复活）──────────────
section('6. 删除名单');
const removedHolder = api.createEmptyProfile();
api.markProfileRemoved(removedHolder, 'experience', { company: '厦门界玺科普有限公司' });
check('指纹按身份键归一', api.profileMatchFingerprint({ company: '厦门界玺科普有限公司' }, 'company') === '厦门界玺科普有限公司');
check('删除记录已写入', api.isProfileRemoved(removedHolder, 'experience', '厦门界玺科普有限公司'));
check('不同分组互不影响', api.isProfileRemoved(removedHolder, 'projects', '厦门界玺科普有限公司') === false);
check('不同公司不算删过', api.isProfileRemoved(removedHolder, 'experience', '腾讯') === false);
api.clearProfileRemoved(removedHolder, 'experience', { company: '厦门界玺科普有限公司' });
check('改名后撤销删除记录', api.isProfileRemoved(removedHolder, 'experience', '厦门界玺科普有限公司') === false);
api.markProfileRemoved(removedHolder, 'experience', { company: '' });
check('没有身份键时不记删除', removedHolder._removed.length === 0);

// ── 7. 敏感字段过滤 ──────────────────────────
section('7. 敏感字段');
const withSecret = api.normalizeProfile({
  basic: { name: '张三', idCard: '440000199001011234', homeAddress: 'XX路1号' },
  skills: [{ name: 'Figma' }]
});
const flatSafe = api.flattenProfile(withSecret, { includeSensitive: false });
const flatAll = api.flattenProfile(withSecret, { includeSensitive: true });
check('默认排除身份证', !flatSafe.some(f => f.key === 'idCard'));
check('默认排除家庭住址', !flatSafe.some(f => f.key === 'homeAddress'));
check('开启后可带出身份证', flatAll.some(f => f.key === 'idCard'));
check('敏感键清单含 4 项', api.PROFILE_SENSITIVE_KEYS.length === 4, api.PROFILE_SENSITIVE_KEYS);
check('统计分别计数敏感项', api.profileStats(withSecret).sensitiveFilled === 2, api.profileStats(withSecret));

// ── 8. flatten 结构（预填消费方）─────────────
section('8. flatten 结构');
const sample = api.normalizeProfile({
  basic: { name: '张三', phone: '13800000000' },
  education: [{ school: '广东海洋大学', degree: '本科' }, { school: '某中学' }],
  skills: [{ name: 'SQL' }]
});
const flatFields = api.flattenProfile(sample);
check('路径唯一', new Set(flatFields.map(f => f.path)).size === flatFields.length);
check('每条含 key/label/value', flatFields.every(f => f.key && f.label && f.value));
check('list 项带 index', flatFields.filter(f => f.multi).every(f => typeof f.index === 'number'));
check('第二条教育经历 index = 1', flatFields.some(f => f.path === 'education.1.school'));
check('每条带 required 标记', flatFields.every(f => typeof f.required === 'boolean'));
check('总条数正确（name,phone,school×2,degree,skillName=6）', flatFields.length === 6, flatFields.length);

// ── 9. JSON 提取（AI 输出包裹各种外壳）────────
section('9. JSON 提取');
check('```json 围栏', api.extractJsonBlock('```json\n{"a":1}\n```') === '{"a":1}');
check('``` 无语言标记', api.extractJsonBlock('```\n{"a":1}\n```') === '{"a":1}');
check('前后有解释文字', api.extractJsonBlock('好的，结果如下：\n{"a":1}\n希望有帮助') === '{"a":1}');
check('无 JSON 时抛错', (() => { try { api.extractJsonBlock('抱歉我不能'); return false; } catch { return true; } })());
check('parseProfileJson 端到端', api.parseProfileJson('```json\n{"basic":{"姓名":"赵六"}}\n```').basic.name === '赵六');

// ── 10. v1 → v2 迁移 ─────────────────────────
section('10. v1 → v2 迁移');
check('识别 v1 数据', api.needsProfileMigration({
  version: 1, basic: {}, skills: { skillTags: 'SQL' }
}) === true);
check('v2 数据不迁移', api.needsProfileMigration({
  version: 2, skills: [{ name: 'SQL' }]
}) === false);
check('识别平铺的 v1 数据', api.needsProfileMigration({ skillTags: 'SQL' }) === true);

const v1 = api.normalizeProfile({
  version: 1,
  basic: { name: '刘子涵', phone: '13640336295', idCard: '4401', politicalStatus: '共青团员' },
  intent: { targetPosition: '产品运营' },
  education: [{ school: '广东海洋大学', degree: '本科' }],
  experience: [{ company: '美高创新', title: '产品营销实习生' }],
  projects: [{ name: '鹅创营' }],
  skills: {
    skillTags: 'SQL、Figma',
    certificates: '计算机二级、软件设计师',
    languages: '英语 CET-6、粤语',
    honors: '国家励志奖学金；校二等奖学金',
    selfEvaluation: '做事踏实',
    portfolio: 'https://github.com/x'
  },
  updatedAt: '2026-09-01T00:00:00.000Z'
});
check('迁移后版本为 2', v1.version === 2);
check('v1 basic 字段全部保留', v1.basic.name === '刘子涵' && v1.basic.phone === '13640336295'
  && v1.basic.idCard === '4401' && v1.basic.politicalStatus === '共青团员');
check('v1 intent 保留', v1.intent.targetPosition === '产品运营');
check('v1 教育/实习/项目保留', v1.education.length === 1 && v1.experience.length === 1 && v1.projects.length === 1);
check('skillTags 拆成技能列表', v1.skills.length === 2 && v1.skills[0].name === 'SQL' && v1.skills[1].name === 'Figma', v1.skills);
check('certificates 拆成证书列表', v1.certificates.length === 2 && v1.certificates[1].name === '软件设计师', v1.certificates);
check('languages 拆出语言类型', v1.languages.length === 2 && v1.languages[0].type === '英语' && v1.languages[1].type === '粤语', v1.languages);
check('语言等级从文本里切开', v1.languages[0].level === 'CET-6', v1.languages[0]);
// v1 的 languages 常写成「CET-6、粤语」这种只写等级、不写语言名的样子。
// 不补语言名的话，迁移出来的「语言类型」就是「CET-6」，
// 而网申的语言类型下拉里是「英语 / 日语 / 粤语」，匹配不上整栏填不进去。
check('只写等级时反推出语言名', api.migrateLanguageItem('CET-6').type === '英语', api.migrateLanguageItem('CET-6'));
check('反推后等级原文保留', api.migrateLanguageItem('CET-6').level === 'CET-6', api.migrateLanguageItem('CET-6'));
check('雅思托福同样归到英语', ['雅思 6.5', 'TOEFL 100', 'TEM-8'].every(v => api.migrateLanguageItem(v).type === '英语'));
check('日语等级归到日语', ['JLPT N2', 'N1', '日语 N3'].every(v => api.migrateLanguageItem(v).type === '日语'));
check('拉丁等级词不误命中中文拼音', api.migrateLanguageItem('Nanjing').type === 'Nanjing', api.migrateLanguageItem('Nanjing'));
check('语言名在前时照旧拆开', api.migrateLanguageItem('英语 CET-6').type === '英语'
  && api.migrateLanguageItem('英语 CET-6').level === 'CET-6', api.migrateLanguageItem('英语 CET-6'));
check('普通话与粤语按语言名归位', api.migrateLanguageItem('普通话二级甲等').type === '普通话'
  && api.migrateLanguageItem('粤语').type === '粤语');
check('honors 按「、」和「；」都拆', v1.honors.length === 2 && v1.honors[0].name === '国家励志奖学金', v1.honors);
check('自我评价搬到附加信息', v1.extra.selfEvaluation === '做事踏实');
check('作品链接搬到附加信息', v1.extra.portfolio === 'https://github.com/x');
check('旧的平铺 skillTags 键已清掉', !('skillTags' in v1));
check('迁移后仍有内容', api.profileHasValue(v1));
check('空值碎片被丢弃', api.splitTagValues('SQL、、Fig').length === 2, api.splitTagValues('SQL、、Fig'));
check('迁移不炸 null', (() => { try { api.migrateProfile(null); return true; } catch { return false; } })());

// ── 11. 派生回退 ─────────────────────────────
section('11. 派生回退（个人信息 ↔ 教育经历）');
const deriveProfile = api.normalizeProfile({
  basic: { name: '张三' },
  education: [
    { school: '某中学', degree: '高中', major: '理科' },
    { school: '广东海洋大学', degree: '本科', major: '电子信息工程' }
  ]
});
const highest = api.pickHighestEducation(deriveProfile);
check('挑出学历最高那条', highest.school === '广东海洋大学', highest && highest.school);
check('basic.school 由教育经历带出', api.profileDerivedValue(deriveProfile, 'basic', 'school') === '广东海洋大学');
check('basic.major 由教育经历带出', api.profileDerivedValue(deriveProfile, 'basic', 'major') === '电子信息工程');
check('basic.degree 由教育经历带出', api.profileDerivedValue(deriveProfile, 'basic', 'degree') === '本科');
check('最高学位按学历换算', api.profileDerivedValue(deriveProfile, 'basic', 'degreeLevel') === '学士');
check('派生值被标记为 derived', api.profileResolvedValue(deriveProfile, 'basic', 'school').derived === true);
check('直接填了就不派生', api.profileResolvedValue(
  api.normalizeProfile({ basic: { school: '我自己填的' }, education: [{ school: '广东海洋大学', degree: '本科' }] }),
  'basic', 'school').derived === false);
check('没有教育经历时不派生', api.profileDerivedValue(api.createEmptyProfile(), 'basic', 'school') === '');
check('无派生规则的字段不派生', api.profileDerivedValue(deriveProfile, 'basic', 'ethnicity') === '');

const derived = api.applyProfileDerived(deriveProfile);
check('派生副本补进 basic.school', derived.basic.school === '广东海洋大学');
check('派生副本补进 basic.degreeLevel', derived.basic.degreeLevel === '学士');
check('派生不改原对象', deriveProfile.basic.school === '', deriveProfile.basic.school);
check('派生副本保留列表条目', derived.education.length === 2);

// 派生后统计里不再算缺
const statsBefore = api.profileStats(deriveProfile);
check('派生项计入已填', statsBefore.derived >= 4, statsBefore);
check('派生后 school 不算缺', !api.profileEmptyPaths(deriveProfile).includes('basic.school'),
  api.profileEmptyPaths(deriveProfile).filter(x => x.indexOf('basic.') === 0));

// ── 12. 智能合并（重新解析保留手工改动）───────
section('12. 智能合并');
const base = api.extractProfileLocally(`教育背景
2023.09-2027.06 广东海洋大学 电子信息工程专业

实习经历
2026.06-2026.8 深圳美高创新股份有限公司 产品营销实习生
做了产品文档。
2025.09-2025.10 厦门界玺科普有限公司 产品专员
做了市场调研。`);
base.basic.name = '刘子涵';
api.markProfileDirty(base, 'basic.name');
base.basic.ethnicity = '';
base.basic.politicalStatus = '共青团员';
api.markProfileDirty(base, 'basic.politicalStatus');
base.experience[0].title = '产品营销实习生（我改过的）';
api.markProfileDirty(base, 'experience.0.title');
base.experience[0].achievement = '我补的业绩';
api.markProfileDirty(base, 'experience.0.achievement');

const reparse = api.extractProfileLocally(`教育背景
2023.09-2027.06 广东海洋大学 电子信息工程专业

实习经历
2026.06-2026.8 深圳美高创新股份有限公司 产品营销实习生
做了产品文档。
2025.09-2025.10 厦门界玺科普有限公司 产品专员
做了市场调研。`);
reparse.basic.name = 'AI 抽出来的名字';
reparse.basic.politicalStatus = '群众';

const merged = api.mergeProfile(reparse, base);
check('第一次解析（无已有数据）直接采用', api.mergeProfile(reparse, null).profile.basic.name === 'AI 抽出来的名字');
check('无有效内容时也直接采用', api.mergeProfile(reparse, api.createEmptyProfile()).profile.basic.name === 'AI 抽出来的名字');
check('手工改过的字段保留', merged.profile.basic.name === '刘子涵', merged.profile.basic.name);
check('手工改过的必填字段也保留', merged.profile.basic.politicalStatus === '共青团员');
check('条目内手工字段保留', merged.profile.experience[0].title === '产品营销实习生（我改过的）');
check('条目内手工补充的内容不丢', merged.profile.experience[0].achievement === '我补的业绩');
check('未手工过的字段用 AI 新值', merged.profile.experience[0].company === '深圳美高创新股份有限公司');
check('AI 没抽到的旧内容保留', merged.profile.experience[0].description.includes('产品文档'));
check('原有条目不被清空', merged.profile.experience.length === 2);
check('报告：手工保留计数', merged.report.dirtyKept >= 3, merged.report);
check('报告：没有新增条数时不虚报', merged.report.added === 0, merged.report);
check('报告的 addedByGroup 为空', Object.keys(merged.report.addedByGroup).length === 0);

// 新增一段经历
const reparseMore = api.extractProfileLocally(`实习经历
2026.06-2026.8 深圳美高创新股份有限公司 产品营销实习生
做了产品文档。
2025.09-2025.10 厦门界玺科普有限公司 产品专员
做了市场调研。
2024.07-2024.09 第三家公司 运营实习生
做了运营。`);
const merged2 = api.mergeProfile(reparseMore, base);
check('新增条目被追加', merged2.profile.experience.length === 3);
check('报告：新增 1 段', merged2.report.added === 1, merged2.report);
check('报告：新增按分组记账', merged2.report.addedByGroup.experience === 1, merged2.report);
check('旧条目的手工改动仍保留', merged2.profile.experience[0].title === '产品营销实习生（我改过的）');

// AI 这次一条都没抽到 → 旧条目原样保留，不能被清空
const mergedEmpty = api.mergeProfile(api.createEmptyProfile(), base);
check('AI 全空时旧条目全部保留', mergedEmpty.profile.experience.length === 2, mergedEmpty.profile.experience.length);
check('报告：保留条目计数', mergedEmpty.report.keptItems >= 1, mergedEmpty.report);
check('AI 全空时对象字段也保留', mergedEmpty.profile.basic.name === '刘子涵');
check('AI 全空时旧值不被清空', mergedEmpty.profile.basic.politicalStatus === '共青团员');

// 删除过的条目不再复活
const withRemoved = JSON.parse(JSON.stringify(base));
api.markProfileRemoved(withRemoved, 'experience', { company: '第三家公司' });
const merged3 = api.mergeProfile(reparseMore, withRemoved);
check('删除过的条目不复活', merged3.profile.experience.length === 2, merged3.profile.experience.length);
check('报告：被拦下的条数', merged3.report.blocked === 1, merged3.report);
check('删除名单随合并保留', merged3.profile._removed.length === 1, merged3.profile._removed);

// 没有身份键的条目：合并时丢弃（表里连名字都没有，用户既认不出也用不上），
// 但首次解析时保留 —— 那时用户的描述文本不该因为缺个名字就消失
const nameless = api.normalizeProfile({ projects: [{ name: '', description: '只有描述' }] });
check('首次解析保留无名条目', api.mergeProfile(nameless, null).profile.projects.length === 1);
const mergedNameless = api.mergeProfile(nameless, api.normalizeProfile({ basic: { name: '已有内容' } }));
check('合并时无身份键的条目丢弃', mergedNameless.profile.projects.length === 0, mergedNameless.profile.projects);

// 合并结果存过一轮再读回来，_dirty 不能丢
const roundTrip = api.normalizeProfile(JSON.parse(JSON.stringify(merged.profile)));
check('_dirty 能随存储往返', api.isProfileDirty(roundTrip, 'basic.name') === true, roundTrip.basic._dirty);
check('_dirty 能随存储往返（条目）', api.isProfileDirty(roundTrip, 'experience.0.title') === true);
check('往返后 _removed 保留', Array.isArray(roundTrip._removed));

// ── 13. 本地规则解析（未配 AI 的兜底）──────────
section('13. 本地规则解析');
const resume = `个人简历
张三
性别：男  |  出生：2002.05  |  现居：深圳
手机：138-0000-0000   邮箱：zhangsan@example.com
政治面貌：共青团员  籍贯：广东汕头  民族：汉族

求职意向：产品运营实习生

教育经历
广东海洋大学  新闻学  本科  2022.09-2026.06
GPA: 3.6/4.0  全日制

实习经历
深圳市某某科技有限公司  内容运营实习生  2025.07-2025.10
负责小红书账号内容策划与数据复盘

项目经历
校园二手交易平台  产品负责人  2025.03-2025.06
使用 Figma 完成高保真原型，上线后服务 200+ 用户

技能证书
英语 CET-6、粤语
熟练使用 Excel、SQL、Figma、PS
计算机二级

兴趣爱好
摄影、长跑
特长
视频剪辑

自我评价
做事踏实，能独立推进项目
喜欢研究用户需求

https://github.com/zhangsan`;
const local = api.extractProfileLocally(resume);
check('姓名', local.basic.name === '张三', local.basic.name);
check('性别', local.basic.gender === '男');
check('手机号去横线', local.basic.phone === '13800000000', local.basic.phone);
check('邮箱', local.basic.email === 'zhangsan@example.com');
check('出生日期', local.basic.birthDate === '2002.05', local.basic.birthDate);
check('现居城市', local.basic.currentCity === '深圳', local.basic.currentCity);
check('籍贯', local.basic.hometown === '广东汕头', local.basic.hometown);
check('民族', local.basic.ethnicity === '汉族', local.basic.ethnicity);
check('政治面貌', local.basic.politicalStatus === '共青团员');
check('求职意向岗位', local.intent.targetPosition === '产品运营实习生', local.intent.targetPosition);
check('求职类型=实习', local.intent.jobType === '实习');
check('教育-学校', local.education[0].school === '广东海洋大学', local.education[0] && local.education[0].school);
check('教育-学历归一', local.education[0].degree === '本科');
check('教育-专业', local.education[0].major === '新闻学', local.education[0].major);
check('教育-起止时间', local.education[0].startDate === '2022.09' && local.education[0].endDate === '2026.06',
  local.education[0] && [local.education[0].startDate, local.education[0].endDate]);
check('教育-GPA', local.education[0].gpa === '3.6/4.0', local.education[0].gpa);
check('教育-培养方式', local.education[0].studyMode === '全日制');
check('公司名抽取', local.experience.some(e => e.company.includes('科技有限公司')), local.experience);
check('项目经历抽到', local.projects.length === 1 && local.projects[0].name === '校园二手交易平台', local.projects);
check('技能：Figma 与 SQL 都命中',
  local.skills.some(s => s.name === 'Figma') && local.skills.some(s => s.name === 'SQL'), local.skills);
check('技能：掌握程度从同一行带出',
  local.skills.find(s => s.name === 'SQL').level === '熟练', local.skills);
check('语言：英语带等级', local.languages[0].type === '英语' && local.languages[0].level === 'CET-6', local.languages);
check('语言：粤语单独一条', local.languages.some(l => l.type === '粤语'), local.languages);
check('证书命中', local.certificates.some(c => c.name === '计算机二级'), local.certificates);
check('证书不被技能行污染',
  local.certificates.every(c => !/SQL|Figma|Excel|熟练/.test(c.name)), local.certificates);
check('兴趣爱好', local.extra.hobby === '摄影、长跑', local.extra.hobby);
check('特长', local.extra.strength === '视频剪辑', local.extra.strength);
check('自我评价', /做事踏实/.test(local.extra.selfEvaluation), local.extra.selfEvaluation);
check('作品链接', /github\.com\/zhangsan/.test(local.extra.portfolio), local.extra.portfolio);
check('本地解析有内容', api.profileHasValue(local));
check('本地解析不产生敏感字段', api.flattenProfile(local).every(f => !f.sensitive));
check('本地解析不误判在校职务', local.campusRole.length === 0, local.campusRole);
check('本地解析不误判在校实践', local.campusPractice.length === 0, local.campusPractice);

// ── 14. 在校职务 / 在校实践（新增两组）─────────
section('14. 在校职务 / 在校实践');
const campus = api.extractProfileLocally(`在校职务
2024.09-2025.06 学生会宣传部部长
负责公众号运营，粉丝增长 2000+。

在校实践
2024.07-2024.08 暑期三下乡社会实践
走访 12 个村落完成调研报告。`);
check('在校职务抽到', campus.campusRole.length === 1 && campus.campusRole[0].title === '学生会宣传部部长',
  campus.campusRole);
check('在校职务-时间', campus.campusRole[0].startDate === '2024.09' && campus.campusRole[0].endDate === '2025.06');
check('在校职务-描述', campus.campusRole[0].description.includes('粉丝增长'), campus.campusRole[0].description);
check('在校实践抽到', campus.campusPractice.length === 1 && campus.campusPractice[0].name === '暑期三下乡社会实践',
  campus.campusPractice);
check('在校实践-描述', campus.campusPractice[0].description.includes('12 个村落'));
check('在校职务不进项目经历', campus.projects.length === 0, campus.projects);
check('在校实践不进项目经历', campus.projects.length === 0);

// 「学生工作」含「工作」，必须排在实习之前判，否则整段被当成实习
const studentWork = api.extractProfileLocally(`学生工作
2024.09-2025.06 校学生会主席
统筹 5 个部门。`);
check('学生工作归在校职务而非实习', studentWork.campusRole.length === 1 && studentWork.experience.length === 0,
  { role: studentWork.campusRole, exp: studentWork.experience });

// 「实习实践」含「实践」，实习必须排在实践之前判
const internshipPractice = api.extractProfileLocally(`实习实践
2025.07-2025.10 某某科技有限公司 运营实习生
做了运营。`);
check('实习实践归实习而非在校实践',
  internshipPractice.experience.length === 1 && internshipPractice.campusPractice.length === 0,
  { exp: internshipPractice.experience, prac: internshipPractice.campusPractice });

// 混排章节：技能 / 语言 / 证书 / 奖项四类在同一标题下
const mixed = api.extractProfileLocally(`荣誉以及奖项
荣获国家励志奖学金；校级“三好学生”称号；第十六届蓝桥杯EDA赛道广东赛区二等奖。
全国大学生信息技术认证挑战赛“嵌入式赛道”全国三等奖。

技能证书
英语 CET-6
熟练使用 Excel、SQL
计算机二级`);
check('混排章节：奖项拆成多条', mixed.honors.length === 4, mixed.honors.map(h => h.name));
check('混排章节：奖项按含金量标注级别',
  mixed.honors.find(h => h.name === '国家励志奖学金').level === '国家级', mixed.honors);
check('混排章节：省赛标省级',
  mixed.honors.find(h => h.name.includes('蓝桥杯')).level === '省部级', mixed.honors);
check('混排章节：校级奖标校级',
  mixed.honors.find(h => h.name.includes('三好学生')).level === '校级', mixed.honors);
check('混排章节：技能仍抽到', mixed.skills.some(s => s.name === 'SQL'), mixed.skills);
check('混排章节：语言仍抽到', mixed.languages.some(l => l.type === '英语'), mixed.languages);
check('混排章节：证书仍抽到', mixed.certificates.some(c => c.name === '计算机二级'), mixed.certificates);
// 原文没写级别时不能替它断级别。用「优秀员工」这种完全不含级别词的奖项验证
const noLevelHonor = api.extractProfileLocally('荣誉以及奖项\n优秀员工');
check('原文没写级别时不臆造级别',
  noLevelHonor.honors.length === 1 && noLevelHonor.honors[0].level === '', noLevelHonor.honors);

// ── 15. 空简历与边界 ─────────────────────────
section('15. 边界');
check('空字符串不抛错', (() => { try { api.extractProfileLocally(''); return true; } catch { return false; } })());
check('null 不抛错', (() => { try { api.normalizeProfile(null); return true; } catch { return false; } })());
check('数组入参不抛错', (() => { try { api.normalizeProfile([]); return true; } catch { return false; } })());
check('纯模板简历不产生假姓名', api.extractProfileLocally('个人简历\n求职意向\n教育经历\n工作经历').basic.name === '',
  api.extractProfileLocally('个人简历\n求职意向\n教育经历\n工作经历').basic.name);
check('空 profile 的空缺清单不炸', Array.isArray(api.profileEmptyPaths(api.createEmptyProfile())));

// ── 16. 解析 AI 的「## 分组 + 键：值」文本 ──────
section('16. 文本格式解析');

const idealText = `## 个人信息
姓名：张三
性别：男
出生日期：2002.05
手机号码：13800000000
邮箱：zhangsan@example.com
民族：汉族
最高学历：本科
最高学位：学士
现居城市：深圳
籍贯：广东汕头
政治面貌：共青团员
身份证号：

## 求职意向
期望岗位：产品运营实习生
期望工作城市：深圳
期望月薪（税前）：面议
到岗时间：一周内
求职类型：实习

## 教育经历
学校名称：广东海洋大学
学院名称：文学与新闻传播学院
专业名称：新闻学
学历：本科
开始时间：2022.09
结束时间：2026.06
成绩(GPA)：3.6/4.0
专业排名：专业前20%
培养方式：全日制

## 实习经历
单位名称：深圳市某某科技有限公司
职位名称：内容运营实习生
开始时间：2025.07
结束时间：2025.10
实习内容：负责小红书账号内容策划；完成 30 篇图文

## 项目经历
项目名称：校园二手交易平台
职务：产品负责人
开始时间：2025.03
项目描述：面向校内学生的二手交易平台
技术栈 / 工具：Figma、Axure

## 在校职务
职务名称：学生会宣传部部长
开始时间：2024.09
职务描述：负责公众号运营

## 在校实践
实践名称：暑期三下乡社会实践
实践描述：走访 12 个村落

## 附加信息
兴趣爱好：摄影
特长：视频剪辑
自我评价：做事踏实，能独立推进项目
作品 / 主页链接：https://github.com/zhangsan

## 技能
技能名称：Python
掌握程度：熟练
使用时间总计：3 年
技能名称：SQL
掌握程度：掌握

## 获奖情况
获奖项：国家励志奖学金
获奖级别：国家级
获奖描述：专业前 5%

## 语言能力
语言类型：英语
掌握程度：CET-6

## 证书
证书名称：软件设计师
获得时间：2024.06`;

const p16 = api.parseProfileText(idealText);
check('个人信息-姓名', p16.basic.name === '张三', p16.basic.name);
check('个人信息-手机号', p16.basic.phone === '13800000000');
check('个人信息-民族', p16.basic.ethnicity === '汉族');
check('个人信息-最高学位没被学历串掉', p16.basic.degreeLevel === '学士' && p16.basic.degree === '本科',
  { degree: p16.basic.degree, degreeLevel: p16.basic.degreeLevel });
check('个人信息-政治面貌', p16.basic.politicalStatus === '共青团员');
check('空值字段留空', p16.basic.idCard === '' && p16.basic.bankAccount === '');
check('求职意向-期望工作城市', p16.intent.targetCity === '深圳');
check('求职意向-期望月薪', p16.intent.targetSalary === '面议');
check('教育-学校名称', p16.education[0].school === '广东海洋大学');
check('教育-GPA 与排名分开',
  p16.education[0].gpa === '3.6/4.0' && p16.education[0].rank === '专业前20%',
  [p16.education[0].gpa, p16.education[0].rank]);
check('实习-描述', /30 篇图文/.test(p16.experience[0].description));
check('项目-技术栈带斜杠字段名', p16.projects[0].techStack === 'Figma、Axure', p16.projects[0].techStack);
check('项目-职务落到 role', p16.projects[0].role === '产品负责人', p16.projects[0].role);
check('在校职务-职务名称落到 title', p16.campusRole[0].title === '学生会宣传部部长', p16.campusRole[0]);
check('在校职务-描述', p16.campusRole[0].description === '负责公众号运营');
check('在校实践-实践名称落到 name', p16.campusPractice[0].name === '暑期三下乡社会实践', p16.campusPractice[0]);
check('附加信息-兴趣爱好', p16.extra.hobby === '摄影');
check('附加信息-特长', p16.extra.strength === '视频剪辑');
check('附加信息-自我评价', /做事踏实/.test(p16.extra.selfEvaluation));
check('附加信息-含冒号的链接值', p16.extra.portfolio === 'https://github.com/zhangsan', p16.extra.portfolio);
check('技能-拆成两条', p16.skills.length === 2, p16.skills);
check('技能-掌握程度与年限',
  p16.skills[0].name === 'Python' && p16.skills[0].level === '熟练' && p16.skills[0].years === '3 年', p16.skills[0]);
check('获奖-获奖项落到 name', p16.honors[0].name === '国家励志奖学金', p16.honors[0]);
check('获奖-获奖级别落到 level', p16.honors[0].level === '国家级', p16.honors[0]);
check('语言-语言类型落到 type', p16.languages[0].type === '英语' && p16.languages[0].level === 'CET-6', p16.languages[0]);
check('证书-名称与时间', p16.certificates[0].name === '软件设计师' && p16.certificates[0].date === '2024.06',
  p16.certificates[0]);
check('单条经历数组长度为 1', p16.education.length === 1 && p16.experience.length === 1 && p16.projects.length === 1);
check('解析后有内容', api.profileHasValue(p16));
check('12 组里 10 组有命中',
  GROUP_IDS.filter(id => api.profileGroupStats(p16, api.groupById(id)).filled > 0).length >= 10,
  GROUP_IDS.map(id => api.profileGroupStats(p16, api.groupById(id)).filled));

// 多条经历：同组标题重复出现
const multiBlock = `## 教育经历
学校名称：A 大学
学历：本科
专业名称：软件工程

## 教育经历
学校名称：B 中学
学历：高中

## 实习经历
单位名称：甲公司
职位名称：运营

## 实习经历
单位名称：乙公司
职位名称：产品

## 技能
技能名称：Python
掌握程度：熟练

## 技能
技能名称：SQL
掌握程度：掌握`;
const p17 = api.parseProfileText(multiBlock);
check('重复分组 → 多条教育', p17.education.length === 2, p17.education.length);
check('第二条教育内容正确', p17.education[1].school === 'B 中学' && p17.education[1].degree === '高中');
check('重复分组 → 多条实习', p17.experience.length === 2);
check('第二条实习内容正确', p17.experience[1].company === '乙公司');
check('不同条目字段不串', p17.education[0].school === 'A 大学' && p17.education[0].major === '软件工程');
check('重复分组 → 多条技能', p17.skills.length === 2 && p17.skills[1].name === 'SQL', p17.skills);

// 多条经历：单块内同键重复
const multiKey = `## 教育经历
学校名称：A 大学
学历：本科
学校名称：B 中学
学历：高中`;
const p18 = api.parseProfileText(multiKey);
check('同键重复 → 拆成两条', p18.education.length === 2, p18.education.length);
check('重复拆分的第二条正确', p18.education[1].school === 'B 中学' && p18.education[1].degree === '高中');

// 标题变体
check('标题含序号仍归组', api.parseProfileText('## 教育经历 2\n学校名称：X 大学').education.length === 1);
check('标题含括号仍归组', api.parseProfileText('## 教育经历（第一段）\n学校名称：Y 大学').education.length === 1);
check('别名标题 工作经历', api.parseProfileText('## 工作经历\n公司：Z 公司').experience.length === 1);
check('别名标题 教育背景', api.parseProfileText('## 教育背景\n学校名称：W 大学').education.length === 1);
check('别名标题 基本信息', api.parseProfileText('## 基本信息\n姓名：钱七').basic.name === '钱七');
check('别名标题 个人信息', api.parseProfileText('## 个人信息\n邮箱：a@b.c').basic.email === 'a@b.c');
check('别名标题 实践经历 → 在校实践',
  api.parseProfileText('## 实践经历\n实践名称：支教').campusPractice.length === 1);
check('别名标题 学生工作 → 在校职务',
  api.parseProfileText('## 学生工作\n职务名称：班长').campusRole.length === 1);
check('未知分组被忽略（无有效字段则抛错以便降级）', (() => {
  try { api.parseProfileText('## 随便写写\n旅行'); return false; } catch { return true; }
})());

// 容错
const messyText = `好的，以下是抽取结果：

## 个人信息
- 姓名：张三
- 手机号码：13800000000
手机号码续行说明文字
**备注**：无

## 技能
技能名称：Excel
掌握程度：熟练`;
const p19 = api.parseProfileText(messyText);
check('数字列表符号被容忍', p19.basic.name === '张三' && p19.basic.phone.startsWith('13800000000'), [p19.basic.name, p19.basic.phone]);
check('开场白被忽略', !JSON.stringify(p19).includes('以下是抽取结果'));
check('无法识别的行并入上一字段', /手机号码续行说明文字/.test(p19.basic.phone), p19.basic.phone);
check('加粗符号行不破坏解析', p19.skills[0].name === 'Excel' && p19.skills[0].level === '熟练', p19.skills);
check('空内容抛错', (() => { try { api.parseProfileText('   '); return false; } catch { return true; } })());
check('纯闲聊抛错', (() => { try { api.parseProfileText('抱歉，我无法完成'); return false; } catch { return true; } })());

// JSON 容错分支（模型坚持输出 JSON 时）
const jsonOut = '```json\n{"basic":{"姓名":"李四","手机号码":"13900000000"}}\n```';
check('JSON 输出也能吃下', api.parseProfileText(jsonOut).basic.name === '李四', api.parseProfileText(jsonOut).basic.name);
check('坏 JSON 不炸（退文本解析或抛错）', (() => {
  try { const r = api.parseProfileText('{"basic":{"姓名":'); return r && typeof r === 'object'; } catch { return true; }
})());

// 转义与注入安全
const injected = api.parseProfileText('## 个人信息\n姓名：<script>alert(1)</script>\n手机号码：13800000000');
check('恶意内容按原样存为字符串', injected.basic.name === '<script>alert(1)</script>');
check('恶意内容不产生额外字段', Object.keys(injected.basic).length === api.PROFILE_GROUPS[0].fields.length,
  Object.keys(injected.basic).length);

// 解析 → 预填链路连通
const flatInjected = api.flattenProfile(p16);
check('文本解析结果可生成预填清单', flatInjected.length > 25, flatInjected.length);
check('预填清单含教育路径', flatInjected.some(f => f.path === 'education.0.school'));
check('预填清单含新增分组路径', flatInjected.some(f => f.path === 'campusRole.0.title')
  && flatInjected.some(f => f.path === 'honors.0.name'), flatInjected.map(f => f.path));
check('预填清单默认无敏感项', flatInjected.every(f => !f.sensitive));

// ── 17. 必填与缺失统计（补充引导的数据来源）────
section('17. 必填与缺失统计');
const guide = api.normalizeProfile({
  basic: { name: '张三', phone: '13800000000' },
  education: [{ school: '广东海洋大学', degree: '本科' }]
});
const guideStats = api.profileStats(guide);
check('已填计数', guideStats.filled >= 3, guideStats);
check('必填总数 12', guideStats.requiredTotal === 12);
check('必填已填 = name/phone/degree/school', guideStats.requiredFilled === 4, guideStats);
check('必填缺口 = 8', guideStats.requiredMissing === 8, guideStats);
check('还缺项 = 已填 + 还缺 = total', guideStats.filled + guideStats.missing === guideStats.total, guideStats);
check('percent 由已填/总数得出', guideStats.percent === Math.round(guideStats.filled / guideStats.total * 100));
check('教育组未满：requiredMissing = 4',
  api.profileGroupStats(guide, api.groupById('education')).requiredMissing === 4);
check('空的分组 isEmpty = true', api.profileGroupStats(guide, api.groupById('projects')).isEmpty === true);
check('有内容的分组 isEmpty = false', api.profileGroupStats(guide, api.groupById('basic')).isEmpty === false);

const emptyPaths = api.profileEmptyPaths(guide);
check('空缺清单第一项是必填', emptyPaths[0] === 'basic.email' || emptyPaths[0] === 'basic.gender'
  || emptyPaths[0] === 'basic.birthDate', emptyPaths.slice(0, 5));
check('空缺清单含教育必填（列表组按第一条）', emptyPaths.includes('education.0.college'), emptyPaths.slice(0, 12));
check('空缺清单不含已填字段', !emptyPaths.includes('basic.name') && !emptyPaths.includes('education.0.school'));
check('空缺清单不含派生可得的字段', !emptyPaths.includes('basic.school'));
check('空缺清单不含空分组的可选字段', !emptyPaths.some(p => p.indexOf('projects.') === 0), emptyPaths.filter(p => p.startsWith('projects')));

// ── 18. 经历提取：校招简历的真实排版 ─────────
// 原先只抽公司名（项目经历完全不处理），实习的职位/时间/内容与整段项目经历都丢失。
// 这里锁定真实简历里的几种排版，防止以后回退。
console.log('\n=== 本地规则：经历提取（真实排版） ===');

const realLayout = `个人简历
姓名：刘子涵 居住地：广东省深圳市
手机号码：136-4033-6295 邮箱：zihan@example.com

教育背景 Educational background
2023.09-2027.06（准大四） 广东海洋大学 电子信息工程专业
GPA：3.7（专业前20%）
主修课程：嵌入式Linux系统，云计算与大数据，数字电子技术，模拟电子技术，Python设计。

实习经历 Internship experience
2026.06-2026.8 深圳美高创新股份有限公司 产品营销实习生（迷你PC/NAS）
产品文档与需求支持
将产品硬件参数转化为市场可理解的产品语言，累计输出 8 篇产品文档。
协助产品信息梳理及需求沟通。
2025.09-2025.10 厦门界玺科普有限公司 产品专员
竞品分析与市场研究
针对科普场馆产品线开展全渠道市场调研。

项目经历 Practical experience
2026.03-2026.06 腾讯传播研习生培养专项[鹅创营]第三期 学员-TOP20
采用问卷 + 深度访谈混合研究方法。
2025.12-2026.03 可解释机器学习在电信客户流失预测中的应用
独立作者
基于 7043 条用户数据搭建分析框架。

荣誉以及奖项
荣获国家励志奖学金；校级“三好学生”称号；第十六届蓝桥杯EDA赛道广东赛区二等奖。`;

const real = api.extractProfileLocally(realLayout);

check('经历-实习条数正确', real.experience.length === 2, real.experience.length);
check('经历-行首日期：公司名', real.experience[0].company === '深圳美高创新股份有限公司', real.experience[0].company);
check('经历-行首日期：职位', real.experience[0].title === '产品营销实习生（迷你PC/NAS）', real.experience[0].title);
check('经历-行首日期：开始时间', real.experience[0].startDate === '2026.06', real.experience[0].startDate);
check('经历-行首日期：结束时间补零', real.experience[0].endDate === '2026.08', real.experience[0].endDate);
// 「小标题 + 要点」整段都属于实习内容，小标题本身也要保留
check('经历-小标题+要点聚合为实习内容',
  real.experience[0].description.includes('产品文档与需求支持')
  && real.experience[0].description.includes('累计输出 8 篇产品文档')
  && real.experience[0].description.includes('协助产品信息梳理'),
  real.experience[0].description);
check('经历-第二段公司名', real.experience[1].company === '厦门界玺科普有限公司', real.experience[1].company);
check('经历-第二段职位', real.experience[1].title === '产品专员', real.experience[1].title);
check('经历-第二段描述未与第一段串味',
  !real.experience[1].description.includes('产品文档与需求支持'),
  real.experience[1].description);

check('项目-条数正确（原先完全抽不到）', real.projects.length === 2, real.projects.length);
check('项目-项目名', real.projects[0].name === '腾讯传播研习生培养专项[鹅创营]第三期', real.projects[0].name);
check('项目-角色连后缀一起抽到', real.projects[0].role === '学员-TOP20', real.projects[0].role);
check('项目-起止时间', real.projects[0].startDate === '2026.03' && real.projects[0].endDate === '2026.06',
  [real.projects[0].startDate, real.projects[0].endDate]);
// 角色单独占一行时也要抽到，且不能混进描述
check('项目-角色独立成行时能识别', real.projects[1].role === '独立作者', real.projects[1].role);
check('项目-项目名不含角色字样', real.projects[1].name === '可解释机器学习在电信客户流失预测中的应用', real.projects[1].name);
check('项目-角色行不进描述', !real.projects[1].description.startsWith('独立作者'), real.projects[1].description);

check('教育-专业去掉「专业」后缀', real.education[0].major === '电子信息工程', real.education[0].major);
check('教育-排名与 GPA 分开', real.education[0].rank === '专业前20%' && real.education[0].gpa === '3.7',
  [real.education[0].gpa, real.education[0].rank]);
check('教育-主修课程', real.education[0].courses.includes('Python设计') && real.education[0].courses.includes('云计算与大数据'),
  real.education[0].courses);
check('荣誉奖项独立成组', real.honors.map(h => h.name).join('、').includes('国家励志奖学金'), real.honors);
check('荣誉奖项按含金量标级别', real.honors[0].level === '国家级', real.honors);
check('荣誉奖项不再混在技能里', real.skills.every(s => !/奖学金/.test(s.name)), real.skills);

// 行尾日期排版（同样常见，不能只支持行首）
const tailDate = api.extractProfileLocally(`实习经历
深圳市某某科技有限公司  内容运营实习生  2025.07-2025.10
负责小红书账号内容策划与数据复盘。`);
check('行尾日期：公司名', tailDate.experience[0].company === '深圳市某某科技有限公司', tailDate.experience[0].company);
check('行尾日期：职位', tailDate.experience[0].title === '内容运营实习生', tailDate.experience[0].title);
check('行尾日期：起止时间', tailDate.experience[0].startDate === '2025.07' && tailDate.experience[0].endDate === '2025.10',
  [tailDate.experience[0].startDate, tailDate.experience[0].endDate]);
check('行尾日期：描述', tailDate.experience[0].description.includes('小红书'), tailDate.experience[0].description);

const projTail = api.extractProfileLocally(`项目经历
校园二手交易平台  产品负责人  2025.03-2025.06
使用 Figma 完成高保真原型，上线后服务 200+ 用户。`);
check('项目-行尾日期：项目名', projTail.projects[0].name === '校园二手交易平台', projTail.projects[0].name);
check('项目-行尾日期：角色', projTail.projects[0].role === '产品负责人', projTail.projects[0].role);

// 日期笔误（真实简历里很常见）
const typoDate = api.extractProfileLocally(`项目经历
2025.012-2026.03 某机器学习项目
独立作者
做了些分析。`);
check('日期笔误按意图纠正', typoDate.projects[0].startDate === '2025.12', typoDate.projects[0].startDate);

// 没有章节标题的简历：整篇扫，但只认含公司后缀的条目，
// 否则「广东海洋大学」会被当成一段实习
const noSection = api.extractProfileLocally(`姓名：张三
2022.07-2023.06 某某科技有限公司 产品实习生
负责需求文档撰写。
2021.09-2025.06 某某大学 计算机科学与技术`);
check('无章节时仍能抽到实习', noSection.experience.some(e => (e.company || '').includes('某某科技有限公司')),
  noSection.experience.map(e => e.company));
check('无章节时不把学校当公司', !noSection.experience.some(e => (e.company || '').includes('某某大学')),
  noSection.experience.map(e => e.company));

// 有章节时不能被无章节兜底逻辑干扰
const withSection = api.extractProfileLocally(`教育经历
2021.09-2025.06 某某大学 计算机科学与技术
实习经历
2022.07-2023.06 某某科技有限公司 产品实习生`);
check('有章节时学校不进实习', !withSection.experience.some(e => (e.company || '').includes('某某大学')),
  withSection.experience.map(e => e.company));
check('有章节时实习正常抽出', withSection.experience.some(e => (e.company || '').includes('某某科技')),
  withSection.experience.map(e => e.company));

// ── 19. 提示词与 schema 的一致性 ─────────────
//
// 提示词里的字段清单是写给 AI 看的，schema 是解析时用的。两边只要有一处对不上，
// 表现就是「AI 说它抽到了，但字段表里什么都没有」——不报错，只是静默少一格。
// 这里把提示词里的每个字段名都拿去解析一遍，保证它落在正确的分组里
console.log('\n=== 提示词与 schema 一致性 ===');
const promptPath = path.join(root, 'prompts', 'resume-extract.md');
const promptText = fs.readFileSync(promptPath, 'utf8');
const promptListStart = promptText.indexOf('### 分组与字段名清单');
const promptListEnd = promptText.indexOf('### 三个限制');
check('提示词里有字段清单', promptListStart >= 0 && promptListEnd > promptListStart);

const promptGroups = (() => {
  if (promptListStart < 0 || promptListEnd <= promptListStart) return [];
  const block = promptText.slice(promptListStart, promptListEnd);
  const out = [];
  let current = null;
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(/^\*\*(.+?)\*\*$/);
    if (heading) { current = { label: heading[1].trim(), names: [] }; out.push(current); continue; }
    if (!current) continue;
    for (const name of line.split('、').map(s => s.trim()).filter(Boolean)) current.names.push(name);
  }
  return out;
})();

check('提示词覆盖 12 个分组', promptGroups.length === 12, promptGroups.map(g => g.label));
check('提示词的每个分组都能认出对应 schema 分组',
  promptGroups.every(g => api.resolveGroupFromHeading(g.label)),
  promptGroups.filter(g => !api.resolveGroupFromHeading(g.label)).map(g => g.label));

const promptMismatches = [];
for (const entry of promptGroups) {
  const group = api.resolveGroupFromHeading(entry.label);
  if (!group) continue;
  for (const name of entry.names) {
    if (!api.resolveProfileKeyInGroup(name, group)) promptMismatches.push(`${entry.label} · ${name}`);
  }
}
check('提示词里的每个字段名都能解析到对应分组', promptMismatches.length === 0, promptMismatches);

// 反向：schema 里的字段提示词也必须写到，否则 AI 永远填不上这一格。
// 敏感字段与文件类字段不要求（提示词明确写了不要抽取）
const promptNameSet = new Set(promptGroups.flatMap(g => g.names.map(n => api.normKey(n))));
const missingInPrompt = [];
for (const group of api.PROFILE_GROUPS) {
  for (const field of group.fields) {
    // 敏感字段与文件类字段按设计不由 AI 抽取（提示词里明确写了不要抽）
    if (field.sensitive || field.file) continue;
    // 「最高学历 / 最高学位 / 专业名称 / 毕业学校」按设计从教育经历派生，不由 AI 抽
    if (group.id === 'basic' && ['degree', 'degreeLevel', 'major', 'school'].includes(field.key)) continue;
    if (!promptNameSet.has(api.normKey(field.label))) missingInPrompt.push(`${group.label} · ${field.label}`);
  }
}
check('schema 的字段在提示词里都提到了', missingInPrompt.length === 0, missingInPrompt);

console.log(`\n──────── 结果：${pass} 通过 / ${fail} 失败 ────────`);
process.exit(fail ? 1 : 0);

// 结构化简历数据层验证（无 DOM 依赖，可直接运行）
// 用法：node tests/profile.test.js
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'profile.js'), 'utf8');

const api = new Function(src + `
  return { PROFILE_GROUPS, PROFILE_SCHEMA_VERSION, createEmptyProfile, normalizeProfile,
    getProfilePath, setProfilePath, profileStats, flattenProfile, extractProfileLocally,
    extractJsonBlock, parseProfileJson, parseProfileText, splitProfileBlocks, resolveGroupFromHeading,
    profileHasValue, resolveProfileKey, profileFieldLabel, PROFILE_SENSITIVE_KEYS, createEmptyItem, groupById };
`)();

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ── 1. 空 profile 结构 ────────────────────────
section('1. 空结构');
const empty = api.createEmptyProfile();
check('含全部六组', ['basic','intent','education','experience','projects','skills'].every(k => k in empty));
check('数组组为数组', Array.isArray(empty.education) && Array.isArray(empty.experience) && Array.isArray(empty.projects));
check('profileHasValue(空) === false', api.profileHasValue(empty) === false);
check('空结构 percent = 0', api.profileStats(empty).percent === 0);

// ── 2. 脏数据规整：模拟 AI 各种不听话的返回 ────
section('2. 脏数据容错');
const messy = {
  basicInfo: { name: '张三', 手机号码: '138 0000 0000', email: ['a@b.com'], gender: '男', unknownKey: 'x' },
  jobIntent: { 期望职位: '产品经理', jobType: '实习' },
  work_experience: [{ 公司名称: '腾讯', position_title: '运营', desc: '负责A\n负责B', start: '2024.07' }],
  projects: { name: '单对象不是数组' },
  skills: { 技能: ['SQL','Figma'], selfEvaluation: 12345 },
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
check('skills 数组 → 、拼接', norm.skills.skillTags === 'SQL、Figma');
check('数字值转字符串', norm.skills.selfEvaluation === '12345');
check('未知顶层键被丢弃', !('extraGarbage' in norm) && !('basicInfo' in norm));
check('未知字段被丢弃', norm.basic.unknownKey === undefined);

// ── 3. 顶层平铺兜底 ──────────────────────────
section('3. 顶层平铺兜底');
const flat = api.normalizeProfile({ name: '李四', phone: '13900000000', skillTags: 'Excel' });
check('平铺 name → basic', flat.basic.name === '李四');
check('平铺 phone → basic', flat.basic.phone === '13900000000');
check('平铺 skillTags → skills', flat.skills.skillTags === 'Excel');

// ── 4. 路径读写 ──────────────────────────────
section('4. 路径读写');
const p = api.createEmptyProfile();
api.setProfilePath(p, 'basic.name', '王五');
api.setProfilePath(p, 'education.0.school', '广海大');
check('object 路径写入', api.getProfilePath(p, 'basic.name') === '王五');
check('list 路径写入', api.getProfilePath(p, 'education.0.school') === '广海大');
check('不存在的路径返回空串', api.getProfilePath(p, 'basic.nothing') === '');
check('非法分组写入返回 false', api.setProfilePath(p, 'nope.x', 1) === false);
check('字段标签解析', api.profileFieldLabel('education.0.school') === '教育经历 · 学校', api.profileFieldLabel('education.0.school'));

// ── 5. 敏感字段过滤 ──────────────────────────
section('5. 敏感字段');
const withSecret = api.normalizeProfile({
  basic: { name: '张三', idCard: '440000199001011234', homeAddress: 'XX路1号' },
  skills: { skillTags: 'Figma' }
});
const flatSafe = api.flattenProfile(withSecret, { includeSensitive: false });
const flatAll = api.flattenProfile(withSecret, { includeSensitive: true });
check('默认排除身份证', !flatSafe.some(f => f.key === 'idCard'));
check('默认排除家庭住址', !flatSafe.some(f => f.key === 'homeAddress'));
check('开启后可带出身份证', flatAll.some(f => f.key === 'idCard'));
check('敏感键清单含 4 项', api.PROFILE_SENSITIVE_KEYS.length === 4, api.PROFILE_SENSITIVE_KEYS);
check('统计分别计数敏感项', api.profileStats(withSecret).sensitiveFilled === 2, api.profileStats(withSecret));

// ── 6. flatten 结构（预填消费方）─────────────
section('6. flatten 结构');
const sample = api.normalizeProfile({
  basic: { name: '张三', phone: '13800000000' },
  education: [{ school: '广东海洋大学', degree: '本科' }, { school: '某中学' }],
  skills: { skillTags: 'SQL' }
});
const flatFields = api.flattenProfile(sample);
check('路径唯一', new Set(flatFields.map(f => f.path)).size === flatFields.length);
check('每条含 key/label/value', flatFields.every(f => f.key && f.label && f.value));
check('list 项带 index', flatFields.filter(f => f.multi).every(f => typeof f.index === 'number'));
check('第二条教育经历 index = 1', flatFields.some(f => f.path === 'education.1.school'));
check('总条数正确（name,phone,school×2,degree,skillTags=6）', flatFields.length === 6, flatFields.length);

// ── 7. JSON 提取（AI 输出包裹各种外壳）────────
section('7. JSON 提取');
check('```json 围栏', api.extractJsonBlock('```json\n{"a":1}\n```') === '{"a":1}');
check('``` 无语言标记', api.extractJsonBlock('```\n{"a":1}\n```') === '{"a":1}');
check('前后有解释文字', api.extractJsonBlock('好的，结果如下：\n{"a":1}\n希望有帮助') === '{"a":1}');
check('无 JSON 时抛错', (() => { try { api.extractJsonBlock('抱歉我不能'); return false; } catch { return true; } })());
check('parseProfileJson 端到端', api.parseProfileJson('```json\n{"basic":{"姓名":"赵六"}}\n```').basic.name === '赵六');

// ── 8. 本地规则解析（未配 AI 的兜底）──────────
section('8. 本地规则解析');
const resume = `个人简历
张三
性别：男  |  出生：2002.05  |  现居：深圳
手机：138-0000-0000   邮箱：zhangsan@example.com
政治面貌：共青团员  籍贯：广东汕头

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
check('技能标签命中', /Figma/.test(local.skills.skillTags) && /SQL/.test(local.skills.skillTags), local.skills.skillTags);
check('语言等级命中', /CET-6/.test(local.skills.languages), local.skills.languages);
check('证书命中', /计算机二级/.test(local.skills.certificates), local.skills.certificates);
check('自我评价', /做事踏实/.test(local.skills.selfEvaluation), local.skills.selfEvaluation);
check('作品链接', /github\.com\/zhangsan/.test(local.skills.portfolio), local.skills.portfolio);
check('本地解析有内容', api.profileHasValue(local));
check('本地解析不产生敏感字段', api.flattenProfile(local).every(f => !f.sensitive));

// ── 9. 空简历不炸 ────────────────────────────
section('9. 边界');
check('空字符串不抛错', (() => { try { api.extractProfileLocally(''); return true; } catch { return false; } })());
check('null 不抛错', (() => { try { api.normalizeProfile(null); return true; } catch { return false; } })());
check('数组入参不抛错', (() => { try { api.normalizeProfile([]); return true; } catch { return false; } })());
check('纯模板简历不产生假姓名', api.extractProfileLocally('个人简历\n求职意向\n教育经历\n工作经历').basic.name === '',
  api.extractProfileLocally('个人简历\n求职意向\n教育经历\n工作经历').basic.name);

// ── 10. 解析 AI 的「## 分组 + 键：值」文本 ──────
section('10. 文本格式解析');

// 理想输出（与 prompt 骨架一致）
const idealText = `## 基础信息
姓名：张三
性别：男
出生日期：2002.05
手机号：13800000000
邮箱：zhangsan@example.com
现居城市：深圳
籍贯：广东汕头
政治面貌：共青团员
身份证号：
银行卡号：
家庭住址：
紧急联系人：

## 求职意向
期望岗位：产品运营实习生
期望城市：深圳
期望薪资：
到岗时间：一周内
求职类型：实习

## 教育经历
学校：广东海洋大学
学历：本科
专业：新闻学
学院：文学与新闻传播学院
开始时间：2022.09
结束时间：2026.06
GPA / 排名：3.6/4.0
培养方式：全日制

## 工作与实习
公司：深圳市某某科技有限公司
职位：内容运营实习生
开始时间：2025.07
结束时间：2025.10
工作内容：负责小红书账号内容策划；完成 30 篇图文
业绩成果：账号涨粉 2000+

## 项目经历
项目名：校园二手交易平台
担任角色：产品负责人
开始时间：2025.03
结束时间：2025.06
项目描述：面向校内学生的二手交易平台
技术栈 / 工具：Figma、Axure
成果：上线后服务 200+ 用户

## 技能与补充
语言等级：英语 CET-6、粤语
技能标签：SQL、Figma、PS
证书：计算机二级
自我评价：做事踏实，能独立推进项目
作品 / 主页链接：https://github.com/zhangsan`;

const p10 = api.parseProfileText(idealText);
check('基础信息-姓名', p10.basic.name === '张三', p10.basic.name);
check('基础信息-手机号', p10.basic.phone === '13800000000');
check('基础信息-政治面貌', p10.basic.politicalStatus === '共青团员');
check('空值字段留空', p10.basic.idCard === '' && p10.basic.bankAccount === '');
check('求职意向-岗位', p10.intent.targetPosition === '产品运营实习生');
check('求职意向-到岗时间', p10.intent.availableDate === '一周内');
check('教育-学校', p10.education[0].school === '广东海洋大学');
check('教育-含斜杠的字段名', p10.education[0].gpa === '3.6/4.0', p10.education[0].gpa);
check('工作-描述', /30 篇图文/.test(p10.experience[0].description));
check('项目-技术栈带斜杠字段名', p10.projects[0].techStack === 'Figma、Axure', p10.projects[0].techStack);
check('技能-标签', p10.skills.skillTags === 'SQL、Figma、PS');
check('技能-含冒号的链接值', p10.skills.portfolio === 'https://github.com/zhangsan', p10.skills.portfolio);
check('技能-自我评价', /做事踏实/.test(p10.skills.selfEvaluation));
check('单条经历数组长度为 1', p10.education.length === 1 && p10.experience.length === 1 && p10.projects.length === 1);
check('解析后有内容', api.profileHasValue(p10));

// 多条经历：同组标题重复出现
const multiBlock = `## 教育经历
学校：A 大学
学历：本科
专业：软件工程

## 教育经历
学校：B 中学
学历：高中

## 工作与实习
公司：甲公司
职位：运营

## 工作与实习
公司：乙公司
职位：产品`;
const p11 = api.parseProfileText(multiBlock);
check('重复分组 → 多条教育', p11.education.length === 2, p11.education.length);
check('第二条教育内容正确', p11.education[1].school === 'B 中学' && p11.education[1].degree === '高中');
check('重复分组 → 多条工作', p11.experience.length === 2);
check('第二条工作内容正确', p11.experience[1].company === '乙公司');
check('不同条目字段不串', p11.education[0].school === 'A 大学' && p11.education[0].major === '软件工程');

// 多条经历：单块内同键重复
const multiKey = `## 教育经历
学校：A 大学
学历：本科
学校：B 中学
学历：高中`;
const p12 = api.parseProfileText(multiKey);
check('同键重复 → 拆成两条', p12.education.length === 2, p12.education.length);
check('重复拆分的第二条正确', p12.education[1].school === 'B 中学' && p12.education[1].degree === '高中');

// 标题变体
check('标题含序号仍归组', api.parseProfileText('## 教育经历 2\n学校：X 大学').education.length === 1);
check('标题含括号仍归组', api.parseProfileText('## 教育经历（第一段）\n学校：Y 大学').education.length === 1);
check('别名标题 工作经历', api.parseProfileText('## 工作经历\n公司：Z 公司').experience.length === 1);
check('别名标题 教育背景', api.parseProfileText('## 教育背景\n学校：W 大学').education.length === 1);
check('别名标题 基本信息', api.parseProfileText('## 基本信息\n姓名：钱七').basic.name === '钱七');
check('别名标题 个人信息', api.parseProfileText('## 个人信息\n邮箱：a@b.c').basic.email === 'a@b.c');
check('未知分组被忽略（无有效字段则抛错以便降级）', (() => {
  try { api.parseProfileText('## 兴趣爱好\n旅行'); return false; } catch { return true; }
})());

// 容错
const messyText = `好的，以下是抽取结果：

## 基础信息
- 姓名：张三
- 手机号：13800000000
手机号续行说明文字
**备注**：无

## 技能与补充
技能标签：Excel、SQL`;
const p13 = api.parseProfileText(messyText);
check('数字列表符号被容忍', p13.basic.name === '张三' && p13.basic.phone.startsWith('13800000000'), [p13.basic.name, p13.basic.phone]);
check('开场白被忽略', !JSON.stringify(p13).includes('以下是抽取结果'));
check('无法识别的行并入上一字段', /手机号续行说明文字/.test(p13.basic.phone), p13.basic.phone);
check('加粗符号行不破坏解析', p13.skills.skillTags === 'Excel、SQL');
check('空内容抛错', (() => { try { api.parseProfileText('   '); return false; } catch { return true; } })());
check('纯闲聊抛错', (() => { try { api.parseProfileText('抱歉，我无法完成'); return false; } catch { return true; } })());

// JSON 容错分支（模型坚持输出 JSON 时）
const jsonOut = '```json\n{"basic":{"姓名":"李四","手机号":"13900000000"}}\n```';
check('JSON 输出也能吃下', api.parseProfileText(jsonOut).basic.name === '李四', api.parseProfileText(jsonOut).basic.name);
check('坏 JSON 不炸（退文本解析或抛错）', (() => {
  try { const r = api.parseProfileText('{"basic":{"姓名":'); return r && typeof r === 'object'; } catch { return true; }
})());

// 转义与注入安全
const injected = api.parseProfileText('## 基础信息\n姓名：<script>alert(1)</script>\n手机号：13800000000');
check('恶意内容按原样存为字符串', injected.basic.name === '<script>alert(1)</script>');
check('恶意内容不产生额外字段', Object.keys(injected.basic).length === api.PROFILE_GROUPS[0].fields.length);

// 解析 → 预填链路连通
const flatInjected = api.flattenProfile(p10);
check('文本解析结果可生成预填清单', flatInjected.length > 15, flatInjected.length);
check('预填清单含教育路径', flatInjected.some(f => f.path === 'education.0.school'));
check('预填清单默认无敏感项', flatInjected.every(f => !f.sensitive));

// ── 经历提取：校招简历的真实排版 ─────────────
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
// 「小标题 + 要点」整段都属于工作内容，小标题本身也要保留
check('经历-小标题+要点聚合为工作内容',
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
check('荣誉奖项独立成字段', real.skills.honors.includes('国家励志奖学金') && real.skills.honors.includes('蓝桥杯'),
  real.skills.honors);

// 行尾日期排版（同样常见，不能只支持行首）
const tailDate = api.extractProfileLocally(`工作与实习
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
工作与实习
2022.07-2023.06 某某科技有限公司 产品实习生`);
check('有章节时学校不进实习', !withSection.experience.some(e => (e.company || '').includes('某某大学')),
  withSection.experience.map(e => e.company));
check('有章节时实习正常抽出', withSection.experience.some(e => (e.company || '').includes('某某科技')),
  withSection.experience.map(e => e.company));

console.log(`\n──────── 结果：${pass} 通过 / ${fail} 失败 ────────`);
process.exit(fail ? 1 : 0);

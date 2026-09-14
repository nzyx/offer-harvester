// 网申预填验证：字段语义识别、取值适配、填写计划
// 运行：node tests/form-fill.test.js
//
// 这套断言分两侧：正向用例要求「必须认出并填对」，反向用例要求「必须认不出 / 必须拒绝」。
// 网申预填最大的风险不是漏填，而是填错——把公司规模当成公司名、把验证码当成手机号。
// 所以反向用例和正向用例同等重要，改任何关键词或权重后必须两侧都仍然成立。

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'form-fill.js'), 'utf8');

const api = new Function(src + `
  return {
    FILL_SCORE_THRESHOLD, FILL_LABELS, FILL_REASONS, FILL_RULES, FILL_SILENT_REASONS,
    squashFill, resolveSectionGroup, classifyFillField, blockFillField,
    resolveFillValue, adaptFillValue, adaptDateValue, matchFillOption, parseLooseDate,
    createFillPlan, summarizeFillResult, nextItemIndex, createGroupCursor, keywordScore
  };
`)();

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++;
  console.log(`✗ ${name}${detail !== undefined ? '  →  ' + detail : ''}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// 构造字段特征，只写关心的部分
function F(overrides) {
  return Object.assign({
    ref: 'r1',
    type: 'text',
    tag: 'input',
    name: '',
    id: '',
    label: '',
    placeholder: '',
    ariaLabel: '',
    autocomplete: '',
    optionText: '',
    options: [],
    maxLength: 0,
    hasValue: false,
    sectionTexts: []
  }, overrides || {});
}

// ── 样例简历 ──────────────────────────────────

const PROFILE = {
  version: 1,
  basic: {
    name: '张三', gender: '男', birthDate: '2002.05', phone: '13800000000',
    email: 'zhangsan@example.com', currentCity: '深圳', hometown: '广东汕头',
    politicalStatus: '共青团员', idCard: '440000200205010000', bankAccount: '', homeAddress: '',
    emergencyContact: ''
  },
  intent: {
    targetPosition: '产品运营', targetCity: '深圳 / 广州', targetSalary: '面议',
    availableDate: '随时到岗', jobType: '校招'
  },
  education: [
    {
      school: '广东海洋大学', degree: '本科', major: '新闻学', college: '文学与新闻传播学院',
      startDate: '2022.09', endDate: '2026.06', gpa: '3.6/4.0', studyMode: '全日制'
    },
    { school: '汕头金山中学', degree: '高中', major: '', college: '', startDate: '2019.09', endDate: '2022.06', gpa: '', studyMode: '' }
  ],
  experience: [
    {
      company: '深圳市某某科技有限公司', title: '产品运营实习生', startDate: '2025.07', endDate: '2025.10',
      description: '负责内容排期与用户反馈整理，产出周报 12 份', achievement: '把回复时长从 6 小时压到 2 小时'
    }
  ],
  projects: [
    {
      name: '校园二手交易平台', role: '产品负责人', startDate: '2025.03', endDate: '2025.06',
      description: '面向本校学生的闲置交易小程序', techStack: 'Figma、Axure', achievement: '上线两周 800 注册'
    }
  ],
  skills: {
    languages: '英语 CET-6、粤语', skillTags: 'SQL、Figma、内容运营', certificates: '计算机二级',
    selfEvaluation: '对数据和内容都敏感，喜欢把模糊问题拆成可验证的假设。',
    portfolio: 'github.com/example'
  }
};

// ══════════════════════════════════════════════
section('1. 归一化');
// ══════════════════════════════════════════════

check('驼峰属性名压平', api.squashFill('realName') === 'realname');
check('下划线属性名压平', api.squashFill('real_name') === 'realname');
check('带空格中文压平', api.squashFill('姓 名：') === '姓名');
check('英文标签小写+去空格', api.squashFill('Your Name') === 'yourname');
check('全角冒号被去掉', api.squashFill('邮箱：') === '邮箱');

// ══════════════════════════════════════════════
section('2. 章节归组');
// ══════════════════════════════════════════════

check('识别教育经历', api.resolveSectionGroup(['教育经历']) === 'education');
check('识别「工作与实习」', api.resolveSectionGroup(['工作与实习']) === 'experience');
check('识别项目经验', api.resolveSectionGroup(['项目经验']) === 'projects');
check('识别求职意向', api.resolveSectionGroup(['求职意向']) === 'intent');
check('由近及远取第一个能识别的', api.resolveSectionGroup(['姓名', '教育经历']) === 'education');
check('都认不出返回 null', api.resolveSectionGroup(['其他说明', '备注']) === null);
check('长文本不误判（含「技能」的段落）', api.resolveSectionGroup(['技能']) === 'skills');

// ══════════════════════════════════════════════
section('3. 正向：必须认出的字段');
// ══════════════════════════════════════════════

function expectHit(name, features, expected) {
  const hit = api.classifyFillField(features, { sectionTexts: features.sectionTexts });
  const ok = hit && hit.id === expected && !hit.ambiguous;
  check(name, ok, hit ? `${hit.id}${hit.ambiguous ? '（判为不明确，次优 ' + hit.runnerUp + '）' : ''}` : '未识别');
}

expectHit('姓名（中文标签）', F({ label: '姓名' }), 'basic.name');
expectHit('姓名（name=realName）', F({ name: 'realName', label: '姓名' }), 'basic.name');
expectHit('姓名（autocomplete）', F({ autocomplete: 'name', label: 'Your Name' }), 'basic.name');
expectHit('手机号（label+tel）', F({ label: '手机号码', type: 'tel' }), 'basic.phone');
expectHit('邮箱（type=email）', F({ label: '电子邮箱', type: 'email' }), 'basic.email');
expectHit('性别（下拉）', F({ label: '性别', type: 'select', options: [{ value: '1', text: '男' }] }), 'basic.gender');
expectHit('政治面貌', F({ label: '政治面貌', type: 'select' }), 'basic.politicalStatus');
expectHit('现居城市', F({ label: '现居城市', type: 'select' }), 'basic.currentCity');
expectHit('籍贯', F({ label: '籍贯' }), 'basic.hometown');
expectHit('身份证号', F({ label: '身份证号码', maxLength: 18 }), 'basic.idCard');
expectHit('期望岗位', F({ label: '期望岗位' }), 'intent.targetPosition');
expectHit('期望职位（长词优先于「职位」）', F({ label: '期望职位' }), 'intent.targetPosition');
expectHit('到岗时间', F({ label: '到岗时间', type: 'select' }), 'intent.availableDate');
expectHit('求职类型', F({ label: '求职类型', type: 'select' }), 'intent.jobType');
expectHit('学校名称', F({ label: '学校名称' }), 'education.school');
expectHit('所学专业', F({ label: '所学专业' }), 'education.major');
expectHit('学历', F({ label: '学历', type: 'select' }), 'education.degree');
expectHit('入学时间', F({ label: '入学时间', type: 'date' }), 'education.startDate');
expectHit('毕业时间', F({ label: '毕业时间', type: 'date' }), 'education.endDate');
expectHit('任职起止时间', F({ label: '任职起止时间' }), 'experience.range');
expectHit('公司名称', F({ label: '公司名称' }), 'experience.company');
expectHit('职位名称', F({ label: '职位名称' }), 'experience.title');
expectHit('工作内容（textarea）', F({ label: '工作内容', type: 'textarea' }), 'experience.description');
expectHit('项目名称', F({ label: '项目名称' }), 'projects.name');
expectHit('项目角色', F({ label: '项目角色' }), 'projects.role');
expectHit('技术栈', F({ label: '技术栈' }), 'projects.techStack');
expectHit('专业技能', F({ label: '专业技能', type: 'textarea' }), 'skills.skillTags');
expectHit('外语水平', F({ label: '外语水平' }), 'skills.languages');
expectHit('自我评价（textarea）', F({ label: '自我评价', type: 'textarea' }), 'skills.selfEvaluation');
expectHit('作品链接', F({ label: '作品集链接' }), 'skills.portfolio');

// 章节消歧：同一个「起始时间」在两个章节里必须落到不同分组
expectHit('起始时间 @教育经历', F({ label: '起始时间', type: 'month', sectionTexts: ['教育经历'] }), 'education.startDate');
expectHit('起始时间 @工作经历', F({ label: '起始时间', type: 'month', sectionTexts: ['工作经历'] }), 'experience.startDate');
expectHit('结束时间 @教育经历', F({ label: '结束时间', type: 'month', sectionTexts: ['教育经历'] }), 'education.endDate');
expectHit('开始时间 @项目经历', F({ label: '开始时间', type: 'month', sectionTexts: ['项目经历'] }), 'projects.startDate');
expectHit('描述 @项目经历', F({ label: '描述', type: 'textarea', sectionTexts: ['项目经历'] }), 'projects.description');

// ══════════════════════════════════════════════
section('4. 反向：必须认不出（填错比不填更糟）');
// ══════════════════════════════════════════════

function expectMiss(name, features) {
  const hit = api.classifyFillField(features, { sectionTexts: features.sectionTexts });
  check(name, !hit, hit ? `误判为 ${hit.id}（${hit.score}）` : undefined);
}

expectMiss('公司规模（含「公司」但不是公司名）', F({ label: '公司规模', type: 'number' }));
expectMiss('学校性质（含「学校」但不是校名）', F({ label: '学校性质', type: 'select' }));
expectMiss('出生地（不是出生日期）', F({ label: '出生地' }));
expectMiss('公司行业', F({ label: '公司行业', type: 'select' }));
expectMiss('公司简介', F({ label: '公司简介', type: 'textarea' }));
expectMiss('兴趣爱好', F({ label: '兴趣爱好', type: 'textarea' }));
expectMiss('职业规划', F({ label: '职业规划', type: 'textarea' }));
expectMiss('入职部门', F({ label: '入职部门' }));

// 无章节信息时「起始时间」两义，必须判为不明确而不是硬选一个
const ambiguousHit = api.classifyFillField(F({ label: '起始时间', type: 'month' }), {});
check('无章节的「起始时间」判为不明确', Boolean(ambiguousHit && ambiguousHit.ambiguous),
  ambiguousHit ? `${ambiguousHit.id} 次优 ${ambiguousHit.runnerUp} 分差 ${(ambiguousHit.score - ambiguousHit.runnerUpScore).toFixed(1)}` : '未识别');

// ══════════════════════════════════════════════
section('5. 阻断规则');
// ══════════════════════════════════════════════

check('password 类型', api.blockFillField(F({ type: 'password', label: '设置密码' })) === 'password');
check('短信验证码', api.blockFillField(F({ label: '短信验证码', name: 'smsCode' })) === 'captcha');
check('图形验证码', api.blockFillField(F({ label: '图形验证码' })) === 'captcha');
check('文件上传', api.blockFillField(F({ type: 'file', label: '上传简历附件' })) === 'file');
check('搜索框', api.blockFillField(F({ label: '搜索职位', name: 'searchKeyword' })) === 'search');
check('自定义下拉', api.blockFillField(F({ type: 'custom-select', label: '学历' })) === 'custom-select');
check('禁用字段', api.blockFillField(F({ label: '姓名', disabled: true })) === 'disabled');
check('只读字段', api.blockFillField(F({ label: '姓名', readOnly: true })) === 'readonly');

// research 不该被 search 误伤
check('researchExperience 不被 search 误伤',
  api.blockFillField(F({ name: 'researchExperience', label: '科研经历' })) === null);
check('contactPhone 不被误伤',
  api.blockFillField(F({ name: 'contactPhone', label: '联系电话' })) === null);
check('companyName 不被误伤',
  api.blockFillField(F({ name: 'companyName', label: '公司名称' })) === null);

// ══════════════════════════════════════════════
section('6. 下拉选项匹配');
// ══════════════════════════════════════════════

const DEGREE_OPTS = [
  { value: '', text: '请选择' },
  { value: 'a', text: '大专' },
  { value: 'b', text: '本科' },
  { value: 'c', text: '硕士' },
  { value: 'd', text: '博士' }
];

check('精确匹配', api.matchFillOption('本科', DEGREE_OPTS)?.value === 'b');
check('同义写法（本科→学士）',
  api.matchFillOption('本科', [{ value: 'x', text: '学士' }])?.value === 'x');
check('同义写法（大专→专科）',
  api.matchFillOption('大专', [{ value: 'x', text: '专科' }])?.value === 'x');
check('占位项「请选择」被排除',
  api.matchFillOption('', DEGREE_OPTS) === null);
check('多城市串按包含匹配',
  api.matchFillOption('深圳 / 广州', [{ value: 'sz', text: '深圳' }, { value: 'gz', text: '广州' }])?.value === 'sz');
check('无对应选项返回 null（不猜）',
  api.matchFillOption('面议', [{ value: 'a', text: '3-5K' }, { value: 'b', text: '5-8K' }]) === null);
// 单字值不参与包含匹配：「男」不能配到「男装」这类无关选项
check('单字值不参与包含匹配',
  api.matchFillOption('男', [{ value: 'a', text: '男装' }]) === null);
// 真实表单里性别选项常写成「男性/女性」，靠同义词组兜住
check('单字值靠同义词命中（男→男性）',
  api.matchFillOption('男', [{ value: 'a', text: '男性' }])?.value === 'a');

// ══════════════════════════════════════════════
section('7. 日期适配');
// ══════════════════════════════════════════════

check('2022.09 → date 补 01', api.adaptDateValue('2022.09', 'date').value === '2022-09-01');
check('2022.09 补日时有告知', /核对/.test(api.adaptDateValue('2022.09', 'date').note));
check('2022.09 → month', api.adaptDateValue('2022.09', 'month').value === '2022-09');
check('2022.09.15 → date 原样', api.adaptDateValue('2022.09.15', 'date').value === '2022-09-15');
check('2022-09 → text 保持原样', api.adaptDateValue('2022-09', 'text').value === '2022-09');
check('只有年份 → month 时拒绝（不编造月份）', api.adaptDateValue('2022', 'month').value === '');
check('只有年份 → date 时按 01 月 01 日', api.adaptDateValue('2022', 'date').value === '2022-01-01');
check('非法月份被拒', api.parseLooseDate('2022.13') === null);
check('2022年9月 可解析', api.parseLooseDate('2022年9月')?.month === '09');

// ══════════════════════════════════════════════
section('8. 值适配');
// ══════════════════════════════════════════════

const radioMale = F({ type: 'radio', label: '性别', optionText: '男' });
check('radio 命中自身选项', api.adaptFillValue('男', radioMale, 'basic.gender').ok === true);
check('radio 未命中则不选', api.adaptFillValue('女', radioMale, 'basic.gender').reason === 'option-not-match');
check('radio 同义词命中（男性→男）',
  api.adaptFillValue('男性', radioMale, 'basic.gender').ok === true);

const sel = F({ type: 'select', label: '学历', options: DEGREE_OPTS });
check('select 匹配到选项值', api.adaptFillValue('本科', sel, 'education.degree').value === 'b');
check('select 无匹配时拒绝', api.adaptFillValue('博士后', F({ type: 'select', options: [{ value: 'a', text: '本科' }] }), 'education.degree').reason === 'no-option');

check('单行控件把换行压成分号',
  api.adaptFillValue('第一行\n第二行', F({ type: 'text' }), 'skills.selfEvaluation').value === '第一行；第二行');
check('textarea 保留换行',
  api.adaptFillValue('第一行\n第二行', F({ type: 'textarea' }), 'skills.selfEvaluation').value.includes('\n'));
check('长文本超长时截断并告知',
  (() => { const r = api.adaptFillValue('x'.repeat(50), F({ type: 'textarea', maxLength: 20 }), 'skills.selfEvaluation'); return r.ok && r.value.length === 20 && /截断/.test(r.note); })());
check('手机号超长直接拒绝（截断等于填错）',
  api.adaptFillValue('13800000000', F({ type: 'text', maxLength: 8 }), 'basic.phone').reason === 'too-long');
check('空值不填', api.adaptFillValue('', F({}), 'basic.name').reason === 'no-value');

// ══════════════════════════════════════════════
section('9. 取值');
// ══════════════════════════════════════════════

check('对象型分组取值', api.resolveFillValue(PROFILE, 'basic', 'name', 0) === '张三');
check('列表型分组取第 1 段', api.resolveFillValue(PROFILE, 'education', 'school', 0) === '广东海洋大学');
check('列表型分组取第 2 段', api.resolveFillValue(PROFILE, 'education', 'school', 1) === '汕头金山中学');
check('越界返回空', api.resolveFillValue(PROFILE, 'education', 'school', 5) === '');
check('range 由起止时间拼出', api.resolveFillValue(PROFILE, 'education', 'range', 0) === '2022.09 - 2026.06');
check('不存在的分组返回空', api.resolveFillValue(PROFILE, 'nope', 'x', 0) === '');

// ══════════════════════════════════════════════
section('10. 经历条数推进');
// ══════════════════════════════════════════════

{
  const cursor = api.createGroupCursor();
  check('第一段为 0', api.nextItemIndex(cursor, 'education', 0, 'school') === 0);
  check('同段换字段名仍是同一段', api.nextItemIndex(cursor, 'education', 0, 'major') === 0);
  check('同段字段名重复 → 进入第二段', api.nextItemIndex(cursor, 'education', 0, 'school') === 1);
  check('进入第二段后换字段仍为第二段', api.nextItemIndex(cursor, 'education', 0, 'major') === 1);

  const c2 = api.createGroupCursor();
  check('段落标记变化 → 进入第二段', (() => {
    api.nextItemIndex(c2, 'education', 0, 'school');
    return api.nextItemIndex(c2, 'education', 1, 'school') === 1;
  })());

  // ═══ 真机回归：同组内的同义词不得互相推进游标 ═══
  // 北森表单里「最高学历」「最高学位」都映射 education.degree。按组记账时，
  // 第二个出现就把游标推过末尾（教育经历只有 1 条），结果后面整个教育区块
  // —— 专业、学校、学历、起止时间 —— 全部 no-value。记账必须按「分组+字段」。
  //
  // 已知取舍：两个不同名字的同义字段（毕业学校 / 学校名称）只有一个能取到
  // 第 0 条，另一个会进手动清单。这比按组记账（整块全灭）或按「字段名」记账
  // （会把第一条经历的数据复制进第二个空块）都好 —— 漏填可补，填错难删。
  {
    const c4 = api.createGroupCursor();
    check('同义词①取第 0 条', api.nextItemIndex(c4, 'education', 0, 'degree') === 0);
    check('同义词②（同一语义再次出现）推进到第 1 条',
      api.nextItemIndex(c4, 'education', 0, 'degree') === 1);
    check('同组其它字段不受同义词影响', (() => {
      api.nextItemIndex(c4, 'education', 0, 'degree'); // 最高学位再吃一次
      return api.nextItemIndex(c4, 'education', 0, 'major') === 0
        && api.nextItemIndex(c4, 'education', 0, 'school') === 0;
    })());
    check('同一字段第二次出现才推进', api.nextItemIndex(c4, 'education', 0, 'major') === 1);
  }

  // 端到端：还原第三轮报告的教育区块顺序。
  // 修复前：最高学位把游标推过末尾，整个教育区块全部 no-value。
  // 修复后：除「最高学位」（简历里本就没有学位信息）与「学校名称」（同义字段的
  // 已知取舍）外全部取到值。
  {
    const F = (ref, label, type, sectionSeq) => ({
      ref, type: type || 'text', label, placeholder: '', name: '', id: '', autocomplete: '',
      dataHints: '', ariaLabel: '', title: '', optionText: '', options: [], hasValue: false,
      sectionTexts: [], sectionSeq
    });
    const PROFILE1 = {
      education: [{ school: '广东海洋大学', degree: '本科', major: '电子信息工程', gpa: '3.7', startDate: '2023.09', endDate: '2027.06' }]
    };
    const planEdu = api.createFillPlan([
      F('e1', '最高学历'), F('e2', '最高学位'), F('e3', '专业名称'),
      F('e4', '毕业学校'), F('e5', '学校名称'), F('e6', '成绩(GPA)')
    ], PROFILE1, {});
    const got = {};
    for (const item of planEdu.items) got[item.formLabel] = item.value;
    check('最高学历取到本科', got['最高学历'] === '本科', got);
    check('专业名称取到专业', got['专业名称'] === '电子信息工程', got);
    check('毕业学校取到学校', got['毕业学校'] === '广东海洋大学', got);
    check('GPA 取到成绩', got['成绩(GPA)'] === '3.7', got);
    const eduManual = planEdu.manual.filter(m => m.reason === 'no-item' || m.reason === 'no-value');
    check('取不到值的只有同义字段（最高学位 / 学校名称）',
      eduManual.length === 2
        && eduManual.every(m => m.formLabel === '最高学位' || m.formLabel === '学校名称'),
      eduManual.map(m => m.formLabel));
  }

  const c3 = api.createGroupCursor();
  check('不同分组各自计数互不干扰', (() => {
    api.nextItemIndex(c3, 'education', 0, 'school');
    api.nextItemIndex(c3, 'experience', 0, 'company');
    return api.nextItemIndex(c3, 'education', 0, 'major') === 0
      && api.nextItemIndex(c3, 'experience', 0, 'title') === 0;
  })());
}

// ══════════════════════════════════════════════
section('11. 端到端：填写计划');
// ══════════════════════════════════════════════

// 一份贴近真实网申页的表单
const FORM = [
  // 基础信息
  F({ ref: 'f1', label: '姓名', name: 'realName' }),
  F({ ref: 'f2', label: '性别', type: 'select', options: [{ value: '', text: '请选择' }, { value: 'M', text: '男' }, { value: 'F', text: '女' }] }),
  F({ ref: 'f3', label: '手机号码', type: 'tel', name: 'mobile' }),
  F({ ref: 'f4', label: '电子邮箱', type: 'email', name: 'email' }),
  F({ ref: 'f5', label: '身份证号码', name: 'idCard' }),
  F({ ref: 'f6', label: '紧急联系人', name: 'emergencyContact' }),
  F({ ref: 'f7', label: '上传简历附件', type: 'file' }),
  F({ ref: 'f8', label: '短信验证码', name: 'smsCode' }),
  F({ ref: 'f9', label: '兴趣爱好', type: 'textarea' }),
  // 求职意向
  F({ ref: 'f10', label: '期望岗位', sectionTexts: ['求职意向'] }),
  F({ ref: 'f11', label: '期望城市', type: 'select', sectionTexts: ['求职意向'],
    options: [{ value: '', text: '请选择' }, { value: 'sz', text: '深圳' }, { value: 'gz', text: '广州' }] }),
  F({ ref: 'f12', label: '到岗时间', type: 'select', sectionTexts: ['求职意向'],
    options: [{ value: '', text: '请选择' }, { value: 'now', text: '随时到岗' }, { value: 'w1', text: '一周内' }] }),
  // 教育经历（第一段）
  F({ ref: 'f20', label: '学校名称', sectionTexts: ['教育经历'], sectionSeq: 0 }),
  F({ ref: 'f21', label: '所学专业', sectionTexts: ['教育经历'], sectionSeq: 0 }),
  F({ ref: 'f22', label: '学历', type: 'select', sectionTexts: ['教育经历'], sectionSeq: 0,
    options: [{ value: '', text: '请选择' }, { value: 'a', text: '大专' }, { value: 'b', text: '本科' }] }),
  F({ ref: 'f23', label: '入学时间', type: 'date', sectionTexts: ['教育经历'], sectionSeq: 0 }),
  F({ ref: 'f24', label: '毕业时间', type: 'date', sectionTexts: ['教育经历'], sectionSeq: 0 }),
  // 教育经历（第二段）
  F({ ref: 'f25', label: '学校名称', sectionTexts: ['教育经历'], sectionSeq: 1 }),
  F({ ref: 'f26', label: '学历', type: 'select', sectionTexts: ['教育经历'], sectionSeq: 1,
    options: [{ value: '', text: '请选择' }, { value: 'h', text: '高中' }, { value: 'b', text: '本科' }] }),
  // 工作经历
  F({ ref: 'f30', label: '公司名称', sectionTexts: ['工作经历'], sectionSeq: 2 }),
  F({ ref: 'f31', label: '职位名称', sectionTexts: ['工作经历'], sectionSeq: 2 }),
  F({ ref: 'f32', label: '任职起止时间', sectionTexts: ['工作经历'], sectionSeq: 2 }),
  F({ ref: 'f33', label: '工作内容', type: 'textarea', sectionTexts: ['工作经历'], sectionSeq: 2 }),
  // 已有内容
  F({ ref: 'f40', label: '期望薪资', hasValue: true }),
  F({ ref: 'f41', label: '自我评价', type: 'textarea', hasValue: true })
];

const plan = api.createFillPlan(FORM, PROFILE, {});
const byRef = {};
plan.items.forEach(it => { byRef[it.ref] = it; });
const manualByRef = {};
plan.manual.forEach(m => { manualByRef[m.ref] = m; });

check('计划总数等于字段数', plan.total === FORM.length, plan.total);
check('姓名被填入', byRef.f1?.value === '张三', JSON.stringify(byRef.f1));
check('性别下拉选中 M', byRef.f2?.value === 'M');
check('手机号被填入', byRef.f3?.value === '13800000000');
check('邮箱被填入', byRef.f4?.value === 'zhangsan@example.com');
check('期望岗位被填入', byRef.f10?.value === '产品运营');
check('期望城市近似匹配到深圳', byRef.f11?.value === 'sz' && /核对/.test(byRef.f11.note));
check('到岗时间精确匹配', byRef.f12?.value === 'now');
check('学校（第一段）', byRef.f20?.value === '广东海洋大学');
check('专业（第一段）', byRef.f21?.value === '新闻学');
check('学历下拉选中本科', byRef.f22?.value === 'b');
check('入学时间补日 + 有核对提示', byRef.f23?.value === '2022-09-01' && /核对/.test(byRef.f23.note));
check('毕业时间补日', byRef.f24?.value === '2026-06-01');
check('教育第二段取到中学', byRef.f25?.value === '汕头金山中学');
check('教育第二段学历选中高中', byRef.f26?.value === 'h');
check('公司被填入', byRef.f30?.value === '深圳市某某科技有限公司');
check('职位被填入', byRef.f31?.value === '产品运营实习生');
check('任职起止时间由起止拼出', byRef.f32?.value === '2025.07 - 2025.10');
check('工作内容被填入 textarea', Boolean(byRef.f33?.value));

// 该跳过的必须跳过
check('身份证默认不填', !byRef.f5 && manualByRef.f5?.reason === 'sensitive');
check('紧急联系人默认不填', !byRef.f6 && manualByRef.f6?.reason === 'sensitive');
check('文件上传跳过', !byRef.f7 && manualByRef.f7?.reason === 'file');
check('验证码跳过', !byRef.f8 && manualByRef.f8?.reason === 'captcha');
check('兴趣爱好未识别', !byRef.f9 && manualByRef.f9?.reason === 'unknown');
check('已有内容不覆盖', !byRef.f40 && manualByRef.f40?.reason === 'has-value');
check('已有内容（评价）不覆盖', !byRef.f41 && manualByRef.f41?.reason === 'has-value');

// 敏感字段开关打开后才会填
const planSensitive = api.createFillPlan(FORM, PROFILE, { includeSensitive: true });
const sensRefs = planSensitive.items.map(i => i.ref);
check('开启敏感字段后身份证被填入', sensRefs.indexOf('f5') >= 0);
check('开启敏感字段后果不影响其它跳过项', sensRefs.indexOf('f7') < 0 && sensRefs.indexOf('f8') < 0);

// 覆盖开关打开后已有内容会被改写
const planOverwrite = api.createFillPlan([F({ ref: 'x', label: '自我评价', type: 'textarea', hasValue: true })], PROFILE, { overwrite: true });
check('覆盖开关生效', planOverwrite.items.length === 1 && Boolean(planOverwrite.items[0].value));

// 计划项的元信息要完整，UI 依赖它渲染
const sample = byRef.f20;
check('计划项带 semantic', sample.semantic === 'education.school');
check('计划项带中文语义名', sample.semanticLabel === '学校');
check('计划项带第几段经历', sample.itemIndex === 0);
check('计划项带表单标签', sample.formLabel === '学校名称');
check('计划项带展示值', sample.displayValue === '广东海洋大学');

// 下拉框：写入的是 value，给用户看的必须是选项文字。
// 真实站点里 <option value="1">男</option> 很常见，直接显示 value 用户没法核对。
const selectPlan = api.createFillPlan([
  F({ ref: 'sel1', label: '性别', type: 'select', sectionTexts: ['基础信息'],
    options: [{ value: '', text: '请选择' }, { value: '1', text: '男' }, { value: '2', text: '女' }] })
], PROFILE, {});
check('下拉写入 option 的 value', selectPlan.items[0]?.value === '1', selectPlan.items[0]?.value);
check('下拉展示 option 的文字而非 value', selectPlan.items[0]?.displayValue === '男', selectPlan.items[0]?.displayValue);

// 近似匹配命中的选项也要展示实际选中的那个文字
const partialPlan = api.createFillPlan([
  F({ ref: 'sel2', label: '最高学历', type: 'select', sectionTexts: ['教育经历'],
    options: [{ value: 'x', text: '本科（全日制）' }, { value: 'y', text: '硕士研究生' }] })
], PROFILE, {});
check('近似匹配写入对应 value', partialPlan.items[0]?.value === 'x', partialPlan.items[0]?.value);
check('近似匹配展示实际选项文字', partialPlan.items[0]?.displayValue === '本科（全日制）', partialPlan.items[0]?.displayValue);
check('近似匹配给出核对提示', /核对/.test(partialPlan.items[0]?.note || ''), partialPlan.items[0]?.note);

// radio 展示的是「本项文字」（字段名在分组容器上，不在选项上）
const radioPlan = api.createFillPlan([
  F({ ref: 'r1', label: '性别', optionText: '男', type: 'radio', sectionTexts: ['基础信息'] })
], PROFILE, {});
check('radio 展示本项文字', radioPlan.items[0]?.displayValue === '男', radioPlan.items[0]?.displayValue);

// 一条经历都没有时不应乱填
const emptyPlan = api.createFillPlan([F({ ref: 'e', label: '公司名称', sectionTexts: ['工作经历'] })], { version: 1, basic: {}, experience: [], education: [], projects: [], intent: {}, skills: {} }, {});
check('简历为空时不填', emptyPlan.items.length === 0 && emptyPlan.manual[0]?.reason === 'no-value');

// 表单条数多于简历条数时如实说明
const shortProfile = JSON.parse(JSON.stringify(PROFILE));
shortProfile.education = shortProfile.education.slice(0, 1);
const shortPlan = api.createFillPlan([
  F({ ref: 's1', label: '学校名称', sectionTexts: ['教育经历'], sectionSeq: 0 }),
  F({ ref: 's2', label: '学校名称', sectionTexts: ['教育经历'], sectionSeq: 1 })
], shortProfile, {});
check('第二段经历缺失时不编造', shortPlan.items.length === 1 && shortPlan.manual[0]?.reason === 'no-item',
  JSON.stringify(shortPlan.manual));

// 结果汇总
const summary = api.summarizeFillResult([{ ok: true }, { ok: true }, { ok: false, reason: 'stale' }, { ok: false, reason: 'error' }]);
check('汇总成功数', summary.ok === 2);
check('汇总失效数', summary.stale === 1 && summary.other === 1);

// 每个原因码都要有面向用户的文案，否则 UI 会显示 undefined
const missingReason = Object.keys(api.FILL_REASONS).filter(k => !api.FILL_REASONS[k].title || !api.FILL_REASONS[k].detail);
check('所有原因码都有文案', missingReason.length === 0, missingReason.join(','));

// 每条规则都要有中文显示名，否则 UI 会露出英文 id
const missingLabel = api.FILL_RULES.filter(r => !api.FILL_LABELS[r.id]).map(r => r.id);
check('所有规则都有中文显示名', missingLabel.length === 0, missingLabel.join(','));

// 静默失效的两条防线。都是「不报错但功能坏掉」的类型，只能靠断言兜住：
//   ① 对象字面量里重复的 key —— JS 静默取最后一个，编辑时极易漏掉
//   ② 原因码缺文案 —— 清单里会显示 undefined，或干脆被静默跳过
// option-not-match 曾经两者都中过：没有文案，于是被放进静默列表，
// 结果字段在清单里凭空消失，用户完全不知道发生了什么。
const reasonsBlock = src.match(/const FILL_REASONS = \{([\s\S]*?)\n\};/);
const reasonKeys = [...(reasonsBlock ? reasonsBlock[1] : '').matchAll(/^\s{2}'?([\w-]+)'?:/gm)].map(m => m[1]);
const dupReasons = reasonKeys.filter((k, i) => reasonKeys.indexOf(k) !== i);
check('原因码无重复定义', dupReasons.length === 0, dupReasons.join(','));

check('静默原因列表为空（字段不该无声消失）', api.FILL_SILENT_REASONS.length === 0, api.FILL_SILENT_REASONS);
check('静默列表里没有缺文案的原因码',
  api.FILL_SILENT_REASONS.every(k => api.FILL_REASONS[k] && api.FILL_REASONS[k].title && api.FILL_REASONS[k].detail),
  api.FILL_SILENT_REASONS.filter(k => !api.FILL_REASONS[k] || !api.FILL_REASONS[k].title));

// 用真实计划驱动一遍：产出的每条手动项都必须带标题与说明
const manualEvery = api.createFillPlan([
  F({ ref: 'q1', label: '身份证号', sectionTexts: ['基础信息'] }),
  F({ ref: 'q2', label: '上传简历', type: 'file' }),
  F({ ref: 'q3', label: '验证码', name: 'captcha' }),
  F({ ref: 'q4', label: '学校性质', type: 'select' }),
  F({ ref: 'q5', label: '期望城市', type: 'custom-select' }),
  F({ ref: 'q6', label: '姓名', sectionTexts: ['基础信息'] })
], PROFILE, {});
check('手动清单每项都有标题', manualEvery.manual.every(m => m.title), manualEvery.manual.filter(m => !m.title));
check('手动清单每项都有说明', manualEvery.manual.every(m => m.detail), manualEvery.manual.filter(m => !m.detail));
check('手动清单每项的原因码都有定义', manualEvery.manual.every(m => Boolean(api.FILL_REASONS[m.reason])), manualEvery.manual.map(m => m.reason));
check('custom-select 会进清单并说明原因',
  manualEvery.manual.some(m => m.reason === 'custom-select' && m.title === '自定义下拉框'),
  manualEvery.manual.map(m => m.reason));

// 规则 id 不能重复（重复会让打分永远偏向同一条）
const ids = api.FILL_RULES.map(r => r.id);
check('规则 id 无重复', new Set(ids).size === ids.length);

// ── 12. 新补的网申字段（分类拆开后的互斥性）──
// 这批字段是从旧字段里拆出来的（GPA/排名、籍贯/生源地、证书/荣誉），
// 拆分后两侧必须互不抢占，否则用户会看到值填到了错误的框里。
console.log('\n=== 12. 新补字段的识别与互斥 ===');

const missOf = (label, extra) => api.classifyFillField(F(Object.assign({ label }, extra || {})), {}) ;

check('生源地能被认出', missOf('生源地', { sectionTexts: ['基础信息'] })?.id === 'basic.nativePlace',
  missOf('生源地', { sectionTexts: ['基础信息'] })?.id);
check('生源所在地能被认出', missOf('生源所在地', { sectionTexts: ['基础信息'] })?.id === 'basic.nativePlace');
check('籍贯不会被生源地抢走', missOf('籍贯', { sectionTexts: ['基础信息'] })?.id === 'basic.hometown',
  missOf('籍贯', { sectionTexts: ['基础信息'] })?.id);
check('户籍所在地仍归籍贯', missOf('户籍所在地', { sectionTexts: ['基础信息'] })?.id === 'basic.hometown');

check('专业排名能被认出', missOf('专业排名', { sectionTexts: ['教育经历'] })?.id === 'education.rank',
  missOf('专业排名', { sectionTexts: ['教育经历'] })?.id);
check('班级排名能被认出', missOf('班级排名', { sectionTexts: ['教育经历'] })?.id === 'education.rank');
check('GPA 仍归 GPA 字段', missOf('GPA', { type: 'text', sectionTexts: ['教育经历'] })?.id === 'education.gpa',
  missOf('GPA', { type: 'text', sectionTexts: ['教育经历'] })?.id);
check('平均绩点仍归 GPA 字段', missOf('平均绩点', { type: 'text', sectionTexts: ['教育经历'] })?.id === 'education.gpa');
// 排名已经从 GPA 里拆出来：GPA 框不能吃掉排名字段
check('GPA 不吞排名字段', missOf('专业排名', { sectionTexts: ['教育经历'] })?.id !== 'education.gpa');

check('主修课程能被认出', missOf('主修课程', { type: 'textarea', sectionTexts: ['教育经历'] })?.id === 'education.courses',
  missOf('主修课程', { type: 'textarea', sectionTexts: ['教育经历'] })?.id);
check('核心课程能被认出', missOf('核心课程', { type: 'textarea', sectionTexts: ['教育经历'] })?.id === 'education.courses');
check('课程编号不是课程名', missOf('课程编号', { sectionTexts: ['教育经历'] }) === null,
  missOf('课程编号', { sectionTexts: ['教育经历'] })?.id);

check('所属行业能被认出', missOf('所属行业', { sectionTexts: ['工作经历'] })?.id === 'experience.industry',
  missOf('所属行业', { sectionTexts: ['工作经历'] })?.id);
check('行业规模不是行业名', missOf('行业规模', { sectionTexts: ['工作经历'] }) === null);
check('学校排名不是专业排名', missOf('学校排名', { sectionTexts: ['教育经历'] }) === null);

check('荣誉奖项能被认出', missOf('荣誉奖项', { type: 'textarea', sectionTexts: ['荣誉奖项'] })?.id === 'skills.honors',
  missOf('荣誉奖项', { type: 'textarea', sectionTexts: ['荣誉奖项'] })?.id);
check('获奖情况能被认出', missOf('获奖情况', { type: 'textarea' })?.id === 'skills.honors');
check('奖学金能被认出', missOf('奖学金', { type: 'textarea', sectionTexts: ['荣誉奖项'] })?.id === 'skills.honors');
// 荣誉已独立成字段：证书框不能把获奖情况抢走
check('证书不吞获奖情况', missOf('获奖情况', { type: 'textarea' })?.id !== 'skills.certificates');
check('资格证书仍归证书字段', missOf('资格证书', { type: 'textarea', sectionTexts: ['技能证书'] })?.id === 'skills.certificates',
  missOf('资格证书', { type: 'textarea', sectionTexts: ['技能证书'] })?.id);
check('证书编号不是证书名', missOf('证书编号', { sectionTexts: ['技能证书'] }) === null,
  missOf('证书编号', { sectionTexts: ['技能证书'] })?.id);

// department 在教育与实习两侧都有，靠章节归组消歧 —— 这是刻意设计，不是冲突
console.log('\n--- department 的章节消歧（两侧同词是刻意的）---');
check('部门 + 实习章节 → 部门', missOf('部门', { sectionTexts: ['实习经历'] })?.id === 'experience.department',
  missOf('部门', { sectionTexts: ['实习经历'] })?.id);
check('部门 + 工作章节 → 部门', missOf('部门', { sectionTexts: ['工作经历'] })?.id === 'experience.department');
check('department + 教育章节 → 学院', missOf('', { name: 'department', sectionTexts: ['教育经历'] })?.id === 'education.college',
  missOf('', { name: 'department', sectionTexts: ['教育经历'] })?.id);
check('学院 + 教育章节 → 学院', missOf('学院', { sectionTexts: ['教育经历'] })?.id === 'education.college');
// 没有章节线索时必须判定为「不明确」交给用户，不能硬猜
const deptNoSection = missOf('', { name: 'department' });
check('department 无章节时不硬猜（判为不明确）', deptNoSection && deptNoSection.ambiguous === true,
  deptNoSection && { id: deptNoSection.id, ambiguous: deptNoSection.ambiguous });

// 新字段也要能进预填清单（否则 profile 里填了却填不到页面）
const PLAN_PROFILE = {
  version: 1,
  basic: { name: '张三', nativePlace: '广东汕头' },
  intent: {},
  education: [{ school: '广东海洋大学', rank: '专业前20%', courses: '数字电子技术、Python 程序设计', gpa: '3.7' }],
  experience: [{ company: '某科技公司', title: '产品实习生', department: '产品部', industry: '计算机软件' }],
  projects: [],
  skills: { honors: '国家励志奖学金' }
};
const newFieldPlan = api.createFillPlan([
  F({ ref: 'n1', label: '生源地', sectionTexts: ['基础信息'] }),
  F({ ref: 'n2', label: '专业排名', sectionTexts: ['教育经历'] }),
  F({ ref: 'n3', label: '主修课程', type: 'textarea', sectionTexts: ['教育经历'] }),
  F({ ref: 'n4', label: '部门', sectionTexts: ['工作经历'] }),
  F({ ref: 'n5', label: '所属行业', sectionTexts: ['工作经历'] }),
  F({ ref: 'n6', label: '荣誉奖项', type: 'textarea', sectionTexts: ['荣誉奖项'] })
], PLAN_PROFILE, {});
check('新字段全部进入预填清单', newFieldPlan.items.length === 6, newFieldPlan.items.map(i => i.semantic));
const byRefNew = {};
for (const item of newFieldPlan.items) byRefNew[item.ref] = item;
check('生源地取值正确', byRefNew.n1?.value === '广东汕头', byRefNew.n1?.value);
check('专业排名取值正确', byRefNew.n2?.value === '专业前20%', byRefNew.n2?.value);
check('主修课程取值正确', byRefNew.n3?.value.includes('Python'), byRefNew.n3?.value);
check('部门取值正确', byRefNew.n4?.value === '产品部', byRefNew.n4?.value);
check('所属行业取值正确', byRefNew.n5?.value === '计算机软件', byRefNew.n5?.value);
check('荣誉奖项取值正确', byRefNew.n6?.value === '国家励志奖学金', byRefNew.n6?.value);
check('新字段都有中文语义名', newFieldPlan.items.every(i => i.semanticLabel && i.semanticLabel !== i.semantic),
  newFieldPlan.items.map(i => i.semanticLabel));

// ── 13. 可搜索的自定义下拉框 vs 只读的自定义下拉框 ──
// 中大型招聘系统的「学校 / 部门 / 专业」普遍是脚本接管的 lookup 控件，
// 但同样是「自定义下拉框」，处理方式应当分开：
//   · 可输入的（Element UI / antd 搜索型 Select）→ 填入关键词触发组件筛选，用户点一下即可
//   · 只读的（点击弹窗、不接受键入）→ 真的写不进去，只能跳过
console.log('\n=== 13. 可搜索的自定义下拉框 ===');

const readonlySelect = F({ ref: 's1', label: '学校', name: 'school', type: 'custom-select', sectionTexts: ['教育经历'] });
check('只读的自定义下拉框被跳过', api.blockFillField(readonlySelect) === 'custom-select', api.blockFillField(readonlySelect));
check('缺 searchable 时按只读处理（向后兼容）',
  api.blockFillField(F({ ref: 's2', label: '学校', type: 'custom-select' })) === 'custom-select');

const searchableSelect = F({
  ref: 's3', label: '学校', name: 'school', type: 'custom-select', searchable: true, sectionTexts: ['教育经历']
});
check('可搜索的自定义下拉框不跳过', api.blockFillField(searchableSelect) === null, api.blockFillField(searchableSelect));

const searchableHit = api.classifyFillField(searchableSelect, { sectionTexts: ['教育经历'] });
check('可搜索下拉框仍能识别语义', Boolean(searchableHit) && searchableHit.id === 'education.school',
  searchableHit && searchableHit.id);
// custom-select 与 combobox 是同一个 ARIA 角色的两种实现，按同等类型加分
const plainSelectHit = api.classifyFillField(
  F({ ref: 's4', label: '学校', type: 'select', sectionTexts: ['教育经历'] }), {});
check('custom-select 不被类型不符扣分',
  searchableHit.score >= plainSelectHit.score - 1,
  { customSelect: searchableHit.score, nativeSelect: plainSelectHit.score });

const searchablePlan = api.createFillPlan([searchableSelect], PROFILE, {});
check('可搜索下拉框进入将填写清单', searchablePlan.items.length === 1, searchablePlan.items.length);
check('标记为辅助填入', Boolean(searchablePlan.items[0]) && searchablePlan.items[0].assisted === true,
  searchablePlan.items[0] && searchablePlan.items[0].assisted);
// 没标出来的话，用户会以为填好了，直接提交才发现值丢了
check('说明必须提醒用户点选确认', /点选/.test(searchablePlan.items[0] ? searchablePlan.items[0].note : ''),
  searchablePlan.items[0] && searchablePlan.items[0].note);
check('只读下拉框不进将填写清单', api.createFillPlan([readonlySelect], PROFILE, {}).items.length === 0);
check('普通字段不带辅助标记',
  api.createFillPlan([F({ ref: 's5', label: '姓名', sectionTexts: ['基础信息'] })], PROFILE, {}).items[0].assisted === false);

console.log('\n=== 14. 真机报告驱动：占位符稀释、地区框误填、新字段 ===');
// 以下用例全部来自用户真实简历在北森（hollyland.zhiye.com）网申页导出的诊断报告。
// 报告里的分数与本地复现完全吻合（姓名 9.6、专业名称 11.6、邮箱认不出），
// 说明「label + placeholder=请选择」就是真实特征 —— 断言照这个来写。

// 14.1 无语义占位符不得稀释标签
// 「邮箱」是 lo（弱词）。标签层被「请选择」污染后拿不到「整段匹配」奖励，
// 只剩 5.6 分，永远够不到 7.5 —— 中文里最标准的邮箱写法反而认不出来。
const phCases = [
  ['邮箱', '请选择', 'basic.email'],
  ['邮箱', '请输入', 'basic.email'],
  ['姓名', '请输入姓名', 'basic.name'],
  ['专业名称', '请选择', 'education.major'],
  ['单位名称', '请选择', 'experience.company'],
  ['职位名称', '请选择', 'experience.title'],
  ['项目名称', '请选择', 'projects.name'],
  ['项目描述', '请输入', 'projects.description'],
  ['技能名称', '请选择', 'skills.skillTags']
];
for (const [label, ph, want] of phCases) {
  const hit = api.classifyFillField(F({ ref: 'r', label, placeholder: ph }), {});
  check('「' + label + '」+ 占位符「' + ph + '」仍能认出', Boolean(hit) && hit.id === want, hit && hit.id);
}

// 14.2 报告里原先认不出的真实标签
const newLabels = [
  ['实践名称', ['实践经历'], 'projects.name'],
  ['实践描述', ['实践经历'], 'projects.description'],
  ['职务描述', ['项目经历'], 'projects.description'],
  ['获奖描述', ['技能证书'], 'skills.honors'],
  ['获奖项', ['技能证书'], 'skills.honors'],
  ['证书描述', [], 'skills.certificates']
];
for (const [label, sections, want] of newLabels) {
  const hit = api.classifyFillField(F({ ref: 'r', label, placeholder: '请选择', sectionTexts: sections }),
    { sectionTexts: sections });
  check('「' + label + '」能认出', Boolean(hit) && hit.id === want, hit && hit.id);
}

// 14.3 「职务」在项目侧与工作侧都有，靠章节消歧
const zhiwu = (sections) => api.classifyFillField(
  F({ ref: 'r', label: '职务', placeholder: '请选择', sectionTexts: sections }), { sectionTexts: sections });
check('项目区块里的「职务」判给项目角色', (zhiwu(['项目经历']) || {}).id === 'projects.role', zhiwu(['项目经历']));
check('实习区块里的「职务」判给职位', (zhiwu(['实习经历']) || {}).id === 'experience.title', zhiwu(['实习经历']));
// 章节认不出来时必须判「含义不明确」交用户手填，而不是随便挑一个填错
const zhiwuNoSection = zhiwu([]);
check('章节未知时「职务」判为不明确', Boolean(zhiwuNoSection) && zhiwuNoSection.ambiguous === true, zhiwuNoSection);

// 14.4 国家 / 地区选择框不能被当成手机号
// 报告第 4 行「中国大陆」被识别成 basic.phone 且真的会填进去 ——
// 它是手机号前面的区号选择框。把手机号填进区号框比不填更糟。
for (const label of ['中国大陆', '中国香港', '中国澳门', '中国台湾', '国家/地区', '国籍', '区号']) {
  const plan = api.createFillPlan([F({ ref: 'region', label, placeholder: '请输入手机号码' })], PROFILE, {});
  check('「' + label + '」被挡下不填', plan.items.length === 0, plan.items.map(i => i.semantic));
  check('「' + label + '」给出地区框原因', plan.manual.some(m => m.reason === 'region'),
    plan.manual.map(m => m.reason));
}
check('region 原因有完整文案',
  Boolean(api.FILL_REASONS.region && api.FILL_REASONS.region.title && api.FILL_REASONS.region.detail));
const phonePlan = api.createFillPlan([F({ ref: 'p', label: '手机号码', placeholder: '请输入手机号码' })], PROFILE, {});
check('真正的手机号字段不受影响',
  phonePlan.items.length === 1 && phonePlan.items[0].semantic === 'basic.phone',
  phonePlan.items.map(i => i.semantic));

// 14.5 反向用例不能被这次放宽误伤
for (const label of ['学校性质', '公司规模', '公司行业', '兴趣爱好', '特长', '使用时间总计', '推荐码']) {
  const hit = api.classifyFillField(F({ ref: 'r', label, placeholder: '请选择' }), {});
  check('「' + label + '」仍然认不出', hit === null, hit && hit.id);
}
check('无标签字段仍然认不出',
  api.classifyFillField(F({ ref: 'r', label: '', placeholder: '请选择' }), {}) === null);

// 14.6 「整段匹配」奖励只认整段，不认包含
// 这是弱词得以单独成立的前提，也是不能变成乱认的底线。
const hs = (label) => ({ attr: [''], label: [api.squashFill(label), label], near: [''] });
const scoreWhole = api.keywordScore(hs('邮箱'), '邮箱', 2.5);
const scoreInside = api.keywordScore(hs('邮箱地址'), '邮箱', 2.5);
check('整段匹配的分高于包含匹配', scoreWhole > scoreInside, [scoreWhole, scoreInside]);
check('整段匹配足以让弱词单独成立', scoreWhole >= api.FILL_SCORE_THRESHOLD, scoreWhole);
check('包含匹配不足以让弱词单独成立', scoreInside < api.FILL_SCORE_THRESHOLD, scoreInside);

// 14.8 章节标记兜底字段名后的识别（第二轮报告的 28 个空标签控件）
for (const [label, type, want] of [
  ['学校名称', 'text', 'education.school'],
  ['生源地', 'text', 'basic.nativePlace'],
  ['期望工作城市', 'text', 'intent.targetCity'],
  ['最高学历', 'select', 'education.degree'],
  ['学历', 'select', 'education.degree'],
  ['出生日期', 'text', 'basic.birthDate'],
  ['到岗时间', 'text', 'intent.availableDate']
]) {
  const hit = api.classifyFillField(F({ ref: 'r', label, placeholder: '请选择', type, sectionTexts: [label] }), { sectionTexts: [label] });
  check('兜底标签「' + label + '」能认出', Boolean(hit) && hit.id === want, hit && hit.id);
}
// 没有对应语义的字段必须仍然认不出（兜底不是乱认）
for (const label of ['民族', '掌握程度', '获奖时间', '语言类型']) {
  const hit = api.classifyFillField(F({ ref: 'r', label, placeholder: '请选择', sectionTexts: [label] }), { sectionTexts: [label] });
  check('无规则字段「' + label + '」仍认不出', hit === null, hit && hit.id);
}
// 「开始时间」在教育/实习/项目三组都有 → 必须判不明确，不能随便挑一组填
const startHit = api.classifyFillField(F({ ref: 'r', label: '开始时间', placeholder: '请选择', sectionTexts: ['开始时间'] }), { sectionTexts: ['开始时间'] });
check('「开始时间」判为不明确而不是乱填', Boolean(startHit) && startHit.ambiguous === true, startHit);

// 14.7 实践经历归组
check('「实践经历」归到项目组', api.resolveSectionGroup(['实践经历']) === 'projects', api.resolveSectionGroup(['实践经历']));
check('「社会实践」归到项目组', api.resolveSectionGroup(['社会实践']) === 'projects');
check('「实习经历」仍归到工作与实习组', api.resolveSectionGroup(['实习经历']) === 'experience');

console.log(`\n──────── 结果：${pass} 通过 / ${fail} 失败 ────────`);
process.exit(fail ? 1 : 0);

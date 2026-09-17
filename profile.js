// ── 网申字段表 · 数据层 ────────────────────────
// 职责：定义 12 组标准字段（网申表单镜像）、把 AI/本地的任意输入规整成固定结构、
//       处理 v1→v2 迁移、重新解析时的智能合并、提供读写路径与统计工具。
// 设计约束：本文件不含任何 DOM 操作，可在 node 下直接加载做单元验证。
// 依赖：无（不依赖 common.js / popup.js / form-fill.js）

const PROFILE_SCHEMA_VERSION = 2;

// 12 组标准字段，顺序即网申表单的栏目顺序。
//   type: text | textarea | tags（tags 以「、」分隔存为字符串）
//   required: 网申必填项（参考表单里带 * 的），用于「还缺 N 项」与必填红点
//   sensitive: 默认不写入网申页面的敏感字段
//   file: 只能手动上传的字段（浏览器不允许脚本写 input[type=file]）
const PROFILE_GROUPS = [
  {
    id: 'basic',
    label: '个人信息',
    kind: 'object',
    fields: [
      { key: 'name', label: '姓名', required: true, ph: '张三' },
      { key: 'phone', label: '手机号码', required: true, ph: '13800000000' },
      { key: 'email', label: '邮箱', required: true, ph: 'name@example.com' },
      { key: 'gender', label: '性别', required: true, options: ['男', '女', '保密'] },
      { key: 'birthDate', label: '出生日期', required: true, ph: '2002.05' },
      { key: 'idCard', label: '证件号码（身份证）', sensitive: true, ph: '默认关闭' },
      // 证件照是文件类字段，程序无法写入。放进字段表只为提醒用户别漏，预填时跳过并提示手填
      { key: 'photo', label: '证件照', file: true, ph: '需在网页上手动上传' },
      // 「最高学历 / 最高学位 / 专业名称 / 毕业学校」在教育经历里已经填过一次，
      // 这里留空也能用 —— 预填时会从教育经历里学历最高那条带出（见 PROFILE_DERIVE_RULES）
      { key: 'degree', label: '最高学历', options: ['博士', '硕士', '本科', '大专', '高中'], ph: '留空则用教育经历里的' },
      { key: 'degreeLevel', label: '最高学位', options: ['博士', '硕士', '学士', '无'], ph: '留空则按学历换算' },
      { key: 'major', label: '专业名称', ph: '留空则用教育经历里的' },
      { key: 'ethnicity', label: '民族', ph: '汉族' },
      { key: 'school', label: '毕业学校', ph: '留空则用教育经历里的' },
      // 生源地 ≠ 籍贯：生源地是高考时的户籍所在地，央国企与银行网申的必填项，
      // 且常用于属地岗位匹配，填错会错过本可匹配的岗位
      { key: 'nativePlace', label: '生源地', ph: '广东汕头（高考户籍地）' },
      { key: 'politicalStatus', label: '政治面貌', options: ['中共党员', '中共预备党员', '共青团员', '群众', '民主党派'] },
      { key: 'hometown', label: '籍贯', ph: '广东汕头' },
      { key: 'currentCity', label: '现居城市', ph: '深圳' },
      { key: 'bankAccount', label: '银行卡号', sensitive: true, ph: '默认关闭' },
      { key: 'homeAddress', label: '家庭住址', sensitive: true, ph: '默认关闭' },
      { key: 'emergencyContact', label: '紧急联系人', sensitive: true, ph: '默认关闭' }
    ]
  },
  {
    id: 'intent',
    label: '求职意向',
    kind: 'object',
    fields: [
      { key: 'targetSalary', label: '期望月薪（税前）', ph: '面议' },
      { key: 'targetCity', label: '期望工作城市', required: true, ph: '深圳 / 广州' },
      { key: 'availableDate', label: '到岗时间', options: ['随时到岗', '一周内', '两周内', '一个月内'] },
      // 参考表单的求职意向里没有这两项，但打招呼语与简历优化都要用，保留为扩展字段
      { key: 'targetPosition', label: '期望岗位', ph: '产品经理' },
      { key: 'jobType', label: '求职类型', options: ['实习', '校招', '社招', '兼职'] }
    ]
  },
  {
    id: 'education',
    label: '教育经历',
    kind: 'list',
    itemLabel: '教育经历',
    fields: [
      { key: 'school', label: '学校名称', required: true, ph: '广东海洋大学' },
      { key: 'college', label: '学院名称', required: true, ph: '文学与新闻传播学院' },
      { key: 'major', label: '专业名称', required: true, ph: '新闻学' },
      { key: 'degree', label: '学历', required: true, options: ['博士', '硕士', '本科', '大专', '高中'] },
      { key: 'startDate', label: '开始时间', required: true, ph: '2022.09' },
      { key: 'endDate', label: '结束时间', required: true, ph: '2026.06' },
      { key: 'gpa', label: '成绩(GPA)', ph: '3.7/4.0' },
      // 排名与 GPA 在网申里是两个独立输入框，且「3/120」比「前 5%」更有说服力
      { key: 'rank', label: '专业排名', ph: '前 20% 或 3/120' },
      // 中石油等系统在「其他描述」栏明确要求填核心课程，与岗位相关的 5-8 门
      { key: 'courses', label: '主修课程', type: 'textarea', ph: '数据库原理、数据结构、Python 程序设计' },
      { key: 'studyMode', label: '培养方式', options: ['全日制', '非全日制', '交换', '辅修'] }
    ]
  },
  {
    id: 'experience',
    label: '实习经历',
    kind: 'list',
    itemLabel: '实习',
    fields: [
      { key: 'company', label: '单位名称', ph: 'XX科技有限公司' },
      { key: 'title', label: '职位名称', ph: '产品运营实习生' },
      { key: 'startDate', label: '开始时间', ph: '2025.07' },
      { key: 'endDate', label: '结束时间', ph: '2025.10 或 至今' },
      { key: 'description', label: '实习内容', type: 'textarea', ph: '负责什么、怎么做' },
      { key: 'department', label: '部门', ph: '产品部' },
      { key: 'industry', label: '所属行业', ph: '计算机软件' },
      { key: 'achievement', label: '业绩成果', type: 'textarea', ph: '带数字的结果' }
    ]
  },
  {
    id: 'projects',
    label: '项目经历',
    kind: 'list',
    itemLabel: '项目',
    fields: [
      { key: 'name', label: '项目名称', ph: '校园二手交易平台' },
      { key: 'role', label: '职务', ph: '产品负责人' },
      { key: 'startDate', label: '开始时间', ph: '2025.03' },
      { key: 'endDate', label: '结束时间', ph: '2025.06 或 至今' },
      { key: 'description', label: '项目描述', type: 'textarea', ph: '背景、目标、你做了什么' },
      { key: 'techStack', label: '技术栈 / 工具', ph: 'Figma、Axure' },
      { key: 'achievement', label: '成果', type: 'textarea', ph: '上线效果、数据' }
    ]
  },
  {
    // 学生会 / 班委 / 社团任职。原先这类内容被硬塞进「项目经历」，
    // 语义不通，还会与真正的项目经历抢填同一个表单栏
    id: 'campusRole',
    label: '在校职务',
    kind: 'list',
    itemLabel: '在校职务',
    fields: [
      { key: 'title', label: '职务名称', ph: '学生会宣传部部长' },
      { key: 'startDate', label: '开始时间', ph: '2023.09' },
      { key: 'endDate', label: '结束时间', ph: '2024.06 或 至今' },
      { key: 'description', label: '职务描述', type: 'textarea', ph: '负责什么、做出什么结果' }
    ]
  },
  {
    // 志愿服务 / 社会实践 / 支教。北森等系统的「实践经历」独立于「项目经历」，
    // schema 里没有它就只能塞进项目，用户补也补不到正确的位置
    id: 'campusPractice',
    label: '在校实践',
    kind: 'list',
    itemLabel: '在校实践',
    fields: [
      { key: 'name', label: '实践名称', ph: '暑期三下乡社会实践' },
      { key: 'startDate', label: '开始时间', ph: '2024.07' },
      { key: 'endDate', label: '结束时间', ph: '2024.08 或 至今' },
      { key: 'description', label: '实践描述', type: 'textarea', ph: '做了什么、有什么产出' }
    ]
  },
  {
    // 参考表单的「附加信息」带「添加」按钮，是可重复块组件。这里按对象型处理：
    // 它本质是「一人一份」，做成列表会让用户每填一次都要先点「+ 添加一条」
    id: 'extra',
    label: '附加信息',
    kind: 'object',
    fields: [
      { key: 'hobby', label: '兴趣爱好', ph: '摄影、长跑' },
      { key: 'strength', label: '特长', ph: '视频剪辑、公众表达' },
      // 后两项是扩展字段：参考表单没有，但打招呼语与简历优化要读它们
      { key: 'selfEvaluation', label: '自我评价', type: 'textarea', ph: '三句话以内' },
      { key: 'portfolio', label: '作品 / 主页链接', type: 'textarea', ph: 'github.com/xxx' }
    ]
  },
  {
    // 原先是「一坨文字」的 skillTags，而表单要的是「技能名称 + 掌握程度 +
    // 使用时间总计 + 技能描述」这样一条一条的，只能改成列表
    id: 'skills',
    label: '技能',
    kind: 'list',
    itemLabel: '技能',
    fields: [
      { key: 'name', label: '技能名称', ph: 'Python' },
      { key: 'level', label: '掌握程度', options: ['精通', '熟练', '掌握', '了解', '入门'] },
      { key: 'years', label: '使用时间总计', ph: '3 年' },
      { key: 'description', label: '技能描述', type: 'textarea', ph: '用它做过什么' }
    ]
  },
  {
    id: 'honors',
    label: '获奖情况',
    kind: 'list',
    itemLabel: '获奖',
    fields: [
      { key: 'name', label: '获奖项', ph: '国家励志奖学金' },
      { key: 'date', label: '获奖时间', ph: '2024.10' },
      // 级别是表单的独立下拉框，也是排序依据（国家级 > 省部级 > 校级）
      { key: 'level', label: '获奖级别', options: ['国家级', '省部级', '市级', '校级', '院级'] },
      { key: 'description', label: '获奖描述', type: 'textarea', ph: '获奖原因或名次' }
    ]
  },
  {
    id: 'languages',
    label: '语言能力',
    kind: 'list',
    itemLabel: '语言',
    fields: [
      { key: 'type', label: '语言类型', options: ['英语', '日语', '韩语', '法语', '德语', '粤语'] },
      // 掌握程度放开成自由文本：「CET-6 / 读写流利」这类写法在表单里也只能整体填
      { key: 'level', label: '掌握程度', ph: 'CET-6 / 读写流利' }
    ]
  },
  {
    id: 'certificates',
    label: '证书',
    kind: 'list',
    itemLabel: '证书',
    fields: [
      { key: 'name', label: '证书名称', ph: '软件设计师' },
      { key: 'date', label: '获得时间', ph: '2024.06' },
      { key: 'description', label: '证书描述', type: 'textarea', ph: '发证机构或用途' }
    ]
  }
];

// 列表型分组的「条目身份键」：重新解析时用它把 AI 抽到的新条目与已有条目对上，
// 对不上才不会同一段经历出现两条。sensitive/file 占比高或本来就无名的分组不在此列
const PROFILE_MATCH_KEYS = {
  education: 'school',
  experience: 'company',
  projects: 'name',
  campusRole: 'title',
  campusPractice: 'name',
  skills: 'name',
  honors: 'name',
  languages: 'type',
  certificates: 'name'
};

// 学历等级：用于从教育经历里挑出「最高」那一条（数字越大越高）
const PROFILE_DEGREE_RANK = { '博士': 5, '硕士': 4, '本科': 3, '大专': 2, '高中': 1 };

// 学历 → 学位。参考表单里「最高学位」是独立一栏，而教育经历只记学历，
// 所以这一项由学历换算得出，不让用户填两遍
const PROFILE_DEGREE_TO_LEVEL = { '博士': '博士', '硕士': '硕士', '本科': '学士', '大专': '无', '高中': '无' };

// 派生回退：个人信息里这几个字段留空时，从教育经历里学历最高那条带出，
// 预填时两栏都能填上，用户只需要补一处
const PROFILE_DERIVE_RULES = {
  'basic.degree': { key: 'degree' },
  'basic.degreeLevel': { key: 'degree', map: PROFILE_DEGREE_TO_LEVEL },
  'basic.major': { key: 'major' },
  'basic.school': { key: 'school' }
};

// AI 返回的分组名可能五花八门，这里做归并。
// ⚠️ 「实践」类词汇不能给 projects：北森等系统的「实践经历」是独立一栏
const PROFILE_GROUP_ALIASES = {
  basic: ['basic', 'basicinfo', 'basic_info', 'personal', 'personalinfo', 'personal_info', 'profile', '个人信息', '基础信息', '基本信息'],
  intent: ['intent', 'jobintent', 'job_intent', 'expectation', 'expectations', 'jobexpectation', '求职意向', '求职意愿', '意向'],
  education: ['education', 'educations', 'educationexperience', 'education_experience', 'educationbackground', '教育经历', '教育背景', '学历'],
  experience: ['experience', 'experiences', 'workexperience', 'work_experience', 'internship', 'internships', 'work', '实习经历', '工作经历', '工作与实习'],
  projects: ['projects', 'project', 'projectexperience', 'project_experience', '项目经历', '项目经验'],
  campusRole: ['campusrole', 'campus_role', 'studentwork', 'student_work', '在校职务', '校园职务', '校内职务', '学生工作', '社团经历', '社团职务'],
  // 只用复合词，不用「实践」这种裸词 —— 它会误命中「实习实践」
  campusPractice: ['campuspractice', 'campus_practice', 'practice', 'socialpractice', 'social_practice', '在校实践', '社会实践', '校园实践', '实践活动', '志愿活动', '实践经历'],
  extra: ['extra', 'additional', 'addition', 'others', 'misc', '附加信息', '其他信息', '补充信息', '兴趣爱好', '特长'],
  skills: ['skills', 'skill', '技能', '专业技能', '技能特长', '技能证书', '技能与补充'],
  honors: ['honors', 'honor', 'awards', 'award', '获奖情况', '荣誉奖项', '获奖经历', '荣誉', '奖项', '奖励'],
  languages: ['languages', 'language', 'languageability', '语言能力', '语言水平', '外语水平', '语言等级'],
  certificates: ['certificates', 'certificate', 'certs', 'certifications', '证书', '资格证书', '证书情况']
};

// 字段级别名（AI 偶尔不用标准键名）。这份表是**全局共享**的，只放「换个分组也成立」
// 的别名（姓名、手机、邮箱、起止时间…）。
const PROFILE_KEY_ALIASES = {
  name: ['fullname', 'full_name', 'realname', 'real_name', 'username', 'chinesename',
    '姓名', '名字', '真实姓名', '中文姓名'],
  phone: ['mobile', 'phonenumber', 'phone_number', 'tel', 'telephone', '手机', '手机号码', '电话', '联系电话'],
  email: ['mail', 'emailaddress', 'email_address', '邮箱地址', '电子邮箱'],
  gender: ['sex', '性别'],
  birthDate: ['birthday', 'birth', 'dob', '出生年月', '出生日期', '生日'],
  idCard: ['idnumber', 'identitycard', '身份证号码', '身份证号', '身份证', '证件号码', '证件号'],
  photo: ['photourl', 'photo_url', 'avatar', '证件照', '照片', '头像'],
  ethnicity: ['nation', 'ethnicgroup', 'ethnic_group', 'ethnic', '民族'],
  degree: ['education_level', 'educationlevel', 'qualification', '学历层次', '学历', '最高学历'],
  // 注意：不能把 degree 当学位别名，那会把「学历」抢成「学位」
  degreeLevel: ['academicdegree', 'academic_degree', 'degreetype', '学位', '最高学位', '所获学位'],
  major: ['speciality', 'majorname', '专业', '专业名称'],
  // 注意：不能把 department 当作学院的别名 —— 实习经历里的「部门」也叫 department
  college: ['faculty', 'schoolof', 'school_of', '院系', '学院', '学院名称'],
  school: ['university', 'schoolname', 'school_name', '毕业院校', '毕业学校', '院校', '学校', '学校名称', '就读学校'],
  nativePlace: ['nativeplace', 'native_place', '生源所在地', '高考户籍所在地', '生源', '生源地'],
  politicalStatus: ['politicalstatus', 'political_status', '政治面貌', '政治身份'],
  hometown: ['nativeplace_origin', '籍贯地', '籍贯', '老家', '故乡', '户籍所在地', '户籍地'],
  currentCity: ['city', 'location', 'current_location', 'currentcity', 'current_city',
    '现居地', '所在城市', '居住城市', '现居城市', '现居住地', '当前城市'],
  bankAccount: ['bankcard', 'bank_card', '银行卡号', '银行账号', '银行卡'],
  homeAddress: ['postaladdress', 'postal_address', 'homeaddress', 'home_address',
    '家庭住址', '通讯地址', '联系地址', '居住地址', '现住址', '详细地址'],
  emergencyContact: ['emergencycontact', 'emergency_contact', '紧急联系人', '紧急联系电话'],
  targetSalary: ['salary', 'expectedsalary', 'expected_salary', 'desiredsalary',
    '期望薪资', '期望薪酬', '期望月薪', '期望工资', '薪资要求', '薪酬要求'],
  targetCity: ['expectedcity', 'expected_city', 'desiredcity', 'worklocation',
    '期望城市', '期望工作城市', '期望工作地点', '期望工作地', '意向城市', '意向工作地'],
  availableDate: ['available', 'onboarddate', 'onboard_date', 'entrydate', 'entry_date', '到岗时间', '到岗日期', '入职时间'],
  targetPosition: ['position', 'expectedposition', 'expected_position', 'desiredposition', 'jobintention',
    '期望岗位', '期望职位', '期望工作岗位', '意向岗位', '意向职位', '目标岗位', '应聘岗位'],
  jobType: ['jobtype', 'job_type', 'jobnature', 'job_nature', '求职类型', '求职性质', '工作性质', '应聘类型'],
  startDate: ['start', 'from', 'begin', '起始时间', '开始日期', '开始时间', '入学时间', '入职时间'],
  endDate: ['end', 'to', 'finish', '结束时间', '结束日期', '毕业时间', '离职时间'],
  // GPA 与排名在旧版本是合并成「GPA / 排名」一个字段的，别名要保留以兼容旧数据与 AI 输出
  gpa: ['gradepoint', 'grade_point', 'gparank', 'gpa_score', 'gpa/排名', 'gpa排名', '绩点', '平均绩点', '成绩'],
  rank: ['ranking', 'classrank', 'class_rank', 'professionrank',
    '排名', '专业排名', '年级排名', '班级排名', '成绩排名'],
  courses: ['corecourses', 'core_courses', 'maincourses', 'main_courses',
    '核心课程', '主要课程', '修读课程', '专业课程', '主修课程'],
  studyMode: ['studymode', 'study_mode', '培养方式', '培养类型', '学习形式'],
  company: ['companyname', 'company_name', 'organization', 'employer',
    '公司名称', '工作单位', '单位名称', '公司', '单位'],
  department: ['dept', 'division', 'departmentname', '所属部门', '部门名称', '任职部门', '所在部门', '部门'],
  title: ['position_title', 'jobtitle', 'job_title', 'rolename', 'role_title',
    '职位名称', '岗位名称', '实习职位', '实习岗位', '职位', '岗位'],
  industry: ['business', 'sector', 'industryname', 'industry_name', '所属行业', '行业类别', '行业领域', '行业'],
  // 「描述」类只留最泛的几个；具体的「项目描述 / 实践描述 / 技能描述」放在
  // PROFILE_GROUP_KEY_ALIASES 里按分组生效，否则「证书描述」会串到实习内容上
  description: ['desc', 'content', 'detail', 'details', '描述'],
  achievement: ['achievements', 'result', 'results', 'outcome',
    '工作成果', '工作业绩', '业绩成果', '项目成果', '项目业绩', '主要业绩', '成果', '业绩'],
  role: ['projectrole', 'project_role', 'duty', '担任角色', '项目角色', '项目职务', '担任职务', '职务'],
  techStack: ['tech', 'stack', 'technology', 'tools',
    '技术栈', '主要技术', '使用工具', '技术工具', '开发工具', '技术', '工具'],
  hobby: ['interest', 'interests', 'hobbies', '兴趣爱好', '个人爱好', '爱好', '兴趣'],
  strength: ['specialty', 'strongpoint', 'strong_point', '特长', '专长', '个人特长'],
  selfEvaluation: ['selfevaluation', 'self_evaluation', 'summary', 'selfintro', 'self_introduction',
    '自我评价', '个人评价', '个人总结', '自我介绍'],
  portfolio: ['portfolio_url', 'website', 'homepage', 'link', '作品链接', '作品 / 主页链接', '个人主页', '作品集'],
  level: ['proficiency', 'mastery', '级别', '水平'],
  years: ['useyears', 'use_years', 'experienceyears', '使用时间总计', '使用年限', '使用时间', '年限'],
  date: ['awarddate', 'award_date', 'getdate', 'get_date'],
  type: ['languagetype', 'language_type', '语言类型', '语种']
};

// 只在该分组内生效的别名。
//
// ⚠️ 为什么必须单独一张表：`name` 这个 key 在项目、在校实践、技能、证书、获奖里
// 都用同一个名字，`description` 在实习、项目、在校职务、在校实践、技能、获奖、
// 证书里也都叫 description。把这些分组的专属叫法塞进全局别名表，会让
// 「获奖项：国家励志奖学金」在「项目经历」分组里被认成 `name`（项目名）——
// 字段会填到完全不相干的位置上。分组内的叫法只能在分组内生效
const PROFILE_GROUP_KEY_ALIASES = {
  basic: {
    idCard: ['证件号码'],
    degree: ['最高学历'],
    degreeLevel: ['最高学位'],
    photo: ['证件照']
  },
  intent: {
    targetSalary: ['期望月薪（税前）', '期望月薪'],
    targetCity: ['期望工作城市'],
    availableDate: ['到岗']
  },
  education: {
    school: ['学校名称'],
    college: ['学院名称'],
    major: ['专业名称'],
    degree: ['学历'],
    courses: ['主修课程']
  },
  experience: {
    company: ['单位名称'],
    title: ['职位名称'],
    description: ['实习内容', '工作内容', '工作描述', '工作职责', '岗位职责', '职务描述', '职责描述'],
    achievement: ['业绩成果']
  },
  projects: {
    name: ['项目名', '项目名称', 'projectname'],
    role: ['职务'],
    description: ['项目描述', '项目简介', '项目内容', '项目介绍', '职务描述', '职责描述'],
    techStack: ['技术栈 / 工具'],
    achievement: ['项目成果', '项目产出']
  },
  campusRole: {
    title: ['职务名称', '职务'],
    description: ['职务描述', '职责描述']
  },
  campusPractice: {
    name: ['实践名称', '实践项目', '实践课题'],
    description: ['实践描述', '实践内容']
  },
  extra: {
    hobby: ['兴趣爱好'],
    strength: ['特长'],
    selfEvaluation: ['自我评价'],
    portfolio: ['作品 / 主页链接']
  },
  skills: {
    name: ['技能名称', '技能', 'skillname'],
    level: ['掌握程度', '熟练程度'],
    years: ['使用时间总计'],
    description: ['技能描述']
  },
  honors: {
    name: ['获奖项', '奖项名称', '荣誉名称', '奖励名称'],
    date: ['获奖时间', '获奖年月'],
    level: ['获奖级别', '奖项级别'],
    description: ['获奖描述']
  },
  languages: {
    type: ['语言类型'],
    level: ['掌握程度']
  },
  certificates: {
    name: ['证书名称', '证书', 'certificatename'],
    date: ['获得时间', '取得时间'],
    description: ['证书描述']
  }
};

// key → 字段元信息（同一 key 在多个分组出现时保留首个，语义一致）
const PROFILE_FIELD_INDEX = (() => {
  const index = {};
  for (const group of PROFILE_GROUPS) {
    for (const field of group.fields) {
      if (!index[field.key]) {
        index[field.key] = {
          key: field.key,
          label: field.label,
          type: field.type || 'text',
          sensitive: Boolean(field.sensitive),
          file: Boolean(field.file),
          required: Boolean(field.required),
          multi: group.kind === 'list',
          groupId: group.id,
          groupLabel: group.label
        };
      }
    }
  }
  return index;
})();

// 反向索引：别名（小写、去下划线和空格）→ 标准 key。作为「分组内找不到」时的兜底
const PROFILE_ALIAS_LOOKUP = (() => {
  const lookup = {};
  for (const group of PROFILE_GROUPS) {
    for (const field of group.fields) {
      lookup[normKey(field.key)] = field.key;
      lookup[normKey(field.label)] = field.key;
      for (const alias of PROFILE_KEY_ALIASES[field.key] || []) lookup[normKey(alias)] = field.key;
    }
  }
  return lookup;
})();

// 出现在多个分组里的 key。全局兜底遇到这些 key 时一律作废 ——
// `name` 出现在 6 个分组里（姓名/项目名/实践名称/技能名称/证书名称/获奖项），
// 靠 key 名反推不出该落到哪个分组。「获奖项」的全局映射结果是 `name`，
// 于是它在「项目经历」分组里会被认成项目名
const PROFILE_AMBIGUOUS_KEYS = (() => {
  const counts = {};
  for (const group of PROFILE_GROUPS) {
    for (const field of group.fields) counts[field.key] = (counts[field.key] || 0) + 1;
  }
  return new Set(Object.keys(counts).filter(key => counts[key] > 1));
})();

const PROFILE_SENSITIVE_KEYS = PROFILE_GROUPS
  .flatMap(g => g.fields.filter(f => f.sensitive).map(f => f.key));

// 全部必填栏位，形如 `basic.name` / `education.school`（列表型对所有条目生效）
const PROFILE_REQUIRED_KEYS = PROFILE_GROUPS
  .flatMap(g => g.fields.filter(f => f.required).map(f => g.id + '.' + f.key));

function normKey(key) {
  return String(key).toLowerCase().replace(/[\s_\-]/g, '');
}

// 把任意键名解析为标准 key（全局，不看分组）。无法识别返回 null
function resolveProfileKey(rawKey) {
  return PROFILE_ALIAS_LOOKUP[normKey(rawKey)] || null;
}

// 分组内优先的键名解析。
//
// 为什么必须带分组：12 组里有大量同名 key —— `name` 在项目/实践/技能/证书/获奖里
// 都叫 name，`description` 在七个分组里都有，`level` 在技能里是「掌握程度」而在获奖里是
// 「获奖级别」。只看全局别名表会把「获奖项」解成「姓名」。三级查找：
//   ① 本分组字段的 key 与 label（表单就叫这个名字，最可信）
//   ② 本分组的专属别名（PROFILE_GROUP_KEY_ALIASES）
//   ③ 全局别名，且解出的 key 必须存在于本分组
// 三级都落空一律返回 null（该行按上一字段的续行处理）—— 宁缺勿错，绝不猜
function resolveProfileKeyInGroup(rawKey, group) {
  const target = normKey(rawKey);
  if (!target) return null;
  if (!group) return PROFILE_ALIAS_LOOKUP[target] || null;

  for (const field of group.fields) {
    if (normKey(field.key) === target || normKey(field.label) === target) return field.key;
  }

  const scoped = PROFILE_GROUP_KEY_ALIASES[group.id] || {};
  for (const field of group.fields) {
    for (const alias of scoped[field.key] || []) {
      if (normKey(alias) === target) return field.key;
    }
  }
  for (const field of group.fields) {
    for (const alias of PROFILE_KEY_ALIASES[field.key] || []) {
      if (normKey(alias) === target) return field.key;
    }
  }

  const global = PROFILE_ALIAS_LOOKUP[target];
  if (!global || PROFILE_AMBIGUOUS_KEYS.has(global)) return null;
  return group.fields.some(f => f.key === global) ? global : null;
}

function createEmptyProfile() {
  const profile = { version: PROFILE_SCHEMA_VERSION, updatedAt: '', _removed: [] };
  for (const group of PROFILE_GROUPS) {
    // 对象型分组也补全全部键（而非空对象），保证「本地解析」与「AI 解析」产出同一种结构
    profile[group.id] = group.kind === 'list' ? [] : createEmptyItem(group);
  }
  return profile;
}

// 空条目不预置 _dirty：只有用户真的改过某个字段才会出现这个键。
// 预置空数组会让「是否手工填过」这件事失去信号，也会污染对象键名断言
function createEmptyItem(group) {
  const item = {};
  for (const field of group.fields) item[field.key] = '';
  return item;
}

// 值规整：数组 → 「、」拼接；数字/布尔 → 字符串；对象 → 丢弃
function normalizeValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map(v => (v == null ? '' : (typeof v === 'object' ? '' : String(v).trim())))
      .filter(Boolean)
      .join('、');
  }
  if (typeof value === 'object') return '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value).replace(/\s*\n\s*/g, '\n').trim();
}

// 单个对象/条目 → 按 schema 取字段
function normalizeItem(raw, group) {
  const out = createEmptyItem(group);
  if (!raw || typeof raw !== 'object') return out;

  // 先做键名映射（含别名），分组内优先
  const mapped = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    if (rawKey === '_dirty') continue;
    const key = resolveProfileKeyInGroup(rawKey, group);
    if (key) {
      const value = normalizeValue(rawValue);
      if (value && !mapped[key]) mapped[key] = value;
    }
  }
  for (const field of group.fields) {
    if (mapped[field.key]) out[field.key] = mapped[field.key];
  }

  // 脏标记必须跟着数据一起从存储里读回来：它只存在于内存里的话，
  // 关掉侧边栏再打开，合并保护就失效了，用户手工填的内容又会被 AI 覆盖
  if (Array.isArray(raw._dirty)) {
    const dirty = raw._dirty.filter(k => group.fields.some(f => f.key === k));
    if (dirty.length) out._dirty = dirty;
  }
  return out;
}

function itemHasValue(item, group) {
  return group.fields.some(f => item[f.key]);
}

// ── 脏标记：记录「哪些字段是用户手工填的」────────
//
// 自动保存只说明「存没存」，不说明「是谁填的」。要支持「重新解析时保留手工改动」，
// 就必须知道来源，否则 AI 的新值无法判断该不该覆盖。
//
// ⚠️ 脏标记挂在**条目对象自己身上**（`item._dirty`），不按数组下标记录 ——
// 用户删掉中间一条经历，后面所有下标都会错位，挂在外部表里的脏标记会串到别的经历上。

function profileContainerAt(profile, path) {
  const { groupId, rest } = parseProfilePath(path);
  const group = groupById(groupId);
  if (!group || !rest.length || !profile || !profile[groupId]) return null;
  if (group.kind === 'object') return profile[groupId];
  const item = profile[groupId][Number(rest[0])];
  return item && typeof item === 'object' ? item : null;
}

function markProfileDirty(profile, path) {
  const container = profileContainerAt(profile, path);
  if (!container) return false;
  const { groupId } = parseProfilePath(path);
  const group = groupById(groupId);
  const key = String(path).split('.').pop();
  // 不是本分组的字段就什么都不做。少了这一步，任何路径拼错的调用都会往
  // 脏标记里塞一个永不生效的键，而「谁被手工改过」这件事会悄悄失真
  if (!group || !group.fields.some(f => f.key === key)) return false;
  const dirty = Array.isArray(container._dirty) ? container._dirty.slice() : [];
  if (!dirty.includes(key)) dirty.push(key);
  container._dirty = dirty;
  return true;
}

function isProfileDirty(profile, path) {
  const container = profileContainerAt(profile, path);
  if (!container) return false;
  const key = String(path).split('.').pop();
  return Array.isArray(container._dirty) && container._dirty.includes(key);
}

// 「用户点过 × 删除的条目」名单。重新解析时同名条目不再追加回来 ——
// 否则删了又出现，用户会以为删除没生效。
// 指纹取条目身份键的值（教育=学校、实习=单位、项目=项目名…）
const PROFILE_REMOVED_LIMIT = 100;

function profileMatchFingerprint(item, key) {
  if (!item || !key) return '';
  return normKey(item[key]);
}

function markProfileRemoved(profile, groupId, item) {
  const fingerprint = profileMatchFingerprint(item, PROFILE_MATCH_KEYS[groupId]);
  if (!profile || !fingerprint) return false;
  if (!Array.isArray(profile._removed)) profile._removed = [];
  const exists = profile._removed.some(r => r.group === groupId && r.value === fingerprint);
  if (!exists) profile._removed.push({ group: groupId, value: fingerprint });
  // 名单不能无限增长：只留最近删除的一批
  if (profile._removed.length > PROFILE_REMOVED_LIMIT) {
    profile._removed = profile._removed.slice(-PROFILE_REMOVED_LIMIT);
  }
  return true;
}

function isProfileRemoved(profile, groupId, fingerprint) {
  if (!fingerprint || !Array.isArray(profile?._removed)) return false;
  return profile._removed.some(r => r.group === groupId && r.value === fingerprint);
}

// 用户把条目改回（或新建）同名内容时，把删除记录撤掉，重新解析才会再认它
function clearProfileRemoved(profile, groupId, item) {
  const fingerprint = profileMatchFingerprint(item, PROFILE_MATCH_KEYS[groupId]);
  if (!fingerprint || !Array.isArray(profile?._removed)) return false;
  const before = profile._removed.length;
  profile._removed = profile._removed.filter(r => !(r.group === groupId && r.value === fingerprint));
  return profile._removed.length !== before;
}

// ── v1 → v2 迁移 ───────────────────────────────
//
// v1 只有 6 组，且技能/获奖/语言/证书被塞在一个 TEXT 字段里；v2 把它们拆成 12 组、
// 四条结构化列表。旧用户升级后字段表不能空白，所以要在 normalizeProfile 之前先迁移。

const PROFILE_V1_SKILL_KEYS = ['skillTags', 'certificates', 'languages', 'honors', 'selfEvaluation', 'portfolio'];

// v1 的这些字段可能嵌在 skills 里，也可能被平铺在顶层（旧版 AI 的写法）
function v1SkillSource(raw) {
  const nested = (raw.skills && typeof raw.skills === 'object' && !Array.isArray(raw.skills)) ? raw.skills : {};
  const flat = {};
  for (const key of PROFILE_V1_SKILL_KEYS) {
    if (typeof raw[key] === 'string' && raw[key]) flat[key] = raw[key];
  }
  return Object.assign({}, flat, nested);
}

function needsProfileMigration(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (Number(raw.version) >= PROFILE_SCHEMA_VERSION) return false;
  const skills = v1SkillSource(raw);
  return PROFILE_V1_SKILL_KEYS.some(k => skills[k]);
}

// 「、」「，」「；」都能拆。全是空白的碎片直接丢掉
function splitTagValues(value) {
  return String(value == null ? '' : value)
    .split(/[、,，;；\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// 语言类型的公共前缀。v1 把语言与等级写在一条文本里（「英语 CET-6」），
// v2 拆成两个字段，迁移时按前缀切开，用户不用重填一遍
const PROFILE_LANGUAGE_PREFIXES = ['英语', '英文', '日语', '韩语', '法语', '德语', '粤语', '普通话'];

// v1 的 `languages` 是一段自由文本，常见写法有两种：
//   · 「英语 CET-6」—— 语言名在前，前缀匹配就能拆成 type + level
//   · 「CET-6」—— 只写了等级/分数，没写语言名
// 后者必须从等级反推语言名：不然迁移出来的「语言类型」就是「CET-6」，
// 而网申的语言类型下拉里是「英语 / 日语 / 粤语」这类语言名，
// 匹配不上就整栏填不进去（实测就是这一条把语言能力从 4/4 变成 0/4）。
// 拉丁词一律走词边界，避免 n2 命中中文拼音、cet 命中别的词。
const PROFILE_LANGUAGE_HINTS = [
  { re: /(^|[^a-z0-9])(cet[\s\-]?[46]|tem[\s\-]?[48]|ielts|toefl|gre|雅思|托福|英语|英文)([^a-z0-9]|$)/i, type: '英语' },
  { re: /(^|[^a-z0-9])(jlpt|jtest|n[1-5]|日语)([^a-z0-9]|$)/i, type: '日语' },
  { re: /(^|[^a-z0-9])(topik|韩语)([^a-z0-9]|$)/i, type: '韩语' },
  { re: /(^|[^a-z0-9])(delf|dalf|tcf|tef|法语)([^a-z0-9]|$)/i, type: '法语' },
  { re: /(^|[^a-z0-9])(testdaf|dsh|德语)([^a-z0-9]|$)/i, type: '德语' },
  { re: /普通话|二级甲等|二级乙等|一级甲等/, type: '普通话' },
  { re: /粤语|广东话/, type: '粤语' }
];

function migrateLanguageItem(value) {
  const text = String(value || '').trim();
  const prefix = PROFILE_LANGUAGE_PREFIXES.find(p => text.indexOf(p) === 0);
  if (prefix) {
    return { type: prefix, level: text.slice(prefix.length).replace(/^[\s、:：/]+/, '').trim() };
  }
  // 只写了等级/分数 → 从它反推语言名，等级原文完整保留在 level 里
  const hint = PROFILE_LANGUAGE_HINTS.find(h => h.re.test(text));
  if (hint) return { type: hint.type, level: text };
  return { type: text, level: '' };
}

function migrateProfile(raw) {
  if (!needsProfileMigration(raw)) return raw;

  const out = Object.assign({}, raw);
  const skills = v1SkillSource(raw);
  const toList = (value, key) => splitTagValues(value).map(v => ({ [key]: v }));

  out.skills = toList(skills.skillTags, 'name');
  out.certificates = toList(skills.certificates, 'name');
  out.languages = splitTagValues(skills.languages).map(migrateLanguageItem);
  // 奖项原文常用「、」和「；」混排，splitTagValues 两种都拆
  out.honors = toList(skills.honors, 'name');

  // 自我评价与作品链接在 v1 属于 skills，v2 归到附加信息
  const extra = Object.assign({}, (raw.extra && typeof raw.extra === 'object') ? raw.extra : {});
  if (skills.selfEvaluation) extra.selfEvaluation = skills.selfEvaluation;
  if (skills.portfolio) extra.portfolio = skills.portfolio;
  if (Object.keys(extra).length) out.extra = extra;

  // 平铺在顶层的 v1 字段全部搬走后清掉，避免残留的旧键名被后续解析误读。
  // ⚠️ 不能连 certificates / languages / honors 一起删：它们既是 v1 的文本字段名，
  // 也是 v2 的分组名，上面刚赋的值就在这几个键上
  for (const key of PROFILE_V1_SKILL_KEYS) {
    if (PROFILE_GROUPS.some(g => g.id === key)) continue;
    delete out[key];
  }

  return out;
}

// ── 规整 ──────────────────────────────────────

// 取分组原始数据（含别名归并 + 顶层平铺兜底）
function pickGroupSource(src, groupId) {
  const aliases = PROFILE_GROUP_ALIASES[groupId] || [groupId];
  const normalized = {};
  for (const [k, v] of Object.entries(src)) normalized[normKey(k)] = v;
  for (const alias of aliases) {
    const hit = normalized[normKey(alias)];
    if (hit != null) return hit;
  }
  return undefined;
}

// 把 AI / 本地的任意结构规整为固定 profile
function normalizeProfile(raw) {
  const source = migrateProfile(raw);
  const src = (source && typeof source === 'object' && !Array.isArray(source)) ? source : {};
  const out = createEmptyProfile();
  let foundGroup = false;

  for (const group of PROFILE_GROUPS) {
    const groupSource = pickGroupSource(src, group.id);
    if (group.kind === 'list') {
      const list = Array.isArray(groupSource)
        ? groupSource
        : (groupSource && typeof groupSource === 'object' ? [groupSource] : []);
      out[group.id] = list
        .map(item => normalizeItem(item, group))
        .filter(item => itemHasValue(item, group));
      if (out[group.id].length) foundGroup = true;
    } else {
      out[group.id] = normalizeItem(groupSource, group);
      if (itemHasValue(out[group.id], group)) foundGroup = true;
    }
  }

  // 兜底：AI 把字段直接平铺在顶层（没有分组）时，从顶层收集
  if (!foundGroup) {
    for (const group of PROFILE_GROUPS) {
      if (group.kind === 'list') continue;
      Object.assign(out[group.id], normalizeItem(src, group));
    }
  }

  if (Array.isArray(src._removed)) {
    out._removed = src._removed
      .filter(r => r && typeof r === 'object' && PROFILE_MATCH_KEYS[r.group] && r.value)
      .slice(-PROFILE_REMOVED_LIMIT);
  }

  out.version = PROFILE_SCHEMA_VERSION;
  out.updatedAt = new Date().toISOString();
  return out;
}

// ── 派生回退 ──────────────────────────────────
//
// 参考表单的「个人信息」里有最高学历/最高学位/专业名称/毕业学校，教育经历里又各问一遍。
// 让用户填两遍是浪费，而 AI 抽取时写两遍也浪费额度。做法：用户只填教育经历，
// 这几个字段留空 → 预填取值时自动带出，UI 上以灰色提示显示带出的值。

function educationRecency(endDate) {
  const digits = String(endDate || '').replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

// 挑「学历最高、时间最近」的那一条教育经历
function pickHighestEducation(profile) {
  const items = Array.isArray(profile?.education) ? profile.education : [];
  let best = null;
  let bestScore = -1;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rank = PROFILE_DEGREE_RANK[item.degree] || 0;
    const score = rank * 1e8 + educationRecency(item.endDate);
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return best;
}

function profileDerivedValue(profile, groupId, key) {
  const rule = PROFILE_DERIVE_RULES[groupId + '.' + key];
  if (!rule) return '';
  const item = pickHighestEducation(profile);
  if (!item) return '';
  const raw = item[rule.key];
  if (!raw) return '';
  return rule.map ? (rule.map[raw] || '') : raw;
}

// 取「直接值 or 派生值」。derived 为 true 表示实际是空字段，靠教育经历带出
function profileResolvedValue(profile, groupId, key) {
  const direct = profile?.[groupId]?.[key];
  if (direct) return { value: direct, derived: false };
  const derived = profileDerivedValue(profile, groupId, key);
  return derived ? { value: derived, derived: true } : { value: '', derived: false };
}

// 供预填消费的副本：把可派生的空字段补上。不改原对象 ——
// 派生值只用于「填表」，不能写回字段表，否则用户改教育经历时它会过期
function applyProfileDerived(profile) {
  if (!profile) return profile;
  const out = createEmptyProfile();
  out._removed = Array.isArray(profile._removed) ? profile._removed.slice() : [];
  out.updatedAt = profile.updatedAt || '';
  for (const group of PROFILE_GROUPS) {
    if (group.kind === 'list') {
      const items = Array.isArray(profile[group.id]) ? profile[group.id] : [];
      out[group.id] = items.map(item => Object.assign({}, item));
      continue;
    }
    out[group.id] = Object.assign(createEmptyItem(group), profile[group.id]);
    for (const field of group.fields) {
      if (out[group.id][field.key]) continue;
      const resolved = profileResolvedValue(profile, group.id, field.key);
      if (resolved.value) out[group.id][field.key] = resolved.value;
    }
  }
  return out;
}

// ── 智能合并（重新解析时保留手工改动）──────────
//
// 规则：
//   对象型分组 → 用户改过的字段保留原值；否则 AI 有新值就用新值，
//                AI 这次没抽到就保留旧值（不能因为换了一份简历就把已有内容清空）
//   列表型分组 → 按条目身份键对齐：对得上的逐字段合并（同上）；
//                对不上的新条目追加；旧条目一律保留
//   删除名单里的条目不再追加

function mergeProfileItem(parsedItem, existingItem, group, report) {
  const out = createEmptyItem(group);
  const dirty = Array.isArray(existingItem._dirty) ? existingItem._dirty : [];
  for (const field of group.fields) {
    const oldValue = existingItem[field.key] || '';
    const newValue = parsedItem[field.key] || '';
    if (dirty.includes(field.key)) {
      out[field.key] = oldValue;
      if (newValue && newValue !== oldValue) report.dirtyKept += 1;
      continue;
    }
    if (newValue) {
      if (newValue !== oldValue) report.updated += 1;
      out[field.key] = newValue;
    } else {
      out[field.key] = oldValue;
    }
  }
  if (dirty.length) out._dirty = dirty.slice();
  return out;
}

// 返回 { profile, report }。report 供 UI 如实说明「更新了几项 / 保留了几项 / 新增几段」
function mergeProfile(parsed, existing) {
  const report = { updated: 0, dirtyKept: 0, added: 0, keptItems: 0, blocked: 0, addedByGroup: {} };

  if (!existing || !profileHasValue(existing)) {
    const fresh = normalizeProfile(parsed);
    report.updated = profileStats(fresh).filled;
    return { profile: fresh, report };
  }

  const incoming = normalizeProfile(parsed);
  const out = createEmptyProfile();

  for (const group of PROFILE_GROUPS) {
    if (group.kind === 'object') {
      out[group.id] = mergeProfileItem(incoming[group.id] || {}, existing[group.id] || {}, group, report);
      continue;
    }

    const matchKey = PROFILE_MATCH_KEYS[group.id];
    const olds = Array.isArray(existing[group.id]) ? existing[group.id] : [];
    const news = Array.isArray(incoming[group.id]) ? incoming[group.id] : [];
    const used = new Array(news.length).fill(false);

    for (const oldItem of olds) {
      const fingerprint = profileMatchFingerprint(oldItem, matchKey);
      let hit = -1;
      if (fingerprint) {
        for (let i = 0; i < news.length; i++) {
          if (!used[i] && profileMatchFingerprint(news[i], matchKey) === fingerprint) { hit = i; break; }
        }
      }
      if (hit < 0) {
        // AI 这次没抽到这一段 → 原样保留。用户不该因为换了份简历就丢内容
        out[group.id].push(oldItem);
        report.keptItems += 1;
        continue;
      }
      used[hit] = true;
      out[group.id].push(mergeProfileItem(news[hit], oldItem, group, report));
    }

    for (let i = 0; i < news.length; i++) {
      if (used[i]) continue;
      const fingerprint = profileMatchFingerprint(news[i], matchKey);
      // 没有身份键的条目在字段表里连名字都没有，用户既认不出也没法用于预填，直接丢弃
      if (!fingerprint) continue;
      if (isProfileRemoved(existing, group.id, fingerprint)) { report.blocked += 1; continue; }
      const item = createEmptyItem(group);
      for (const field of group.fields) item[field.key] = news[i][field.key] || '';
      out[group.id].push(item);
      report.added += 1;
      report.addedByGroup[group.id] = (report.addedByGroup[group.id] || 0) + 1;
    }
  }

  out._removed = Array.isArray(existing._removed) ? existing._removed.slice() : [];
  out.updatedAt = new Date().toISOString();
  return { profile: out, report };
}

// ── 路径读写（供 UI 绑定）─────────────────────
// path 形如 'basic.name' 或 'education.0.school'

function parseProfilePath(path) {
  const [groupId, ...rest] = String(path).split('.');
  return { groupId, rest };
}

function getProfilePath(profile, path) {
  const { groupId, rest } = parseProfilePath(path);
  let cur = profile?.[groupId];
  for (const seg of rest) {
    if (cur == null) return '';
    cur = cur[seg];
  }
  return cur == null ? '' : cur;
}

function setProfilePath(profile, path, value) {
  const { groupId, rest } = parseProfilePath(path);
  if (!profile[groupId] || !rest.length) return false;
  let cur = profile[groupId];
  for (let i = 0; i < rest.length - 1; i++) {
    const seg = rest[i];
    if (cur[seg] == null) cur[seg] = {};
    cur = cur[seg];
  }
  cur[rest[rest.length - 1]] = value;
  return true;
}

function groupById(id) {
  return PROFILE_GROUPS.find(g => g.id === id) || null;
}

function profileFieldLabel(path) {
  const { groupId, rest } = parseProfilePath(path);
  const group = groupById(groupId);
  if (!group) return path;
  const key = rest[rest.length - 1];
  const field = group.fields.find(f => f.key === key);
  return field ? `${group.label} · ${field.label}` : path;
}

// ── 统计 ──────────────────────────────────────

// 单组统计，供 UI 角标与「默认展开有内容的组」判断使用
function profileGroupStats(profile, group) {
  if (group.kind === 'list') {
    const items = Array.isArray(profile?.[group.id]) ? profile[group.id] : [];
    let filled = 0;
    for (const item of items) {
      for (const field of group.fields) if (item[field.key]) filled += 1;
    }
    const first = items[0];
    const requiredMissing = group.fields
      .filter(f => f.required && !(first && first[f.key]))
      .length;
    return {
      filled,
      total: items.length * group.fields.length,
      count: items.length,
      requiredMissing,
      isEmpty: items.length === 0
    };
  }
  let filled = 0;
  let requiredMissing = 0;
  for (const field of group.fields) {
    const resolved = profileResolvedValue(profile, group.id, field.key);
    if (resolved.value) filled += 1;
    else if (field.required) requiredMissing += 1;
  }
  return {
    filled,
    total: group.fields.length,
    count: filled,
    requiredMissing,
    isEmpty: filled === 0
  };
}

function profileStats(profile) {
  let filled = 0;
  let derived = 0;
  let missing = 0;
  let sensitiveFilled = 0;
  let requiredTotal = 0;
  let requiredFilled = 0;
  let requiredMissing = 0;

  for (const group of PROFILE_GROUPS) {
    if (group.kind === 'list') {
      const items = Array.isArray(profile?.[group.id]) ? profile[group.id] : [];
      // 必填项按「第一条」计：网申至少要有一段经历，组里一条都没有时全部算缺
      const first = items[0];
      for (const field of group.fields) {
        if (!field.required) continue;
        requiredTotal += 1;
        if (first && first[field.key]) requiredFilled += 1;
        else requiredMissing += 1;
        // 必填缺口单独计数，不与「可选信息待补」重复
        if (!(first && first[field.key])) missing += 1;
      }
      for (const item of items) {
        for (const field of group.fields) {
          if (item[field.key]) {
            filled += 1;
            if (field.sensitive) sensitiveFilled += 1;
          } else if (!field.required) {
            missing += 1;
          }
        }
      }
      continue;
    }

    for (const field of group.fields) {
      const resolved = profileResolvedValue(profile, group.id, field.key);
      if (resolved.value) {
        filled += 1;
        if (resolved.derived) derived += 1;
        if (field.sensitive) sensitiveFilled += 1;
      } else {
        missing += 1;
      }
      if (field.required) {
        requiredTotal += 1;
        if (resolved.value) requiredFilled += 1;
        else requiredMissing += 1;
      }
    }
  }

  // total = 已填 + 还缺。这样 percent 直接回答「该补的都补了没有」，
  // 不会因为一个分组整组为空就把它从分母里漏掉
  const total = filled + missing;

  return {
    filled,
    derived,
    missing,
    total,
    sensitiveFilled,
    requiredTotal,
    requiredFilled,
    requiredMissing,
    percent: total ? Math.round((filled / total) * 100) : 0,
    educationCount: (profile?.education || []).length,
    experienceCount: (profile?.experience || []).length,
    projectCount: (profile?.projects || []).length,
    campusRoleCount: (profile?.campusRole || []).length,
    campusPracticeCount: (profile?.campusPractice || []).length
  };
}

// 是否存在任何有效内容
function profileHasValue(profile) {
  return profileStats(profile).filled > 0;
}

// 「跳到下一处空缺」用的降序清单：必填缺口排前面，其次可选空缺。
// 空的分组不贡献可选空缺 —— 「要不要有一段在校职务」是用户的决定，不该替他记一笔
function profileEmptyPaths(profile, options = {}) {
  const includeOptional = options.includeOptional !== false;
  const required = [];
  const optional = [];

  for (const group of PROFILE_GROUPS) {
    if (group.kind === 'list') {
      const items = Array.isArray(profile?.[group.id]) ? profile[group.id] : [];
      const first = items[0];
      for (const field of group.fields) {
        if (!field.required) continue;
        if (!(first && first[field.key])) required.push(`${group.id}.0.${field.key}`);
      }
      if (!includeOptional) continue;
      items.forEach((item, index) => {
        for (const field of group.fields) {
          if (field.required || item[field.key]) continue;
          optional.push(`${group.id}.${index}.${field.key}`);
        }
      });
      continue;
    }
    for (const field of group.fields) {
      const resolved = profileResolvedValue(profile, group.id, field.key);
      if (resolved.value) continue;
      if (field.required) required.push(`${group.id}.${field.key}`);
      else if (includeOptional) optional.push(`${group.id}.${field.key}`);
    }
  }

  return required.concat(optional);
}

// ── 预填用的扁平字段清单 ────────────────────────

function flattenProfile(profile, options = {}) {
  const includeSensitive = Boolean(options.includeSensitive);
  const out = [];
  for (const group of PROFILE_GROUPS) {
    if (group.kind === 'list') {
      const items = Array.isArray(profile?.[group.id]) ? profile[group.id] : [];
      items.forEach((item, index) => {
        for (const field of group.fields) {
          const value = item[field.key];
          if (!value) continue;
          if (field.sensitive && !includeSensitive) continue;
          out.push({
            path: `${group.id}.${index}.${field.key}`,
            key: field.key,
            label: `${group.itemLabel || group.label} ${index + 1} · ${field.label}`,
            groupLabel: group.label,
            value,
            sensitive: Boolean(field.sensitive),
            required: Boolean(field.required),
            multi: true,
            index
          });
        }
      });
    } else {
      for (const field of group.fields) {
        const value = profile?.[group.id]?.[field.key];
        if (!value) continue;
        if (field.sensitive && !includeSensitive) continue;
        out.push({
          path: `${group.id}.${field.key}`,
          key: field.key,
          label: `${group.label} · ${field.label}`,
          groupLabel: group.label,
          value,
          sensitive: Boolean(field.sensitive),
          required: Boolean(field.required),
          multi: false
        });
      }
    }
  }
  return out;
}

// ── 经历条目解析（本地规则专用）────────────────
//
// 中文简历的经历排版有两种，都必须支持：
//   A. 字段名式：  公司：XX科技有限公司 / 职位：产品实习生 / 开始时间：2025.07
//   B. 行首日期式：2026.06-2026.8 深圳美高创新股份有限公司 产品营销实习生
//
// B 是校招简历最常见的写法。流程：按章节标题切段 → 段内按「日期范围行」切条目
// → 解析条目头 → 聚合并条目体

// 日期范围有两种常见位置，都要支持：
//   · 行首：2026.06-2026.8 深圳美高创新股份有限公司 产品营销实习生
//   · 行尾：深圳市某某科技有限公司  内容运营实习生  2025.07-2025.10
// 月份放宽到 3 位：真实简历里「2025.012-2026.03」这类笔误很常见
const LOCAL_DATE_RANGE_RE = /((?:19|20)\d{2})\s*[.\-/年]?\s*(\d{0,3})\s*[-–—~至到]+\s*((?:19|20)\d{2})\s*[.\-/年]?\s*(\d{0,3})/;

// 判断日期是否落在行首（决定头部文字取日期之前还是之后）
const LOCAL_DATE_AT_START_RE = /^\s*(?:19|20)\d{2}\s*[.\-/年]?\s*\d{0,3}\s*[-–—~至到]+/;

// 章节标题必须够短且不含句读标点。少了这两个限制，
// 正文里「参与年度审计项目，整理 200+ 份凭证。」这种句子会被当成章节标题，
// 后面的内容就会被错误地归到「项目经历」里
const LOCAL_SECTION_MAX_LEN = 32;
const LOCAL_SECTION_PUNCT_RE = /[，,。；;！!？?、]/;

// 公司类后缀。拿它定位公司名的结束位置，因此有无空格分隔都能正确切开
const LOCAL_COMPANY_RE = /^([\s\S]{2,40}?(?:股份有限公司|有限责任公司|有限公司|集团|研究院|研究所|事务所|公司|银行))/;

// 项目角色词。两类要特别处理：
//   · 「学员-TOP20」这类带后缀的写法要连后缀一起匹配，
//     否则「学员」被摘掉后会留下一个孤零零的「-TOP20」粘在项目名尾巴上
//   · 「产品负责人」要整体匹配，只认「负责人」会把「产品」留在项目名里
const LOCAL_PROJECT_ROLE_RE = /(独立作者|第一作者|第二作者|通讯作者|项目负责人|技术负责人|产品负责人|设计负责人|运营负责人|市场负责人|主要负责人|主要成员|核心成员|组长|队长|主持人|参与者|开发者|学员(?:[-－]\S+)?|[\u4e00-\u9fff]{1,3}负责人|负责人)/;

// 章节标题 → 分组。返回的 id 有两类是「细粒度章节」（hobby / strength /
// selfEvaluation / extra），它们在 extractProfileLocally 里落到 extra 的字段上
function localSectionOf(line) {
  const text = String(line || '').trim();
  if (!text || text.length > LOCAL_SECTION_MAX_LEN) return null;
  if (LOCAL_SECTION_PUNCT_RE.test(text)) return null;
  // 含日期范围的是经历条目，不是章节标题。
  // 少了这条判断，「2025.012-2026.03 某机器学习项目」会因为含「项目」二字
  // 被当成「项目经历」标题，于是整条经历被消耗掉、什么都不剩。
  if (LOCAL_DATE_RANGE_RE.test(text)) return null;
  const lower = text.toLowerCase();
  // 顺序即优先级。三处关键次序，改任一处前先想清楚：
  //   · 「项目经历 Practical experience」同时含「项目」和 experience，必须先判项目
  //   · 「学生工作 / 社团职务」含「工作」，必须排在「实习/工作」之前，
  //     否则整段在校职务会被判成实习经历
  //   · 「实习实践」含「实践」，实习/工作必须排在「实践」之前，
  //     否则整段实习会被判成在校实践
  if (/项目|projects?/.test(lower)) return 'projects';
  if (/在校职务|校园职务|校内职务|学生工作|社团|班委|学生会/.test(lower)) return 'campusRole';
  if (/教育|学历|education/.test(lower)) return 'education';
  if (/实习|工作|任职|职业|internship|employment/.test(lower)) return 'experience';
  if (/在校实践|社会实践|校园实践|实践经历|实践活动|志愿/.test(lower)) return 'campusPractice';
  if (/获奖|荣誉|奖项|奖励|honor|award/.test(lower)) return 'honors';
  if (/语言|外语|language/.test(lower)) return 'languages';
  // 技能排在证书之前：「技能证书」这类混排标题归到技能这一桶，
  // 里面的证书/语言/奖项行由行级分类再分流（见 localSplitMixedSection）
  if (/技能|skill/.test(lower)) return 'skills';
  if (/证书|资格|certificat/.test(lower)) return 'certificates';
  if (/兴趣|爱好/.test(lower)) return 'hobby';
  if (/特长|专长/.test(lower)) return 'strength';
  if (/自我评价|个人评价|个人总结|自我介绍/.test(lower)) return 'selfEvaluation';
  if (/附加|其他信息|补充/.test(lower)) return 'extra';
  return null;
}

function localSplitSections(lines) {
  const sections = {};
  let current = null;
  for (const line of lines) {
    const id = localSectionOf(line);
    if (id) {
      current = id;
      if (!sections[id]) sections[id] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  return sections;
}

// 按「含日期范围的行」切条目。日期行之后的非日期行都属于这个条目。
// 日期在行首还是行尾都算 —— 两种排版在中英文简历里都很常见。
function localSplitItems(lines) {
  const items = [];
  let current = null;
  for (const line of lines) {
    const text = String(line == null ? '' : line);
    const dateMatch = text.match(LOCAL_DATE_RANGE_RE);
    if (dateMatch) {
      current = { head: text, dateMatch, body: [] };
      items.push(current);
    } else if (current) {
      current.body.push(text);
    }
  }
  return items;
}

// 取条目头里「日期之外」的那部分文字，供解析公司/职位/项目名使用
function localHeadTextWithoutDate(item) {
  const head = String(item.head || '');
  const raw = item.dateMatch[0];
  const atStart = LOCAL_DATE_AT_START_RE.test(head);
  if (atStart) return head.slice(raw.length).trim();
  const index = typeof item.dateMatch.index === 'number' ? item.dateMatch.index : head.indexOf(raw);
  if (index < 0) return head.trim();
  return head.slice(0, index).trim();
}

function localDateValue(year, month) {
  if (!month) return String(year);
  const value = parseInt(month, 10);
  // 「2025.012」这类笔误：parseInt 得到 12 仍可用；真正越界的月份只保留年份
  if (!value || value > 12) return String(year);
  return `${year}.${String(value).padStart(2, '0')}`;
}

function localParseExperienceHead(rest) {
  const out = { company: '', title: '' };
  const text = String(rest || '').trim();
  if (!text) return out;
  const companyMatch = text.match(LOCAL_COMPANY_RE);
  if (companyMatch) {
    out.company = companyMatch[1].trim();
    out.title = text.slice(companyMatch[0].length).replace(/^[\s,，·|]+/, '').trim();
    return out;
  }
  // 没有公司后缀：可能是「机构名 职位」写法
  const segments = text.split(/\s+/).filter(Boolean);
  if (segments.length >= 2) {
    out.company = segments[0];
    out.title = segments.slice(1).join(' ');
  } else {
    out.company = text;
  }
  return out;
}

function localParseProjectHead(rest) {
  const out = { name: '', role: '' };
  const text = String(rest || '').trim();
  if (!text) return out;
  const roleMatch = text.match(LOCAL_PROJECT_ROLE_RE);
  if (roleMatch) {
    out.role = roleMatch[1];
    out.name = text
      .replace(roleMatch[0], ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/[-－]\s*$/, '')
      .trim();
    return out;
  }
  out.name = text;
  return out;
}

// 条目体（小标题 + 要点行）聚合成一段描述。
// 用「；」连接并保留全部原文：宁可多给用户一点他自己的原话，
// 也不要因为"怕不准"而丢掉他简历里实际写的内容。
function localJoinBody(body) {
  return (body || [])
    .map(line => String(line == null ? '' : line).trim())
    .filter(Boolean)
    .filter(line => !/^[-—_=·•\s]+$/.test(line))
    .join('；')
    .replace(/；{2,}/g, '；')
    .replace(/^；|；$/g, '')
    .trim();
}

// 字段名式排版的兜底：借 parseProfileText 的统一解析（它已有别名表与续行处理），
// 因此需要按它认识的 `## 分组名` 结构包一层
function localParseFieldStyleItems(lines, groupId) {
  const text = lines.map(l => String(l == null ? '' : l)).join('\n').trim();
  if (!text) return [];
  try {
    const parsed = parseProfileText(`## ${groupById(groupId).label}\n${text}`);
    const items = parsed && Array.isArray(parsed[groupId]) ? parsed[groupId] : [];
    return items.filter(item => item && itemHasValue(item, groupById(groupId)));
  } catch (e) {
    return [];
  }
}

// 找不到「工作经历」章节标题时的兜底：整篇扫一遍，但只认含公司类后缀的条目。
// 少数简历不写章节标题，此时按章节切分拿不到任何东西；
// 而放宽到全文扫之后，必须靠「公司后缀」把学校、项目名挡在外面。
function localExtractExperienceWithoutSection(lines) {
  const items = [];
  for (const raw of localSplitItems(lines)) {
    const text = localHeadTextWithoutDate(raw);
    if (!LOCAL_COMPANY_RE.test(text)) continue;
    items.push(localBuildExperienceItem(raw, text));
  }
  return items;
}

function localBuildExperienceItem(raw, headText) {
  const head = localParseExperienceHead(headText);
  const entry = createEmptyItem(groupById('experience'));
  entry.company = head.company;
  entry.title = head.title;
  entry.startDate = localDateValue(raw.dateMatch[1], raw.dateMatch[2]);
  entry.endDate = localDateValue(raw.dateMatch[3], raw.dateMatch[4]);
  entry.description = localJoinBody(raw.body);
  return entry;
}

function localExtractExperience(sectionLines) {
  const items = [];
  for (const raw of localSplitItems(sectionLines)) {
    const entry = localBuildExperienceItem(raw, localHeadTextWithoutDate(raw));
    if (itemHasValue(entry, groupById('experience'))) items.push(entry);
  }
  if (items.length) return items;
  return localParseFieldStyleItems(sectionLines, 'experience');
}

function localExtractProjects(sectionLines) {
  const items = [];
  for (const raw of localSplitItems(sectionLines)) {
    const head = localParseProjectHead(localHeadTextWithoutDate(raw));
    const entry = createEmptyItem(groupById('projects'));
    entry.name = head.name;
    entry.role = head.role;
    entry.startDate = localDateValue(raw.dateMatch[1], raw.dateMatch[2]);
    entry.endDate = localDateValue(raw.dateMatch[3], raw.dateMatch[4]);
    // 角色也常常单独占一行（如「独立作者」），此时它在条目体首行。
    // 只在首行足够短时才认，否则描述正文里出现的「负责人」会被误当成项目角色。
    const body = raw.body.slice();
    if (!entry.role && body.length) {
      const first = String(body[0]).trim();
      const roleMatch = first.length <= 12 ? first.match(LOCAL_PROJECT_ROLE_RE) : null;
      if (roleMatch) {
        entry.role = roleMatch[1];
        body.shift();
      }
    }
    entry.description = localJoinBody(body);
    if (itemHasValue(entry, groupById('projects'))) items.push(entry);
  }
  if (items.length) return items;
  return localParseFieldStyleItems(sectionLines, 'projects');
}

// 在校职务 / 在校实践：结构与实习、项目同构（头部一行 + 日期范围 + 条目体），
// 只是头部字段分别叫「职务名称」「实践名称」
function localExtractHeaded(groupId, headKey, sectionLines) {
  const group = groupById(groupId);
  const items = [];
  for (const raw of localSplitItems(sectionLines)) {
    const entry = createEmptyItem(group);
    entry[headKey] = localHeadTextWithoutDate(raw);
    entry.startDate = localDateValue(raw.dateMatch[1], raw.dateMatch[2]);
    entry.endDate = localDateValue(raw.dateMatch[3], raw.dateMatch[4]);
    entry.description = localJoinBody(raw.body);
    if (itemHasValue(entry, group)) items.push(entry);
  }
  if (items.length) return items;
  return localParseFieldStyleItems(sectionLines, groupId);
}

// ── 本地规则：技能 / 获奖 / 语言 / 证书的分流 ────
//
// 真实简历常把它们挤在一个「技能证书」或「荣誉以及奖项」标题下，所以按**行**分类，
// 而不是按章节。这是粗解析，只填空缺，不覆盖已有值。

// 拉丁词必须词边界匹配：'PS' 不能命中 'PSD'，'Go' 不能命中 'Google'
function localTokenHit(text, token) {
  const source = String(text || '');
  if (!token) return false;
  const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^[a-zA-Z]/.test(token)) {
    return new RegExp('(^|[^a-zA-Z])' + escaped + '([^a-zA-Z]|$)', 'i').test(source);
  }
  return source.includes(token);
}

const LOCAL_SKILL_POOL = [
  'Excel', 'Word', 'PowerPoint', 'PPT', 'WPS', 'SQL', 'MySQL', 'Python', 'Java', 'Kotlin',
  'JavaScript', 'TypeScript', 'HTML', 'CSS', 'MATLAB', 'C++', 'C#',
  'Figma', 'Axure', 'Sketch', 'Photoshop', 'Premiere', '剪映', 'Tableau', 'SPSS', 'Stata',
  'Git', 'Docker', 'Linux', 'Vue', 'React', 'Node.js',
  '数据分析', '用户研究', '竞品分析', '文案撰写', '新媒体运营', '项目管理',
  '需求分析', '原型设计', '活动策划', '视频剪辑'
];

const LOCAL_SKILL_LEVELS = ['精通', '熟练', '掌握', '熟悉', '了解', '入门'];

const LOCAL_HONOR_RE = /奖学金|三好学生|优秀(班干部|学生|团员|党员|毕业生|员工)|先进个人|标兵|荣誉称号|竞赛|大赛|挑战杯|蓝桥杯|数学建模|创新创业|获奖|一等奖|二等奖|三等奖/;

// 级别只在原文写了级别词时才推断，不做「按含金量替它升格」这种臆断
const LOCAL_HONOR_LEVEL_RULES = [
  [/全国|国家级|国家|国际/, '国家级'],
  [/省|赛区|直辖市|自治区/, '省部级'],
  [/市|市级/, '市级'],
  [/学院|院级|系级/, '院级'],
  [/校级|学校|校/, '校级']
];

const LOCAL_LANGUAGE_DEFS = [
  {
    type: '英语',
    re: /英语|英文|CET-?\s?[46]|雅思|托福|IELTS|TOEFL/i,
    levelRe: /CET-?\s?[46]|雅思\s*[\d.]+|托福\s*[\d.]+|IELTS\s*[\d.]+|TOEFL\s*[\d.]+|专业[四八]级/i
  },
  { type: '日语', re: /日语|JLPT|N[12]\s*级/ },
  { type: '韩语', re: /韩语|TOPIK/ },
  { type: '法语', re: /法语|DELF/ },
  { type: '德语', re: /德语/ },
  { type: '粤语', re: /粤语/ },
  { type: '普通话', re: /普通话/ }
];

const LOCAL_CERT_POOL = [
  '计算机一级', '计算机二级', '计算机三级', '计算机四级', '教师资格', '会计从业', '初级会计',
  '中级会计', '软件设计师', '软件测试工程师', 'PMP', '驾照', '驾驶证', '报关员'
];

function localSkillItems(source) {
  const out = [];
  const seen = new Set();
  for (const rawLine of String(source || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // 同一行里的「熟练使用 Excel、SQL」说明这一行全部技能的掌握程度
    const level = LOCAL_SKILL_LEVELS.find(l => line.includes(l)) || '';
    for (const name of LOCAL_SKILL_POOL) {
      if (seen.has(name) || !localTokenHit(line, name)) continue;
      seen.add(name);
      out.push({ name, level, years: '', description: '' });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

function localLanguageItems(source) {
  const lines = String(source || '').split('\n');
  const out = [];
  for (const def of LOCAL_LANGUAGE_DEFS) {
    let hit = false;
    let level = '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !def.re.test(line)) continue;
      hit = true;
      if (!level && def.levelRe) {
        const match = line.match(def.levelRe);
        if (match) level = match[0].replace(/\s+/g, '');
      }
    }
    if (hit) out.push({ type: def.type, level, date: '', description: '' });
  }
  return out;
}

// 只有「专门列证书」的章节才逐行收。混排的「技能证书」章节交给上面的固定词表 ——
// 把它的行直接当证书名，会把「熟练使用 Excel、SQL」拆成三张并不存在的证书
function localLooksLikeCertificate(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 40) return false;
  if (LOCAL_LANGUAGE_DEFS.some(def => def.re.test(text))) return false;
  if (LOCAL_SKILL_LEVELS.some(level => text.includes(level))) return false;
  if (LOCAL_SKILL_POOL.some(name => localTokenHit(text, name))) return false;
  return true;
}

function localCertificateItems(source, sectionLines) {
  const out = [];
  const seen = new Set();
  const push = (name) => {
    const value = String(name || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ name: value, date: '', description: '' });
  };
  for (const name of LOCAL_CERT_POOL) {
    if (localTokenHit(source, name)) push(name);
  }
  for (const line of sectionLines) {
    for (const fragment of splitTagValues(line)) {
      if (localLooksLikeCertificate(fragment)) push(fragment);
    }
  }
  return out;
}

function localHonorItems(lines) {
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    for (const fragment of splitTagValues(line)) {
      const name = fragment
        .replace(/^[-*•·]\s*/, '')
        .replace(/^(荣获|获得|曾获|被评为|授予|获)\s*/, '')
        .replace(/[。.]$/, '')
        .trim();
      if (!name || seen.has(name) || !LOCAL_HONOR_RE.test(name)) continue;
      seen.add(name);
      const levelRule = LOCAL_HONOR_LEVEL_RULES.find(rule => rule[0].test(name));
      out.push({ name, date: '', level: levelRule ? levelRule[1] : '', description: '' });
    }
  }
  return out;
}

// ── 本地规则解析（未配置 AI 时的兜底）────────────
// 明确说明：这是粗解析，仅填空缺，不覆盖已有值

function extractProfileLocally(text) {
  const profile = createEmptyProfile();
  const src = String(text || '').replace(/\r/g, '');

  // 去掉常见占位符与页眉噪音，避免把模板字样当成真实信息
  const lines = src.split('\n').map(l => l.trim()).filter(Boolean);

  // 章节标题词表（含判定）：用于排除被误当姓名/专业的标题行。
  // 注意「语言」这类词既可能出现在标题（「语言能力」）也可能出现在正文（专业「汉语言文学」），
  // 所以姓名用「包含」判定（标题必然包含），专业用「以之开头」判定（避免误杀合法专业名）。
  const SECTION_WORD = /简历|个人|求职|应聘|教育|经历|工作|实习|项目|技能|证书|荣誉|奖项|获奖|评价|信息|联系|方式|背景|校园|在校|实践|职务|社团|志愿|语言|兴趣|爱好|特长|概览|总结|介绍|说明/;
  const SECTION_HEAD_WORD = /^(简历|个人|求职|应聘|教育|经历|工作|实习|项目|技能|证书|荣誉|奖项|获奖|评价|信息|联系|方式|背景|校园|在校|实践|职务|社团|志愿|语言|兴趣|爱好|特长|概览|总结|介绍|说明)/;
  const DEGREE_WORD = /^(博士|硕士|本科|学士|大专|专科|高中|全日制|非全日制)$/;

  const setIfEmpty = (groupId, key, value) => {
    if (!value) return;
    if (groupById(groupId).kind === 'object') {
      if (!profile[groupId][key]) profile[groupId][key] = String(value).trim();
    }
  };

  // 手机号：允许中间带空格/横线（138-0000-0000），匹配后去掉分隔符
  const phoneRaw = src.match(/(?<!\d)1[3-9]\d[\s\-]?\d{4}[\s\-]?\d{4}(?!\d)/);
  if (phoneRaw) setIfEmpty('basic', 'phone', phoneRaw[0].replace(/[\s\-]/g, ''));

  const email = src.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  setIfEmpty('basic', 'email', email?.[0]);

  // 姓名：优先「姓名：X」，其次前 5 行里的 2-4 字纯中文行（排除章节标题）
  const namedLine = src.match(/(?:姓\s*名|名字)\s*[:：]?\s*([\u4e00-\u9fff·]{2,6})/);
  if (namedLine) {
    setIfEmpty('basic', 'name', namedLine[1]);
  } else {
    for (const line of lines.slice(0, 5)) {
      if (/^[\u4e00-\u9fff·]{2,4}$/.test(line) && !SECTION_WORD.test(line)) {
        setIfEmpty('basic', 'name', line);
        break;
      }
    }
  }

  const gender = src.match(/(?:性\s*别)\s*[:：]?\s*(男|女)/);
  setIfEmpty('basic', 'gender', gender?.[1]);

  const birthday = src.match(/(?:出生|生日)\D{0,4}((?:19|20)\d{2})[.\-/年]?(\d{1,2})?/);
  if (birthday) setIfEmpty('basic', 'birthDate', `${birthday[1]}${birthday[2] ? '.' + birthday[2].padStart(2, '0') : ''}`);

  const city = src.match(/(?:现居|所在城市|居住地|现居地)\s*[:：]?\s*([\u4e00-\u9fff]{2,10})/);
  setIfEmpty('basic', 'currentCity', city?.[1]);

  const hometown = src.match(/籍贯\s*[:：]?\s*([\u4e00-\u9fff]{2,10})/);
  setIfEmpty('basic', 'hometown', hometown?.[1]);

  const nativePlace = src.match(/生源地\s*[:：]?\s*([\u4e00-\u9fff]{2,10})/);
  setIfEmpty('basic', 'nativePlace', nativePlace?.[1]);

  // 民族：只认「XX族」这种明确写法，不做猜测
  const ethnicity = src.match(/民族\s*[:：]?\s*([\u4e00-\u9fff]{1,4}族)/);
  setIfEmpty('basic', 'ethnicity', ethnicity?.[1]);

  const political = src.match(/(中共党员|中共预备党员|共青团员|民主党派|群众)/);
  setIfEmpty('basic', 'politicalStatus', political?.[1]);

  // ── 求职意向 ──
  const position = src.match(/(?:求职意向|应聘岗位|目标岗位|意向岗位)\s*[:：]?\s*([^\n，,；;]{2,20})/);
  setIfEmpty('intent', 'targetPosition', position?.[1]);

  const targetCity = src.match(/(?:期望工作城市|期望城市|意向城市|期望工作地)\s*[:：]?\s*([\u4e00-\u9fff\/、]{2,20})/);
  setIfEmpty('intent', 'targetCity', targetCity?.[1]);

  const salary = src.match(/(?:期望月薪|期望薪资|期望薪酬|薪资要求|薪酬要求)\s*[:：]?\s*([^\n，,；;]{1,20})/);
  setIfEmpty('intent', 'targetSalary', salary?.[1]);

  const jobTypeHit = src.match(/求职类型\s*[:：]?\s*(实习|校招|社招|兼职)/);
  if (jobTypeHit) {
    setIfEmpty('intent', 'jobType', jobTypeHit[1]);
  } else {
    const looseJobType = src.match(/(实习|校招|校园招聘|社招|兼职)/);
    if (looseJobType) setIfEmpty('intent', 'jobType', looseJobType[1] === '校园招聘' ? '校招' : looseJobType[1]);
  }

  // ── 教育经历：学校 + 学历 + 专业 + 时间范围 ──
  const degree = src.match(/(博士|硕士|本科|学士|大专|专科)/);
  const edu = { ...createEmptyItem(groupById('education')) };
  const schools = [...src.matchAll(/([\u4e00-\u9fff]{2,15}(?:大学|学院|学校|职业技术学院))/g)].map(m => m[1]);
  const school = schools.sort((a, b) => b.length - a.length)[0];
  if (school) edu.school = school;
  if (degree) edu.degree = degree[1] === '学士' ? '本科' : (degree[1] === '专科' ? '大专' : degree[1]);
  const major = src.match(/专\s*业\s*[:：]\s*([\u4e00-\u9fff]{2,15})/);
  if (major) edu.major = major[1];
  // 简历常写「2022.09-2026.06 广东海洋大学 新闻学专业」——专业名紧跟学校名，没有冒号。
  // ⚠️ 不能只取「第一行含学校名的行」：「出生年月：2005年6月 毕业院校：广东海洋大学」
  // 往往排在教育行之前，而学校名落在行尾时它后面什么都没有，
  // 于是真正含专业的那一行被挤掉，专业就空了。必须遍历所有候选行。
  if (!edu.major && school) {
    const schoolLines = lines.filter(l => l.includes(school));
    for (const schoolLine of schoolLines) {
      const after = schoolLine.slice(schoolLine.indexOf(school) + school.length);
      const match = after.match(/([\u4e00-\u9fff]{2,15})/);
      if (!match) continue;
      if (DEGREE_WORD.test(match[1]) || SECTION_HEAD_WORD.test(match[1])) continue;
      // 「电子信息工程专业」→「电子信息工程」：网申里专业名一般不带「专业」二字
      edu.major = match[1].replace(/专业$/, '');
      break;
    }
  }
  const college = src.match(/([\u4e00-\u9fff]{2,15}学院)/);
  if (college && college[1] !== school) edu.college = college[1];
  const range = src.match(/((?:19|20)\d{2})[.\-/年]?\s*(\d{1,2})?\s*[-–—~至到]\s*((?:19|20)\d{2})[.\-/年]?\s*(\d{1,2})?/);
  if (range) {
    edu.startDate = `${range[1]}${range[2] ? '.' + range[2].padStart(2, '0') : ''}`;
    edu.endDate = `${range[3]}${range[4] ? '.' + range[4].padStart(2, '0') : ''}`;
  }
  const gpa = src.match(/GPA\s*[:：]?\s*([\d.]+\s*\/?\s*[\d.]*)/i);
  if (gpa) edu.gpa = gpa[1].trim();
  // 排名与 GPA 在网申里是两个独立输入框，且「3/120」比「前 20%」更有说服力
  const rankRatio = src.match(/排名\s*[:：]?\s*(\d{1,4}\s*\/\s*\d{1,5})/);
  const rankPercent = src.match(/(?:专业|年级|班级)\s*前\s*(\d{1,3}\s*%)/);
  if (rankRatio) edu.rank = rankRatio[1].replace(/\s+/g, '');
  else if (rankPercent) edu.rank = `专业前${rankPercent[1].replace(/\s+/g, '')}`;
  // 主修课程：中石油等系统在「其他描述」栏明确要求填核心课程
  const courses = src.match(/(?:主修课程|核心课程|主要课程|修读课程)\s*[:：]\s*([^\n]{4,400})/);
  if (courses) edu.courses = courses[1].replace(/[。；;]\s*$/, '').trim();
  if (!edu.studyMode && /全日制/.test(src)) edu.studyMode = '全日制';
  if (itemHasValue(edu, groupById('education'))) profile.education.push(edu);

  // ── 章节切分 ──
  const sections = localSplitSections(lines);

  // 工作/实习与项目经历：按章节切段后逐条目解析
  if (sections.experience && sections.experience.length) {
    for (const item of localExtractExperience(sections.experience)) profile.experience.push(item);
  } else {
    // 少数简历没有章节标题：整篇扫，但只认含公司类后缀的条目，
    // 否则「2023.09-2027.06 广东海洋大学 电子信息工程」会被当成一段实习
    for (const item of localExtractExperienceWithoutSection(lines)) {
      if (itemHasValue(item, groupById('experience'))) profile.experience.push(item);
    }
  }
  // 无章节标题时**不**全文扫项目 —— 「项目」二字在正文里太常见，会误抓一大片
  for (const item of localExtractProjects(sections.projects || [])) profile.projects.push(item);

  // 在校职务 / 在校实践：结构与实习同构，头部字段分别叫「职务名称」「实践名称」
  for (const item of localExtractHeaded('campusRole', 'title', sections.campusRole || [])) profile.campusRole.push(item);
  for (const item of localExtractHeaded('campusPractice', 'name', sections.campusPractice || [])) profile.campusPractice.push(item);

  // 技能 / 语言 / 证书：整篇扫。「技能证书」这类混排章节里的内容也在这三类里，
  // 按章节找会漏掉一半
  profile.skills.push(...localSkillItems(src));
  profile.languages.push(...localLanguageItems(src));
  profile.certificates.push(...localCertificateItems(src, sections.certificates || []));

  // 荣誉奖项：混在「技能证书」章节里也很常见，两个章节的行都要过一遍
  profile.honors.push(...localHonorItems((sections.honors || []).concat(sections.skills || [])));

  // 附加信息：兴趣爱好 / 特长各一章
  const hobby = localJoinBody(sections.hobby || []);
  if (hobby) profile.extra.hobby = hobby;
  const strength = localJoinBody(sections.strength || []);
  if (strength) profile.extra.strength = strength;

  // 自我评价：优先取「自我评价」章节，其次是按标题往下数 3 行
  const selfBody = localJoinBody(sections.selfEvaluation || []);
  if (selfBody) {
    profile.extra.selfEvaluation = selfBody;
  } else {
    const selfIdx = lines.findIndex(l => /自我评价|个人评价|个人总结/.test(l) && l.length <= 12);
    if (selfIdx >= 0) {
      const body = lines.slice(selfIdx + 1, selfIdx + 4)
        .filter(l => !/^(教育|工作|实习|项目|技能|荣誉|证书)/.test(l))
        .join(' ');
      if (body) profile.extra.selfEvaluation = body;
    }
  }

  const links = [...new Set([...src.matchAll(/(?:https?:\/\/|www\.)[^\s，,；;）)]+/g)].map(m => m[0]))];
  if (links.length) profile.extra.portfolio = links.slice(0, 3).join('\n');

  profile.updatedAt = new Date().toISOString();
  return profile;
}

// ── 解析 AI 返回的「## 分组 + 键：值」文本 ──────
// 项目约定：不让 AI 输出 JSON（JSON 一个逗号错了就全废）。
// 这里按 Markdown 标题切块，块内按「字段名：值」取键值，字段名用中文标签匹配。
// 容错要点：宁缺勿错——认不出的行按上一个字段的续行处理，认不出的分组直接丢弃。

function splitProfileBlocks(text) {
  const blocks = [];
  let current = null;
  let inFence = false;

  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const heading = line.match(/^#{1,6}\s*(.+)$/);
    if (heading) {
      current = { heading: heading[1].trim(), lines: [] };
      blocks.push(current);
      continue;
    }
    if (!current) {
      current = { heading: '', lines: [] };
      blocks.push(current);
    }
    current.lines.push(raw);
  }
  return blocks;
}

// 「## 教育经历 2」「## 教育经历（第二段）」都能归到教育经历组
function resolveGroupFromHeading(heading) {
  const cleaned = String(heading || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s*\d+\s*$/, '')
    .replace(/[：:]\s*$/, '')
    .trim();
  if (!cleaned) return null;
  const target = normKey(cleaned);

  // 先精确匹配别名，再退化到「包含分组名」（如「工作与实习经历」）
  for (const group of PROFILE_GROUPS) {
    const aliases = PROFILE_GROUP_ALIASES[group.id] || [group.id];
    if (aliases.some(a => normKey(a) === target)) return group;
  }
  for (const group of PROFILE_GROUPS) {
    if (target.includes(normKey(group.label))) return group;
  }
  return null;
}

// 块内解析「字段名：值」。认不出的行作为上一个字段的续行（AI 常把长内容换行）。
// 键名解析带分组，否则「获奖项：X」会被解成「姓名」——五六个分组里都有关键字段叫 name
function parseProfilePairs(lines, group) {
  const pairs = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const match = line.match(/^\s*[-*•]?\s*([^：:]{1,24})\s*[:：]\s*(.*)$/);
    const key = match ? resolveProfileKeyInGroup(match[1].trim(), group) : null;

    if (key) {
      current = { key, value: match[2].trim() };
      pairs.push(current);
    } else if (current) {
      const extra = line.replace(/^\s*[-*•]\s*/, '').trim();
      if (extra) current.value += (current.value ? '；' : '') + extra;
    }
  }
  return pairs;
}

function parseProfileText(raw) {
  const text = String(raw || '').replace(/\r/g, '').trim();
  if (!text) throw new Error('AI 未返回内容');

  // 容错：个别模型坚持输出 JSON，能解析就用，解析不了继续走文本解析
  if (/^\s*[{[]/.test(text) || /```json/i.test(text)) {
    try { return parseProfileJson(text); } catch (e) { /* 继续按文本解析 */ }
  }

  const out = createEmptyProfile();
  let touched = false;

  for (const block of splitProfileBlocks(text)) {
    const group = resolveGroupFromHeading(block.heading);
    if (!group) continue;
    const pairs = parseProfilePairs(block.lines, group);
    if (!pairs.length) continue;

    if (group.kind === 'list') {
      let item = createEmptyItem(group);
      let hasValue = false;
      const flush = () => {
        if (hasValue) { out[group.id].push(item); touched = true; }
        item = createEmptyItem(group);
        hasValue = false;
      };
      for (const { key, value } of pairs) {
        if (!value || !group.fields.some(f => f.key === key)) continue;
        // 同一字段在块内重复出现 → 说明开始了下一条经历
        if (item[key]) flush();
        item[key] = value;
        hasValue = true;
      }
      flush();
    } else {
      for (const { key, value } of pairs) {
        if (!value || !group.fields.some(f => f.key === key)) continue;
        out[group.id][key] = value;
        touched = true;
      }
    }
  }

  if (!touched) throw new Error('AI 返回的内容里没有可识别的字段');
  out.updatedAt = new Date().toISOString();
  return out;
}

// ── 从 AI 返回文本里提取 JSON（容错分支）─────────

function extractJsonBlock(raw) {
  let text = String(raw || '').trim();
  // 去掉 ```json ... ``` 围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('AI 未返回可解析的结构化数据');
  return text.slice(first, last + 1);
}

function parseProfileJson(raw) {
  return normalizeProfile(JSON.parse(extractJsonBlock(raw)));
}

// ── 存储读写 ──────────────────────────────────

const PROFILE_STORAGE_KEYS = ['savedResumeProfile', 'profileVersion'];

function loadProfileFromStorage() {
  return new Promise(resolve => {
    chrome.storage.local.get(PROFILE_STORAGE_KEYS, (data) => {
      if (!data.savedResumeProfile) { resolve(null); return; }
      try {
        // normalizeProfile 内部会先跑 migrateProfile，v1 数据在读取时就被升级
        resolve(normalizeProfile(data.savedResumeProfile));
      } catch (e) {
        console.warn('结构化简历读取失败', e);
        resolve(null);
      }
    });
  });
}

function saveProfileToStorage(profile) {
  if (!profile) return;
  profile.version = PROFILE_SCHEMA_VERSION;
  profile.updatedAt = new Date().toISOString();
  chrome.storage.local.set({ savedResumeProfile: profile, profileVersion: PROFILE_SCHEMA_VERSION });
}

function clearProfileFromStorage() {
  return new Promise(resolve => {
    chrome.storage.local.remove(PROFILE_STORAGE_KEYS, resolve);
  });
}

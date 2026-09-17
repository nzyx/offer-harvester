// ── 网申表单预填：字段语义识别与取值（纯算法层）──
//
// 设计约束：
//   · 本文件不含任何 DOM 操作，可在 node 下直接加载做单元验证。
//   · 输入是「字段特征对象」（由 form-fill-page.js 采集，可结构化克隆），输出是填写计划。
//   · 不依赖 profile.js：分组是「对象」还是「列表」由 profile 自身结构判断（Array.isArray），
//     因此两份文件既可各自测试，也可任意顺序加载。
//
// 核心策略 —— 宁缺勿错：
//   每个字段对候选语义打分，低于阈值不认、与次优解过于接近也不认。
//   认不出/不明确的字段一律交给用户手填，并如实说明原因，绝不猜。
//
// 已知无法程序化写入的两类控件（浏览器安全模型所限，不做无效尝试）：
//   · 自定义下拉框（div 模拟的 select）：写入 input.value 不会进入组件状态
//   · 文件上传（input[type=file]）：不允许脚本赋值
//   这两类一律跳过并提示用户手填。

// ── 打分参数 ──────────────────────────────────

const FILL_SCORE_THRESHOLD = 7.5;    // 低于此分视为「认不出」
const FILL_AMBIGUOUS_DELTA = 0.9;    // 与次优解分差小于此值视为「含义不明确」
const FILL_STRONG_BASE = 6;          // 高置信关键词基础分
const FILL_WEAK_BASE = 2.5;          // 低置信关键词基础分
const FILL_TIER_W = { attr: 1, label: 0.85, near: 0.45 };
const FILL_ANCHOR_BONUS = 1.5;       // 关键词命中在开头（说明是主词而非修饰）
const FILL_EXACT_BONUS = 1;          // 整段文本就等于关键词
// 「标签层的整段文字恰好就是这个关键词」。这比「标签里包含这个关键词」强得多——
// 表单给字段起名就是这么短，一个字段的标签整段就是「邮箱」，那它就是邮箱。
// 弱词（lo）靠它才能单独成立：只算子串匹配时「邮箱」只有 5.6 分，
// 永远够不到 7.5 的阈值，而它明明是中文里最标准的邮箱标签写法。
const FILL_WHOLE_LABEL_BONUS = 2;
const FILL_SECTION_BONUS = 2.5;      // 与所在章节分组一致
const FILL_SECTION_MISMATCH = 1.5;   // 与所在章节分组冲突
const FILL_TYPE_BONUS = 1;           // 控件类型符合该字段的预期
const FILL_TYPE_PENALTY = 2;         // 控件类型明显不符
const FILL_AUTOCOMPLETE_SCORE = 13;  // HTML autocomplete 是标准语义，直接判定

const FILL_MAX_NEAR_LEN = 40;        // 邻近文本最大长度（超过基本是段落，不是标签）
const FILL_MAX_SECTION_MARKERS = 3;  // 最多回溯几层章节标题

// 无信息量的占位符。它们不含字段语义，留在标签层只会稀释信号：
// 实测「label=邮箱 + placeholder=请选择」会认不出邮箱，因为占位符把标签层
// 从「整段就是关键词」变成了「关键词加三个无关字」，锚点与整段匹配奖励全丢。
// 注意分辨：「请输入姓名」有信息（保留），「请选择」没有（剔除）。
const FILL_GENERIC_TEXT_RE = /^(请)?(选择|选取|选|输入|填写|录入|添加|点击|上传)(或输入|或选择|内容|文本|文字|数字|日期|时间|金额|数量|更多)?$/;
const FILL_GENERIC_EXTRA_RE = /^(必填|选填|可填|非必填|无|暂无|没有|其他|其它|以上都不是)$/i;

// 整个标签就是「国家 / 地区」的字段：手机号前面那个区号选择框。
// 它不含任何原生控件（是个 div 模拟的下拉），所以躲过了所有类型判断，
// 曾经被识别成 basic.phone 并把手机号填了进去 —— 数据填错框比不填更糟。
const FILL_REGION_ONLY_RE = /^(中国)?(大陆|内地|香港|澳门|台湾|境内|境外|海外|国内|国外)$|^(国家|国籍|地区|国家和地区|国家地区|国家或地区|区号|国际区号|国家代码|地区代码)$/;

const FILL_DEFAULT_SENSITIVE = ['idCard', 'bankAccount', 'homeAddress', 'emergencyContact'];

// ── 章节关键词（用于把字段归到哪一组）───────────
//
// ⚠️ 12 组里有几组的关键词长得像，动这张表前先看清三条：
//   · 「实践」类词汇归 campusPractice，不能留在 projects ——
//     北森等系统的「实践经历」独立于「项目经历」，留在 projects 会让两组抢填同一栏
//   · 「其他信息 / 补充信息」归 extra，不能留在 skills
//   · 「技能证书」这种混排标题归 skills（它是技能这一桶），
//     「资格证书 / 证书情况」归 certificates。resolveSectionGroup 取最长匹配，
//     所以「技能证书」不会因为含「证书」二字被判给 certificates
const FILL_SECTION_KEYWORDS = {
  basic: ['基础信息', '基本信息', '个人信息', '基本资料', '个人资料', '联系方式', '基础资料', 'basicinfo', 'personalinfo'],
  intent: ['求职意向', '应聘意向', '求职意愿', '意向信息', '求职期望', 'jobintention', 'expectation'],
  education: ['教育经历', '教育背景', '教育信息', '学历信息', '学习经历', '教育情况', 'education'],
  experience: ['工作经历', '实习经历', '工作经验', '实习经验', '工作与实习', '职业经历', '工作履历', 'experience', 'employment'],
  projects: ['项目经历', '项目经验', '项目信息', '科研经历', 'projects'],
  campusRole: ['在校职务', '校园职务', '校内职务', '学生职务', '学生工作', '社团职务', '社团经历', '学生会', 'campusrole', 'studentwork'],
  campusPractice: ['在校实践', '社会实践', '校园实践', '实践活动', '实践经历', '实践项目', '实践信息',
    '志愿活动', '志愿服务', 'campuspractice', 'socialpractice'],
  extra: ['附加信息', '其他信息', '补充信息', '兴趣爱好', '兴趣特长', '个人特长', 'additional'],
  skills: ['专业技能', '技能特长', '技能证书', '技能与补充', '技能', 'skills'],
  honors: ['获奖情况', '荣誉奖项', '获奖经历', '获奖记录', '荣誉证书', '荣誉', '奖项', '奖励', 'honors', 'awards'],
  languages: ['语言能力', '语言水平', '外语水平', '语言等级', '语言', 'languages'],
  certificates: ['资格证书', '证书情况', '证书信息', '证书', 'certificates']
};

// HTML autocomplete 标准值 → 语义 id
const FILL_AUTOCOMPLETE_MAP = {
  name: 'basic.name',
  'given-name': 'basic.name',
  'family-name': 'basic.name',
  nickname: 'basic.name',
  tel: 'basic.phone',
  'tel-national': 'basic.phone',
  email: 'basic.email',
  bday: 'basic.birthDate',
  sex: 'basic.gender',
  'street-address': 'basic.homeAddress',
  address: 'basic.homeAddress',
  country: 'basic.homeAddress',
  organization: 'experience.company',
  'organization-title': 'experience.title',
  'postal-code': 'basic.homeAddress',
  off: null,
  on: null,
  'new-password': null
};

// ── 字段规则表 ────────────────────────────────
// hi：高置信关键词（任何位置命中都算）
// lo：低置信关键词（单独命中不足以判定，需要章节或类型佐证）
// types：该语义允许的控件类型
// not：排除词。命中即整条规则作废，用于挡住「公司规模」「学校性质」这类
//      被泛词误命中的字段（它们含「公司」「学校」但填的不是公司名/学校名）。

const FILL_RULES = [
  // ── 基础信息 ──────────────────────────────
  {
    id: 'basic.name', group: 'basic', key: 'name', types: ['text', 'number'],
    hi: ['真实姓名', '中文姓名', '姓名', '名字', 'realname', 'fullname', 'chinesename', 'truename', 'applicantname'],
    lo: ['name', 'username', '昵称'],
    not: ['项目', '公司', '企业', '单位', '学校', '学院', '专业', '文件', '证书', '课程', '活动',
      '导师', '推荐人', '家长', '紧急', '机型', '型号', '品类', '产品']
  },
  {
    id: 'basic.gender', group: 'basic', key: 'gender', types: ['select', 'radio', 'text', 'combobox'],
    hi: ['性别', 'gender', 'sex'], lo: []
  },
  {
    id: 'basic.birthDate', group: 'basic', key: 'birthDate', types: ['date', 'month', 'text', 'number', 'select'],
    hi: ['出生日期', '出生年月日', '出生年月', '生日', '出生时间', 'birthday', 'birthdate', 'dateofbirth'],
    lo: ['出生', 'birth', 'dob'],
    not: ['地', '城市', '省份', '籍贯', '地点']
  },
  {
    id: 'basic.phone', group: 'basic', key: 'phone', types: ['tel', 'text', 'number'],
    hi: ['手机号码', '移动电话', '联系电话', '电话号码', '手机号', '手机', '联系方式', '联络电话',
      'mobileno', 'phonenumber', 'mobilephone', 'telephone', 'contactphone'],
    lo: ['mobile', 'phone', 'tel', 'contact'],
    not: ['紧急', '家长', '推荐人', '介绍人', '区号', '邮编']
  },
  {
    id: 'basic.email', group: 'basic', key: 'email', types: ['email', 'text'],
    hi: ['电子邮箱', '邮箱地址', '电子邮件', '电子信箱', 'emailaddress', 'email'],
    lo: ['mail', '邮箱']
  },
  {
    id: 'basic.currentCity', group: 'basic', key: 'currentCity', types: ['select', 'text', 'combobox'],
    hi: ['现居住城市', '现居城市', '现居住地', '当前城市', '所在城市', '现居地', '居住城市', '常驻城市',
      'currentcity', 'currentlocation', 'residence'],
    lo: ['现居', 'city', 'location', '所在地'],
    not: ['出生', '籍贯', '户籍', '户口', '期望', '目标', '意向', '生源']
  },
  {
    id: 'basic.hometown', group: 'basic', key: 'hometown', types: ['select', 'text', 'combobox'],
    hi: ['户籍所在地', '籍贯', '户籍地', '户口所在地', 'hometown', 'domicile'],
    lo: ['户籍', '户口', '籍贯地'],
    // 生源地是「高考时的户籍所在地」，与籍贯不是一个字段。网申里两者分开填，
    // 且央国企常用生源地做属地岗位匹配，混填会让用户错过本可匹配的岗位
    not: ['生源']
  },
  {
    id: 'basic.nativePlace', group: 'basic', key: 'nativePlace', types: ['select', 'text', 'combobox'],
    hi: ['生源地', '生源所在地', '高考户籍所在地', 'nativeplace', 'native_place'],
    lo: ['生源'],
    not: ['籍贯', '现居', '毕业院校', '就读', '学校']
  },
  {
    id: 'basic.politicalStatus', group: 'basic', key: 'politicalStatus', types: ['select', 'radio', 'text', 'combobox'],
    hi: ['政治面貌', '政治身份', 'politicalstatus', 'political'], lo: []
  },
  {
    id: 'basic.ethnicity', group: 'basic', key: 'ethnicity', types: ['select', 'text', 'combobox'],
    hi: ['民族', 'ethnicity', 'ethnic'], lo: []
  },
  {
    id: 'basic.idCard', group: 'basic', key: 'idCard', types: ['text', 'number'],
    hi: ['身份证号码', '身份证号', '身份证', '证件号码', 'idcard', 'idnumber', 'identitycard'],
    lo: ['证件号']
  },
  {
    id: 'basic.bankAccount', group: 'basic', key: 'bankAccount', types: ['text', 'number'],
    hi: ['银行卡号', '银行账号', '开户行', '银行卡', 'bankaccount', 'bankcard'], lo: ['卡号']
  },
  {
    id: 'basic.homeAddress', group: 'basic', key: 'homeAddress', types: ['text', 'textarea'],
    hi: ['家庭住址', '通讯地址', '联系地址', '居住地址', '现住址', '详细地址', 'homeaddress', 'postaladdress'],
    lo: ['地址', 'address'],
    not: ['邮箱', '邮件', '网址', '链接', 'IP', 'ip']
  },
  {
    id: 'basic.emergencyContact', group: 'basic', key: 'emergencyContact', types: ['text'],
    hi: ['紧急联系人', '紧急联系电话', 'emergencycontact'], lo: ['emergency']
  },
  // 「最高学历 / 最高学位」是个人信息栏独有的两个字段：问的是「最高那一档」，
  // 不是某一条教育经历的学历。值取 profile.basic 里的派生值（由
  // profile.js 的 applyProfileDerived 从教育经历里挑学历最高的一条带出），
  // 因此用户只需要在教育经历里填一遍，两栏都能填上。
  {
    id: 'basic.degree', group: 'basic', key: 'degree', types: ['select', 'radio', 'text', 'combobox'],
    hi: ['最高学历', 'highesteducation', 'educationlevelhighest'],
    lo: ['学历'],
    not: ['专业', '学校', '学院', '证书', '验证']
  },
  {
    id: 'basic.degreeLevel', group: 'basic', key: 'degreeLevel', types: ['select', 'radio', 'text', 'combobox'],
    hi: ['最高学位', '学位层次', 'highestdegree'],
    lo: ['学位'],
    not: ['学历', '专业', '学校', '学院', '证书', '验证']
  },

  // ── 求职意向 ──────────────────────────────
  {
    id: 'intent.targetPosition', group: 'intent', key: 'targetPosition', types: ['select', 'text', 'combobox'],
    hi: ['期望从事岗位', '期望工作职位', '期望工作岗位', '期望职位', '期望岗位', '意向岗位', '意向职位', '求职意向',
      '应聘岗位', '应聘职位', '目标岗位', '申请职位', '申报岗位',
      'expectedposition', 'targetposition', 'desiredposition', 'jobintention', 'applyposition'],
    lo: ['position', '岗位', '职位', '意向'],
    not: ['公司', '项目', '学校', '部门', '入职', '离职']
  },
  {
    id: 'intent.targetCity', group: 'intent', key: 'targetCity', types: ['select', 'text', 'combobox'],
    hi: ['期望工作城市', '期望工作地点', '期望工作地', '期望城市', '意向城市', '意向工作地', '意向工作城市',
      'expectedcity', 'desiredcity', 'worklocation'],
    lo: ['期望地点', '意向地区']
  },
  {
    id: 'intent.targetSalary', group: 'intent', key: 'targetSalary', types: ['select', 'text', 'number', 'combobox'],
    hi: ['期望薪资', '期望薪酬', '期望月薪', '期望工资', '薪资要求', '薪酬要求', '薪资期望',
      'expectedsalary', 'desiredsalary'],
    lo: ['薪资', '薪酬', 'salary']
  },
  {
    id: 'intent.availableDate', group: 'intent', key: 'availableDate', types: ['select', 'text', 'date', 'month', 'combobox'],
    hi: ['到岗时间', '到岗日期', '入职时间', '可到岗时间', '最快到岗', '到岗', 'onboarddate', 'entrydate', 'availabledate'],
    lo: ['入职']
  },
  {
    id: 'intent.jobType', group: 'intent', key: 'jobType', types: ['select', 'radio', 'text', 'combobox'],
    hi: ['求职类型', '求职性质', '工作性质', '应聘类型', '应聘性质', 'jobtype', 'jobnature', 'employmenttype'],
    lo: ['求职方式']
  },

  // ── 教育经历 ──────────────────────────────
  {
    id: 'education.school', group: 'education', key: 'school', types: ['text', 'select', 'combobox'],
    hi: ['毕业院校', '学校名称', '就读学校', '毕业学校', '院校名称', '学校', 'graduationschool', 'schoolname'],
    lo: ['院校', 'school', 'university'],
    not: ['性质', '类型', '地址', '地点', '排名', '简介', '介绍', '所在地', '层次', '代码']
  },
  {
    id: 'education.college', group: 'education', key: 'college', types: ['text', 'select', 'combobox'],
    hi: ['所在学院', '学院名称', '院系', '学院', 'faculty', 'department'], lo: ['college']
  },
  {
    id: 'education.major', group: 'education', key: 'major', types: ['text', 'select', 'combobox'],
    hi: ['所学专业', '专业名称', '就读专业', '专业方向', '专业', 'majorname', 'major'],
    lo: ['speciality'],
    not: ['排名', '课程', '方向课', '要求']
  },
  {
    id: 'education.degree', group: 'education', key: 'degree', types: ['select', 'radio', 'text', 'combobox'],
    // ⚠️ 「最高学历」必须留给 basic.degree（见下）。它问的是「最高那一档」，
    // 不是「某一条经历的学历」——留在 education 里会取下第一条经历，
    // 用户填了硕士却被填成第一条的本科，是事实性错误。
    hi: ['学历层次', '学历', '学位', '文化程度', 'educationlevel', 'degreetype'],
    lo: ['degree', 'education', 'qualification'],
    // 「最高」前缀的字段一律不由经历条目回答（教育经历区块里不会出现「最高」二字）
    not: ['专业', '学校', '学院', '证书', '验证', '最高']
  },
  {
    id: 'education.studyMode', group: 'education', key: 'studyMode', types: ['select', 'radio', 'text', 'combobox'],
    hi: ['培养方式', '学习形式', '培养类型', '就读方式', 'studymode'], lo: ['全日制']
  },
  {
    id: 'education.gpa', group: 'education', key: 'gpa', types: ['text', 'number'],
    hi: ['平均绩点', '绩点', '平均成绩', '平均分', 'gpa', 'gradepoint'],
    lo: ['成绩'],
    // 排名已经从 GPA 里拆出来独立成字段，这里必须排掉，否则排名会被填进 GPA 框
    not: ['排名', '百分比', '百分位']
  },
  {
    id: 'education.rank', group: 'education', key: 'rank', types: ['text', 'number', 'select'],
    hi: ['专业排名', '年级排名', '班级排名', '成绩排名', '排名百分比', 'classrank', 'professionrank'],
    lo: ['排名', 'ranking'],
    not: ['学校排名', '大学排名', '院校排名', '公司排名', '企业排名', '排行榜']
  },
  {
    id: 'education.courses', group: 'education', key: 'courses', types: ['textarea', 'text'],
    hi: ['主修课程', '核心课程', '主要课程', '修读课程', '专业课程', 'corecourses', 'maincourses'],
    lo: ['课程'],
    not: ['课程编号', '课程代码']
  },
  {
    id: 'education.startDate', group: 'education', key: 'startDate', types: ['date', 'month', 'text', 'number', 'select'],
    hi: ['入学时间', '入学日期', '就读开始时间', 'enrollmentdate'], lo: ['入学', '开始时间', '起始时间']
  },
  {
    id: 'education.endDate', group: 'education', key: 'endDate', types: ['date', 'month', 'text', 'number', 'select'],
    hi: ['毕业时间', '毕业日期', '毕业年月', '离校时间', 'graduationdate'], lo: ['毕业', '结束时间']
  },
  {
    id: 'education.range', group: 'education', key: 'range', types: ['text'],
    hi: ['就读起止时间', '在校起止时间', '起止时间', '在校时间', '就读时间', '学习时间', 'educationperiod'], lo: []
  },
  {
    id: 'education.ongoing', group: 'education', key: 'ongoing', types: ['checkbox'], optional: true,
    hi: ['至今', '在读', '仍在读', '目前在校'], lo: []
  },

  // ── 工作与实习 ──────────────────────────────
  {
    id: 'experience.company', group: 'experience', key: 'company', types: ['text', 'select', 'combobox'],
    hi: ['公司名称', '工作单位', '单位名称', '实习公司', '实习单位', '企业名称', '公司',
      'companyname', 'employer', 'organization'],
    lo: ['单位', 'company'],
    not: ['规模', '行业', '性质', '类型', '人数', '简介', '介绍', '电话', '地址', '网站', '邮箱', '成立',
      '职位', '岗位', '描述', '直属']
  },
  {
    id: 'experience.department', group: 'experience', key: 'department', types: ['text', 'select', 'combobox'],
    hi: ['所属部门', '部门名称', '所在部门', '任职部门', 'department', 'dept'],
    lo: ['部门', '事业部'],
    // 「学院 / 院系」属于教育经历，不是实习部门
    not: ['学院', '院系', '系别', '学校', '专业']
  },
  {
    id: 'experience.industry', group: 'experience', key: 'industry', types: ['text', 'select', 'combobox'],
    hi: ['所属行业', '行业类别', '行业领域', 'industry', 'sector'],
    lo: ['行业'],
    // 「行业规模」「行业排名」「行业分析」问的不是行业名
    not: ['规模', '排名', '前景', '分析', '研究']
  },
  {
    id: 'experience.title', group: 'experience', key: 'title', types: ['text', 'select', 'combobox'],
    hi: ['职位名称', '岗位名称', '担任职务', '担任职位', '实习岗位', '实习职位', '职务',
      'jobtitle', 'worktitle', 'positionname'],
    lo: ['职位', '岗位', 'title'],
    not: ['公司', '部门', '期望', '意向', '目标', '应聘', '离职', '申请']
  },
  {
    id: 'experience.description', group: 'experience', key: 'description', types: ['textarea', 'text'],
    // 「职务描述/职责描述」在项目侧也有一份，靠章节归组消歧：
    // 项目区块里判给 projects.description，实习/工作区块里判给这里。
    hi: ['主要工作内容', '工作职责', '工作内容', '工作描述', '实习内容', '岗位职责', '工作内容描述',
      '职务描述', '职责描述', 'jobdescription', 'workcontent'],
    lo: ['职责', '工作', '描述', '简介']
  },
  {
    id: 'experience.achievement', group: 'experience', key: 'achievement', types: ['textarea', 'text'],
    hi: ['工作成果', '工作业绩', '业绩成果', '主要业绩'], lo: ['成果', '业绩']
  },
  {
    id: 'experience.startDate', group: 'experience', key: 'startDate', types: ['date', 'month', 'text', 'number', 'select'],
    hi: ['实习开始时间', '工作开始时间', '任职开始时间'], lo: ['开始时间', '起始时间']
  },
  {
    id: 'experience.endDate', group: 'experience', key: 'endDate', types: ['date', 'month', 'text', 'number', 'select'],
    hi: ['实习结束时间', '工作结束时间', '离职时间', '任职结束时间'], lo: ['结束时间']
  },
  {
    id: 'experience.range', group: 'experience', key: 'range', types: ['text'],
    hi: ['任职起止时间', '工作起止时间', '在职时间', '任职时间', '实习时间', 'employmentperiod'], lo: []
  },
  {
    id: 'experience.ongoing', group: 'experience', key: 'ongoing', types: ['checkbox'], optional: true,
    hi: ['至今', '仍在职', '目前在职'], lo: []
  },

  // ── 项目经历 ──────────────────────────────
  {
    id: 'projects.name', group: 'projects', key: 'name', types: ['text'],
    // 「实践名称 / 实践项目 / 实践课题」已移给 campusPractice.name：
    // 它们属于在校实践那一栏，留在这里会和真正的项目名抢字段
    hi: ['项目名称', '项目名', 'projectname'], lo: ['项目'],
    not: ['公司', '学校', '企业', '单位', '经历', '描述', '职责', '周期', '时间']
  },
  {
    id: 'projects.role', group: 'projects', key: 'role', types: ['text', 'select', 'combobox'],
    hi: ['项目角色', '担任角色', '项目职责', '担任项目角色', '职务', '项目职务', 'campusrole']
      .concat(['projectrole']), lo: ['角色']
  },
  {
    id: 'projects.description', group: 'projects', key: 'description', types: ['textarea', 'text'],
    hi: ['项目描述', '项目简介', '项目内容', '项目介绍', '职务描述',
      '职责描述', 'projectdescription'],
    lo: ['描述', '简介']
  },
  {
    id: 'projects.techStack', group: 'projects', key: 'techStack', types: ['textarea', 'text'],
    hi: ['技术栈', '主要技术', '使用工具', '技术工具', '开发工具', 'techstack', 'technology'], lo: ['技术', '工具']
  },
  {
    id: 'projects.achievement', group: 'projects', key: 'achievement', types: ['textarea', 'text'],
    hi: ['项目成果', '项目业绩', '项目产出'], lo: []
  },
  {
    id: 'projects.startDate', group: 'projects', key: 'startDate', types: ['date', 'month', 'text', 'number', 'select'],
    hi: ['项目开始时间', '立项时间'], lo: ['开始时间']
  },
  {
    id: 'projects.endDate', group: 'projects', key: 'endDate', types: ['date', 'month', 'text', 'number', 'select'],
    hi: ['项目结束时间', '结项时间'], lo: ['结束时间']
  },
  {
    id: 'projects.range', group: 'projects', key: 'range', types: ['text'],
    hi: ['项目起止时间', '项目周期', '项目时间', 'projectperiod'], lo: []
  },
  {
    id: 'projects.ongoing', group: 'projects', key: 'ongoing', types: ['checkbox'], optional: true,
    hi: ['至今', '仍在进行', '目前仍在'], lo: []
  },

  // ── 在校职务 ──────────────────────────────
  // 「职务」在项目组是项目角色、在这里是在校职务。章节认不出来时判「含义不明确」
  // 交用户手填 —— 这是有意的，比随便挑一个填错好
  {
    id: 'campusRole.title', group: 'campusRole', key: 'title', types: ['text', 'select', 'combobox'],
    hi: ['职务名称', '学生职务', '社团职务', '担任职务', '校内职务', 'campusrole'],
    lo: ['职务', '角色'],
    not: ['公司', '单位', '项目', '描述', '职责', '时间', '内容']
  },
  {
    id: 'campusRole.description', group: 'campusRole', key: 'description', types: ['textarea', 'text'],
    hi: ['职务描述', '职务内容', '职务职责', '工作内容描述'], lo: ['描述', '职责']
  },
  {
    id: 'campusRole.startDate', group: 'campusRole', key: 'startDate', types: ['date', 'month', 'text', 'number', 'select'],
    hi: ['任职开始时间', '担任开始时间'], lo: ['开始时间']
  },
  {
    id: 'campusRole.endDate', group: 'campusRole', key: 'endDate', types: ['date', 'month', 'text', 'number', 'select'],
    hi: ['任职结束时间', '担任结束时间', '离任时间'], lo: ['结束时间']
  },
  {
    id: 'campusRole.range', group: 'campusRole', key: 'range', types: ['text'],
    // 不含「任职起止时间」：那个词是实习区块的写法，两边都写会在没有章节线索时
    // 判成「含义不明确」而白白丢掉一次可填机会
    hi: ['在校职务时间', '学生工作起止时间', '社团任职时间'], lo: []
  },
  {
    id: 'campusRole.ongoing', group: 'campusRole', key: 'ongoing', types: ['checkbox'], optional: true,
    hi: ['至今', '仍在任', '现在仍在'], lo: []
  },

  // ── 在校实践 ──────────────────────────────
  {
    id: 'campusPractice.name', group: 'campusPractice', key: 'name', types: ['text'],
    hi: ['实践名称', '实践活动名称', '活动名称', '实践项目', '实践课题', 'campuspractice'],
    lo: ['实践'],
    not: ['公司', '学校', '企业', '单位', '描述', '职责', '时间', '成果', '内容']
  },
  {
    id: 'campusPractice.description', group: 'campusPractice', key: 'description', types: ['textarea', 'text'],
    // 不含「实践成果」：那是产出，不是这次实践做了什么。填错位置比不填更糟
    hi: ['实践描述', '实践内容', '实践经历描述'], lo: ['描述']
  },
  {
    id: 'campusPractice.startDate', group: 'campusPractice', key: 'startDate', types: ['date', 'month', 'text', 'number', 'select'],
    hi: ['实践开始时间', '活动开始时间'], lo: ['开始时间']
  },
  {
    id: 'campusPractice.endDate', group: 'campusPractice', key: 'endDate', types: ['date', 'month', 'text', 'number', 'select'],
    hi: ['实践结束时间', '活动结束时间'], lo: ['结束时间']
  },
  {
    id: 'campusPractice.range', group: 'campusPractice', key: 'range', types: ['text'],
    hi: ['实践起止时间', '实践时间', '活动时间'], lo: []
  },
  {
    id: 'campusPractice.ongoing', group: 'campusPractice', key: 'ongoing', types: ['checkbox'], optional: true,
    hi: ['至今', '仍在进行'], lo: []
  },

  // ── 附加信息 ──────────────────────────────
  {
    id: 'extra.hobby', group: 'extra', key: 'hobby', types: ['textarea', 'text'],
    hi: ['兴趣爱好', '业余爱好', '个人爱好', 'hobby'], lo: ['爱好', '兴趣']
  },
  {
    id: 'extra.strength', group: 'extra', key: 'strength', types: ['textarea', 'text'],
    hi: ['个人特长', '特长', '专长', 'strongpoint'], lo: []
  },
  {
    id: 'extra.selfEvaluation', group: 'extra', key: 'selfEvaluation', types: ['textarea', 'text'],
    hi: ['自我评价', '个人评价', '自我介绍', '个人总结', '自荐理由', 'selfevaluation', 'selfintroduction', 'summary'],
    lo: ['评价', '简介']
  },
  {
    id: 'extra.portfolio', group: 'extra', key: 'portfolio', types: ['textarea', 'text', 'url'],
    hi: ['作品集链接', '作品链接', '个人主页', '博客地址', '作品展示', 'portfolio', 'homepage'], lo: ['作品', '主页', '链接']
  },

  // ── 技能 ──────────────────────────────────
  // 表单里技能有两种形态：一条一条的（技能名称 + 掌握程度）和整块文本框的（专业技能）。
  // 两种都要能填：前者走 name / level，后者走 summary（把多条技能合成一行）
  {
    id: 'skills.name', group: 'skills', key: 'name', types: ['text', 'select', 'combobox'],
    hi: ['技能名称', '专业技能', '技能特长', '掌握技能', '技能类别', 'skilltags'], lo: ['技能'],
    not: ['描述', '水平', '等级', '程度']
  },
  {
    id: 'skills.level', group: 'skills', key: 'level', types: ['text', 'select', 'combobox'],
    hi: ['掌握程度', '熟练程度', '技能水平'], lo: ['程度'],
    not: ['获奖', '奖项', '荣誉', '语言']
  },
  {
    id: 'skills.years', group: 'skills', key: 'years', types: ['text', 'number', 'select'],
    hi: ['使用时间总计', '使用年限', '使用时间', '技能年限'], lo: []
  },
  {
    id: 'skills.description', group: 'skills', key: 'description', types: ['textarea', 'text'],
    hi: ['技能描述', '技能说明'], lo: []
  },
  {
    id: 'skills.summary', group: 'skills', key: 'summary', types: ['textarea'],
    hi: ['专业技能', '技能特长', '技能证书', '计算机水平', '技能与特长', '技能标签'],
    lo: ['技能']
  },

  // ── 获奖情况 ──────────────────────────────
  {
    id: 'honors.name', group: 'honors', key: 'name', types: ['text', 'select', 'combobox'],
    hi: ['获奖项', '奖项名称', '奖励名称', '荣誉名称', '获奖名称'], lo: ['奖项', '荣誉', '获奖', '奖励'],
    not: ['时间', '日期', '级别', '等级', '描述', '编号', '代码']
  },
  {
    id: 'honors.date', group: 'honors', key: 'date', types: ['date', 'month', 'text', 'select'],
    hi: ['获奖时间', '获奖年月', '获奖日期', '奖项时间'], lo: []
  },
  {
    id: 'honors.level', group: 'honors', key: 'level', types: ['select', 'text', 'combobox'],
    hi: ['获奖级别', '奖项级别', '获奖等级', '奖项等级'], lo: ['级别', '等级'],
    not: ['时间', '日期']
  },
  {
    id: 'honors.description', group: 'honors', key: 'description', types: ['textarea', 'text'],
    hi: ['获奖描述', '奖项描述', '获奖原因', '获奖说明'], lo: []
  },
  {
    id: 'honors.summary', group: 'honors', key: 'summary', types: ['textarea'],
    hi: ['荣誉奖项', '获奖情况', '获奖经历', '荣誉证书', '奖励情况', '荣誉奖项及证书'],
    lo: ['荣誉', '奖项', '获奖', '奖励', '奖学金'],
    not: ['编号', '代码']
  },

  // ── 语言能力 ──────────────────────────────
  {
    id: 'languages.type', group: 'languages', key: 'type', types: ['text', 'select', 'combobox'],
    hi: ['语言类型', '语种', '语言种类'], lo: ['语言']
  },
  {
    id: 'languages.level', group: 'languages', key: 'level', types: ['text', 'select', 'combobox'],
    hi: ['掌握程度', '熟练程度', '语言等级'], lo: ['水平', '等级'],
    not: ['获奖', '奖项']
  },
  {
    id: 'languages.summary', group: 'languages', key: 'summary', types: ['textarea'],
    hi: ['外语水平', '语言能力', '语言水平', '语言等级', '外语能力'], lo: ['语言', '外语']
  },

  // ── 证书 ──────────────────────────────────
  {
    id: 'certificates.name', group: 'certificates', key: 'name', types: ['text', 'select', 'combobox'],
    hi: ['证书名称', '证书名', '资格证书名称', '证书全称'], lo: ['证书'],
    // 「荣誉奖项」「获奖情况」现在有独立分组：网申里它们是两个栏目，
    // 且荣誉要按含金量分级填，混进证书栏会让用户后续填错位置
    not: ['荣誉', '奖项', '获奖', '奖学金', '称号', '编号', '代码', '时间', '日期', '描述']
  },
  {
    id: 'certificates.date', group: 'certificates', key: 'date', types: ['date', 'month', 'text', 'select'],
    hi: ['获得时间', '取证时间', '发证时间', '证书获得时间'], lo: []
  },
  {
    id: 'certificates.description', group: 'certificates', key: 'description', types: ['textarea', 'text'],
    hi: ['证书描述', '证书说明', '发证机构'], lo: []
  },
  {
    id: 'certificates.summary', group: 'certificates', key: 'summary', types: ['textarea'],
    hi: ['证书情况', '资格证书', '证书信息', '证书及荣誉', '获得证书'],
    lo: ['证书'],
    not: ['编号', '代码']
  }
];

// id → 规则。createFillPlan 需要回看规则上的 optional 标记
const FILL_RULE_INDEX = (() => {
  const index = {};
  for (const rule of FILL_RULES) index[rule.id] = rule;
  return index;
})();

// ── 字段显示名（无匹配标签时兜底，也用于提示文案）──

const FILL_LABELS = {
  'basic.name': '姓名', 'basic.gender': '性别', 'basic.birthDate': '出生日期', 'basic.phone': '手机号',
  'basic.email': '邮箱', 'basic.currentCity': '现居城市', 'basic.hometown': '籍贯',
  'basic.nativePlace': '生源地', 'basic.politicalStatus': '政治面貌', 'basic.ethnicity': '民族',
  'basic.idCard': '身份证号',
  'basic.bankAccount': '银行卡号', 'basic.homeAddress': '家庭住址', 'basic.emergencyContact': '紧急联系人',
  'basic.degree': '最高学历', 'basic.degreeLevel': '最高学位',
  'intent.targetPosition': '期望岗位', 'intent.targetCity': '期望城市', 'intent.targetSalary': '期望薪资',
  'intent.availableDate': '到岗时间', 'intent.jobType': '求职类型',
  'education.school': '学校', 'education.college': '学院', 'education.major': '专业',
  'education.degree': '学历', 'education.studyMode': '培养方式', 'education.gpa': 'GPA',
  'education.rank': '专业排名', 'education.courses': '主修课程',
  'education.startDate': '入学时间', 'education.endDate': '毕业时间', 'education.range': '就读起止时间',
  'education.ongoing': '至今',
  'experience.company': '公司', 'experience.department': '部门', 'experience.title': '职位',
  'experience.industry': '所属行业', 'experience.description': '工作内容',
  'experience.achievement': '业绩成果', 'experience.startDate': '开始时间', 'experience.endDate': '结束时间',
  'experience.range': '任职起止时间', 'experience.ongoing': '至今',
  'projects.name': '项目名', 'projects.role': '担任角色', 'projects.description': '项目描述',
  'projects.techStack': '技术栈', 'projects.achievement': '项目成果', 'projects.startDate': '开始时间',
  'projects.endDate': '结束时间', 'projects.range': '项目起止时间', 'projects.ongoing': '至今',
  'campusRole.title': '在校职务', 'campusRole.description': '职务描述', 'campusRole.startDate': '开始时间',
  'campusRole.endDate': '结束时间', 'campusRole.range': '任职起止时间', 'campusRole.ongoing': '至今',
  'campusPractice.name': '实践名称', 'campusPractice.description': '实践描述', 'campusPractice.startDate': '开始时间',
  'campusPractice.endDate': '结束时间', 'campusPractice.range': '实践起止时间', 'campusPractice.ongoing': '至今',
  'extra.hobby': '兴趣爱好', 'extra.strength': '特长', 'extra.selfEvaluation': '自我评价',
  'extra.portfolio': '作品 / 主页链接',
  'skills.name': '技能名称', 'skills.level': '掌握程度', 'skills.years': '使用时间总计',
  'skills.description': '技能描述', 'skills.summary': '技能',
  'honors.name': '获奖项', 'honors.date': '获奖时间', 'honors.level': '获奖级别',
  'honors.description': '获奖描述', 'honors.summary': '荣誉奖项',
  'languages.type': '语言类型', 'languages.level': '掌握程度', 'languages.summary': '语言能力',
  'certificates.name': '证书名称', 'certificates.date': '获得时间', 'certificates.description': '证书描述',
  'certificates.summary': '证书'
};

// ── 跳过原因文案（面向用户，说明「为什么没填」）──

const FILL_REASONS = {
  disabled: { title: '字段不可编辑', detail: '页面上该字段处于禁用状态。' },
  readonly: { title: '只读字段', detail: '页面上该字段只读，无法写入。' },
  password: { title: '密码类字段', detail: '出于安全考虑不自动填写。' },
  captcha: { title: '验证码', detail: '验证码需要你手动获取后填写。' },
  search: { title: '搜索框', detail: '这不是简历字段。' },
  file: { title: '文件上传', detail: '浏览器不允许脚本写入文件，请手动选择文件。' },
  'custom-select': { title: '自定义下拉框', detail: '这类下拉框由页面脚本接管、输入框不接受键入，无法自动填写，请点开手动选择。' },
  checkbox: { title: '勾选类字段', detail: '无法从简历推断是否勾选，请手动确认。' },
  unknown: { title: '未能识别', detail: '无法判断这个字段该填什么，请手动填写。' },
  ambiguous: { title: '含义不明确', detail: '这个字段可能对应多项信息，为避免填错请手动确认。' },
  'no-value': { title: '简历中为空', detail: '简历里没有这项信息，可在第 1 步补充。' },
  'no-item': { title: '经历条数不足', detail: '简历里没有这么多段经历，请手动补充。' },
  sensitive: { title: '敏感字段', detail: '默认不写入网申页面。需要时到第 1 步打开敏感字段开关后重试。' },
  'has-value': { title: '已有内容', detail: '页面上这项已经有内容，未覆盖。' },
  'no-option': { title: '选项不匹配', detail: '下拉选项里没有与简历内容对应的值，请手动选择。' },
  'option-not-match': {
    title: '选项对不上',
    detail: '这个单选项的文字与简历里的内容对不上，无法判断该不该勾它，请手动确认。'
  },
  'too-long': { title: '超出长度限制', detail: '简历内容比字段允许的长度更长，请手动精简。' },
  region: { title: '国家/地区选择框', detail: '这是国家或地区选择框（如「中国大陆」），不属于简历内容，请按需手动选择。' },
  unsupported: { title: '不支持的控件', detail: '该控件类型无法自动填写。' },
  'not-ongoing': {
    title: '该经历不是进行中',
    detail: '这段经历的结束时间已经写完，所以没有勾选「至今」。这是正常的，不用处理。'
  },
  stale: { title: '页面已变化', detail: '扫描后页面结构发生变化，该字段已失效，请重新扫描。' }
};

// 曾有一个「静默原因」列表（option-not-match 不显示给用户），现已取消：
// 字段在清单里凭空消失、用户完全不知道发生了什么，比多一条提示糟糕得多。
// 现在所有原因码都会显示，且每个都必须有 title + detail（测试有断言查缺）。
const FILL_SILENT_REASONS = [];

// ── 下拉选项别名（跨站写法差异）──────────────

const FILL_OPTION_ALIASES = [
  ['本科', '学士', '大学本科', '本科毕业', '全日制本科', '本科生'],
  ['大专', '专科', '大学专科', '高职', '专科毕业', '大专毕业'],
  ['硕士', '研究生', '硕士研究生', '硕士毕业', '研究生毕业'],
  ['博士', '博士研究生', '博士毕业'],
  ['全日制', '普通全日制', '全日制统招', '统招全日制', '全日制普通高校'],
  ['非全日制', '在职', '在职研究生', '非全日制研究生'],
  ['随时到岗', '随时可到岗', '立即到岗', '随时', '马上到岗'],
  ['一周内', '一周内到岗', '1周内', '1周内到岗'],
  ['两周内', '两周内到岗', '2周内', '2周内到岗'],
  ['一个月内', '一个月内到岗', '1个月内', '1个月内到岗'],
  ['男', '男性', 'male'],
  ['女', '女性', 'female'],
  ['共青团员', '团员'],
  ['中共党员', '党员', '中国共产党党员'],
  ['中共预备党员', '预备党员'],
  ['校招', '校园招聘', '应届生', '应届毕业生'],
  ['实习', '实习生', '实习岗'],
  ['社招', '社会招聘'],
  ['面议', '薪资面议', '可面议']
];

const FILL_OPTION_PLACEHOLDER_RE = /^(请选择|请选取|请选|请填写|选择|全部|不限|无|暂无|none|select|choose|pick|--|-|—|　)*$/i;

// ── 基础工具 ──────────────────────────────────

// 归一化：小写 + 去掉所有非「字母/数字/汉字」字符。
// 这样 name="realName"、real_name、Real Name、姓 名 都能归一到同一个 haystack。
function squashFill(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function normalizeFillText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(v => (v == null ? '' : String(v).trim())).filter(Boolean).join('、');
  }
  if (typeof value === 'object') return '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value).replace(/\r/g, '').trim();
}

// 单行输入里的换行会让浏览器吞掉后半段，统一压成顿号/分号
function toSingleLine(value) {
  return String(value).replace(/\s*\n+\s*/g, '；').trim();
}

// ── 章节归组 ──────────────────────────────────

// 从「由近及远的章节标题文本列表」里挑第一个能识别的分组
function resolveSectionGroup(texts) {
  const list = Array.isArray(texts) ? texts : (texts ? [texts] : []);
  for (const raw of list) {
    const target = squashFill(raw);
    if (!target) continue;
    let best = null;
    let bestLen = 0;
    for (const [groupId, keywords] of Object.entries(FILL_SECTION_KEYWORDS)) {
      for (const kw of keywords) {
        const k = squashFill(kw);
        if (!k || !target.includes(k)) continue;
        if (k.length > bestLen) { bestLen = k.length; best = groupId; }
      }
    }
    if (best) return best;
  }
  return null;
}

// ── 语义打分 ──────────────────────────────────

function isGenericFillText(text) {
  const t = String(text == null ? '' : text)
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[*:：、,，.。/\-—~～|]+/g, '');
  if (!t) return true;
  // 与 form-fill-page.js 的 isGenericText 保持同一套口径（含字数统计器）
  if (/^\d+$/.test(t)) return true;
  return FILL_GENERIC_TEXT_RE.test(t) || FILL_GENERIC_EXTRA_RE.test(t);
}

function buildFillHaystacks(features) {
  const f = features || {};
  const attrRaw = [f.name, f.id, f.autocomplete, f.dataHints].filter(Boolean).join(' ');
  // 无语义的占位符不进标签层。它是「提示怎么写」而不是「这个字段是什么」，
  // 留在里面会把标签层从「整段就是关键词」稀释成「关键词 + 几个无关字」，
  // 锚点与整段匹配的奖励一并失效（实测「邮箱」就这样被卡在阈值下面）。
  const labelParts = [f.label, f.ariaLabel, f.placeholder, f.title, f.optionText]
    .filter(part => part && !isGenericFillText(part));
  const labelRaw = labelParts.join(' ');
  const nearRaw = String(f.nearbyText || '').slice(0, FILL_MAX_NEAR_LEN);
  return {
    attr: [squashFill(attrRaw)],
    // 标签层同时看「压平」和「原样」两种写法：中文标签压平去空格，英文标签原样保留词边界
    label: [squashFill(labelRaw), String(labelRaw).toLowerCase().trim()],
    near: [squashFill(nearRaw)]
  };
}

function keywordScore(haystacks, keyword, base) {
  const k = squashFill(keyword);
  if (!k) return 0;
  let best = 0;
  for (const tier of ['attr', 'label', 'near']) {
    for (const hay of haystacks[tier]) {
      if (!hay) continue;
      const idx = hay.indexOf(k);
      if (idx < 0) continue;
      let score = base * FILL_TIER_W[tier] + Math.min(k.length, 6);
      if (idx === 0) score += FILL_ANCHOR_BONUS;
      if (hay === k) score += FILL_EXACT_BONUS;
      // 标签层的整段文字恰好就是这个关键词 —— 表单给字段起名就是这么短。
      // 弱词只能靠它单独成立，否则「邮箱」这类标准中文标签永远认不出来。
      if (tier === 'label' && hay === k) score += FILL_WHOLE_LABEL_BONUS;
      if (score > best) best = score;
    }
  }
  return best;
}

function scoreFillRule(rule, haystacks) {
  let best = 0;
  for (const kw of rule.hi) {
    const s = keywordScore(haystacks, kw, FILL_STRONG_BASE);
    if (s > best) best = s;
  }
  for (const kw of rule.lo) {
    const s = keywordScore(haystacks, kw, FILL_WEAK_BASE);
    if (s > best) best = s;
  }
  return best;
}

// 排除词命中即整条规则作废。只看属性与标签两层，不看邻近文本——
// 邻近文本里出现「公司」往往只是同一区块的其它字段，不该影响本字段判定。
function ruleDisqualified(rule, haystacks) {
  if (!rule.not || !rule.not.length) return false;
  for (const kw of rule.not) {
    const k = squashFill(kw);
    if (!k) continue;
    for (const tier of ['attr', 'label']) {
      for (const hay of haystacks[tier]) {
        if (hay && hay.indexOf(k) >= 0) return true;
      }
    }
  }
  return false;
}

function resolveAutocompleteSemantic(value) {
  const key = String(value || '').toLowerCase().trim();
  if (!key || !Object.prototype.hasOwnProperty.call(FILL_AUTOCOMPLETE_MAP, key)) return null;
  return FILL_AUTOCOMPLETE_MAP[key];
}

// 识别单个字段的语义。返回 null 表示「认不出」，ambiguous 表示「认得出但不唯一」。
function classifyFillField(features, ctx) {
  const f = features || {};
  const haystacks = buildFillHaystacks(f);
  const sectionGroup = resolveSectionGroup((ctx && ctx.sectionTexts) || f.sectionTexts);
  const autocomplete = resolveAutocompleteSemantic(f.autocomplete);

  const scored = [];
  for (const rule of FILL_RULES) {
    const isAutocompleteHit = Boolean(autocomplete) && autocomplete === rule.id;
    if (!isAutocompleteHit && ruleDisqualified(rule, haystacks)) continue;

    let score = scoreFillRule(rule, haystacks);
    if (isAutocompleteHit) score = Math.max(score, FILL_AUTOCOMPLETE_SCORE);
    if (!score) continue;

    if (sectionGroup) {
      score += (rule.group === sectionGroup ? FILL_SECTION_BONUS : -FILL_SECTION_MISMATCH);
    }
    if (Array.isArray(rule.types) && rule.types.length) {
      // custom-select 是「脚本接管的 combobox」，语义上与 combobox 等价。
      // 各规则的 types 里写的是 combobox（因为那是它的 ARIA 角色），
      // 这里按同等类型加分，避免它被无谓地扣分。
      const type = f.type === 'custom-select' ? 'combobox' : f.type;
      score += (rule.types.indexOf(type) >= 0 ? FILL_TYPE_BONUS : -FILL_TYPE_PENALTY);
    }
    if (score <= 0) continue;
    scored.push({ rule, score: round1(score) });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < FILL_SCORE_THRESHOLD) return null;

  // 与最高分咬得很紧的那几个（分差小于阈值就算咬紧）
  const tied = scored.filter(item => best.score - item.score < FILL_AMBIGUOUS_DELTA);

  // 「相邻字段分组」只用来化解平局，不会凭空多认出一个字段。
  //
  // 解决的是这一类：「开始时间 / 结束时间」在教育、实习、项目三组里同名同分，
  // 而它们所属的章节标题一旦没被解析出来（真实表单里很常见），
  // 打分完全没法区分，只能判「含义不明确」全部交用户手填。
  // 此时最可靠的线索是紧邻的上一个已识别字段属于哪一组 ——
  // 表单总是把同一区块的字段挨着排的，人也是这么判断的。
  const neighborGroup = (ctx && ctx.neighborGroup) || null;
  let chosen = best;
  let viaNeighbor = false;
  if (tied.length > 1 && neighborGroup) {
    const preferred = tied.filter(item => item.rule.group === neighborGroup);
    // 只有「恰好一个候选属于相邻分组」时才敢用：两个都属同一组（如
    // 教育组的开始时间与入学时间）说明还得分不清，保持「不明确」。
    if (preferred.length === 1) {
      chosen = preferred[0];
      viaNeighbor = true;
    }
  }

  const runnerUp = scored.filter(item => item !== chosen)[0] || null;
  const ambiguous = !viaNeighbor && tied.length > 1;

  return {
    id: chosen.rule.id,
    group: chosen.rule.group,
    key: chosen.rule.key,
    score: chosen.score,
    sectionGroup,
    runnerUp: runnerUp ? runnerUp.rule.id : null,
    runnerUpScore: runnerUp ? runnerUp.score : null,
    viaNeighbor,
    ambiguous
  };
}

// ── 阻断规则（这些控件永远不填）────────────────
//
// 拉丁词必须按词边界匹配：直接用 includes('search') 会把 researchExperience
// 这类正常字段一起挡掉。中文没有词边界问题，单独用一张表。

const FILL_BLOCK_LATIN_RE = /(^|[^a-zA-Z])(password|passwd|pwd|captcha|verifycode|verify_code|smscode|checkcode|search|keyword|query)([^a-zA-Z]|$)/i;
const FILL_BLOCK_MARK_LATIN_RE = /(^|[^a-zA-Z])(captcha|verifycode|verify_code|smscode|checkcode)([^a-zA-Z]|$)/i;
const FILL_BLOCK_SEARCH_LATIN_RE = /(^|[^a-zA-Z])(search|keyword|query)([^a-zA-Z]|$)/i;

const FILL_BLOCK_CN_MARK_RE = /验证码|图形码|短信码|校验码/;
const FILL_BLOCK_CN_PWD_RE = /密码/;
const FILL_BLOCK_CN_SEARCH_RE = /搜索|查询|关键词/;

function blockFillField(features) {
  const f = features || {};
  if (f.type === 'password') return 'password';
  if (f.type === 'file') return 'file';
  if (f.type === 'search') return 'search';
  // 自定义下拉框只在「不可输入」时跳过。可输入的（Element UI / antd 的搜索型
  // Select、北森 lookup 的搜索框）能填入关键词触发组件自身筛选，值得帮用户一把，
  // 让它继续走识别与取值流程，最后以 assisted 形式交给用户点选确认。
  if (f.type === 'custom-select' && !f.searchable) return 'custom-select';
  if (f.type === 'hidden' || f.type === 'unsupported' || f.type === 'contenteditable') return 'unsupported';
  if (f.disabled) return 'disabled';
  if (f.readOnly) return 'readonly';

  // 国家 / 地区选择框：标签本身就是地区名（如手机号前面的「中国大陆」）。
  // 它不是简历字段，而且很容易被旁边手机号的占位符带偏识别成 basic.phone，
  // 把手机号填进区号框。这里拦掉，既不给错误建议也不真的填错。
  const labelOnly = squashFill(f.label);
  if (labelOnly && FILL_REGION_ONLY_RE.test(labelOnly)) return 'region';

  // 属性名做词边界匹配；标签文本用中文子串匹配
  const attrText = [f.name, f.id].filter(Boolean).join(' ');
  if (attrText) {
    if (FILL_BLOCK_MARK_LATIN_RE.test(attrText)) return 'captcha';
    if (FILL_BLOCK_LATIN_RE.test(attrText)) {
      if (/(^|[^a-zA-Z])(password|passwd|pwd)([^a-zA-Z]|$)/i.test(attrText)) return 'password';
      if (FILL_BLOCK_SEARCH_LATIN_RE.test(attrText)) return 'search';
    }
  }

  const labelText = [f.label, f.placeholder, f.ariaLabel].filter(Boolean).join(' ');
  if (labelText) {
    if (FILL_BLOCK_CN_MARK_RE.test(labelText)) return 'captcha';
    if (FILL_BLOCK_CN_PWD_RE.test(labelText)) return 'password';
    if (FILL_BLOCK_CN_SEARCH_RE.test(labelText)) return 'search';
  }
  return null;
}

// ── 取值 ──────────────────────────────────────

// 列表型分组里「不在 schema 上、由多条合成」的伪字段。
// range 早就存在（起止时间），summary 是这次新增的：
// 表单里技能/获奖/证书/语言常常只有一个大文本框（「专业技能」「荣誉奖项」），
// 而字段表里它们是一条一条的，需要合成一行才填得进去
const FILL_SUMMARY_GROUPS = {
  skills: 'name',
  certificates: 'name',
  honors: 'name'
};

function summarizeFillItems(group, items) {
  const list = Array.isArray(items) ? items : [];
  if (group === 'languages') {
    // 语言要把类型和等级拼起来：「英语 CET-6、粤语」
    return list
      .map(item => {
        const type = normalizeFillText(item.type);
        const level = normalizeFillText(item.level);
        if (!type) return level;
        return level ? `${type} ${level}` : type;
      })
      .filter(Boolean)
      .join('、');
  }
  const key = FILL_SUMMARY_GROUPS[group];
  if (!key) return '';
  return list.map(item => normalizeFillText(item[key])).filter(Boolean).join('、');
}

// 按语义从 profile 取原始值。列表型分组用 itemIndex 取第几段经历。
function resolveFillValue(profile, group, key, itemIndex) {
  const container = profile && profile[group];
  if (!container) return '';

  if (Array.isArray(container)) {
    // summary 看的是整个列表，与 itemIndex 无关
    if (key === 'summary') return summarizeFillItems(group, container);
    const item = container[itemIndex];
    if (!item) return '';
    if (key === 'range') {
      const start = normalizeFillText(item.startDate);
      const end = normalizeFillText(item.endDate);
      if (start && end) return `${start} - ${end}`;
      return start || end || '';
    }
    // 「至今」是个复选框：只有结束时间真的写着「至今」才勾。返回值就用「至今」本身，
    // 好让下面的复选框适配逻辑拿它跟本选项的文字比对；对不上就交用户手填，
    // 而不是自作主张勾上一个文字不同的框
    if (key === 'ongoing') {
      return normalizeFillText(item.endDate) === '至今' ? '至今' : '';
    }
    return normalizeFillText(item[key]);
  }
  return normalizeFillText(container[key]);
}

// ── 值适配（不同控件的写入格式不同）───────────

const FILL_DATE_PARTS_RE = /^(\d{4})\s*[.\-/年]?\s*(\d{1,2})?\s*[.\-/月]?\s*(\d{1,2})?\s*日?/;

function parseLooseDate(raw) {
  const m = String(raw || '').trim().match(FILL_DATE_PARTS_RE);
  if (!m) return null;
  const year = m[1];
  const month = m[2] ? m[2].padStart(2, '0') : null;
  const day = m[3] ? m[3].padStart(2, '0') : null;
  if (month && (Number(month) < 1 || Number(month) > 12)) return null;
  if (day && (Number(day) < 1 || Number(day) > 31)) return null;
  return { year, month, day };
}

// 把简历里的「2022.09」适配到 date / month / number 控件
function adaptDateValue(raw, inputType) {
  const parts = parseLooseDate(raw);
  if (!parts) return { value: String(raw || '').trim(), note: '' };

  if (inputType === 'month') {
    if (!parts.month) return { value: '', skip: 'too-long', note: `简历里「${raw}」只精确到年，该字段需要年月，请手动填写` };
    return { value: `${parts.year}-${parts.month}`, note: '' };
  }
  if (inputType === 'date') {
    // 只精确到年月时，日按 01 填充并明确告知，绝不静默
    const day = parts.day || '01';
    const inferred = !parts.day;
    return {
      value: `${parts.year}-${parts.month || '01'}-${day}`,
      note: inferred ? `简历只有「${raw}」，日按 01 填充，请核对` : ''
    };
  }
  if (inputType === 'number') {
    return { value: parts.year, note: parts.month ? '该字段只接受数字，已填年份' : '' };
  }
  return { value: String(raw || '').trim(), note: '' };
}

// 建「别名 → 组号」查表，用于把「本科」匹配到「学士」
const FILL_ALIAS_INDEX = (() => {
  const index = {};
  FILL_OPTION_ALIASES.forEach((group, i) => {
    for (const word of group) index[squashFill(word)] = i;
  });
  return index;
})();

// 在候选选项里找与简历值最贴近的一项。找不到返回 null（不猜）。
function matchFillOption(value, options) {
  const target = squashFill(value);
  if (!target) return null;
  const list = (options || []).filter(o => o && !FILL_OPTION_PLACEHOLDER_RE.test(String(o.text == null ? '' : o.text).trim()));

  // 1) 完全相同
  for (const opt of list) {
    if (squashFill(opt.text) === target) return { value: opt.value, text: opt.text, how: 'exact' };
  }
  for (const opt of list) {
    if (opt.value != null && squashFill(opt.value) === target) return { value: opt.value, text: opt.text, how: 'exact' };
  }
  // 2) 同义写法（本科 ↔ 学士）
  const aliasGroup = FILL_ALIAS_INDEX[target];
  if (aliasGroup != null) {
    for (const opt of list) {
      if (FILL_ALIAS_INDEX[squashFill(opt.text)] === aliasGroup) {
        return { value: opt.value, text: opt.text, how: 'alias' };
      }
    }
  }
  // 3) 包含关系：只在双方都够长时启用，避免「男」误配「男装」
  for (const opt of list) {
    const text = squashFill(opt.text);
    if (text.length < 2 || target.length < 2) continue;
    if (text.indexOf(target) >= 0 || target.indexOf(text) >= 0) {
      return { value: opt.value, text: opt.text, how: 'partial' };
    }
  }
  return null;
}

// 把原始值适配成能写进该控件的值
function adaptFillValue(rawValue, features, semantic) {
  const f = features || {};
  const value = normalizeFillText(rawValue);
  if (!value) return { ok: false, reason: 'no-value' };

  if (f.type === 'select' || f.type === 'radio' || f.type === 'checkbox') {
    const options = f.type === 'select'
      ? (f.options || [])
      : [{ value: value, text: f.optionText || '' }];
    if (f.type !== 'select') {
      // radio / checkbox：只有「本选项的文字」与简历值匹配时才会被选中
      const target = squashFill(value);
      const own = squashFill(f.optionText);
      if (!own) return { ok: false, reason: 'option-not-match' };
      if (own === target) return { ok: true, value: true, note: '' };
      const aliasGroup = FILL_ALIAS_INDEX[target];
      if (aliasGroup != null && FILL_ALIAS_INDEX[own] === aliasGroup) return { ok: true, value: true, note: '' };
      if (own.length >= 2 && target.length >= 2 && (own.indexOf(target) >= 0 || target.indexOf(own) >= 0)) {
        return { ok: true, value: true, note: '' };
      }
      return { ok: false, reason: 'option-not-match' };
    }
    const hit = matchFillOption(value, options);
    if (!hit) return { ok: false, reason: 'no-option' };
    // 一并回传选项的文字：<option value="1">男</option> 写入的是 "1"，
    // 但给用户看的清单必须显示「男」，否则用户无法核对填的是不是自己想要的
    return {
      ok: true,
      value: hit.value,
      optionText: hit.text || '',
      note: hit.how === 'partial' ? `选项按近似匹配为「${hit.text}」，请核对` : ''
    };
  }

  if (f.type === 'date' || f.type === 'month' || f.type === 'number') {
    const adapted = adaptDateValue(value, f.type);
    if (adapted.skip) return { ok: false, reason: adapted.skip, detail: adapted.note };
    return { ok: true, value: adapted.value, note: adapted.note || '' };
  }

  // 文本类：单行控件要把换行压平
  let out = f.type === 'textarea' ? value : toSingleLine(value);
  let note = '';

  const maxLength = Number(f.maxLength) || 0;
  if (maxLength > 0 && out.length > maxLength) {
    // 关键短字段（姓名/手机/邮箱/证件）截断等于填错，直接交给用户处理
    const strict = ['basic.name', 'basic.phone', 'basic.email', 'basic.idCard', 'basic.bankAccount'];
    if (strict.indexOf(semantic) >= 0) {
      return { ok: false, reason: 'too-long' };
    }
    out = out.slice(0, maxLength);
    note = `字段限 ${maxLength} 字，内容已截断，请核对`;
  }

  return { ok: true, value: out, note };
}

// ── 经历条数推进 ──────────────────────────────
// 同一个分组在表单里可能反复出现。两种信号都表示「进入下一条经历」：
//   1) 段落标记变化（表单里出现第二个「教育经历」标题）
//   2) 同一段落里**同一个字段**重复（连着两组「单位名称」）
//
// ⚠️ 记账必须按「分组 + 字段」而不是按分组。按组记账时，最高学历和最高学位
// 都映射到 education.degree，第二个出现就把游标推过末尾 —— 教育经历只有
// 1 条记录，结果后面整个教育区块（专业、学校、学历、起止时间）全部 no-value。
// 实测北森表单就是这样把 9 项将填写里能填的教育字段全吃掉的。
// 按字段记账后：同一字段第二次出现才推进，其余字段各自从第 0 条取值，
// 第二个「单位名称」也仍然能正确推进到第二条经历。

// 「最高那一档」的取值：个人信息区块里的学历 / 学位 / 专业 / 学校问的不是
// 「第一条经历」，而是「最高学历那一条」。用户的教育经历常常是本科在前、
// 硕士在后，按第 0 条取会把硕士填成本科 —— 那是事实性错误，比不填更糟。
//
// 判定靠所在章节，不靠关键词：同一个「专业名称」在教育经历区块里是这一条的
// 专业，在个人信息区块里是最高学历的专业。章节认不出来时保持原行为（第 0 条），
// 不做猜测 —— 章节识别不出来时，按条目推进本来就是更保守的默认。
const FILL_HIGHEST_EDUCATION_KEYS = { degree: true, major: true, school: true, college: true };
const FILL_DEGREE_RANK = { '博士': 5, '硕士': 4, '本科': 3, '大专': 2, '高中': 1 };

function isHighestEducationField(hit, sectionGroup) {
  return Boolean(hit) && sectionGroup === 'basic'
    && hit.group === 'education'
    && FILL_HIGHEST_EDUCATION_KEYS[hit.key] === true;
}

// 学历高者优先；同学历时结束时间晚的更近（在读的硕士胜过已毕业的本科）。
// 一条都认不出学历时退化为「结束时间最晚的那一条」。
function fillHighestEducationIndex(education) {
  const items = Array.isArray(education) ? education : [];
  let best = 0;
  let bestRank = -1;
  let bestEnd = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    const rank = FILL_DEGREE_RANK[normalizeFillText(item.degree).trim()] || 0;
    const end = normalizeFillText(item.endDate);
    if (rank > bestRank || (rank === bestRank && end > bestEnd)) {
      best = i;
      bestRank = rank;
      bestEnd = end;
    }
  }
  return best;
}

function createGroupCursor() {
  return {};
}

function nextItemIndex(cursor, group, sectionSeq, key) {
  const bucket = group + '\u0000' + key;
  let state = cursor[bucket];
  if (!state) {
    state = { index: 0, sectionSeq: sectionSeq == null ? 0 : sectionSeq, started: false };
    cursor[bucket] = state;
  } else if (sectionSeq != null && state.sectionSeq !== sectionSeq) {
    // 段落切换：进入下一条经历
    if (state.started) state.index += 1;
    state.sectionSeq = sectionSeq;
  } else if (state.started) {
    // 同一段落里同一字段第二次出现：进入下一条经历
    state.index += 1;
  }
  state.started = true;
  return state.index;
}

// ── 填写计划 ──────────────────────────────────
//
// 返回结构：
//   { total, items: [...将填写], manual: [...需手动], stats }
// items 里每项都带 ref（页面侧的元素句柄）、semantic、value、displayValue、note
// manual 里每项都带 reason 与对应文案，供 UI 如实告知用户

// 清单上「填的是什么」的可读呈现。真实站点里 <option value="1">男</option>
// 很常见，直接展示 value 会让用户看不懂自己在核对什么。
function fillDisplayValue(field, adapted) {
  const f = field || {};
  if (f.type === 'radio' || f.type === 'checkbox') return f.optionText || '';
  if (f.type === 'select' && adapted && adapted.optionText) return adapted.optionText;
  return toSingleLine(String((adapted || {}).value || '')).slice(0, 80);
}

function createFillPlan(fields, profile, options) {
  const opts = options || {};
  const includeSensitive = Boolean(opts.includeSensitive);
  const overwrite = Boolean(opts.overwrite);
  const sensitiveKeys = Array.isArray(opts.sensitiveKeys) && opts.sensitiveKeys.length
    ? opts.sensitiveKeys
    : FILL_DEFAULT_SENSITIVE;

  const list = Array.isArray(fields) ? fields : [];
  const items = [];
  const manual = [];
  const cursor = createGroupCursor();
  const usedRefs = {};
  // 最近一个「确定识别出来」的分组。用来给后面同名的字段化解平局
  // （「开始时间 / 结束时间」在三组里同名同分，见 classifyFillField）。
  let lastNeighborGroup = null;

  const pushManual = (field, reason, extra) => {
    if (FILL_SILENT_REASONS.indexOf(reason) >= 0) return;
    const info = FILL_REASONS[reason] || FILL_REASONS.unknown;
    manual.push({
      ref: field.ref,
      formLabel: field.label || field.placeholder || field.name || '',
      reason,
      title: info.title,
      detail: (extra && extra.detail) || info.detail
    });
  };

  for (let i = 0; i < list.length; i++) {
    const field = list[i] || {};

    // 1) 硬性阻断
    const blocked = blockFillField(field);
    if (blocked) { pushManual(field, blocked); continue; }

    // 2) 同一控件在一次计划里只能填一次（重复出现的 identity 字段除外）
    if (field.ref != null) {
      if (usedRefs[field.ref]) continue;
      usedRefs[field.ref] = true;
    }

    // 3) 语义识别
    const hit = classifyFillField(field, { sectionTexts: field.sectionTexts, neighborGroup: lastNeighborGroup });
    if (!hit) { pushManual(field, 'unknown'); continue; }
    if (hit.ambiguous) { pushManual(field, 'ambiguous'); continue; }
    // 只记「确定」的结果：不确定的分组当线索会把后面的字段一起带偏
    lastNeighborGroup = hit.group;

    // 4) 敏感字段
    if (sensitiveKeys.indexOf(hit.key) >= 0 && !includeSensitive) { pushManual(field, 'sensitive'); continue; }

    // 5) 定位第几条经历
    // 个人信息区块里的「学历 / 专业名称 / 毕业学校」问的是最高学历那一档，
    // 不是第一条经历 —— 本科在前、硕士在后的简历按第 0 条取会填成本科。
    const highestPick = isHighestEducationField(hit, hit.sectionGroup);
    const itemIndex = highestPick
      ? fillHighestEducationIndex(profile && profile.education)
      : nextItemIndex(cursor, hit.group, field.sectionSeq, hit.key);
    const raw = resolveFillValue(profile, hit.group, hit.key, itemIndex);
    if (!raw) {
      // 「至今」这类可选勾选：没勾不等于缺数据，用专门的文案说明，别让用户以为漏了
      const rule = FILL_RULE_INDEX[hit.id];
      if (rule && rule.optional) { pushManual(field, 'not-ongoing'); continue; }
      // 「最高那一档」取不到值不等于经历条数不足，别给误导性的原因
      const shortOfItems = !highestPick && field.sectionSeq != null && itemIndex > 0;
      pushManual(field, shortOfItems ? 'no-item' : 'no-value');
      continue;
    }

    // 6) 已有内容
    if (field.hasValue && !overwrite) { pushManual(field, 'has-value'); continue; }

    // 7) 适配控件
    const adapted = adaptFillValue(raw, field, hit.id);
    if (!adapted.ok) {
      pushManual(field, adapted.reason, adapted.detail ? { detail: adapted.detail } : null);
      continue;
    }

    // 可输入的自定义下拉框属于「辅助填入」：我们只能把关键词填进去触发页面的
    // 筛选，最终必须由用户从下拉候选里点一下才算选中。不标出来会让用户以为
    // 已经填好了，直接提交就会发现值丢了。
    const assisted = field.type === 'custom-select' && field.searchable === true;
    const notes = [];
    if (assisted) notes.push('已填入关键词触发页面筛选，请从下拉候选里点选才算选中');
    // 靠相邻字段推出来的分组不是铁证，让用户核对一眼
    if (hit.viaNeighbor) notes.push('按上文相邻字段判断所属区块，请核对');
    // 从「最高那一档」里取的值要让用户知道取的是哪一条
    if (highestPick && itemIndex > 0) notes.push('取自学历最高的一段教育经历，请核对');
    if (adapted.note) notes.push(adapted.note);

    items.push({
      ref: field.ref,
      semantic: hit.id,
      group: hit.group,
      key: hit.key,
      itemIndex,
      type: field.type,
      formLabel: field.label || field.placeholder || field.name || '',
      semanticLabel: FILL_LABELS[hit.id] || hit.id,
      value: adapted.value,
      // displayValue 是给用户核对用的，必须是人能读懂的那个：
      // 勾选项显示本项文字；下拉显示选中的选项文字（而非 value）；其余显示填入内容
      displayValue: fillDisplayValue(field, adapted),
      note: notes.join('；'),
      assisted,
      score: hit.score
    });
  }

  return {
    total: list.length,
    items,
    manual,
    stats: {
      total: list.length,
      fillable: items.length,
      manual: manual.length
    }
  };
}

// ── 填充结果汇总（页面回传后生成面向用户的文案）──

function summarizeFillResult(results) {
  const list = Array.isArray(results) ? results : [];
  const ok = list.filter(r => r && r.ok).length;
  const failed = list.filter(r => r && !r.ok);
  const stale = failed.filter(r => r.reason === 'stale').length;
  const other = failed.length - stale;
  return { ok, failed: failed.length, stale, other };
}

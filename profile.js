// ── 结构化简历 · 数据层 ────────────────────────
// 职责：定义六组标准字段、把 AI/本地的任意输入规整成固定结构、提供读写路径工具。
// 设计约束：本文件不含任何 DOM 操作，可在 node 下直接加载做单元验证。
// 依赖：无（不依赖 common.js / popup.js）

const PROFILE_SCHEMA_VERSION = 1;

// 六组标准字段。type: text | textarea | tags（tags 以「、」分隔存为字符串）
const PROFILE_GROUPS = [
  {
    id: 'basic',
    label: '基础信息',
    kind: 'object',
    fields: [
      { key: 'name', label: '姓名', ph: '张三' },
      { key: 'gender', label: '性别', options: ['男', '女'] },
      { key: 'birthDate', label: '出生日期', ph: '2002.05' },
      { key: 'phone', label: '手机号', ph: '13800000000' },
      { key: 'email', label: '邮箱', ph: 'name@example.com' },
      { key: 'currentCity', label: '现居城市', ph: '深圳' },
      { key: 'hometown', label: '籍贯', ph: '广东汕头' },
      // 生源地 ≠ 籍贯：生源地是高考时的户籍所在地，央国企与银行网申的必填项，
      // 且常用于属地岗位匹配，填错会错过本可匹配的岗位
      { key: 'nativePlace', label: '生源地', ph: '广东汕头（高考户籍地）' },
      { key: 'politicalStatus', label: '政治面貌', options: ['中共党员', '中共预备党员', '共青团员', '群众', '民主党派'] },
      { key: 'idCard', label: '身份证号', sensitive: true, ph: '默认关闭' },
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
      { key: 'targetPosition', label: '期望岗位', ph: '产品经理' },
      { key: 'targetCity', label: '期望城市', ph: '深圳 / 广州' },
      { key: 'targetSalary', label: '期望薪资', ph: '面议' },
      { key: 'availableDate', label: '到岗时间', options: ['随时到岗', '一周内', '两周内', '一个月内'] },
      { key: 'jobType', label: '求职类型', options: ['实习', '校招', '社招', '兼职'] }
    ]
  },
  {
    id: 'education',
    label: '教育经历',
    kind: 'list',
    itemLabel: '教育经历',
    fields: [
      { key: 'school', label: '学校', ph: '广东海洋大学' },
      { key: 'degree', label: '学历', options: ['博士', '硕士', '本科', '大专', '高中'] },
      { key: 'major', label: '专业', ph: '新闻学' },
      { key: 'college', label: '学院', ph: '文学与新闻传播学院' },
      { key: 'startDate', label: '开始时间', ph: '2022.09' },
      { key: 'endDate', label: '结束时间', ph: '2026.06' },
      { key: 'gpa', label: 'GPA', ph: '3.7/4.0' },
      // 排名与 GPA 在网申里是两个独立输入框，且「3/120」比「前 5%」更有说服力
      { key: 'rank', label: '专业排名', ph: '前 20% 或 3/120' },
      // 中石油等系统在「其他描述」栏明确要求填核心课程，与岗位相关的 5-8 门
      { key: 'courses', label: '主修课程', type: 'textarea', ph: '数据库原理、数据结构、Python 程序设计' },
      { key: 'studyMode', label: '培养方式', options: ['全日制', '非全日制', '交换', '辅修'] }
    ]
  },
  {
    id: 'experience',
    label: '工作与实习',
    kind: 'list',
    itemLabel: '工作/实习',
    fields: [
      { key: 'company', label: '公司', ph: 'XX科技有限公司' },
      { key: 'department', label: '部门', ph: '产品部' },
      { key: 'title', label: '职位', ph: '产品运营实习生' },
      { key: 'industry', label: '所属行业', ph: '计算机软件' },
      { key: 'startDate', label: '开始时间', ph: '2025.07' },
      { key: 'endDate', label: '结束时间', ph: '2025.10' },
      { key: 'description', label: '工作内容', type: 'textarea', ph: '负责什么、怎么做' },
      { key: 'achievement', label: '业绩成果', type: 'textarea', ph: '带数字的结果' }
    ]
  },
  {
    id: 'projects',
    label: '项目经历',
    kind: 'list',
    itemLabel: '项目',
    fields: [
      { key: 'name', label: '项目名', ph: '校园二手交易平台' },
      { key: 'role', label: '担任角色', ph: '产品负责人' },
      { key: 'startDate', label: '开始时间', ph: '2025.03' },
      { key: 'endDate', label: '结束时间', ph: '2025.06' },
      { key: 'description', label: '项目描述', type: 'textarea', ph: '背景、目标、你做了什么' },
      { key: 'techStack', label: '技术栈 / 工具', ph: 'Figma、Axure' },
      { key: 'achievement', label: '成果', type: 'textarea', ph: '上线效果、数据' }
    ]
  },
  {
    id: 'skills',
    label: '技能与补充',
    kind: 'object',
    fields: [
      { key: 'languages', label: '语言等级', type: 'tags', ph: '英语 CET-6、粤语' },
      { key: 'skillTags', label: '技能标签', type: 'tags', ph: 'SQL、Figma、Python' },
      { key: 'certificates', label: '证书', type: 'tags', ph: '软件设计师' },
      // 获奖独立于证书：网申里通常是两个独立栏目，且要按「国家级 > 省部级 > 校级」分级填写
      { key: 'honors', label: '荣誉奖项', type: 'textarea', ph: '国家励志奖学金；校级三好学生（按含金量排序）' },
      { key: 'selfEvaluation', label: '自我评价', type: 'textarea', ph: '三句话以内' },
      { key: 'portfolio', label: '作品 / 主页链接', type: 'textarea', ph: 'github.com/xxx' }
    ]
  }
];

// AI 返回的分组名可能五花八门，这里做归并
const PROFILE_GROUP_ALIASES = {
  basic: ['basic', 'basicinfo', 'basic_info', 'personal', 'personalinfo', 'personal_info', 'profile', '基础信息', '基本信息', '个人信息'],
  intent: ['intent', 'jobintent', 'job_intent', 'expectation', 'expectations', 'jobexpectation', '求职意向', '求职意愿', '意向'],
  education: ['education', 'educations', 'educationexperience', 'education_experience', 'educationbackground', '教育经历', '教育背景', '学历'],
  experience: ['experience', 'experiences', 'workexperience', 'work_experience', 'internship', 'internships', 'work', '工作经历', '实习经历', '工作与实习'],
  projects: ['projects', 'project', 'projectexperience', 'project_experience', '项目经历', '项目经验'],
  skills: ['skills', 'skill', 'certificates', 'others', 'extra', '技能', '技能证书', '技能与补充', '其他', '补充信息']
};

// 字段级别名（AI 偶尔不用标准键名）
const PROFILE_KEY_ALIASES = {
  phone: ['mobile', 'phonenumber', 'phone_number', 'tel', 'telephone', '手机', '手机号码', '电话'],
  email: ['mail', 'emailaddress', 'email_address', '邮箱地址', '电子邮箱'],
  name: ['fullname', 'full_name', 'username', 'realname', 'real_name'],
  currentCity: ['city', 'location', 'current_location', '现居地', '所在城市', '居住城市'],
  hometown: ['nativeplace_origin', '籍贯地', '老家', '故乡'],
  // 生源地与籍贯是两个字段，网申里分开填
  nativePlace: ['nativeplace', 'native_place', '生源所在地', '高考户籍所在地', '生源'],
  birthDate: ['birthday', 'birth', 'dob', '出生年月'],
  targetPosition: ['position', 'targetposition', 'expectedposition', 'expected_position', 'desiredposition', '期望职位'],
  targetCity: ['expectedcity', 'expected_city', 'desiredcity', '期望工作城市', '意向城市'],
  targetSalary: ['salary', 'expectedsalary', 'expected_salary', '期望薪酬'],
  availableDate: ['available', 'onboarddate', 'entrydate', '到岗日期', '入职时间'],
  jobType: ['jobtype', 'jobnature', '求职性质'],
  school: ['university', 'schoolname', 'school_name', '院校'],
  degree: ['education_level', 'educationlevel', 'qualification', '学历层次'],
  major: ['speciality', 'majorname', '专业名称'],
  // 注意：不能把 department 当作学院的别名 —— 实习经历里的「部门」也叫 department，
  // 那条别名会把实习生所属部门错认成校内学院
  college: ['faculty', 'schoolof', 'school_of', '院系', '学院名称'],
  startDate: ['start', 'startdate', 'from', 'begin', '起始时间', '开始日期'],
  endDate: ['end', 'enddate', 'to', 'finish', '结束时间', '结束日期'],
  // GPA 与排名在旧版本是合并成「GPA / 排名」一个字段的，别名要保留以兼容旧数据与 AI 输出
  gpa: ['gradepoint', 'grade_point', 'gparank', 'gpa_score', 'gpa/排名', 'gpa排名', '绩点', '平均绩点'],
  rank: ['ranking', 'classrank', 'class_rank', 'professionrank', '排名', '专业排名', '年级排名', '班级排名', '成绩排名'],
  courses: ['corecourses', 'core_courses', 'maincourses', 'main_courses', '核心课程', '主要课程', '修读课程', '课程'],
  studyMode: ['studymode', '培养类型'],
  company: ['companyname', 'organization', 'employer', '公司名称', '单位', '工作单位'],
  department: ['dept', 'division', 'subsidiary', '所属部门', '部门名称'],
  title: ['position_title', 'jobtitle', 'job_title', 'role_title', '岗位', '职务', '职位名称'],
  industry: ['business', 'sector', 'industryname', '所属行业', '行业类别'],
  description: ['desc', 'content', 'detail', 'details', '工作描述', '工作职责', '描述'],
  achievement: ['achievements', 'result', 'results', 'outcome', '成果', '业绩'],
  role: ['projectrole', 'duty', '担任职务'],
  techStack: ['tech', 'stack', 'technology', 'tools', '技术', '使用工具'],
  skillTags: ['skills_tags', 'skilltags', 'skillset', '技能', '技能标签', '专业技能'],
  languages: ['language', 'languagelevel', '语言', '语言能力'],
  certificates: ['certificate', 'certs', '证书名称', '资格证书'],
  honors: ['honor', 'honour', 'honors_list', 'awards', 'award', '获奖情况', '获奖经历', '荣誉奖项', '荣誉', '奖项', '奖学金'],
  selfEvaluation: ['selfevaluation', 'self_evaluation', 'summary', 'selfintro', '自我评价', '个人评价', '个人总结'],
  portfolio: ['portfolio_url', 'website', 'homepage', 'link', '作品链接', '个人主页']
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
          multi: group.kind === 'list',
          groupId: group.id,
          groupLabel: group.label
        };
      }
    }
  }
  return index;
})();

// 反向索引：别名（小写、去下划线和空格）→ 标准 key
const PROFILE_ALIAS_LOOKUP = (() => {
  const lookup = {};
  const norm = (s) => String(s).toLowerCase().replace(/[\s_\-]/g, '');
  for (const group of PROFILE_GROUPS) {
    for (const field of group.fields) {
      lookup[norm(field.key)] = field.key;
      lookup[norm(field.label)] = field.key;
      for (const alias of PROFILE_KEY_ALIASES[field.key] || []) lookup[norm(alias)] = field.key;
    }
  }
  return lookup;
})();

const PROFILE_SENSITIVE_KEYS = PROFILE_GROUPS
  .flatMap(g => g.fields.filter(f => f.sensitive).map(f => f.key));

function normKey(key) {
  return String(key).toLowerCase().replace(/[\s_\-]/g, '');
}

// 把任意键名解析为标准 key，无法识别返回 null
function resolveProfileKey(rawKey) {
  return PROFILE_ALIAS_LOOKUP[normKey(rawKey)] || null;
}

function createEmptyProfile() {
  const profile = { version: PROFILE_SCHEMA_VERSION, updatedAt: '' };
  for (const group of PROFILE_GROUPS) {
    // 对象型分组也补全全部键（而非空对象），保证「本地解析」与「AI 解析」产出同一种结构
    profile[group.id] = group.kind === 'list' ? [] : createEmptyItem(group);
  }
  return profile;
}

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

  // 先做键名映射（含别名）
  const mapped = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = resolveProfileKey(rawKey);
    if (key) {
      const value = normalizeValue(rawValue);
      if (value && !mapped[key]) mapped[key] = value;
    }
  }
  for (const field of group.fields) {
    if (mapped[field.key]) out[field.key] = mapped[field.key];
  }
  return out;
}

function itemHasValue(item, group) {
  return group.fields.some(f => item[f.key]);
}

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
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = createEmptyProfile();
  let foundGroup = false;

  for (const group of PROFILE_GROUPS) {
    const source = pickGroupSource(src, group.id);
    if (group.kind === 'list') {
      const list = Array.isArray(source) ? source : (source && typeof source === 'object' ? [source] : []);
      out[group.id] = list
        .map(item => normalizeItem(item, group))
        .filter(item => itemHasValue(item, group));
      if (out[group.id].length) foundGroup = true;
    } else {
      out[group.id] = normalizeItem(source, group);
      if (itemHasValue(out[group.id], group)) foundGroup = true;
    }
  }

  // 兜底：AI 把字段直接平铺在顶层（没有分组）时，从顶层收集
  if (!foundGroup) {
    const flatBasic = normalizeItem(src, PROFILE_GROUPS[0]);
    const flatIntent = normalizeItem(src, PROFILE_GROUPS[1]);
    const flatSkills = normalizeItem(src, PROFILE_GROUPS[5]);
    Object.assign(out.basic, flatBasic);
    Object.assign(out.intent, flatIntent);
    Object.assign(out.skills, flatSkills);
  }

  out.version = PROFILE_SCHEMA_VERSION;
  out.updatedAt = new Date().toISOString();
  return out;
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

function profileStats(profile) {
  let filled = 0;
  let total = 0;
  let sensitiveFilled = 0;

  for (const group of PROFILE_GROUPS) {
    if (group.kind === 'list') {
      const items = Array.isArray(profile?.[group.id]) ? profile[group.id] : [];
      total += items.length * group.fields.length;
      for (const item of items) {
        for (const field of group.fields) {
          if (item[field.key]) {
            filled += 1;
            if (field.sensitive) sensitiveFilled += 1;
          }
        }
      }
    } else {
      total += group.fields.length;
      for (const field of group.fields) {
        if (profile?.[group.id]?.[field.key]) {
          filled += 1;
          if (field.sensitive) sensitiveFilled += 1;
        }
      }
    }
  }

  return {
    filled,
    total,
    sensitiveFilled,
    percent: total ? Math.round((filled / total) * 100) : 0,
    educationCount: (profile?.education || []).length,
    experienceCount: (profile?.experience || []).length,
    projectCount: (profile?.projects || []).length
  };
}

// 是否存在任何有效内容
function profileHasValue(profile) {
  return profileStats(profile).filled > 0;
}

// ── 预填用的扁平字段清单（任务 4 消费）──────────

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
// B 是校招简历最常见的写法，而原先的本地规则**只抽公司名**
// （注释写着「内容留给用户补充」），项目经历更是完全没处理 —— 实测整段丢失。
//
// 流程：按章节标题切段 → 段内按「日期范围行」切条目 → 解析条目头 → 聚合并条目体

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

function localSectionOf(line) {
  const text = String(line || '').trim();
  if (!text || text.length > LOCAL_SECTION_MAX_LEN) return null;
  if (LOCAL_SECTION_PUNCT_RE.test(text)) return null;
  // 含日期范围的是经历条目，不是章节标题。
  // 少了这条判断，「2025.012-2026.03 某机器学习项目」会因为含「项目」二字
  // 被当成「项目经历」标题，于是整条经历被消耗掉、什么都不剩。
  if (LOCAL_DATE_RANGE_RE.test(text)) return null;
  const lower = text.toLowerCase();
  // 顺序即优先级：「项目经历 Practical experience」同时含「项目」和 experience，
  // 必须先判项目，否则整段会被归到工作经历
  if (/项目|projects?/.test(lower)) return 'projects';
  if (/教育|学历|education/.test(lower)) return 'education';
  if (/实习|工作|任职|职业|internship|employment/.test(lower)) return 'experience';
  if (/技能|证书|荣誉|奖项|获奖|评价|skill|honor|award|certificat/.test(lower)) return 'skills';
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
  const SECTION_WORD = /简历|个人|求职|应聘|教育|经历|工作|实习|项目|技能|证书|荣誉|奖项|评价|信息|联系|方式|背景|校园|实践|语言|兴趣|特长|概览|总结|介绍|说明/;
  const SECTION_HEAD_WORD = /^(简历|个人|求职|应聘|教育|经历|工作|实习|项目|技能|证书|荣誉|奖项|评价|信息|联系|方式|背景|校园|实践|语言|兴趣|特长|概览|总结|介绍|说明)/;
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

  const political = src.match(/(中共党员|中共预备党员|共青团员|民主党派|群众)/);
  setIfEmpty('basic', 'politicalStatus', political?.[1]);

  const position = src.match(/(?:求职意向|应聘岗位|目标岗位|意向岗位)\s*[:：]?\s*([^\n，,；;]{2,20})/);
  setIfEmpty('intent', 'targetPosition', position?.[1]);

  const targetCity = src.match(/(?:期望城市|意向城市|期望工作地)\s*[:：]?\s*([\u4e00-\u9fff\/、]{2,20})/);
  setIfEmpty('intent', 'targetCity', targetCity?.[1]);

  const jobType = src.match(/(实习|校招|校园招聘|社招|兼职)/);
  if (src.match(/求职类型\s*[:：]?\s*(实习|校招|社招|兼职)/)) {
    setIfEmpty('intent', 'jobType', src.match(/求职类型\s*[:：]?\s*(实习|校招|社招|兼职)/)[1]);
  } else if (jobType) {
    setIfEmpty('intent', 'jobType', jobType[1] === '校园招聘' ? '校招' : jobType[1]);
  }

  // 教育经历：学校 + 学历 + 专业 + 时间范围
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
      const m = after.match(/([\u4e00-\u9fff]{2,15})/);
      if (!m) continue;
      if (DEGREE_WORD.test(m[1]) || SECTION_HEAD_WORD.test(m[1])) continue;
      // 「电子信息工程专业」→「电子信息工程」：网申里专业名一般不带「专业」二字
      edu.major = m[1].replace(/专业$/, '');
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

  // 工作/实习与项目经历：按章节切段后逐条目解析。
  // 原先只抽公司名、项目经历完全不处理，导致实习的职位/时间/内容与整段项目经历丢失。
  const sections = localSplitSections(lines);
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

  // 技能标签：常见关键词命中
  const skillPool = ['Excel', 'PPT', 'Word', 'SQL', 'Python', 'Java', 'Figma', 'Axure', 'PS', 'Photoshop',
    'Pr', 'Premiere', '剪映', 'Axure', 'Tableau', 'SPSS', 'Kotlin', 'JavaScript', 'HTML', 'CSS',
    '数据分析', '用户研究', '竞品分析', '文案撰写', '新媒体运营', '项目管理', 'Axure', 'Sketch'];
  const hitSkills = [...new Set(skillPool.filter(s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(src)))].slice(0, 12);
  if (hitSkills.length) profile.skills.skillTags = hitSkills.join('、');

  const languageHits = [...new Set(['CET-4', 'CET-6', 'CET4', 'CET6', '雅思', '托福', 'IELTS', 'TOEFL', '日语', '粤语']
    .filter(s => new RegExp(s, 'i').test(src)))];
  if (languageHits.length) profile.skills.languages = languageHits.join('、');

  const certHits = [...new Set(['计算机二级', '计算机三级', '教师资格', '会计从业', '初级会计', '软件设计师', 'PMP', '驾照']
    .filter(s => src.includes(s)))];
  if (certHits.length) profile.skills.certificates = certHits.join('、');

  // 荣誉奖项：网申里是独立于「证书」的一个栏目，且要按含金量（国家级 > 省部级 > 校级）
  // 排序填写。混在证书里会让用户漏掉它，所以单独抽。
  const HONOR_RE = /奖学金|三好学生|优秀(班干部|学生|团员|党员|毕业生|员工)|先进个人|标兵|荣誉称号|竞赛|大赛|挑战杯|蓝桥杯|数学建模|创新创业|获奖|一等奖|二等奖|三等奖/;
  const honorLines = (sections.skills || []).filter(line => HONOR_RE.test(line));
  if (honorLines.length) profile.skills.honors = localJoinBody(honorLines);

  // 自我评价：命中标题后取后续 3 行
  const selfIdx = lines.findIndex(l => /自我评价|个人评价|个人总结/.test(l) && l.length <= 12);
  if (selfIdx >= 0) {
    const body = lines.slice(selfIdx + 1, selfIdx + 4)
      .filter(l => !/^(教育|工作|实习|项目|技能|荣誉|证书)/.test(l))
      .join(' ');
    if (body) profile.skills.selfEvaluation = body;
  }

  const links = [...new Set([...src.matchAll(/(?:https?:\/\/|www\.)[^\s，,；;）)]+/g)].map(m => m[0]))];
  if (links.length) profile.skills.portfolio = links.slice(0, 3).join('\n');

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

// 块内解析「字段名：值」。认不出的行作为上一个字段的续行（AI 常把长内容换行）
function parseProfilePairs(lines) {
  const pairs = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const match = line.match(/^\s*[-*•]?\s*([^：:]{1,24})\s*[:：]\s*(.*)$/);
    const key = match ? resolveProfileKey(match[1].trim()) : null;

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
    const pairs = parseProfilePairs(block.lines);
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
    chrome.storage.local.get(['savedResumeProfile', 'profileVersion'], (data) => {
      if (!data.savedResumeProfile) { resolve(null); return; }
      try {
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
    chrome.storage.local.remove(['savedResumeProfile', 'profileVersion'], resolve);
  });
}

// 分析输入预算与评分提示词；修改规则时同步评分规格和回归测试。
function buildCustomInstructions(settings) {
  return [
    settings.customInstructions ? `评分偏好：${settings.customInstructions}` : "",
    settings.greetingStyle ? `话术风格：${settings.greetingStyle}` : ""
  ].filter(Boolean).join("\n");
}

function compactAnalysisText(value, maxChars) {
  const text = String(value || "");
  const limit = Math.max(200, Number(maxChars) || 0);
  if (text.length <= limit) return text;
  const marker = "\n……【中间内容已省略，以控制批量分析延迟】……\n";
  const available = Math.max(1, limit - marker.length);
  const headLength = Math.floor(available * 0.72);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

function buildAnalysisPrompt({
  resumeText,
  job,
  settings,
  customInstructions,
  targetDirections,
  excludedDirections,
  currentLocation
}) {
  const directions = String(targetDirections || settings.targetDirections || "未配置");
  const exclusions = String(excludedDirections || settings.excludedDirections || "").trim();
  const locationText = String(currentLocation || settings.currentLocation || "").trim();
  const experienceYears = normalizeExperienceYears(settings.experienceYears);
  const graduateStatus = normalizeGraduateStatus(settings.graduateStatus);
  const experienceProfile = [
    experienceYears === "" ? "工作经验年限：未设置，请根据简历时间线谨慎判断" : `工作经验年限：${experienceYears} 年`,
    graduateStatus === "graduate"
      ? "应届身份：应届生"
      : graduateStatus === "experienced"
        ? "应届身份：非应届生"
        : "应届身份：未设置，请勿自行假定"
  ].join("；");
  const configuredPassScore = Number(settings.minScore);
  const passScore = Number.isFinite(configuredPassScore)
    ? Math.max(0, Math.min(100, configuredPassScore))
    : 60;
  const resumeForPrompt = compactAnalysisText(resumeText, MAX_RESUME_INPUT_CHARS);
  const jobDescriptionForPrompt = compactAnalysisText(job.jd, MAX_JOB_DESCRIPTION_INPUT_CHARS);
  const cityRule = settings.restrictTargetLocation && locationText
    ? `用户开启了“只分析城市偏好匹配岗位”。岗位城市或岗位文本若明显不在城市偏好「${locationText}」，应给 skip 或显著降低分数。`
    : "未开启目标城市硬性过滤时，不要仅因为城市不同就直接 skip；要参考岗位城市、公司办公地点、通勤便利性和到岗方式，把地理位置写进匹配理由或风险点。";
  const commuteAnswer = locationText
    ? `如果 HR 问居住地、通勤或到岗地点，围绕「${locationText}」诚实回答，不要编造。`
    : "如果 HR 问居住地、通勤或到岗地点，提醒用户先补充目标城市/通勤回答，不要编造具体地址。";
  return `
你是求职岗位快速批量评分器。请严格基于真实简历和岗位信息判断匹配度，并生成一句可给 HR 的简短话术。

核心要求：
- 不能编造简历中没有的经历、公司、项目、技能熟练度。
- 你拥有最终评分权。扩展只会把 score 限制在 0-100、执行用户明确配置的排除结论，并与用户分数线比较，不会用关键词规则二次抬分。
- 必须同时参考【前台求职配置】【所有已勾选简历】【岗位完整 JD】【公司与实际工作地点】。不得只看标题或关键词，也不得忽略简历中的可迁移经验。
- 评分目标是“是否值得投递/沟通”，不是严格技术面试通过率；应届/初级/不限经验岗位可以更宽松。
- 必须先从简历动态识别用户已有的技能、技术栈、项目、行业知识和可迁移能力，再与完整 JD 对照；不能要求用户把简历里的每项能力重复填写成目标关键词。
- “高级、资深、专家、负责人、5-10 年”等只是岗位门槛证据，不是自动淘汰条件。分别保留方向、技能和项目的匹配得分，再根据简历实际年限与职责深度调整岗位门槛分，禁止仅凭标题统一给低分。
- 岗位详情不完整时应降低结论置信度并进入人工复核区间，不能把信息不足等同于不匹配。
- ${cityRule}
- 地理位置是辅助判断，默认不应大幅扣分；除非用户开启目标城市硬性过滤且岗位明显不满足，或岗位有明确不可接受的到岗要求。优先依据职位工作内容、岗位职责、岗位要求和简历证据评分。
- 对方未回复时，不生成追发话术。
- ${commuteAnswer}
- 遵守【求职偏好】，但求职偏好不能覆盖“不编造经历”和“诚实表达限制”的核心约束。
- 这是快速批量评分：直接完成判断并输出紧凑 JSON，不要输出思考过程、长篇解释或重复输入内容。

目标方向加权：
- 只围绕用户在【我的目标方向】里填写的方向、关键词和求职偏好加权。
- 如果用户未配置目标方向，请主要依据简历证据、岗位门槛和岗位文本判断，不要默认偏向某个行业或职位。
- 用户填写的目标方向关键词是强信号。岗位标题、标签或 JD 只要明确命中用户关键词、关键词核心词，或明显同义表达，不能给 0-19 这种淘汰分，除非存在明显硬性不满足条件。
- 多词职业方向必须按完整语义判断，不能因为共享一个宽泛尾词就视为命中。例如“技术支持”不等于客户支持或业务支持，“前端开发”也不等于任意开发岗位。
- 先概括岗位的主要职业类型，再判断它与用户目标是直接匹配、能力可迁移、无关还是信息不足。不要用代码式字面规则代替语义判断；软技能相通不等于职业方向相同，但有明确简历证据的可迁移能力可以合理加分。
- 岗位标题或核心职责与用户目标方向的完整职业语义直接对应时，必须判定 target_alignment=direct，方向相关性通常应为 24-30 分。工作年限、岗位级别、公司行业或次要技能缺口不得反向降低这部分方向分。
- target_alignment=direct 且简历至少存在一项同方向的真实工作、实习、项目或技能证据时，只要 excluded=false、地点可接受且没有明确硬性准入冲突，总分应进入 60-79 分的值得投递/沟通区间，不能停留在 50 分左右。匹配证据更充分时可进入 80 分以上。
- 只有 JD 明确要求且候选人确实无法满足的法定资质、执业证书、安全许可或同类准入条件，才可作为使上述直接匹配低于 60 分的硬性冲突，并必须在 risks 中写明。经验年限、应届身份以及“高级/资深”标题本身都不是硬性冲突。
- 对用户配置的任意方向都要宽召回：只要标题/JD 出现相关信号，且没有明显硬性冲突，通常进入可复核区间。

排除岗位边界：
- 先概括岗位的主要职业类型，再与【绝不投递岗位/职业类型】逐项进行完整语义比较。
- 排除列表为空时，excluded 必须为 false。
- 只有岗位核心工作内容明确属于某个排除职业类型时才能 excluded=true。共享一个宽泛词不算命中，例如“产品运营”不等于“直播运营”，“技术支持”不等于“电话客服”，“市场策划”不等于“电话销售”。
- 排除项优先级高于目标方向和分数。明确命中时 decision=skip，score 应为 0-19，并写清 exclusion_match 与 exclusion_reason。
- 未明确命中时 excluded=false，不得因为相似、可能包含少量相关任务或公司行业相近而误排除。

统一评分参考：
- 最终 score = 方向相关性 0-30 + 简历证据 0-25 + 岗位门槛 0-20 + 地理位置 0-10 + 机会质量 0-15。
- 先分别确定五个维度的分数并求和，再输出最终 score；不得凭模糊的整体印象另给一个更低的总分。
- 方向相关性必须综合岗位职业类型、核心职责和用户目标，不能只看标题。
- 简历证据必须来自真实工作、实习、项目、技能、作品、课程或可迁移经历。
- 岗位门槛 0-20 中，技能深度、学历和职责要求占 0-14 分；经验年限与应届身份合计 0-6 分，不能单独触发淘汰、skip 或 excluded。
- 同一缺口只能归入一个最贴切的评分维度扣一次，禁止跨维度重复惩罚。经验年限与应届身份只影响岗位门槛中的 0-6 分，不得再次扣减方向相关性、简历证据或机会质量。
- 对照职位卡片城市旁及完整 JD 中的“经验不限、1-3 年、3-5 年、应届”等要求；配置留空时只能依据简历时间线谨慎推断，无法确认时写入 risks，不得编造。
- “高级、资深、5年”等不是自动淘汰词。经验或应届身份不完全匹配时，应结合真实项目、实习和可迁移能力在 0-6 分范围内调整，不得覆盖方向与简历证据。
- 地理位置默认只是辅助因素，只有城市硬限制或明确不可接受的到岗要求才可大幅扣分。
- 与目标方向、简历主线和可迁移能力都基本无关的岗位，即使门槛低，也应低于 50 分，不得为了凑投递量给高分。
- 信息不足应降低置信度和分数，不能自行补全事实。
- ${passScore} 分是用户设置的达标线。score >= ${passScore} 且 excluded=false 时 decision=recommend；低于线但值得查看时 manual_review；明显无关或排除岗位用 skip。
- reasons 最多 ${MAX_ANALYSIS_REASONS} 条，每条一句，合计说明方向、简历证据和岗位门槛。
- risks 最多 ${MAX_ANALYSIS_RISKS} 条，每条一句；没有明确风险时返回空数组。

输出必须是 JSON，不要 Markdown，不要解释 JSON 外的内容。
JSON 格式：
{
  "score": 0,
  "decision": "recommend|manual_review|skip",
  "excluded": false,
  "exclusion_match": "命中的排除职业类型；未命中时为空",
  "exclusion_reason": "命中或未命中的语义判断依据",
  "occupation_family": "岗位主要职业类型",
  "target_alignment": "direct|transferable|unrelated|unclear",
  "reasons": ["匹配理由"],
  "risks": ["风险点"],
  "location_fit": "good|acceptable|unclear|poor",
  "greeting": "第一句 HR 沟通话术，60字以内"
}

【前台求职配置：目标方向】
${directions}

【前台求职配置：绝不投递岗位/职业类型】
${exclusions || "未配置"}

【前台求职配置：额外分析提示词与话术偏好】
${customInstructions || "无"}

【前台求职配置：目标城市/通勤回答】
${locationText || "未配置"}

【前台求职配置：城市偏好方式】
${settings.restrictTargetLocation ? "用户要求把目标城市/地区作为硬性条件，由 AI 结合岗位真实地点和通勤信息判断。" : "城市与通勤是综合评分因素，不是代码硬过滤条件。"}

【前台求职配置：个人经验与应届状态】
${experienceProfile}

【所有已勾选简历】
${resumeForPrompt}

【岗位信息】
平台：${job.platform || "boss"}
岗位：${job.title || ""}
公司：${job.company || ""}
岗位卡片城市/地区：${job.city || ""}
薪资：${job.salary || ""}
链接：${job.url || ""}
JD：
${jobDescriptionForPrompt}
岗位详情完整度：${job.jdComplete === false ? "仅岗位卡片，信息可能不完整" : "已读取完整岗位详情"}
`.trim();
}

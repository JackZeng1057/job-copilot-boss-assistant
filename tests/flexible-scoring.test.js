const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");

(async () => {
  let listener;
  let requestedPrompt = "";
  const settings = {
    apiBaseUrl: "https://api.example.com",
    apiKey: "fixture",
    model: "fixture-model",
    minScore: 60,
    profile: ["default"],
    currentLocation: "示例城市示例区",
    experienceYears: 2.5,
    graduateStatus: "graduate",
    targetDirections: "通用技能",
    excludedDirections: "电话销售",
    customInstructions: "",
    greetingStyle: "简洁",
    resumeDefault: "具备通用技能项目经验，并完成过相关系统开发。",
    resumeAltA: "",
    resumeAltB: "",
    restrictTargetLocation: false,
    autoRunOnJobsPage: false
  };
  const runtime = {
    onMessage: { addListener(value) { listener = value; } },
    get lastError() { return null; }
  };
  const local = {
    get(_keys, callback) { callback({ ...settings }); },
    set(_value, callback) { callback?.(); }
  };
  const fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requestedPrompt = body.messages[0].content;
    const data = {
        choices: [{ message: { content: JSON.stringify({
          score: 64,
          decision: "recommend",
          excluded: false,
          exclusion_match: "",
          exclusion_reason: "未命中排除项",
          occupation_family: "软件开发",
          target_alignment: "direct",
          reasons: ["fixture"],
          risks: ["经验年限待确认"],
          location_fit: "unclear",
          greeting: "您好，我有相关项目经验，希望进一步沟通。"
        }) } }]
    };
    return { ok: true, text: async () => JSON.stringify(data) };
  };

  const sandbox = {
    AbortController,
    chrome: { runtime, storage: { local } },
    console,
    fetch,
    setTimeout,
    clearTimeout,
    URL
  };
  vm.runInNewContext(source, sandbox);

  const response = await new Promise((resolve) => {
    listener({
      type: "analyzeJob",
      payload: {
        platform: "boss",
        title: "高级通用技能工程师",
        company: "示例公司",
        city: "示例城市",
        jd: "完整职位详情：负责通用技能系统建设，要求5-10年经验。",
        jdComplete: true,
        resumeProfile: ["default"],
        targetDirections: "通用技能",
        excludedDirections: "电话销售"
      }
    }, {}, resolve);
  });

  assert.equal(response.ok, true);
  assert.equal(response.analysis.score, 64);
  assert.equal(response.analysis.decision, "recommend");
  assert.match(requestedPrompt, /完整职位详情/);
  assert.match(requestedPrompt, /具备通用技能项目经验，并完成过相关系统开发/);
  assert.match(requestedPrompt, /【前台求职配置：目标方向】\s*通用技能/);
  assert.match(requestedPrompt, /从简历动态识别用户已有的技能/);
  assert.match(requestedPrompt, /所有已勾选简历/);
  assert.match(requestedPrompt, /示例城市示例区/);
  assert.match(requestedPrompt, /【前台求职配置：个人经验与应届状态】\s*工作经验年限：2\.5 年；应届身份：应届生/);
  assert.match(requestedPrompt, /经验年限与应届身份合计 0-6 分/);
  assert.match(requestedPrompt, /target_alignment=direct/);
  assert.match(requestedPrompt, /方向相关性通常应为 24-30 分/);
  assert.match(requestedPrompt, /总分应进入 60-79 分的值得投递\/沟通区间/);
  assert.match(requestedPrompt, /同一缺口只能归入一个最贴切的评分维度扣一次/);
  assert.match(requestedPrompt, /经验年限与应届身份只影响岗位门槛中的 0-6 分/);
  assert.match(requestedPrompt, /先分别确定五个维度的分数并求和/);
  assert.match(requestedPrompt, /【前台求职配置：绝不投递岗位\/职业类型】\s*电话销售/);
  assert.match(requestedPrompt, /扩展只会把 score 限制在 0-100/);
  assert.match(requestedPrompt, /快速批量评分/);
  assert.match(requestedPrompt, /reasons[^\n]*最多 3 条/);
  assert.doesNotMatch(requestedPrompt, /"resume_tips"|"qa"/,
    "batch scoring must not ask every provider to generate unused fields");
  const zeroThresholdPrompt = sandbox.buildAnalysisPrompt({
    resumeText: "候选人简历",
    job: { title: "测试岗位", company: "测试公司", jd: "岗位描述" },
    settings: { ...settings, minScore: 0 },
    customInstructions: "",
    targetDirections: "",
    excludedDirections: "",
    currentLocation: ""
  });
  assert.match(zeroThresholdPrompt, /\n- 0 分是用户设置的达标线/,
    "a valid zero threshold must not silently fall back to 60 in the AI prompt");
  console.log("balanced AI scoring prompt regression test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");

(async () => {
  let listener;
  const settings = {
    apiBaseUrl: "https://api.example.com",
    apiKey: "fixture",
    model: "fixture-model",
    minScore: 60,
    profile: ["default"],
    currentLocation: "目标城区",
    targetDirections: "数据标注,平面设计,仓储管理",
    customInstructions: "评分适当放宽，但以岗位工作内容为主。",
    greetingStyle: "简洁",
    resumeDefault: "具备数据整理、视觉设计和库存管理经验。",
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
  const prompts = [];
  const fetch = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content;
    prompts.push(prompt);
    const customerServiceTarget = /【我的目标方向】\s*客户服务,电话客服/.test(prompt);
    return {
      ok: true,
      text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        score: 67,
        decision: "recommend",
        occupation_family: "电话客服/客户服务",
        target_alignment: customerServiceTarget ? "direct" : "unrelated",
        reasons: ["沟通能力和业务支持具有可迁移性"],
        location_fit: "acceptable"
      }) } }]
      })
    };
  };

  vm.runInNewContext(source, {
    chrome: { runtime, storage: { local } },
    console,
    fetch,
    setTimeout,
    clearTimeout,
    URL
  });

  const response = await new Promise((resolve) => {
    listener({
      type: "analyzeJob",
      payload: {
        platform: "boss",
        title: "无责底薪 到点下班 不加班",
        company: "示例服务公司",
        city: "目标城市",
        jd: "负责和客户电话沟通，解答客户咨询，处理客户反馈；协助信息记录整理，配合团队完成业务支持工作，确保服务质量。经验不限。",
        jdComplete: true,
        resumeProfile: ["default"]
      }
    }, {}, resolve);
  });

  assert.equal(response.ok, true);
  assert.equal(response.analysis.score, 67);
  assert.equal(response.analysis.decision, "recommend");
  assert.equal(response.analysis.reasons[0], "沟通能力和业务支持具有可迁移性");
  assert.match(prompts[0], /直接匹配、能力可迁移、无关还是信息不足/);

  settings.targetDirections = "客户服务,电话客服";
  settings.resumeDefault = "具备客户咨询处理和电话客服经验。";
  const customerServiceResponse = await new Promise((resolve) => {
    listener({
      type: "analyzeJob",
      payload: {
        platform: "boss",
        title: "客户服务专员",
        company: "示例服务公司",
        city: "目标城市",
        jd: "负责和客户电话沟通，解答客户咨询，处理客户反馈，确保服务质量。经验不限。",
        jdComplete: true,
        resumeProfile: ["default"]
      }
    }, {}, resolve);
  });
  assert.equal(customerServiceResponse.ok, true);
  assert.ok(customerServiceResponse.analysis.score >= 60);
  assert.equal(customerServiceResponse.analysis.decision, "recommend");
  console.log("AI occupation judgment passthrough test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

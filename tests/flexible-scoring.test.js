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
          score: 40,
          decision: "manual_review",
          excluded: false,
          reasons: ["fixture"],
          location_fit: "unclear"
        }) } }]
    };
    return { ok: true, text: async () => JSON.stringify(data) };
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
  assert.equal(response.analysis.score, 40);
  assert.equal(response.analysis.decision, "manual_review");
  assert.match(requestedPrompt, /完整职位详情/);
  assert.match(requestedPrompt, /具备通用技能项目经验，并完成过相关系统开发/);
  assert.match(requestedPrompt, /【前台求职配置：目标方向】\s*通用技能/);
  assert.match(requestedPrompt, /从简历动态识别用户已有的技能/);
  assert.match(requestedPrompt, /所有已勾选简历/);
  assert.match(requestedPrompt, /示例城市示例区/);
  assert.match(requestedPrompt, /【前台求职配置：绝不投递岗位\/职业类型】\s*电话销售/);
  assert.match(requestedPrompt, /扩展只会把 score 限制在 0-100/);
  console.log("balanced AI scoring prompt regression test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

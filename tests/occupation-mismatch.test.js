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
    excludedDirections: "电话销售,保险销售",
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
    const excludedSales = /岗位：电话销售专员/.test(prompt);
    const directCustomerService = /【前台求职配置：目标方向】\s*客户服务,电话客服/.test(prompt);
    return {
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          score: excludedSales ? 75 : directCustomerService ? 72 : 38,
          decision: excludedSales ? "recommend" : directCustomerService ? "recommend" : "skip",
          excluded: excludedSales,
          exclusion_match: excludedSales ? "电话销售" : "",
          exclusion_reason: excludedSales ? "核心职责是电话推销产品" : "未命中排除职业类型",
          occupation_family: excludedSales ? "电话销售" : "电话客服/客户服务",
          target_alignment: directCustomerService ? "direct" : "unrelated",
          reasons: ["fixture"],
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

  const analyze = (title, jd) => new Promise((resolve) => {
    listener({
      type: "analyzeJob",
      payload: {
        platform: "boss",
        title,
        company: "示例服务公司",
        city: "目标城市",
        jd,
        jdComplete: true,
        resumeProfile: ["default"]
      }
    }, {}, resolve);
  });

  let response = await analyze(
    "客户服务专员",
    "负责解答客户咨询、处理客户反馈，不承担销售任务。经验不限。"
  );
  assert.equal(response.analysis.score, 38);
  assert.equal(response.analysis.excluded, false,
    "customer service must not be excluded merely because telephone sales is excluded");

  response = await analyze(
    "电话销售专员",
    "通过电话推销保险产品，完成销售业绩指标。"
  );
  assert.equal(response.analysis.excluded, true);
  assert.equal(response.analysis.score, 19, "excluded jobs must be capped below the passing range");
  assert.equal(response.analysis.decision, "skip");
  assert.equal(response.analysis.exclusion_match, "电话销售");

  settings.targetDirections = "客户服务,电话客服";
  response = await analyze(
    "客户服务专员",
    "负责解答客户咨询、处理客户反馈，不承担销售任务。经验不限。"
  );
  assert.equal(response.analysis.score, 72);
  assert.equal(response.analysis.decision, "recommend");
  assert.match(prompts[0], /共享一个宽泛词不算命中/);

  console.log("occupation exclusion boundary tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

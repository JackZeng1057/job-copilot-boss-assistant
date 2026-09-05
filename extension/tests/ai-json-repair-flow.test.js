// 验证分析入口的本地 JSON 修复流程及失败后停止行为。
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = require("./helpers/extension-source").backgroundSource();

function createSandbox(responses) {
  let listener;
  let fetchCount = 0;
  const requestBodies = [];
  const settings = {
    apiProtocol: "openai_chat",
    apiBaseUrl: "https://api.example.com",
    apiAuthType: "bearer",
    apiKey: "fixture",
    model: "fixture-model",
    minScore: 60,
    profile: ["default"],
    resumeDefault: "具备相关项目经验。"
  };
  const storage = {
    get(_keys, callback) { callback({ ...settings }); },
    set(_value, callback) { callback?.(); },
    remove(_keys, callback) { callback?.(); }
  };
  const sandbox = {
    AbortController,
    chrome: {
      runtime: {
        onMessage: { addListener(value) { listener = value; } },
        get lastError() { return null; }
      },
      storage: { local: storage, session: storage },
      tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } }
    },
    console,
    fetch: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      const response = responses[fetchCount++];
      if (!response) throw new Error("unexpected provider repair request");
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    },
    setTimeout,
    clearTimeout,
    URL
  };
  vm.runInNewContext(source, sandbox);
  return {
    get fetchCount() { return fetchCount; },
    get requestBodies() { return requestBodies; },
    analyze() {
      return new Promise((resolve) => listener({
        type: "analyzeJob",
        payload: {
          platform: "boss",
          title: "测试岗位",
          company: "测试公司",
          city: "上海",
          jd: "负责软件开发。",
          jdComplete: true,
          resumeProfile: ["default"]
        }
      }, {}, resolve));
    }
  };
}

const validAnalysisJson = JSON.stringify({
  score: 78,
  decision: "recommend",
  excluded: false,
  exclusion_match: "",
  exclusion_reason: "未命中排除项",
  occupation_family: "软件开发",
  target_alignment: "direct",
  reasons: ["方向匹配"],
  risks: [],
  location_fit: "acceptable",
  greeting: "您好，我的经历与岗位较匹配。"
});

(async () => {
  const localRepair = createSandbox([{
    choices: [{ message: { content: `{
      score: 72,
      decision: 'recommend',
      excluded: false,
      exclusion_match: '',
      exclusion_reason: '未命中排除项',
      occupation_family: '软件开发',
      target_alignment: 'direct',
      reasons: ['匹配',],
      risks: [],
      location_fit: 'acceptable',
      greeting: '您好，我的经历与岗位较匹配。',
    }` } }],
    usage: { prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300 }
  }]);
  let result = await localRepair.analyze();
  assert.equal(result.ok, true, result.error);
  assert.equal(localRepair.fetchCount, 1,
    "common JSON defects must be repaired locally without a second model request");
  assert.equal(result.performance.repaired, true);
  assert.match(result.performance.repairMethod, /^local:/);
  assert.equal(result.performance.usage.visibleOutputTokens, 300);
  assert.deepEqual({ ...localRepair.requestBodies[0].response_format }, { type: "json_object" });
  assert.equal(localRepair.requestBodies[0].max_tokens, undefined);

  const invalidNativeJson = createSandbox([{
    choices: [{ message: { content: "这不是 JSON" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 }
  }]);
  result = await invalidNativeJson.analyze();
  assert.equal(result.ok, false);
  assert.equal(invalidNativeJson.fetchCount, 1,
    "an invalid structured response must fail fast without a second token-consuming model repair");
  assert.match(result.error, /JSON|结构化输出/);

  const reasoningContentFallback = createSandbox([{
    choices: [{
      message: { content: "", reasoning_content: `分析如下：${validAnalysisJson}` },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 900, completion_tokens: 240, total_tokens: 1140 }
  }]);
  result = await reasoningContentFallback.analyze();
  assert.equal(result.ok, true, result.error);
  assert.equal(reasoningContentFallback.fetchCount, 1,
    "valid JSON stranded in reasoning_content must be recovered without another request");
  assert.match(result.performance.repairMethod, /local:reasoning_content/);

  const emptyThenValid = createSandbox([{
    choices: [{ message: { content: "", reasoning_content: "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 900, completion_tokens: 0, total_tokens: 900 }
  }, {
    choices: [{ message: { content: validAnalysisJson }, finish_reason: "stop" }],
    usage: { prompt_tokens: 920, completion_tokens: 220, total_tokens: 1140 }
  }]);
  result = await emptyThenValid.analyze();
  assert.equal(result.ok, true, result.error);
  assert.equal(emptyThenValid.fetchCount, 2,
    "a truly empty provider response must receive exactly one focused retry");
  assert.equal(result.performance.requestCount, 2);
  assert.match(result.performance.repairMethod, /retry:empty_output/);
  assert.equal(result.performance.usage.totalTokens, 2040,
    "usage must include both the empty attempt and successful retry");

  const metadataBeforeAnalysis = createSandbox([{
    choices: [{ message: { content: `{"phase":"reasoning"}\n${validAnalysisJson}` }, finish_reason: "stop" }],
    usage: { prompt_tokens: 880, completion_tokens: 230, total_tokens: 1110 }
  }]);
  result = await metadataBeforeAnalysis.analyze();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.analysis.score, 78);
  assert.equal(metadataBeforeAnalysis.fetchCount, 1,
    "a valid metadata object before the analysis must not hide the later schema-valid object");

  console.log("AI JSON repair flow tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

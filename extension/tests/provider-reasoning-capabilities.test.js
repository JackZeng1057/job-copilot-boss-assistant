// 验证模型推理配置及不支持可选参数时的兼容行为。
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = require("./helpers/extension-source").backgroundSource();
const requests = [];
let rejectReasoningOnce = false;
const storage = {
  get(_keys, callback) { callback({}); },
  set(_value, callback) { callback?.(); },
  remove(_keys, callback) { callback?.(); }
};
const sandbox = {
  AbortController,
  chrome: {
    runtime: { onMessage: { addListener() {} }, get lastError() { return null; } },
    storage: { local: storage, session: storage },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } }
  },
  URL,
  fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (rejectReasoningOnce && requests.length === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "thinking parameter is not supported" } })
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] })
    };
  },
  setTimeout,
  clearTimeout
};

vm.runInNewContext(source, sandbox);

async function request(settings, shouldReject = false) {
  requests.length = 0;
  rejectReasoningOnce = shouldReject;
  const response = await sandbox.callAi({
    apiProtocol: "openai_chat",
    apiAuthType: "bearer",
    apiKey: "secret",
    ...settings
  }, "return JSON");
  return { response, bodies: requests.map((body) => ({ ...body })) };
}

(async () => {
  let result = await request({
    aiProvider: "deepseek",
    apiBaseUrl: "https://deepseek-proxy.example/v1",
    model: "deepseek-v4-flash",
    analysisSpeed: "fast"
  });
  assert.deepEqual({ ...result.bodies[0].thinking }, { type: "disabled" },
    "an explicitly selected DeepSeek provider must retain its capabilities behind a compatible proxy");

  result = await request({
    aiProvider: "qwen",
    apiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.5-flash",
    analysisSpeed: "balanced"
  });
  assert.equal(result.bodies[0].enable_thinking, true);
  assert.equal(result.bodies[0].thinking_budget, 1024);

  result = await request({
    aiProvider: "zhipu",
    apiBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.5",
    analysisSpeed: "fast"
  });
  assert.deepEqual({ ...result.bodies[0].thinking }, { type: "disabled" });

  result = await request({
    aiProvider: "openrouter",
    apiBaseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-v4-flash",
    analysisSpeed: "balanced"
  });
  assert.deepEqual({ ...result.bodies[0].reasoning }, { effort: "low" });

  result = await request({
    aiProvider: "groq",
    apiBaseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-20b",
    analysisSpeed: "accurate"
  });
  assert.equal(result.bodies[0].reasoning_effort, "high");

  result = await request({
    aiProvider: "custom",
    apiBaseUrl: "https://unknown.example/v1",
    model: "unknown-model",
    analysisSpeed: "fast"
  });
  assert.equal(result.bodies[0].thinking, undefined);
  assert.equal(result.bodies[0].reasoning, undefined);
  assert.equal(result.bodies[0].reasoning_effort, undefined);
  assert.equal(result.bodies[0].enable_thinking, undefined);

  result = await request({
    aiProvider: "deepseek",
    apiBaseUrl: "https://rejects-thinking.example/v1",
    model: "deepseek-v4-flash",
    analysisSpeed: "fast"
  }, true);
  assert.equal(result.bodies.length, 2,
    "unsupported optional reasoning controls should receive exactly one compatibility retry");
  assert.deepEqual({ ...result.bodies[0].thinking }, { type: "disabled" });
  assert.equal(result.bodies[1].thinking, undefined);
  assert.equal(result.bodies[1].reasoning_effort, undefined);
  assert.equal(result.response.requestCount, 2);

  result = await request({
    aiProvider: "deepseek",
    apiBaseUrl: "https://rejects-thinking.example/v1",
    model: "deepseek-v4-flash",
    analysisSpeed: "fast"
  });
  assert.equal(result.bodies.length, 1);
  assert.equal(result.bodies[0].thinking, undefined,
    "a rejected capability must be cached for later jobs in the same worker lifetime");

  console.log("Provider reasoning capability tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

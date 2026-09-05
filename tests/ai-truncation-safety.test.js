// 验证模型因输出上限截断时停止分析，避免误用不完整评分。
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = require("./helpers/extension-source").backgroundSource();
const sandbox = {
  AbortController,
  chrome: {
    runtime: { onMessage: { addListener() {} }, get lastError() { return null; } },
    storage: {
      local: { get(_keys, callback) { callback({
        apiProtocol: "openai_chat",
        apiBaseUrl: "https://example.com/v1",
        apiAuthType: "bearer",
        apiKey: "secret",
        model: "generic-model",
        resumeDefault: "resume"
      }); }, set(_value, callback) { callback?.(); }, remove(_keys, callback) { callback?.(); } },
      session: { get(_keys, callback) { callback({}); }, set(_value, callback) { callback?.(); }, remove(_keys, callback) { callback?.(); } }
    },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } }
  },
  URL,
  fetch: async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{
        message: { content: '{"score":88,"decision":"contact"}' },
        finish_reason: "length"
      }],
      usage: { prompt_tokens: 100, completion_tokens: 3000, total_tokens: 3100 }
    })
  }),
  setTimeout,
  clearTimeout
};

vm.runInNewContext(source, sandbox);

(async () => {
  await assert.rejects(
    sandbox.analyzeJob({ title: "岗位", description: "JD", resumeText: "resume" }),
    /输出.*截断|截断.*输出/,
    "a provider-declared truncated response must never become an actionable score"
  );
  console.log("AI truncation safety tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

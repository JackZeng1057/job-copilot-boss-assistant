const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");
const requests = [];
let responseBody = {};
const storage = {
  get(_keys, callback) { callback({}); },
  set(_value, callback) { callback?.(); },
  remove(_keys, callback) { callback?.(); }
};
const sandbox = {
  chrome: {
    runtime: { onMessage: { addListener() {} }, get lastError() { return null; } },
    storage: { local: storage, session: storage },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } }
  },
  URL,
  fetch: async (url, options) => {
    requests.push({ url: String(url), options, body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify(responseBody) };
  },
  setTimeout,
  clearTimeout
};

vm.runInNewContext(source, sandbox);

async function run(settings, body) {
  responseBody = body;
  requests.length = 0;
  const output = await sandbox.callAi(settings, "prompt text", 0.3);
  return { output, request: requests[0] };
}

(async () => {
  let result = await run({
    apiProtocol: "openai_chat",
    apiAuthType: "bearer",
    apiBaseUrl: "https://api.deepseek.com",
    apiKey: "secret",
    model: "any-openai-compatible-model"
  }, { choices: [{ message: { content: "openai result" } }] });
  assert.equal(result.output, "openai result");
  assert.equal(result.request.url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(result.request.options.headers.Authorization, "Bearer secret");
  assert.equal(result.request.body.model, "any-openai-compatible-model");

  result = await run({
    apiProtocol: "openai_responses",
    apiAuthType: "bearer",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: "secret",
    model: "any-responses-model"
  }, { output: [{ content: [{ type: "output_text", text: "responses result" }] }] });
  assert.equal(result.output, "responses result");
  assert.equal(result.request.url, "https://api.openai.com/v1/responses");
  assert.equal(result.request.body.input, "prompt text");

  result = await run({
    apiProtocol: "anthropic_messages",
    apiBaseUrl: "https://api.anthropic.com",
    apiKey: "secret",
    model: "any-claude-model"
  }, { content: [{ type: "text", text: "anthropic result" }] });
  assert.equal(result.output, "anthropic result");
  assert.equal(result.request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(result.request.options.headers["x-api-key"], "secret");
  assert.equal(result.request.options.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(Array.from(result.request.body.messages), [{ role: "user", content: "prompt text" }]);

  result = await run({
    apiProtocol: "gemini_generate_content",
    apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "secret",
    model: "gemini-any-model"
  }, { candidates: [{ content: { parts: [{ text: "gemini result" }] } }] });
  assert.equal(result.output, "gemini result");
  assert.equal(result.request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-any-model:generateContent");
  assert.equal(result.request.options.headers["x-goog-api-key"], "secret");
  assert.equal(result.request.body.contents[0].parts[0].text, "prompt text");

  result = await run({
    apiProtocol: "azure_openai",
    apiBaseUrl: "https://example.openai.azure.com/openai/deployments/demo/chat/completions?api-version=2025-01-01-preview",
    apiKey: "secret",
    model: "deployment-model"
  }, { choices: [{ message: { content: "azure result" } }] });
  assert.equal(result.output, "azure result");
  assert.match(result.request.url, /api-version=2025-01-01-preview/);
  assert.equal(result.request.options.headers["api-key"], "secret");

  result = await run({
    apiProtocol: "openai_chat",
    apiAuthType: "none",
    apiBaseUrl: "http://localhost:11434/v1",
    apiKey: "",
    model: "local-model"
  }, { choices: [{ message: { content: [{ type: "text", text: "local result" }] } }] });
  assert.equal(result.output, "local result");
  assert.equal(result.request.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(result.request.options.headers.Authorization, undefined);
  assert.equal(sandbox.apiKeyRequired({ apiProtocol: "openai_chat", apiAuthType: "none" }), false);
  assert.equal(sandbox.apiKeyRequired({ apiProtocol: "anthropic_messages", apiAuthType: "none" }), true);

  console.log("Multi-provider AI protocol tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

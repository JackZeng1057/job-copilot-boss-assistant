// 模拟不同 AI 协议的请求与响应，验证兼容转换。
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = require("./helpers/extension-source").backgroundSource();
const requests = [];
let responseBody = {};
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
    model: "deepseek-v4-flash",
    analysisSpeed: "fast"
  }, {
    choices: [{ message: { content: "openai result" }, finish_reason: "length" }],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 460,
      total_tokens: 1660,
      prompt_tokens_details: { cached_tokens: 300 },
      completion_tokens_details: { reasoning_tokens: 140 }
    }
  });
  assert.equal(result.output.text, "openai result");
  assert.equal(result.output.truncated, true);
  assert.equal(result.output.finishReason, "length");
  assert.deepEqual({ ...result.output.usage }, {
    inputTokens: 1200,
    outputTokens: 460,
    visibleOutputTokens: 320,
    reasoningTokens: 140,
    cachedInputTokens: 300,
    totalTokens: 1660,
    reported: true
  });
  assert.equal(result.request.url, "https://api.deepseek.com/v1/chat/completions");
  assert.deepEqual({ ...result.request.body.thinking }, { type: "disabled" },
    "fast scoring must disable optional DeepSeek thinking through the provider capability layer");
  assert.deepEqual({ ...result.request.body.response_format }, { type: "json_object" },
    "OpenAI-compatible scoring must request native JSON output");
  assert.equal(result.request.body.max_tokens, undefined,
    "optional provider token ceilings must not be injected into compact scoring requests");
  assert.equal(result.request.options.headers.Authorization, "Bearer secret");
  assert.equal(result.request.body.model, "deepseek-v4-flash");
  assert.equal(result.request.body.temperature, undefined,
    "the shared protocol must not force sampling parameters unsupported by some models");

  result = await run({
    apiProtocol: "openai_chat",
    apiBaseUrl: "https://api.deepseek.com",
    apiKey: "secret",
    model: "deepseek-v4-flash",
    analysisSpeed: "balanced"
  }, { choices: [{ message: { content: "balanced" } }] });
  assert.deepEqual({ ...result.request.body.thinking }, { type: "enabled" });
  assert.equal(result.request.body.reasoning_effort, "high");

  result = await run({
    apiProtocol: "openai_chat",
    apiBaseUrl: "https://api.deepseek.com",
    apiKey: "secret",
    model: "deepseek-v4-flash",
    analysisSpeed: "accurate"
  }, { choices: [{ message: { content: "accurate" } }] });
  assert.deepEqual({ ...result.request.body.thinking }, { type: "enabled" });
  assert.equal(result.request.body.reasoning_effort, "max");

  result = await run({
    apiProtocol: "openai_chat",
    apiAuthType: "bearer",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: "secret",
    model: "any-openai-chat-model"
  }, { choices: [{ message: { content: "official openai result" } }] });
  assert.equal(result.output.text, "official openai result");
  assert.deepEqual({ ...result.request.body.response_format }, { type: "json_object" });
  assert.equal(result.request.body.max_completion_tokens, undefined,
    "the official OpenAI Chat endpoint should use its provider default output ceiling");
  assert.equal(result.request.body.max_tokens, undefined);

  result = await run({
    apiProtocol: "openai_responses",
    apiAuthType: "bearer",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: "secret",
    model: "gpt-5-mini",
    analysisSpeed: "fast"
  }, {
    output: [{ content: [{ type: "output_text", text: "responses result" }] }],
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    usage: {
      input_tokens: 900,
      output_tokens: 240,
      total_tokens: 1140,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 40 }
    }
  });
  assert.equal(result.output.text, "responses result");
  assert.equal(result.output.truncated, true);
  assert.equal(result.output.finishReason, "max_output_tokens");
  assert.equal(result.output.usage.visibleOutputTokens, 200);
  assert.equal(result.request.url, "https://api.openai.com/v1/responses");
  assert.equal(result.request.body.input, "prompt text");
  assert.equal(result.request.body.max_output_tokens, undefined);
  assert.equal(result.request.body.text?.format?.type, "json_schema");
  assert.equal(result.request.body.text?.format?.strict, true);
  assert.deepEqual({ ...result.request.body.reasoning }, { effort: "minimal" });

  result = await run({
    apiProtocol: "openai_responses",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: "secret",
    model: "gpt-5.1-mini",
    analysisSpeed: "fast"
  }, { output_text: "gpt-5.1 fast" });
  assert.deepEqual({ ...result.request.body.reasoning }, { effort: "none" });

  result = await run({
    apiProtocol: "openai_responses",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: "secret",
    model: "gpt-5-pro",
    analysisSpeed: "fast"
  }, { output_text: "fixed effort" });
  assert.equal(result.request.body.reasoning, undefined,
    "fixed-effort Pro models must retain the service default instead of receiving an invalid low effort");

  result = await run({
    apiProtocol: "anthropic_messages",
    apiBaseUrl: "https://api.anthropic.com",
    apiKey: "secret",
    model: "any-claude-model",
    analysisSpeed: "fast"
  }, {
    content: [{ type: "text", text: "anthropic result" }],
    stop_reason: "max_tokens",
    usage: {
      input_tokens: 800,
      output_tokens: 300,
      cache_read_input_tokens: 120,
      output_tokens_details: { thinking_tokens: 80 }
    }
  });
  assert.equal(result.output.text, "anthropic result");
  assert.equal(result.output.truncated, true);
  assert.equal(result.output.finishReason, "max_tokens");
  assert.equal(result.output.usage.visibleOutputTokens, 220);
  assert.equal(result.output.usage.totalTokens, 1220);
  assert.equal(result.request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(result.request.options.headers["x-api-key"], "secret");
  assert.equal(result.request.options.headers["anthropic-version"], "2023-06-01");
  assert.equal(result.request.body.max_tokens, 16384,
    "Anthropic requires an explicit max_tokens value even when other protocols use provider defaults");
  assert.equal(result.request.body.output_config?.format?.type, "json_schema");
  assert.equal(result.request.body.temperature, undefined);
  assert.equal(result.request.body.thinking, undefined,
    "Anthropic extended thinking must remain opt-in unless a model capability is explicitly mapped");
  assert.deepEqual(Array.from(result.request.body.messages), [{ role: "user", content: "prompt text" }]);

  result = await run({
    apiProtocol: "anthropic_messages",
    apiBaseUrl: "https://api.anthropic.com",
    apiKey: "secret",
    model: "claude-sonnet-4-6",
    analysisSpeed: "balanced"
  }, { content: [{ type: "text", text: "balanced anthropic" }] });
  assert.equal(result.request.body.output_config.effort, "medium");

  result = await run({
    apiProtocol: "gemini_generate_content",
    apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "secret",
    model: "gemini-2.5-flash",
    analysisSpeed: "fast"
  }, {
    candidates: [{ content: { parts: [{ text: "gemini result" }] }, finishReason: "MAX_TOKENS" }],
    usageMetadata: {
      promptTokenCount: 700,
      candidatesTokenCount: 180,
      thoughtsTokenCount: 60,
      cachedContentTokenCount: 90,
      totalTokenCount: 940
    }
  });
  assert.equal(result.output.text, "gemini result");
  assert.equal(result.output.truncated, true);
  assert.equal(result.output.finishReason, "MAX_TOKENS");
  assert.equal(result.output.usage.outputTokens, 240);
  assert.equal(result.output.usage.visibleOutputTokens, 180);
  assert.equal(result.request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  assert.equal(result.request.options.headers["x-goog-api-key"], "secret");
  assert.equal(result.request.body.contents[0].parts[0].text, "prompt text");
  assert.equal(result.request.body.generationConfig.maxOutputTokens, undefined);
  assert.equal(result.request.body.generationConfig.responseMimeType, "application/json");
  assert.equal(result.request.body.generationConfig.responseJsonSchema?.type, "object");
  assert.deepEqual({ ...result.request.body.generationConfig.thinkingConfig }, { thinkingBudget: 0 });
  assert.equal(result.request.body.generationConfig.temperature, undefined);

  result = await run({
    apiProtocol: "gemini_generate_content",
    apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "secret",
    model: "gemini-2.5-flash",
    analysisSpeed: "balanced"
  }, { candidates: [{ content: { parts: [{ text: "balanced gemini" }] } }] });
  assert.deepEqual({ ...result.request.body.generationConfig.thinkingConfig }, { thinkingBudget: 1024 });

  result = await run({
    apiProtocol: "gemini_generate_content",
    apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "secret",
    model: "gemini-2.5-flash",
    analysisSpeed: "accurate"
  }, { candidates: [{ content: { parts: [{ text: "accurate gemini" }] } }] });
  assert.equal(result.request.body.generationConfig.thinkingConfig, undefined);

  result = await run({
    apiProtocol: "gemini_generate_content",
    apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "secret",
    model: "gemini-3.1-pro-preview",
    analysisSpeed: "fast"
  }, { candidates: [{ content: { parts: [{ text: "gemini pro" }] } }] });
  assert.deepEqual({ ...result.request.body.generationConfig.thinkingConfig }, { thinkingLevel: "low" },
    "Gemini Pro must never receive the unsupported minimal level");

  result = await run({
    apiProtocol: "azure_openai",
    apiBaseUrl: "https://example.openai.azure.com/openai/deployments/demo/chat/completions?api-version=2025-01-01-preview",
    apiKey: "secret",
    model: "deployment-model"
  }, { choices: [{ message: { content: "azure result" } }] });
  assert.equal(result.output.text, "azure result");
  assert.match(result.request.url, /api-version=2025-01-01-preview/);
  assert.equal(result.request.options.headers["api-key"], "secret");
  assert.deepEqual({ ...result.request.body.response_format }, { type: "json_object" });
  assert.equal(result.request.body.max_tokens, undefined);

  result = await run({
    apiProtocol: "openai_chat",
    apiAuthType: "none",
    apiBaseUrl: "http://localhost:11434/v1",
    apiKey: "",
    model: "local-model"
  }, { choices: [{ message: { content: [{ type: "text", text: "local result" }] } }] });
  assert.equal(result.output.text, "local result");
  assert.equal(result.output.usage.reported, false);
  assert.equal(result.request.url, "http://localhost:11434/v1/chat/completions");
  assert.equal(result.request.options.headers.Authorization, undefined);
  assert.equal(result.request.body.thinking, undefined);
  assert.deepEqual({ ...result.request.body.response_format }, { type: "json_object" });
  assert.equal(result.request.body.max_tokens, undefined);
  assert.equal(sandbox.apiKeyRequired({ apiProtocol: "openai_chat", apiAuthType: "none" }), false);
  assert.equal(sandbox.apiKeyRequired({ apiProtocol: "anthropic_messages", apiAuthType: "none" }), true);

  console.log("Multi-provider AI protocol tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

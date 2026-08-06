const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");
const requestBodies = [];
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
    requestBodies.push(JSON.parse(options.body));
    if (requestBodies.length === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "response_format is not supported" } })
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }]
      })
    };
  },
  setTimeout,
  clearTimeout
};

vm.runInNewContext(source, sandbox);

(async () => {
  const result = await sandbox.callAi({
    apiProtocol: "openai_chat",
    apiAuthType: "bearer",
    apiBaseUrl: "https://legacy-compatible.example/v1",
    apiKey: "secret",
    model: "legacy-model"
  }, "return JSON");

  assert.equal(requestBodies.length, 2,
    "an endpoint that rejects native JSON mode should receive one compatibility retry");
  assert.deepEqual({ ...requestBodies[0].response_format }, { type: "json_object" });
  assert.equal(requestBodies[1].response_format, undefined);
  assert.equal(result.requestCount, 2);
  console.log("Structured-output compatibility fallback tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

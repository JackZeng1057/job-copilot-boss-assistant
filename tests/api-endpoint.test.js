const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");
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
  fetch: async () => { throw new Error("fetch should not run"); },
  setTimeout,
  clearTimeout
};

vm.runInNewContext(source, sandbox);

assert.equal(sandbox.chatEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/v1/chat/completions");
assert.equal(sandbox.chatEndpoint("https://example.com/v1"), "https://example.com/v1/chat/completions");
assert.equal(sandbox.chatEndpoint("https://example.com/v1/chat/completions"), "https://example.com/v1/chat/completions");
assert.equal(sandbox.chatEndpoint("https://open.bigmodel.cn/api/paas/v4"), "https://open.bigmodel.cn/api/paas/v4/chat/completions");
assert.equal(sandbox.chatEndpoint("http://localhost:11434"), "http://localhost:11434/v1/chat/completions");
assert.throws(() => sandbox.chatEndpoint("http://example.com"), /HTTPS/);
assert.throws(() => sandbox.chatEndpoint("https://user:secret@example.com"), /用户名或密码/);

console.log("AI endpoint validation tests passed");

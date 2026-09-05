// 按真实脚本边界执行模块，验证后台与页面依赖在入口启动前就绪。
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource, contentFiles } = require("./helpers/extension-source");

test("worker loads each classic script before handling a settings request", async () => {
  let listener;
  const storage = { get(_keys, callback) { callback({}); } };
  const context = vm.createContext({
    chrome: {
      storage: { local: storage, session: storage },
      runtime: { onMessage: { addListener(callback) { listener = callback; } }, lastError: null }
    },
    URL, setTimeout, clearTimeout
  });
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(readSource(file), context, { filename: file });
  };
  vm.runInContext(readSource("background.js"), context, { filename: "background.js" });
  const response = await new Promise((resolve) => {
    assert.equal(listener({ type: "getSettings" }, {}, resolve), true);
  });
  assert.equal(response.ok, true);
  assert.equal(response.settings.minScore, 60);
  assert.equal("apiKey" in response.settings, false);
  assert.equal("resumeDefault" in response.settings, false);
  assert.equal(context.chatEndpoint("https://example.test"), "https://example.test/v1/chat/completions");
});

test("content manifest initializes dependencies before the startup entry", () => {
  const context = vm.createContext({
    chrome: { runtime: { getManifest: () => ({ version: "1.0.0" }) } },
    document: { getElementById: () => null }
  });
  const files = contentFiles();
  assert.equal(files.at(-1), "content.js");
  for (const file of files.slice(0, -1)) {
    vm.runInContext(readSource(file), context, { filename: file });
  }
  const calls = [];
  for (const name of ["initPanel", "installManualChatTabHandler", "installContentRuntimeResponder", "registerJobsTabProtection"]) {
    assert.equal(typeof context[name], "function");
    context[name] = () => calls.push(name);
  }
  vm.runInContext(readSource("content.js"), context, { filename: "content.js" });
  assert.equal(calls.length, 4);
  assert.equal(vm.runInContext("JC_STATE.pipeline.active", context), false);
  for (const name of ["captureJobSnapshot", "analyzeJobs", "runCommunicateForJob", "renderList", "sendMessage"]) {
    assert.equal(typeof context[name], "function", `${name} must be available at startup`);
  }
});

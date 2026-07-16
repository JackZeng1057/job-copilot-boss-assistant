const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");
const loadTimeout = Number(source.match(/ISOLATED_CONTACT_LOAD_TIMEOUT_MS\s*=\s*(\d+)/)?.[1]);
const actionTimeout = Number(source.match(/ISOLATED_CONTACT_ACTION_TIMEOUT_MS\s*=\s*(\d+)/)?.[1]);
assert.ok(loadTimeout >= 15000, "temporary detail tabs need a realistic load budget");
assert.ok(actionTimeout > 22000, "the outer action timeout must exceed the content script's 10s + 12s budget");
assert.match(source, /sendTabMessageWithTimeout\([\s\S]*ISOLATED_CONTACT_ACTION_TIMEOUT_MS/,
  "isolated communication must use the longer action timeout");
let listener;
let createdOptions;
let removedTabId;
const updateListeners = new Set();
const storage = {
  get(_keys, callback) { callback({}); },
  set(_value, callback) { callback?.(); },
  remove(_keys, callback) { callback?.(); }
};
const tabs = {
  onUpdated: {
    addListener(value) { updateListeners.add(value); },
    removeListener(value) { updateListeners.delete(value); }
  },
  onRemoved: { addListener() {} },
  create(options, callback) {
    createdOptions = options;
    callback({ id: 77, status: "complete", url: options.url });
  },
  get(tabId, callback) { callback({ id: tabId, status: "complete", url: createdOptions.url }); },
  remove(tabId, callback) { removedTabId = tabId; callback(); },
  sendMessage(_tabId, message, callback) {
    assert.equal(message.type, "performIsolatedCommunication");
    assert.equal(message.expectedJob.key, "job:example");
    assert.equal(message.expectedJob.title, "示例岗位");
    assert.equal(message.expectedJob.company, "示例公司");
    assert.equal(message.expectedJob.url, "https://www.zhipin.com/job_detail/example.html");
    callback({ ok: true, status: "stayed" });
  }
};
const runtime = {
  onMessage: { addListener(value) { listener = value; } },
  get lastError() { return null; }
};

vm.runInNewContext(source, {
  chrome: { runtime, storage: { local: storage, session: storage }, tabs },
  URL,
  fetch: async () => { throw new Error("fetch should not run"); },
  setTimeout,
  clearTimeout
});

new Promise((resolve) => {
  const result = listener(
    {
      type: "communicateInIsolatedTab",
      job: {
        key: "job:example",
        title: "示例岗位",
        company: "示例公司",
        url: "https://www.zhipin.com/job_detail/example.html"
      }
    },
    { tab: { id: 41, url: "https://www.zhipin.com/web/geek/jobs", windowId: 2, index: 0 } },
    resolve
  );
  assert.equal(result, true);
}).then((response) => {
  assert.equal(response.ok, true);
  assert.equal(response.status, "stayed");
  assert.equal(createdOptions.active, false);
  assert.equal(createdOptions.openerTabId, undefined);
  assert.equal(removedTabId, 77);
  console.log("Isolated contact tab regression test passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

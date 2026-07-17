const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");

function createStorageArea() {
  const values = {};
  return {
    get(_keys, callback) { callback({ ...values }); },
    set(patch, callback) { Object.assign(values, patch); callback?.(); },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
      callback?.();
    }
  };
}

let messageListener = null;
let createdOptions = null;
let removedTabId = null;
let actionRequests = 0;
let inspectionRequests = 0;
const storage = createStorageArea();
const tabs = {
  onUpdated: { addListener() {}, removeListener() {} },
  onRemoved: { addListener() {} },
  create(options, callback) {
    createdOptions = options;
    callback({ id: 88, status: "complete", url: options.url });
  },
  get(tabId, callback) {
    callback({ id: tabId, status: "complete", url: createdOptions.url });
  },
  update(tabId, changes, callback) { callback({ id: tabId, ...changes }); },
  remove(tabId, callback) { removedTabId = tabId; callback(); },
  sendMessage(_tabId, message, callback) {
    if (message.type === "performIsolatedCommunication") {
      actionRequests += 1;
      callback({ ok: false, error: "临时沟通动作超时" });
      return;
    }
    assert.equal(message.type, "inspectIsolatedCommunicationResult");
    inspectionRequests += 1;
    callback({ ok: true, confirmed: true, status: "" });
  }
};
const runtime = {
  lastError: null,
  onMessage: { addListener(listener) { messageListener = listener; } }
};

vm.runInNewContext(source, {
  chrome: { runtime, storage: { local: storage, session: storage }, tabs },
  URL,
  fetch: async () => { throw new Error("fetch should not run"); },
  setTimeout,
  clearTimeout
});

new Promise((resolve) => {
  const asyncResponse = messageListener({
    type: "communicateInIsolatedTab",
    job: {
      key: "job:timeout-recovery",
      title: "超时恢复测试岗位",
      company: "测试公司",
      url: "https://www.zhipin.com/job_detail/timeout-recovery.html"
    }
  }, {
    tab: { id: 41, url: "https://www.zhipin.com/web/geek/jobs", windowId: 2, index: 0 }
  }, resolve);
  assert.equal(asyncResponse, true);
}).then((response) => {
  assert.equal(response.ok, true);
  assert.equal(response.status, "stayed");
  assert.equal(actionRequests, 1, "timeout recovery must never repeat the communication click");
  assert.equal(inspectionRequests, 1, "timeout recovery must perform one read-only verification");
  assert.equal(removedTabId, 88);
  console.log("Contact timeout recovery regression test passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

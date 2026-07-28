const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");

function createStorageArea(seed = {}) {
  const values = { ...seed };
  return {
    values,
    get(keys, callback) {
      if (keys === null) callback({ ...values });
      else if (typeof keys === "string") callback({ [keys]: values[keys] });
      else callback({ ...values });
    },
    set(patch, callback) {
      Object.assign(values, patch);
      callback?.();
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
      callback?.();
    }
  };
}

(async () => {
  const local = createStorageArea();
  const session = createStorageArea();
  let messageListener = null;
  const createdTabs = [];
  const updatedTabs = [];
  const removedTabs = [];
  const sentMessages = [];
  const workerTab = {
    id: 91,
    windowId: 3,
    index: 5,
    active: false,
    url: "https://www.zhipin.com/job_detail/abc.html"
  };

  const runtime = {
    lastError: null,
    onMessage: { addListener(listener) { messageListener = listener; } }
  };
  const tabs = {
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    create(options, callback) {
      createdTabs.push(options);
      callback({ ...workerTab, ...options });
    },
    get(tabId, callback) {
      assert.equal(tabId, workerTab.id);
      callback(workerTab);
    },
    update(tabId, changes, callback) {
      updatedTabs.push({ tabId, changes });
      callback({ id: tabId, ...changes });
    },
    remove(tabId, callback) {
      removedTabs.push(tabId);
      callback();
    },
    sendMessage(tabId, message, callback) {
      sentMessages.push({ tabId, message });
      assert.equal(tabId, workerTab.id);
      if (message.type === "inspectIsolatedCommunicationResult") {
        callback({ ok: true, ready: true });
      } else if (message.type === "performIsolatedCommunication") {
        callback({ ok: true, status: "navigated_chat" });
      } else {
        callback({ ok: true });
      }
    },
    query(_queryInfo, callback) { callback([]); },
    goBack(_tabId, callback) { callback(); }
  };

  vm.runInNewContext(source, {
    chrome: { runtime, storage: { local, session }, tabs },
    console,
    fetch: async () => { throw new Error("fetch should not run"); },
    setTimeout,
    clearTimeout,
    URL,
    AbortController
  });

  const ownerTab = {
    id: 7,
    windowId: 3,
    index: 4,
    active: true,
    url: "https://www.zhipin.com/web/geek/jobs?query=test"
  };
  const response = await new Promise((resolve) => {
    assert.equal(messageListener({
      type: "communicateInIsolatedTab",
      job: {
        key: "job:abc",
        title: "前端工程师",
        company: "示例公司",
        url: workerTab.url
      }
    }, { tab: ownerTab }, resolve), true);
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "navigated_chat");
  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].active, false, "the communication tab must never steal focus");
  assert.equal(createdTabs[0].windowId, ownerTab.windowId);
  assert.equal(createdTabs[0].index, ownerTab.index + 1);
  assert.deepEqual(removedTabs, [workerTab.id], "the disposable tab must be closed after verification");
  assert.equal(sentMessages.filter((entry) => entry.message.type === "performIsolatedCommunication").length, 1,
    "one job may dispatch only one communication action");
  assert.equal(updatedTabs.some((entry) => entry.tabId === ownerTab.id), false,
    "the owner jobs tab must never be activated, navigated, or otherwise updated");

  console.log("Isolated contact owner-tab boundary tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

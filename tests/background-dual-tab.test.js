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
      else if (Array.isArray(keys)) callback(Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, values[key]])));
      else callback({ ...keys, ...values });
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

async function runNavigationScenario(contactInFlight, targetUrl = "https://www.zhipin.com/web/geek/chat") {
  const local = createStorageArea();
  const session = createStorageArea();
  let messageListener = null;
  let updatedListener = null;
  const createdTabs = [];
  const updatedTabs = [];
  const historyBackTabs = [];
  const runtime = {
    lastError: null,
    onMessage: { addListener(listener) { messageListener = listener; } }
  };
  const tabs = {
    onUpdated: { addListener(listener) { updatedListener = listener; } },
    create(options, callback) {
      createdTabs.push(options);
      callback({ id: 100 + createdTabs.length, ...options });
    },
    update(tabId, changes, callback) {
      updatedTabs.push({ tabId, changes });
      callback({ id: tabId, ...changes });
    },
    sendMessage(_tabId, _message, callback) { callback({ ok: true }); }
  };

  vm.runInNewContext(source, {
    chrome: { runtime, storage: { local, session }, tabs },
    console,
    fetch: async () => { throw new Error("fetch should not run"); },
    setTimeout,
    clearTimeout,
    URL
  });

  const send = (message) => new Promise((resolve) => {
    assert.equal(messageListener(message, { tab: { id: 7 } }, resolve), true);
  });
  const jobKey = "job:test";
  await send({
    type: "registerAutomationSession",
    session: {
      active: true,
      paused: false,
      mode: "auto",
      jobsUrl: "https://www.zhipin.com/web/geek/jobs?query=test",
      fingerprint: "fixture",
      analyses: {},
      progress: { [jobKey]: { status: "contacting", detail: "" } },
      completedJobKeys: ["job:previous"],
      batchNumber: 3,
      batchKeys: [jobKey],
      contactInFlight,
      currentJobKey: contactInFlight ? jobKey : ""
    }
  });

  updatedListener(7, { url: targetUrl });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(historyBackTabs.length, 0);
  assert.equal(createdTabs.length, 0);
  assert.equal(updatedTabs.some((entry) => entry.changes.url), false);
  assert.equal(updatedTabs[0].changes.autoDiscardable, false);
  assert.equal(updatedTabs.at(-1).changes.autoDiscardable, true);

  const saved = session.values.jobCopilotAutomationSessionV1;
  assert.deepEqual(Array.from(saved.completedJobKeys), ["job:previous"]);
  assert.equal(saved.batchNumber, 3);
  assert.deepEqual(Array.from(saved.batchKeys), [jobKey]);
  assert.equal(saved.active, false);
  assert.equal(saved.paused, true);
  assert.equal(saved.status.includes("不会被自动刷新"), true);
  if (contactInFlight) {
    assert.equal(saved.contactInFlight, false);
    assert.equal(saved.progress[jobKey].status, "attention");
  }
}

async function runManualChatScenario(existingChatTab = null) {
  const local = createStorageArea();
  const session = createStorageArea();
  let messageListener = null;
  const createdTabs = [];
  const duplicatedTabs = [];
  const updatedTabs = [];
  const focusedWindows = [];
  const runtime = {
    lastError: null,
    onMessage: { addListener(listener) { messageListener = listener; } }
  };
  const tabs = {
    onUpdated: { addListener() {} },
    query(queryInfo, callback) {
      assert.deepEqual(Array.from(queryInfo.url), ["https://www.zhipin.com/web/geek/chat*"]);
      assert.equal(queryInfo.windowId, 3);
      callback(existingChatTab ? [existingChatTab] : []);
    },
    create(options, callback) {
      createdTabs.push(options);
      callback({ id: 91, ...options });
    },
    duplicate(tabId, callback) {
      duplicatedTabs.push(tabId);
      callback({ id: 91, url: "https://www.zhipin.com/web/geek/jobs", windowId: 3, index: 5 });
    },
    update(tabId, changes, callback) {
      updatedTabs.push({ tabId, changes });
      callback({ id: tabId, ...changes });
    },
    sendMessage(_tabId, _message, callback) { callback({ ok: true }); }
  };
  const windows = {
    update(windowId, changes, callback) {
      focusedWindows.push({ windowId, changes });
      callback({ id: windowId, ...changes });
    }
  };

  vm.runInNewContext(source, {
    chrome: { runtime, storage: { local, session }, tabs, windows },
    console,
    fetch: async () => { throw new Error("fetch should not run"); },
    setTimeout,
    clearTimeout,
    URL
  });

  const senderTab = { id: 7, windowId: 3, index: 4 };
  const send = (message, tab = senderTab) => new Promise((resolve) => {
    assert.equal(messageListener(message, { tab }, resolve), true);
  });
  await send({
    type: "registerAutomationSession",
    session: { active: true, jobsUrl: "https://www.zhipin.com/web/geek/jobs" }
  });
  const response = await send({ type: "openManualChatTab" });
  assert.equal(response.ok, true);

  if (existingChatTab) {
    assert.equal(response.reused, true);
    assert.equal(createdTabs.length, 0);
    assert.equal(duplicatedTabs.length, 0);
    const focusUpdate = updatedTabs.find((entry) => entry.changes.active === true);
    assert.ok(focusUpdate);
    assert.equal(focusUpdate.tabId, existingChatTab.id);
    assert.equal(focusedWindows.length, 1);
    assert.equal(focusedWindows[0].windowId, existingChatTab.windowId);
    assert.equal(focusedWindows[0].changes.focused, true);
  } else {
    assert.equal(response.reused, false);
    assert.equal(createdTabs.length, 1);
    assert.equal(duplicatedTabs.length, 0);
    assert.equal(createdTabs[0].url, "https://www.zhipin.com/web/geek/chat");
    assert.equal(createdTabs[0].active, true);
    assert.equal(createdTabs[0].windowId, senderTab.windowId);
    assert.equal(createdTabs[0].index, senderTab.index + 1);
    assert.equal(updatedTabs.some((entry) => entry.changes.url), false);
  }

  const rejected = await send({ type: "openManualChatTab" }, { id: 8, windowId: 3, index: 5 });
  assert.equal(rejected.ok, false);
}

(async () => {
  await runNavigationScenario(false);
  await runNavigationScenario(true);
  await runNavigationScenario(false, "https://www.zhipin.com/web/geek/resume");
  await runManualChatScenario();
  await runManualChatScenario({ id: 44, windowId: 6, url: "https://www.zhipin.com/web/geek/chat" });
  console.log("Dual-tab navigation isolation tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

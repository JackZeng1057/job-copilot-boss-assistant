// 验证职位页与聊天页的会话归属、切换和导航边界。
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = require("./helpers/extension-source").backgroundSource();

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

async function runNavigationScenario(contactInFlight, targetUrl = "https://www.zhipin.com/web/geek/chat", options = {}) {
  const isDetailEscape = /\/job_detail\//.test(targetUrl);
  const isChatEscape = /\/web\/geek\/chat/.test(targetUrl);
  const isProtectedEscape = isDetailEscape || isChatEscape;
  const local = createStorageArea();
  const session = createStorageArea();
  let messageListener = null;
  let updatedListener = null;
  const createdTabs = [];
  const updatedTabs = [];
  const historyBackTabs = [];
  const jobsUrl = "https://www.zhipin.com/web/geek/jobs?query=test";
  let currentTabUrl = options.currentTabUrl || targetUrl;
  let currentTabReadIndex = 0;
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
    get(tabId, callback) {
      const sequencedUrl = options.currentTabUrls?.[currentTabReadIndex];
      currentTabReadIndex += 1;
      callback({ id: tabId, url: sequencedUrl || currentTabUrl });
    },
    goBack(tabId, callback) {
      historyBackTabs.push(tabId);
      if (options.goBackFails) runtime.lastError = { message: "No page in history" };
      else currentTabUrl = jobsUrl;
      callback();
      runtime.lastError = null;
    },
    sendMessage(_tabId, _message, callback) { callback({ ok: true }); }
  };

  vm.runInNewContext(source, {
    chrome: { runtime, storage: { local, session }, tabs },
    console,
    fetch: async () => { throw new Error("fetch should not run"); },
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 2)),
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
      jobsUrl,
      fingerprint: "fixture",
      analyses: {},
      progress: { [jobKey]: { status: "contacting", detail: "" } },
      completedJobKeys: ["job:previous"],
      batchNumber: 3,
      batchKeys: [jobKey],
      batchSize: 15,
      batchWaitRemainingMs: 42000,
      waitingForNextBatch: true,
      loadingNextBatch: false,
      contactInFlight,
      currentJobKey: contactInFlight ? jobKey : ""
    }
  });

  updatedListener(7, { url: targetUrl });
  await new Promise((resolve) => setTimeout(resolve, isProtectedEscape ? 100 : 20));

  assert.equal(createdTabs.length, 0);
  assert.equal(updatedTabs[0].changes.autoDiscardable, false);

  const saved = session.values.jobCopilotAutomationSessionV1;
  assert.equal(saved.batchNumber, 3);
  assert.deepEqual(Array.from(saved.batchKeys), [jobKey]);
  assert.equal(saved.batchSize, 15);
  assert.equal(saved.batchWaitRemainingMs, 42000);
  assert.equal(saved.waitingForNextBatch, true);
  assert.equal(saved.loadingNextBatch, false);
  const expectHistoryBack = options.expectHistoryBack ?? isProtectedEscape;
  assert.equal(historyBackTabs.length, expectHistoryBack ? 1 : 0,
    expectHistoryBack
      ? "a detail/chat SPA escape must be restored with browser history"
      : "unrelated navigation must not drive browser history");
  const fallbackUpdates = updatedTabs.filter((entry) => entry.changes.url);
  if (options.expectJobsUrlFallback) {
    assert.equal(fallbackUpdates.length, 1,
      "a replace-route escape with no browser history must recover the protected jobs URL in the same tab");
    assert.equal(fallbackUpdates[0].changes.url, jobsUrl);
  } else {
    assert.equal(fallbackUpdates.length, 0,
      "the extension must never reload a saved jobs URL during route recovery");
  }
  assert.deepEqual(Array.from(saved.completedJobKeys), ["job:previous"]);
  assert.equal(saved.active, isProtectedEscape ? true : false);
  assert.equal(saved.paused, true);
  assert.match(saved.status, /暂停/);
  if (contactInFlight) {
    assert.equal(saved.contactInFlight, false);
    assert.equal(saved.currentJobKey, "",
      "clearing the in-flight marker must also release its paired job key");
    assert.equal(saved.progress[jobKey].status, "attention");
  }
  const discardUpdate = updatedTabs.filter((entry) => "autoDiscardable" in entry.changes).at(-1);
  assert.equal(discardUpdate?.changes.autoDiscardable, isProtectedEscape ? false : true);
}

async function runInactiveProtectedJobsTabScenario() {
  const local = createStorageArea();
  const session = createStorageArea();
  let messageListener = null;
  let updatedListener = null;
  const historyBackTabs = [];
  let currentTabUrl = "https://www.zhipin.com/web/geek/chat";
  const tabs = {
    onUpdated: { addListener(listener) { updatedListener = listener; } },
    onRemoved: { addListener() {} },
    update(_tabId, changes, callback) { callback({ id: 12, ...changes }); },
    get(tabId, callback) { callback({ id: tabId, url: currentTabUrl }); },
    goBack(tabId, callback) {
      historyBackTabs.push(tabId);
      currentTabUrl = "https://www.zhipin.com/web/geek/jobs";
      callback();
    },
    sendMessage(_tabId, _message, callback) { callback({ ok: true }); }
  };
  vm.runInNewContext(source, {
    chrome: {
      runtime: { lastError: null, onMessage: { addListener(listener) { messageListener = listener; } } },
      storage: { local, session },
      tabs
    },
    console,
    fetch: async () => { throw new Error("fetch should not run"); },
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 2)),
    clearTimeout,
    URL
  });
  const send = (message) => new Promise((resolve) => {
    assert.equal(messageListener(message, {
      tab: { id: 12, url: "https://www.zhipin.com/web/geek/jobs", windowId: 3 }
    }, resolve), true);
  });
  const protectedResponse = await send({ type: "protectJobsTab" });
  assert.equal(protectedResponse.ok, true);
  updatedListener(12, { url: "https://www.zhipin.com/web/geek/chat" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(historyBackTabs, [12],
    "message routing must be reversed even before automation starts");
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

  const senderTab = {
    id: 7,
    windowId: 3,
    index: 4,
    url: "https://www.zhipin.com/web/geek/jobs"
  };
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
  await runNavigationScenario(false, "https://www.zhipin.com/job_detail/abc.html", {
    expectHistoryBack: true
  });
  await runNavigationScenario(false, "https://www.zhipin.com/web/geek/chat", {
    currentTabUrls: [
      "https://www.zhipin.com/web/geek/jobs?query=test",
      "https://www.zhipin.com/web/geek/chat",
      "https://www.zhipin.com/web/geek/jobs?query=test",
      "https://www.zhipin.com/web/geek/jobs?query=test"
    ],
    expectHistoryBack: true
  });
  await runNavigationScenario(false, "https://www.zhipin.com/web/geek/chat", {
    goBackFails: true,
    expectHistoryBack: true
  });
  await runNavigationScenario(false, "https://www.zhipin.com/web/geek/chat", {
    currentTabUrl: "https://www.zhipin.com/job_detail/route-changed-during-recovery.html",
    expectHistoryBack: true
  });
  await runInactiveProtectedJobsTabScenario();
  await runNavigationScenario(false, "https://www.zhipin.com/job_detail/abc.html", {
    currentTabUrl: "https://www.zhipin.com/web/geek/jobs?query=test",
    expectHistoryBack: false
  });
  await runManualChatScenario();
  await runManualChatScenario({ id: 44, windowId: 6, url: "https://www.zhipin.com/web/geek/chat" });
  console.log("Current-tab navigation boundary tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

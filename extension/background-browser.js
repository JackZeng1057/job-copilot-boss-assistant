// Chrome 回调接口适配；必须在回调内读取 runtime.lastError。
function createTab(options) {
  return browserCall((callback) => chrome.tabs.create(options, callback));
}

function queryTabs(queryInfo) {
  return browserCall((callback) => chrome.tabs.query(queryInfo, callback))
    .then((tabs) => Array.isArray(tabs) ? tabs : []);
}

function debuggerAttach(target) {
  return browserCall((callback) => chrome.debugger.attach(target, "1.3", callback));
}

function debuggerSendCommand(target, method, params = {}) {
  return browserCall((callback) => chrome.debugger.sendCommand(target, method, params, callback));
}

function debuggerDetach(target) {
  return browserCall((callback) => chrome.debugger.detach(target, callback));
}

function goBackTab(tabId) {
  return browserCall((callback) => chrome.tabs.goBack(tabId, callback));
}

function focusWindow(windowId) {
  if (!Number.isInteger(windowId) || !chrome.windows?.update) return Promise.resolve();
  return new Promise((resolve) => chrome.windows.update(windowId, { focused: true }, () => {
    consumeRuntimeLastError();
    resolve();
  }));
}

function updateTab(tabId, changes) {
  return browserCall((callback) => chrome.tabs.update(tabId, changes, callback));
}

function getTab(tabId) {
  return browserCall((callback) => chrome.tabs.get(tabId, callback));
}

function setTabAutoDiscardable(tabId, autoDiscardable) {
  if (!Number.isInteger(tabId) || !chrome.tabs?.update) return Promise.resolve(false);
  return new Promise((resolve) => chrome.tabs.update(tabId, { autoDiscardable }, () => {
    resolve(!consumeRuntimeLastError());
  }));
}

function isMissingTabError(error) {
  return /no tab with id|tab not found|invalid tab id/i.test(String(error?.message || error || ""));
}

// 统一传播回调错误；invoke 放在 Promise 内，同步抛错也会变成拒绝结果。
function browserCall(invoke) {
  return new Promise((resolve, reject) => invoke((result) => {
    const error = consumeRuntimeLastError();
    if (error) reject(new Error(error.message));
    else resolve(result);
  }));
}

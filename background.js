// 后台入口：同步加载依赖后注册事件，确保 worker 每次唤醒都能接收消息。
importScripts(
  "background-state.js",
  "background-session.js",
  "background-contact.js",
  "background-navigation.js",
  "background-browser.js",
  "background-analysis.js",
  "background-ai-usage.js",
  "background-ai-chat.js",
  "background-ai-providers.js",
  "background-ai-endpoints.js",
  "background-ai-prompt.js",
  "background-ai-json.js"
);

function consumeRuntimeLastError() {
  return chrome.runtime?.lastError || null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "analyzeJob") {
    analyzeJob(message.payload)
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type === "getSettings") {
    getSettings()
      // 页面仅接收运行所需设置；API 凭证和简历正文留在扩展内部。
      .then((settings) => sendResponse({ ok: true, settings: publicRuntimeSettings(settings) }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type === "registerAutomationSession") {
    const tabId = sender.tab?.id;
    saveAutomationSession({
      ...sanitizeAutomationSession(message.session),
      tabId,
      active: true,
      updatedAt: Date.now()
    }).then(async (session) => {
      await setTabAutoDiscardable(tabId, false);
      sendResponse({ ok: true, session });
    }).catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type === "protectJobsTab") {
    registerJobsTabGuard(sender.tab)
      .then((guard) => sendResponse({ ok: true, guard }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type === "updateAutomationSession") {
    mergeAutomationSession(sender.tab?.id, message.patch)
      .then(async (session) => {
        if (session && sender.tab?.id) {
          await setTabAutoDiscardable(sender.tab.id, session.active === false);
        }
        sendResponse({ ok: true, session });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type === "getAutomationSession") {
    getAutomationSession().then((session) => sendResponse({
      ok: true,
      session,
      isOwner: Boolean(session?.tabId && session.tabId === sender.tab?.id)
    })).catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type === "focusAutomationTab") {
    focusAutomationTab()
      .then((ok) => sendResponse({ ok }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type === "openManualChatTab") {
    openOrFocusManualChatTab(sender.tab)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type === "dispatchTrustedContactClick") {
    dispatchTrustedContactClick(sender.tab, message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type === "communicateInIsolatedTab") {
    // 拒绝旧版的详情页自动沟通请求，防止重新引入独立投递标签。
    sendResponse({ ok: false, error: "isolated_detail_tabs_disabled" });
    return false;
  }
  if (message?.type === "controlAutomationTab") {
    controlAutomationTab(message.action)
      .then((ok) => sendResponse({ ok }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  if (message?.type === "appendAutomationLog") {
    appendAutomationLog(message.entry, sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }
  return false;
});

if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) return;
    handleAutomationTabNavigation(tabId, changeInfo.url).catch(() => {});
  });
}

if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    clearAutomationSessionForTab(tabId).catch(() => {});
    clearJobsTabGuard(tabId).catch(() => {});
  });
}

if (chrome.idle?.onStateChanged) {
  chrome.idle.setDetectionInterval(IDLE_DETECTION_INTERVAL_SECONDS);
  chrome.idle.onStateChanged.addListener((state) => {
    handleMachineIdleState(state).catch(() => {});
  });
  chrome.idle.queryState?.(IDLE_DETECTION_INTERVAL_SECONDS)
    .then((state) => handleMachineIdleState(state))
    .catch(() => {});
}

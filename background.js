const DEFAULT_SETTINGS = {
  aiProvider: "deepseek",
  apiProtocol: "openai_chat",
  apiAuthType: "bearer",
  apiBaseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-v4-flash",
  analysisSpeed: "fast",
  minScore: 60,
  autoRunOnJobsPage: false,
  restrictTargetLocation: false,
  profile: "default",
  currentLocation: "",
  experienceYears: "",
  graduateStatus: "unspecified",
  targetDirections: "",
  excludedDirections: "",
  customInstructions: "",
  greetingStyle: "简洁、真诚，突出匹配经历和到岗意愿。",
  resumeDefault: "",
  resumeAltA: "",
  resumeAltB: ""
};

const AUTOMATION_SESSION_KEY = "jobCopilotAutomationSessionV1";
const AUTOMATION_LOG_KEY = "jobCopilotAutomationLogV1";
const JOBS_TAB_GUARD_KEY = "jobCopilotJobsTabGuardV1";
const AUTOMATION_LOG_LIMIT = 200;
const IDLE_DETECTION_INTERVAL_SECONDS = 60;
const AI_REQUEST_TIMEOUT_MS = 60000;
// Anthropic Messages requires max_tokens. Other supported protocols use the
// provider/model default so this extension does not impose a universal cap.
const ANTHROPIC_REQUIRED_MAX_OUTPUT_TOKENS = 16384;
const MAX_STORED_ANALYSES = 50;
const MAX_RESUME_INPUT_CHARS = 16000;
const MAX_JOB_DESCRIPTION_INPUT_CHARS = 7000;
const ISOLATED_CONTACT_READY_TIMEOUT_MS = 15000;
const ISOLATED_CONTACT_ACTION_TIMEOUT_MS = 30000;
const OWNER_ROUTE_RECOVERY_CHECKPOINTS_MS = [300, 700, 1500, 3000];
const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    decision: { type: "string", enum: ["recommend", "manual_review", "skip"] },
    excluded: { type: "boolean" },
    exclusion_match: { type: "string" },
    exclusion_reason: { type: "string" },
    occupation_family: { type: "string" },
    target_alignment: { type: "string", enum: ["direct", "transferable", "unrelated", "unclear"] },
    reasons: { type: "array", items: { type: "string" }, maxItems: 3 },
    risks: { type: "array", items: { type: "string" }, maxItems: 2 },
    location_fit: { type: "string", enum: ["good", "acceptable", "unclear", "poor"] },
    greeting: { type: "string" }
  },
  required: [
    "score", "decision", "excluded", "exclusion_match", "exclusion_reason",
    "occupation_family", "target_alignment", "reasons", "risks", "location_fit", "greeting"
  ]
};
const automationStorage = chrome.storage.session || chrome.storage.local;
const disposableContactTabIds = new Set();
const ownerRouteRecoveryTabIds = new Set();
const unsupportedReasoningCapabilityKeys = new Set();

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
      // The page-side controller only needs non-sensitive runtime choices.
      // Keep API credentials and resume contents inside the service worker.
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
  if (message?.type === "communicateInIsolatedTab") {
    // 0.9.5 no longer permits a job-detail tab for automatic communication.
    // The content script uses a hidden same-origin frame on the owner jobs
    // page; reject stale callers instead of silently reintroducing a tab.
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

function storageGet(area, keys) {
  return new Promise((resolve) => area.get(keys, (items) => {
    if (consumeRuntimeLastError()) resolve({});
    else resolve(items && typeof items === "object" ? items : {});
  }));
}

function storageSet(area, values) {
  return new Promise((resolve) => area.set(values, () => {
    consumeRuntimeLastError();
    resolve();
  }));
}

function storageRemove(area, keys) {
  return new Promise((resolve) => area.remove(keys, () => {
    consumeRuntimeLastError();
    resolve();
  }));
}

async function getAutomationSession() {
  const items = await storageGet(automationStorage, AUTOMATION_SESSION_KEY);
  const session = items[AUTOMATION_SESSION_KEY];
  return session && typeof session === "object" ? session : null;
}

async function saveAutomationSession(session) {
  const safeSession = sanitizeAutomationSession(session);
  await storageSet(automationStorage, { [AUTOMATION_SESSION_KEY]: safeSession });
  return safeSession;
}

async function getJobsTabGuards() {
  const items = await storageGet(automationStorage, JOBS_TAB_GUARD_KEY);
  const value = items[JOBS_TAB_GUARD_KEY];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function registerJobsTabGuard(tab) {
  if (!Number.isInteger(tab?.id) || !isAutomationJobsUrl(tab?.url || "")) {
    throw new Error("只能保护 BOSS 职位列表标签");
  }
  const guards = await getJobsTabGuards();
  guards[String(tab.id)] = {
    tabId: tab.id,
    jobsUrl: String(tab.url).slice(0, 500),
    updatedAt: Date.now()
  };
  const bounded = Object.fromEntries(Object.entries(guards).slice(-20));
  await storageSet(automationStorage, { [JOBS_TAB_GUARD_KEY]: bounded });
  return bounded[String(tab.id)];
}

async function getJobsTabGuard(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const guards = await getJobsTabGuards();
  return guards[String(tabId)] || null;
}

async function clearJobsTabGuard(tabId) {
  const guards = await getJobsTabGuards();
  if (!guards[String(tabId)]) return false;
  delete guards[String(tabId)];
  await storageSet(automationStorage, { [JOBS_TAB_GUARD_KEY]: guards });
  return true;
}

async function mergeAutomationSession(tabId, patch) {
  const current = await getAutomationSession();
  if (!current || !tabId || current.tabId !== tabId) return current;
  return saveAutomationSession({
    ...current,
    ...sanitizeAutomationSession(patch),
    tabId,
    updatedAt: Date.now()
  });
}

function sanitizeAutomationSession(value) {
  if (!value || typeof value !== "object") return {};
  const safe = {};
  const allowed = [
    "tabId", "active", "paused", "mode", "jobsUrl", "fingerprint", "analyses", "progress",
    "summary", "status", "contactInFlight", "currentJobKey", "dismissedJobKeys", "completedJobKeys",
    "pauseReason", "phase",
    "batchNumber", "batchKeys", "batchSize", "batchWaitRemainingMs",
    "waitingForNextBatch", "loadingNextBatch", "updatedAt", "autoPausedByIdle"
  ];
  for (const key of allowed) {
    if (value[key] === undefined) continue;
    safe[key] = key === "analyses" ? sanitizeStoredAnalyses(value[key]) : value[key];
  }
  return safe;
}

function sanitizeStoredAnalyses(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).slice(-MAX_STORED_ANALYSES);
  return Object.fromEntries(entries.map(([key, analysis]) => [String(key).slice(0, 160), {
    score: clampScore(analysis?.score),
    decision: String(analysis?.decision || "manual_review").slice(0, 24),
    excluded: analysis?.excluded === true,
    exclusion_match: String(analysis?.exclusion_match || "").slice(0, 80),
    occupation_family: String(analysis?.occupation_family || "").slice(0, 80)
  }]));
}

async function appendAutomationLog(entry, tabId) {
  const items = await storageGet(chrome.storage.local, AUTOMATION_LOG_KEY);
  const current = Array.isArray(items[AUTOMATION_LOG_KEY]) ? items[AUTOMATION_LOG_KEY] : [];
  const safeEntry = {
    time: new Date().toISOString(),
    tabId: Number(tabId || entry?.tabId || 0),
    event: String(entry?.event || "unknown").slice(0, 80),
    title: String(entry?.title || "").slice(0, 80),
    page: String(entry?.page || "").slice(0, 200),
    detail: String(entry?.detail || "").slice(0, 300)
  };
  await storageSet(chrome.storage.local, {
    [AUTOMATION_LOG_KEY]: current.concat(safeEntry).slice(-AUTOMATION_LOG_LIMIT)
  });
}

async function focusAutomationTab() {
  const session = await getAutomationSession();
  if (!session?.tabId) return false;
  try {
    await updateTab(session.tabId, { active: true });
    return true;
  } catch (error) {
    if (!isMissingTabError(error)) throw error;
    await clearAutomationSessionForTab(session.tabId);
    return false;
  }
}

async function clearAutomationSessionForTab(tabId) {
  const session = await getAutomationSession();
  if (!session?.tabId || session.tabId !== tabId) return false;
  await storageRemove(automationStorage, AUTOMATION_SESSION_KEY);
  await setTabAutoDiscardable(tabId, true);
  return true;
}

async function openOrFocusManualChatTab(senderTab) {
  const session = await getAutomationSession();
  const ownsActiveSession = Boolean(session?.active && session.tabId === senderTab?.id);
  const isJobPage = isAutomationJobsUrl(senderTab?.url || "");
  if (!senderTab?.id || (!ownsActiveSession && !isJobPage)) {
    throw new Error("当前标签不是 BOSS 职位页");
  }
  await registerJobsTabGuard(senderTab);

  const chatTabs = await queryTabs({
    url: ["https://www.zhipin.com/web/geek/chat*"],
    windowId: senderTab.windowId
  });
  const existing = chatTabs.find((tab) => tab.id
    && tab.id !== senderTab.id
    && !disposableContactTabIds.has(tab.id));
  if (existing) {
    try {
      await updateTab(existing.id, { active: true });
      await focusWindow(existing.windowId);
      await appendAutomationLog({
        event: "manual_chat_tab_focused",
        page: existing.url || "https://www.zhipin.com/web/geek/chat"
      }, senderTab.id);
      return { tabId: existing.id, reused: true };
    } catch (error) {
      if (!isMissingTabError(error)) throw error;
      // The queried tab was closed before it could be focused. Fall through
      // and create a fresh companion tab instead of surfacing an error.
    }
  }

  // Create a dedicated tab directly. Never duplicate or navigate the jobs tab:
  // Edge may visually activate the duplicate before its URL changes, making a
  // manual message click look like the original jobs document was replaced.
  const chatTab = await createTab({
    url: "https://www.zhipin.com/web/geek/chat",
    active: true,
    windowId: senderTab.windowId,
    index: Number.isInteger(senderTab.index) ? senderTab.index + 1 : undefined
  });
  if (!chatTab?.id) throw new Error("无法创建消息标签");
  await appendAutomationLog({
    event: "manual_chat_tab_opened",
    page: chatTab?.url || "https://www.zhipin.com/web/geek/chat"
  }, senderTab.id);
  return { tabId: chatTab.id, reused: false };
}

async function communicateInIsolatedTab(senderTab, job) {
  if (!senderTab?.id || !isAutomationJobsUrl(senderTab.url || "")) {
    throw new Error("只能从 BOSS 职位页发起隔离沟通");
  }
  await registerJobsTabGuard(senderTab);
  const workerUrl = isolatedContactUrl(job?.url);
  const worker = await createTab({
    url: workerUrl,
    active: false,
    windowId: senderTab.windowId,
    openerTabId: senderTab.id,
    index: Number.isInteger(senderTab.index) ? senderTab.index + 1 : undefined
  });
  if (!worker?.id) throw new Error("无法创建后台沟通标签");
  if (worker.id === senderTab.id) throw new Error("后台沟通标签身份异常，已停止以保护职位页");
  disposableContactTabIds.add(worker.id);
  await setTabAutoDiscardable(worker.id, false);
  await appendAutomationLog({
    event: "isolated_contact_tab_opened",
    title: job?.title,
    page: workerUrl,
    detail: `ownerTab=${senderTab.id};workerTab=${worker.id};active=false`
  }, senderTab.id);

  try {
    const ready = await waitForIsolatedContactReady(worker.id, ISOLATED_CONTACT_READY_TIMEOUT_MS);
    if (!ready) throw new Error("后台沟通页面加载超时");

    const response = await sendTabMessageWithTimeout(worker.id, {
      type: "performIsolatedCommunication",
      expectedJob: {
        key: String(job?.key || ""),
        title: String(job?.title || ""),
        company: String(job?.company || ""),
        url: workerUrl
      }
    }, ISOLATED_CONTACT_ACTION_TIMEOUT_MS);

    let status = response?.ok ? String(response.status || "") : "";
    if (!status) {
      const current = await getTab(worker.id).catch(() => null);
      if (isBossChatUrl(current?.url || "")) status = "navigated_chat";
    }
    if (!status) throw new Error(response?.error || "后台沟通未返回结果");

    await appendAutomationLog({
      event: `isolated_contact_${status}`,
      title: job?.title,
      page: workerUrl,
      detail: `ownerStayed=true;workerTab=${worker.id}`
    }, senderTab.id);
    return { status };
  } finally {
    await setTabAutoDiscardable(worker.id, true);
    await removeDisposableContactTab(worker.id, senderTab.id);
  }
}

async function removeDisposableContactTab(workerTabId, ownerTabId) {
  if (!disposableContactTabIds.has(workerTabId) || workerTabId === ownerTabId) return false;
  const tab = await getTab(workerTabId).catch(() => null);
  if (!tab || tab.id !== workerTabId || tab.openerTabId !== ownerTabId) return false;
  if (isAutomationJobsUrl(tab.url || "")) return false;
  disposableContactTabIds.delete(workerTabId);
  await removeTab(workerTabId).catch(() => {});
  return true;
}

async function waitForIsolatedContactReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await sendTabMessageWithTimeout(tabId, {
      type: "inspectIsolatedCommunicationResult"
    }, 1200);
    if (response?.ok && response.ready) return true;
    const tab = await getTab(tabId).catch(() => null);
    if (!tab) return false;
    await delay(250);
  }
  return false;
}

function sendTabMessageWithTimeout(tabId, message, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "后台沟通动作超时" }), timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = consumeRuntimeLastError();
      if (error) finish({ ok: false, error: error.message });
      else finish(response || { ok: false, error: "后台沟通页面没有响应" });
    });
  });
}

function isolatedContactUrl(value) {
  const url = new URL(String(value || ""), "https://www.zhipin.com");
  if (url.hostname !== "www.zhipin.com" || !/\/job_detail\//.test(url.pathname)) {
    throw new Error("岗位缺少可用的 BOSS 详情链接");
  }
  return url.href;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function controlAutomationTab(action) {
  const session = await getAutomationSession();
  if (!session?.tabId) return false;
  // A manual command takes ownership of the pause state. The next machine
  // "active" event must not undo a pause explicitly requested by the user.
  if (session.autoPausedByIdle) {
    await saveAutomationSession({
      ...session,
      autoPausedByIdle: false,
      updatedAt: Date.now()
    });
  }
  const sent = await sendAutomationControl(session.tabId, action, "manual");
  if (sent && ["pause", "resume"].includes(action)) {
    await appendAutomationLog({
      event: action === "pause" ? "automation_paused_manual" : "automation_resumed_manual",
      page: session.jobsUrl,
      detail: "source=remote_panel"
    }, session.tabId);
  }
  return sent;
}

function sendAutomationControl(tabId, action, reason) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "automationControl", action, reason }, () => {
      const error = consumeRuntimeLastError();
      resolve(!error);
    });
  });
}

async function handleMachineIdleState(state) {
  if (!["active", "idle", "locked"].includes(state)) return false;
  const session = await getAutomationSession();
  if (!session?.active || !session.tabId) return false;

  // chrome.idle reports "idle" after the configured period without physical
  // keyboard or mouse input. That does not mean the display is off or the
  // computer is asleep, so watching an automation run must not pause it.
  if (state === "idle") return false;

  if (state === "active") {
    if (!session.autoPausedByIdle) return false;
    const resumed = await saveAutomationSession({
      ...session,
      paused: false,
      autoPausedByIdle: false,
      status: "电脑恢复使用，自动投递正在继续。",
      updatedAt: Date.now()
    });
    await sendAutomationControl(resumed.tabId, "resume", "machine_active");
    await appendAutomationLog({
      event: "automation_resumed_after_lock",
      page: resumed.jobsUrl,
      detail: "machine_state=active"
    }, resumed.tabId);
    return true;
  }

  // Respect a manual pause. Only runs paused by this handler may be resumed
  // automatically when the machine becomes active again.
  if (session.paused || session.autoPausedByIdle) return false;
  const paused = await saveAutomationSession({
    ...session,
    paused: true,
    autoPausedByIdle: true,
    status: "电脑已锁定，自动投递将在当前步骤结束后暂停。",
    updatedAt: Date.now()
  });
  await sendAutomationControl(paused.tabId, "pause", "machine_locked");
  await appendAutomationLog({
    event: "automation_paused_for_lock",
    page: paused.jobsUrl,
    detail: `machine_state=${state}`
  }, paused.tabId);
  return true;
}

async function handleAutomationTabNavigation(tabId, url) {
  const session = await getAutomationSession();
  const guard = await getJobsTabGuard(tabId);
  const ownsActiveSession = Boolean(session?.active && session.tabId === tabId && session.jobsUrl);
  if (!ownsActiveSession && !guard) return;
  if (isAutomationJobsUrl(url)) return;

  const enteredChat = isBossChatUrl(url);
  const enteredDetail = isBossJobDetailUrl(url);
  if (enteredChat || enteredDetail) {
    if (ownerRouteRecoveryTabIds.has(tabId)) return;
    ownerRouteRecoveryTabIds.add(tabId);
    if (ownsActiveSession) {
      const progress = { ...(session.progress || {}) };
      if (session.contactInFlight && session.currentJobKey) {
        progress[session.currentJobKey] = {
          status: "attention",
          detail: "职位标签异常进入消息/详情路由，已自动恢复并暂停",
          updatedAt: Date.now()
        };
      }
      await saveAutomationSession({
        ...session,
        active: true,
        paused: true,
        progress,
        contactInFlight: false,
        status: enteredChat
          ? "职位标签误入消息页，已自动后退并暂停；消息页必须使用独立标签。"
          : "读取 JD 时职位标签误入详情页，已自动后退并暂停；请确认职位列表恢复后再继续。",
        updatedAt: Date.now()
      });
      await sendAutomationControl(tabId, "pause", enteredChat
        ? "owner_chat_route"
        : "owner_job_detail_route");
    }
    // BOSS can schedule another router write after the first apparent recovery.
    // Keep checking through a stability window instead of trusting one 300 ms
    // snapshot. At most one history.back() is issued for this escape so the
    // original jobs list cannot be skipped by competing recovery paths.
    try {
      const protectedJobsUrl = session?.jobsUrl || guard?.jobsUrl || "";
      const recovery = await stabilizeProtectedJobsRoute(tabId, protectedJobsUrl);
      await appendAutomationLog({
        event: enteredChat ? "owner_chat_route_restored" : "owner_job_detail_route_restored",
        page: url,
        detail: `restore=${recovery.jobsUrlFallback ? "background_jobs_url_fallback" : (recovery.historyBack ? "background_history.back" : "content_guard")};stable=${recovery.stable};final=${recovery.finalUrl};from=${protectedJobsUrl};automation=${ownsActiveSession ? "paused" : "inactive"}`
      }, tabId);
    } finally {
      ownerRouteRecoveryTabIds.delete(tabId);
    }
    return;
  }

  if (!ownsActiveSession) return;

  // Navigation unrelated to the one in-flight communication click remains a
  // hard boundary. Never drive browser history or reload the saved jobs URL:
  // doing so can destroy BOSS's in-memory filters and the current result list.
  const progress = { ...(session.progress || {}) };
  if (session.contactInFlight && session.currentJobKey) {
    progress[session.currentJobKey] = {
      status: "attention",
      detail: "BOSS 异常离开职位页，自动投递已暂停",
      updatedAt: Date.now()
    };
  }
  await saveAutomationSession({
    ...session,
    active: false,
    paused: true,
    progress,
    contactInFlight: false,
    currentJobKey: "",
    status: isBossChatUrl(url)
      ? "职位标签意外进入消息页，自动投递已暂停。"
      : "职位标签已离开职位页，自动投递已暂停；页面不会被自动刷新。",
    updatedAt: Date.now()
  });
  await setTabAutoDiscardable(tabId, true);
  await appendAutomationLog({
    event: "automation_tab_navigation_paused",
    page: url,
    detail: `restore=none;from=${session.jobsUrl};enteredChat=${isBossChatUrl(url)}`
  }, tabId);
}

async function stabilizeProtectedJobsRoute(tabId, protectedJobsUrl = "") {
  let historyBack = false;
  let historyBackAttempted = false;
  let jobsUrlFallback = false;
  let finalUrl = "";
  let consecutiveJobsChecks = 0;
  for (const checkpointMs of OWNER_ROUTE_RECOVERY_CHECKPOINTS_MS) {
    await delay(checkpointMs);
    const currentTab = await getTab(tabId).catch(() => null);
    finalUrl = String(currentTab?.url || "");
    const escaped = isBossChatUrl(finalUrl) || isBossJobDetailUrl(finalUrl);
    if (escaped) {
      consecutiveJobsChecks = 0;
      if (!historyBackAttempted) {
        historyBackAttempted = true;
        historyBack = await goBackTab(tabId).then(() => true).catch(() => false);
      }
      continue;
    }
    if (isAutomationJobsUrl(finalUrl)) consecutiveJobsChecks += 1;
    else consecutiveJobsChecks = 0;
  }
  // Never reload the saved jobs URL as a recovery fallback. A reload destroys
  // BOSS's in-memory result list and filters. The main-world Navigation API
  // guard prevents new escapes; if a legacy browser still escapes and cannot
  // go back, leave the session paused without mutating the tab again.
  return {
    historyBack,
    historyBackAttempted,
    jobsUrlFallback,
    finalUrl,
    stable: consecutiveJobsChecks >= 2 && isAutomationJobsUrl(finalUrl)
  };
}

function isBossChatUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.zhipin.com" && /\/web\/geek\/chat(?:[/?#]|$)/.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

function isBossJobDetailUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.zhipin.com" && /\/job_detail\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isAutomationJobsUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.zhipin.com") return false;
    // Only list/recommend routes may own an automation session. A job detail
    // route means the dedicated jobs tab has departed and must be paused.
    return /\/web\/geek\/(?:jobs?|recommend)(?:[/?#]|$)/.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

function createTab(options) {
  return new Promise((resolve, reject) => chrome.tabs.create(options, (tab) => {
    const error = consumeRuntimeLastError();
    if (error) reject(new Error(error.message));
    else resolve(tab);
  }));
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => chrome.tabs.query(queryInfo, (tabs) => {
    const error = consumeRuntimeLastError();
    if (error) reject(new Error(error.message));
    else resolve(Array.isArray(tabs) ? tabs : []);
  }));
}

function goBackTab(tabId) {
  return new Promise((resolve, reject) => chrome.tabs.goBack(tabId, () => {
    const error = consumeRuntimeLastError();
    if (error) reject(new Error(error.message));
    else resolve();
  }));
}

function focusWindow(windowId) {
  if (!Number.isInteger(windowId) || !chrome.windows?.update) return Promise.resolve();
  return new Promise((resolve) => chrome.windows.update(windowId, { focused: true }, () => {
    consumeRuntimeLastError();
    resolve();
  }));
}

function updateTab(tabId, changes) {
  return new Promise((resolve, reject) => chrome.tabs.update(tabId, changes, (tab) => {
    const error = consumeRuntimeLastError();
    if (error) reject(new Error(error.message));
    else resolve(tab);
  }));
}

function getTab(tabId) {
  return new Promise((resolve, reject) => chrome.tabs.get(tabId, (tab) => {
    const error = consumeRuntimeLastError();
    if (error) reject(new Error(error.message));
    else resolve(tab);
  }));
}

function removeTab(tabId) {
  return new Promise((resolve, reject) => chrome.tabs.remove(tabId, () => {
    const error = consumeRuntimeLastError();
    if (error) reject(new Error(error.message));
    else resolve();
  }));
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

async function analyzeJob(payload) {
  const startedAt = Date.now();
  const settings = await getSettings();
  const resumeText = payload.resumeText || resumeTextForProfile(settings, payload.resumeProfile);
  if (apiKeyRequired(settings) && !settings.apiKey) {
    return { ok: false, error: "请先在插件设置里填写当前 AI 服务商的 API Key" };
  }
  if (!resumeText.trim()) return { ok: false, error: "请先在插件设置里粘贴完整简历文本" };
  const prompt = buildAnalysisPrompt({
    resumeText,
    job: payload,
    settings,
    customInstructions: payload.customInstructions || buildCustomInstructions(settings),
    targetDirections: payload.targetDirections || settings.targetDirections,
    excludedDirections: payload.excludedDirections || settings.excludedDirections,
    currentLocation: payload.currentLocation || settings.currentLocation
  });
  const initialResponse = await callAi(settings, prompt, 0.3);
  if (initialResponse.truncated) {
    throw new Error(
      `AI 输出因 token 上限被截断（${initialResponse.finishReason || "unknown"}），已停止本岗位分析，请重试`
    );
  }
  const raw = initialResponse.text;
  let parsed;
  let repaired = false;
  let repairMethod = "none";
  try {
    const parsedResult = parseJsonWithDiagnostics(raw);
    parsed = parsedResult.value;
    repaired = parsedResult.repaired;
    repairMethod = parsedResult.repaired ? `local:${parsedResult.strategy}` : "none";
  } catch (firstError) {
    throw new Error(`AI 结构化输出不是合法 JSON，已停止本岗位分析且不会发起二次修复请求：${String(firstError?.message || firstError)}`);
  }
  validateAnalysisShape(parsed);
  const analysis = normalizeAnalysis(parsed);
  const usage = aggregateTokenUsage([initialResponse.usage]);
  return {
    ok: true,
    analysis,
    performance: {
      durationMs: Date.now() - startedAt,
      repaired,
      repairMethod,
      requestCount: Math.max(1, Number(initialResponse.requestCount) || 1),
      usage,
      analysisUsage: initialResponse.usage,
      repairUsage: null
    }
  };
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      if (consumeRuntimeLastError()) {
        resolve({ ...DEFAULT_SETTINGS, profile: ["default"] });
        return;
      }
      const stored = items && typeof items === "object" ? items : {};
      const settings = { ...DEFAULT_SETTINGS };
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (stored[key] !== undefined) settings[key] = stored[key];
      }
      settings.minScore = clampScore(settings.minScore);
      settings.profile = normalizeProfiles(stored.profile);
      settings.experienceYears = normalizeExperienceYears(settings.experienceYears);
      settings.graduateStatus = normalizeGraduateStatus(settings.graduateStatus);
      settings.analysisSpeed = normalizeAnalysisSpeed(settings.analysisSpeed);
      resolve(settings);
    });
  });
}

function publicRuntimeSettings(settings) {
  const allowed = [
    "minScore", "autoRunOnJobsPage", "restrictTargetLocation", "profile",
    "currentLocation", "experienceYears", "graduateStatus", "targetDirections",
    "excludedDirections", "customInstructions", "greetingStyle", "analysisSpeed"
  ];
  return Object.fromEntries(allowed.map((key) => [key, settings[key]]));
}

function resumeTextForProfile(settings, profile) {
  const profiles = normalizeProfiles(profile);
  const chunks = profiles
    .map((item) => resumeChunkForProfile(settings, item))
    .filter((chunk) => chunk.text.trim());
  if (chunks.length) {
    return chunks
      .map((chunk) => `【${chunk.label}】\n${chunk.text.trim()}`)
      .join("\n\n---\n\n");
  }
  return "";
}

function resumeChunkForProfile(settings, profile) {
  if (profile === "altA") return { label: "备选简历 A", text: settings.resumeAltA || "" };
  if (profile === "altB") return { label: "备选简历 B", text: settings.resumeAltB || "" };
  return { label: "主简历", text: settings.resumeDefault || "" };
}

function normalizeProfiles(profile) {
  const raw = (Array.isArray(profile) ? profile : [profile || "default"])
    .map((item) => item === "test" ? "altA" : item === "ops" ? "altB" : item);
  const allowed = ["default", "altA", "altB"];
  const profiles = raw.filter((item) => allowed.includes(item));
  return profiles.length ? profiles : ["default"];
}

function normalizeExperienceYears(value) {
  if (String(value ?? "").trim() === "") return "";
  const years = Number(value);
  if (!Number.isFinite(years)) return "";
  return Math.round(Math.max(0, Math.min(50, years)) * 10) / 10;
}

function normalizeGraduateStatus(value) {
  return ["graduate", "experienced"].includes(value) ? value : "unspecified";
}

function normalizeAnalysisSpeed(value) {
  return ["balanced", "accurate"].includes(value) ? value : "fast";
}

function emptyTokenUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    visibleOutputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    reported: false
  };
}

function normalizedTokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

function finalizeTokenUsage(value, reported = true) {
  const usage = { ...emptyTokenUsage(), ...value };
  usage.inputTokens = normalizedTokenCount(usage.inputTokens);
  usage.outputTokens = normalizedTokenCount(usage.outputTokens);
  usage.reasoningTokens = Math.min(
    usage.outputTokens,
    normalizedTokenCount(usage.reasoningTokens)
  );
  usage.visibleOutputTokens = value?.visibleOutputTokens === undefined
    ? Math.max(0, usage.outputTokens - usage.reasoningTokens)
    : normalizedTokenCount(value.visibleOutputTokens);
  usage.cachedInputTokens = normalizedTokenCount(usage.cachedInputTokens);
  usage.totalTokens = normalizedTokenCount(usage.totalTokens)
    || usage.inputTokens + usage.outputTokens;
  usage.reported = reported && [
    usage.inputTokens, usage.outputTokens, usage.totalTokens
  ].some((count) => count > 0);
  return usage;
}

function normalizeOpenAiTokenUsage(value, responses = false) {
  if (!value || typeof value !== "object") return emptyTokenUsage();
  const inputTokens = responses ? value.input_tokens : value.prompt_tokens;
  const outputTokens = responses ? value.output_tokens : value.completion_tokens;
  const inputDetails = responses ? value.input_tokens_details : value.prompt_tokens_details;
  const outputDetails = responses ? value.output_tokens_details : value.completion_tokens_details;
  return finalizeTokenUsage({
    inputTokens,
    outputTokens,
    reasoningTokens: outputDetails?.reasoning_tokens,
    cachedInputTokens: inputDetails?.cached_tokens,
    totalTokens: value.total_tokens
  });
}

function normalizeAnthropicTokenUsage(value) {
  if (!value || typeof value !== "object") return emptyTokenUsage();
  const cacheRead = normalizedTokenCount(value.cache_read_input_tokens);
  const cacheCreation = normalizedTokenCount(value.cache_creation_input_tokens);
  return finalizeTokenUsage({
    inputTokens: normalizedTokenCount(value.input_tokens) + cacheRead + cacheCreation,
    outputTokens: value.output_tokens,
    reasoningTokens: value.output_tokens_details?.thinking_tokens,
    cachedInputTokens: cacheRead
  });
}

function normalizeGeminiTokenUsage(value) {
  if (!value || typeof value !== "object") return emptyTokenUsage();
  const visibleOutputTokens = normalizedTokenCount(value.candidatesTokenCount);
  const reasoningTokens = normalizedTokenCount(value.thoughtsTokenCount);
  return finalizeTokenUsage({
    inputTokens: value.promptTokenCount,
    outputTokens: visibleOutputTokens + reasoningTokens,
    visibleOutputTokens,
    reasoningTokens,
    cachedInputTokens: value.cachedContentTokenCount,
    totalTokens: value.totalTokenCount
  });
}

function aggregateTokenUsage(values) {
  const reported = (Array.isArray(values) ? values : [])
    .filter((value) => value?.reported === true);
  if (!reported.length) return emptyTokenUsage();
  return finalizeTokenUsage(reported.reduce((total, usage) => ({
    inputTokens: total.inputTokens + normalizedTokenCount(usage.inputTokens),
    outputTokens: total.outputTokens + normalizedTokenCount(usage.outputTokens),
    visibleOutputTokens: total.visibleOutputTokens + normalizedTokenCount(usage.visibleOutputTokens),
    reasoningTokens: total.reasoningTokens + normalizedTokenCount(usage.reasoningTokens),
    cachedInputTokens: total.cachedInputTokens + normalizedTokenCount(usage.cachedInputTokens),
    totalTokens: total.totalTokens + normalizedTokenCount(usage.totalTokens)
  }), emptyTokenUsage()));
}

async function callAi(settings, content, _temperature, options = {}) {
  const protocol = normalizeApiProtocol(settings.apiProtocol);
  const requestedTokens = Number(options.maxOutputTokens);
  const maxOutputTokens = Number.isFinite(requestedTokens) && requestedTokens > 0
    ? Math.max(256, Math.round(requestedTokens))
    : null;
  if (protocol === "anthropic_messages") return callAnthropic(settings, content, maxOutputTokens);
  if (protocol === "gemini_generate_content") return callGemini(settings, content, maxOutputTokens);
  if (protocol === "openai_responses") return callOpenAiResponses(settings, content, maxOutputTokens);
  return callOpenAiCompatible(settings, content, protocol === "azure_openai", maxOutputTokens);
}

async function fetchAiResponse(endpoint, options, timeoutMs = AI_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(endpoint, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      throw new Error(`AI 请求超时：超过 ${seconds} 秒未完成，请稍后重试`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callOpenAiCompatible(settings, content, azure = false, maxOutputTokens = null) {
  const endpoint = azure
    ? exactApiEndpoint(settings.apiBaseUrl)
    : chatEndpoint(settings.apiBaseUrl);
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...apiAuthenticationHeaders(settings, azure ? "api-key" : settings.apiAuthType)
  };
  const outputBudget = openAiChatOutputBudget(endpoint, azure, maxOutputTokens);
  const reasoningCapabilityKey = aiReasoningCapabilityKey(settings, endpoint);
  const reasoningConfig = unsupportedReasoningCapabilityKeys.has(reasoningCapabilityKey)
    ? {}
    : openAiCompatibleReasoning(settings, endpoint);
  const requestBody = {
    model: settings.model,
    messages: [{ role: "user", content }],
    response_format: { type: "json_object" },
    ...reasoningConfig,
    ...outputBudget
  };
  const requestOptions = {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody)
  };
  let requestCount = 1;
  let response = await fetchAiResponse(endpoint, requestOptions);
  let text = await response.text();
  if (!response.ok && (structuredOutputUnsupported(response.status, text)
      || reasoningConfigUnsupported(response.status, text))) {
    const dropStructuredOutput = structuredOutputUnsupported(response.status, text);
    const dropReasoning = reasoningConfigUnsupported(response.status, text);
    let fallbackBody = { ...requestBody };
    if (dropStructuredOutput) delete fallbackBody.response_format;
    if (dropReasoning) {
      fallbackBody = withoutOptionalReasoningConfig(fallbackBody);
      unsupportedReasoningCapabilityKeys.add(reasoningCapabilityKey);
    }
    requestCount += 1;
    response = await fetchAiResponse(endpoint, {
      ...requestOptions,
      body: JSON.stringify(fallbackBody)
    });
    text = await response.text();
  }
  if (!response.ok) {
    throw new Error(`AI request failed: status=${response.status}, body=${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text);
  const choice = data.choices?.[0];
  return {
    text: normalizeTextContent(choice?.message?.content),
    usage: normalizeOpenAiTokenUsage(data.usage),
    finishReason: choice?.finish_reason || null,
    truncated: choice?.finish_reason === "length",
    requestCount
  };
}

function structuredOutputUnsupported(status, text) {
  if (![400, 404, 422].includes(Number(status))) return false;
  return /response[_ -]?format|json[_ -]?(?:object|mode)|structured[_ -]?output/i.test(String(text || ""))
    && /unsupported|not supported|unknown|unrecognized|invalid|不支持|未知/i.test(String(text || ""));
}

function reasoningConfigUnsupported(status, text) {
  if (![400, 404, 422].includes(Number(status))) return false;
  const value = String(text || "");
  return /thinking|reasoning[_ .-]?(?:effort|budget|config)?|enable[_ -]?thinking/i.test(value)
    && /unsupported|not supported|unknown|unrecognized|invalid|not allowed|不支持|未知|无效/i.test(value);
}

function withoutOptionalReasoningConfig(body) {
  const fallback = { ...body };
  for (const key of ["thinking", "reasoning", "reasoning_effort", "enable_thinking", "thinking_budget"]) {
    delete fallback[key];
  }
  return fallback;
}

function openAiChatOutputBudget(endpoint, azure = false, maxOutputTokens = null) {
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return {};
  const host = new URL(endpoint).hostname.toLowerCase();
  if (!azure && host === "api.openai.com") {
    return { max_completion_tokens: maxOutputTokens };
  }
  return { max_tokens: maxOutputTokens };
}

function openAiCompatibleReasoning(settings, endpoint) {
  const host = new URL(endpoint).hostname.toLowerCase();
  const provider = resolvedAiProvider(settings, host);
  const value = String(settings.model || "").toLowerCase();
  const speed = normalizeAnalysisSpeed(settings.analysisSpeed);
  // DeepSeek V4 supports enabled/disabled plus high/max effort; low/medium are
  // aliases of high. Source: https://api-docs.deepseek.com/guides/thinking_mode
  if (provider === "deepseek" && /^deepseek-v4(?:[-._]|$)/.test(value)) {
    if (speed === "fast") return { thinking: { type: "disabled" } };
    return {
      thinking: { type: "enabled" },
      reasoning_effort: speed === "balanced" ? "high" : "max"
    };
  }
  if (provider === "qwen" && isQwenHybridThinkingModel(value)) {
    if (speed === "fast") return { enable_thinking: false };
    if (speed === "balanced") return { enable_thinking: true, thinking_budget: 1024 };
    return {};
  }
  if (provider === "zhipu" && /^glm-(?:4\.[5-9]|[5-9])(?:[-._]|$)/.test(value)) {
    return speed === "accurate"
      ? { thinking: { type: "enabled" } }
      : { thinking: { type: speed === "fast" ? "disabled" : "enabled" } };
  }
  if (provider === "openrouter") {
    return { reasoning: { effort: speed === "fast" ? "none" : speed === "balanced" ? "low" : "high" } };
  }
  if (provider === "groq") {
    if (/^openai\/gpt-oss-(?:20b|120b)$/.test(value)) {
      return { reasoning_effort: speed === "fast" ? "low" : speed === "balanced" ? "medium" : "high" };
    }
    if (/^qwen\/qwen3(?:\.|-)/.test(value)) {
      return { reasoning_effort: speed === "fast" ? "none" : "default" };
    }
  }
  if (provider === "openai") {
    const effort = openAiReasoningEffort(value, speed);
    return effort ? { reasoning_effort: effort } : {};
  }
  return {};
}

function resolvedAiProvider(settings, host) {
  const explicit = String(settings?.aiProvider || "").toLowerCase();
  if (explicit && explicit !== "custom") return explicit;
  const knownHosts = {
    "api.deepseek.com": "deepseek",
    "api.openai.com": "openai",
    "dashscope.aliyuncs.com": "qwen",
    "open.bigmodel.cn": "zhipu",
    "openrouter.ai": "openrouter",
    "api.groq.com": "groq"
  };
  return knownHosts[host] || explicit || "custom";
}

function isQwenHybridThinkingModel(model) {
  return /^(?:qwen(?:3(?:\.\d+)?)?-(?:plus|flash|max)(?:[-._]|$)|qwen3(?:\.\d+)?-[\w.-]+)$/.test(model)
    && !/(?:^|[-._])thinking(?:[-._]|$)/.test(model);
}

function aiReasoningCapabilityKey(settings, endpoint) {
  const url = new URL(endpoint);
  return [
    resolvedAiProvider(settings, url.hostname.toLowerCase()),
    url.origin.toLowerCase(),
    String(settings?.model || "").toLowerCase(),
    normalizeApiProtocol(settings?.apiProtocol)
  ].join("|");
}

function openAiReasoningEffort(model, analysisSpeed) {
  const value = String(model || "").toLowerCase();
  const speed = normalizeAnalysisSpeed(analysisSpeed);
  // GPT-5.1 supports none while older GPT-5 models support minimal; Pro models
  // have fixed model-specific effort and are left untouched.
  // Source: https://platform.openai.com/docs/api-reference/responses
  if (/(?:^|-)pro(?:-|$)/.test(value)) return "";
  if (/^gpt-5\.1(?:[-._]|$)/.test(value)) {
    return speed === "fast" ? "none" : speed === "balanced" ? "low" : "high";
  }
  if (/^gpt-5(?:[-._]|$)/.test(value)) {
    return speed === "fast" ? "minimal" : speed === "balanced" ? "low" : "high";
  }
  if (/^o[1-9](?:[-._]|$)/.test(value)) {
    return speed === "fast" ? "low" : speed === "balanced" ? "medium" : "high";
  }
  return "";
}

async function callAnthropic(settings, content, maxOutputTokens = null) {
  const endpoint = appendApiPath(settings.apiBaseUrl, "/v1/messages", /\/v1\/messages$/i);
  const response = await fetchAiResponse(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: maxOutputTokens || ANTHROPIC_REQUIRED_MAX_OUTPUT_TOKENS,
      output_config: {
        format: { type: "json_schema", schema: ANALYSIS_JSON_SCHEMA },
        ...anthropicReasoningConfig(settings.model, settings.analysisSpeed)
      },
      messages: [{ role: "user", content }]
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AI request failed: status=${response.status}, body=${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text);
  return {
    text: normalizeTextContent(data.content),
    usage: normalizeAnthropicTokenUsage(data.usage),
    finishReason: data.stop_reason || null,
    truncated: data.stop_reason === "max_tokens"
  };
}

function anthropicReasoningConfig(model, analysisSpeed) {
  const value = String(model || "").toLowerCase();
  // Output effort is available on the explicitly named current Claude model
  // families. Unknown/older model IDs retain their service default.
  // Source: https://platform.claude.com/docs/en/api/messages/create
  if (!/^claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4-[5-9]|[5-9])(?:-|$)/.test(value)) return {};
  const speed = normalizeAnalysisSpeed(analysisSpeed);
  return { effort: speed === "fast" ? "low" : speed === "balanced" ? "medium" : "high" };
}

async function callOpenAiResponses(settings, content, maxOutputTokens = null) {
  const endpoint = responsesEndpoint(settings.apiBaseUrl);
  const response = await fetchAiResponse(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...apiAuthenticationHeaders(settings, settings.apiAuthType)
    },
    body: JSON.stringify({
      model: settings.model,
      input: content,
      ...openAiResponsesReasoning(endpoint, settings.model, settings.analysisSpeed),
      text: {
        format: {
          type: "json_schema",
          name: "job_analysis",
          strict: true,
          schema: ANALYSIS_JSON_SCHEMA
        }
      },
      ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {})
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AI request failed: status=${response.status}, body=${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text);
  const finishReason = data.incomplete_details?.reason
    || (data.status === "incomplete" ? "incomplete" : null);
  const completion = {
    finishReason,
    truncated: data.status === "incomplete"
      && (!finishReason || finishReason === "max_output_tokens")
  };
  if (typeof data.output_text === "string") {
    return {
      text: data.output_text,
      usage: normalizeOpenAiTokenUsage(data.usage, true),
      ...completion
    };
  }
  const parts = Array.isArray(data.output)
    ? data.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    : [];
  return {
    text: normalizeTextContent(parts),
    usage: normalizeOpenAiTokenUsage(data.usage, true),
    ...completion
  };
}

function openAiResponsesReasoning(endpoint, model, analysisSpeed) {
  const host = new URL(endpoint).hostname.toLowerCase();
  if (host !== "api.openai.com") return {};
  const effort = openAiReasoningEffort(model, analysisSpeed);
  return effort ? { reasoning: { effort } } : {};
}

async function callGemini(settings, content, maxOutputTokens = null) {
  const endpoint = geminiEndpoint(settings.apiBaseUrl, settings.model);
  const response = await fetchAiResponse(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-goog-api-key": settings.apiKey
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: content }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: ANALYSIS_JSON_SCHEMA,
        ...geminiReasoningConfig(settings.model, settings.analysisSpeed),
        ...(maxOutputTokens ? { maxOutputTokens } : {})
      }
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AI request failed: status=${response.status}, body=${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text);
  const candidate = data.candidates?.[0];
  return {
    text: normalizeTextContent(candidate?.content?.parts),
    usage: normalizeGeminiTokenUsage(data.usageMetadata),
    finishReason: candidate?.finishReason || null,
    truncated: candidate?.finishReason === "MAX_TOKENS"
  };
}

function geminiReasoningConfig(model, analysisSpeed) {
  const value = String(model || "").toLowerCase();
  const speed = normalizeAnalysisSpeed(analysisSpeed);
  if (speed === "accurate") return {};
  // Gemini 2.5 uses token budgets; Gemini 3 uses named levels, whose minimum
  // differs between Flash and Pro. Source:
  // https://ai.google.dev/gemini-api/docs/generate-content/thinking
  if (/gemini-2\.5-(?:flash|flash-lite)/.test(value)) {
    return { thinkingConfig: { thinkingBudget: speed === "fast" ? 0 : 1024 } };
  }
  if (/gemini-2\.5-pro/.test(value)) {
    return { thinkingConfig: { thinkingBudget: speed === "fast" ? 128 : 1024 } };
  }
  if (/gemini-3(?:\.|-).*?(?:flash|flash-lite)/.test(value)) {
    return { thinkingConfig: { thinkingLevel: speed === "fast" ? "minimal" : "low" } };
  }
  if (/gemini-3(?:\.|-).*?pro/.test(value)) return { thinkingConfig: { thinkingLevel: "low" } };
  return {};
}

function chatEndpoint(baseUrl) {
  const url = validatedApiUrl(baseUrl || "https://api.deepseek.com");
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(path)) {
    url.pathname = path;
  } else if (/\/v\d+(?:beta\d*)?$/i.test(path)) {
    url.pathname = `${path}/chat/completions`;
  } else {
    url.pathname = `${path}/v1/chat/completions`.replace(/^\/\//, "/");
  }
  return url.toString();
}

function exactApiEndpoint(value) {
  const url = validatedApiUrl(value);
  url.hash = "";
  return url.toString();
}

function responsesEndpoint(baseUrl) {
  const url = validatedApiUrl(baseUrl || "https://api.openai.com/v1");
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/responses$/i.test(path)) url.pathname = path;
  else if (/\/v\d+(?:beta\d*)?$/i.test(path)) url.pathname = `${path}/responses`;
  else url.pathname = `${path}/v1/responses`.replace(/^\/\//, "/");
  return url.toString();
}

function appendApiPath(baseUrl, suffix, completePattern) {
  const url = validatedApiUrl(baseUrl);
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (completePattern.test(path)) url.pathname = path;
  else if (/\/v1$/i.test(path) && suffix.startsWith("/v1/")) url.pathname = `${path}${suffix.slice(3)}`;
  else url.pathname = `${path}${suffix}`.replace(/^\/\//, "/");
  return url.toString();
}

function geminiEndpoint(baseUrl, model) {
  const url = validatedApiUrl(baseUrl || "https://generativelanguage.googleapis.com/v1beta");
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/models\/[^/]+:generateContent$/i.test(path)) {
    url.pathname = path;
  } else {
    const modelId = String(model || "").trim().replace(/^models\//i, "");
    if (!modelId) throw new Error("Gemini 接口必须填写模型 ID");
    const versionPath = /\/v\d+(?:beta\d*)?$/i.test(path) ? path : `${path}/v1beta`;
    url.pathname = `${versionPath}/models/${encodeURIComponent(modelId)}:generateContent`;
  }
  return url.toString();
}

function validatedApiUrl(value) {
  const url = new URL(String(value || "").trim());
  const isLoopbackHttp = url.protocol === "http:"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    throw new Error("AI 接口必须使用 HTTPS；本机接口可使用 localhost 或 127.0.0.1");
  }
  if (url.username || url.password) throw new Error("AI 接口地址不能包含用户名或密码");
  return url;
}

function normalizeApiProtocol(value) {
  const allowed = ["openai_chat", "openai_responses", "anthropic_messages", "gemini_generate_content", "azure_openai"];
  return allowed.includes(value) ? value : "openai_chat";
}

function apiKeyRequired(settings) {
  const protocol = normalizeApiProtocol(settings.apiProtocol);
  if (["anthropic_messages", "gemini_generate_content", "azure_openai"].includes(protocol)) return true;
  return String(settings.apiAuthType || "bearer") !== "none";
}

function apiAuthenticationHeaders(settings, overrideType) {
  const key = String(settings.apiKey || "").trim();
  const type = String(overrideType || settings.apiAuthType || "bearer");
  if (!key || type === "none") return {};
  if (type === "x-api-key") return { "x-api-key": key };
  if (type === "api-key") return { "api-key": key };
  return { "Authorization": `Bearer ${key}` };
}

function normalizeTextContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    return typeof item?.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}

function buildCustomInstructions(settings) {
  return [
    settings.customInstructions ? `评分偏好：${settings.customInstructions}` : "",
    settings.greetingStyle ? `话术风格：${settings.greetingStyle}` : ""
  ].filter(Boolean).join("\n");
}

function compactAnalysisText(value, maxChars) {
  const text = String(value || "");
  const limit = Math.max(200, Number(maxChars) || 0);
  if (text.length <= limit) return text;
  const marker = "\n……【中间内容已省略，以控制批量分析延迟】……\n";
  const available = Math.max(1, limit - marker.length);
  const headLength = Math.floor(available * 0.72);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

function buildAnalysisPrompt({
  resumeText,
  job,
  settings,
  customInstructions,
  targetDirections,
  excludedDirections,
  currentLocation
}) {
  const directions = String(targetDirections || settings.targetDirections || "未配置");
  const exclusions = String(excludedDirections || settings.excludedDirections || "").trim();
  const locationText = String(currentLocation || settings.currentLocation || "").trim();
  const experienceYears = normalizeExperienceYears(settings.experienceYears);
  const graduateStatus = normalizeGraduateStatus(settings.graduateStatus);
  const experienceProfile = [
    experienceYears === "" ? "工作经验年限：未设置，请根据简历时间线谨慎判断" : `工作经验年限：${experienceYears} 年`,
    graduateStatus === "graduate"
      ? "应届身份：应届生"
      : graduateStatus === "experienced"
        ? "应届身份：非应届生"
        : "应届身份：未设置，请勿自行假定"
  ].join("；");
  const passScore = Math.max(0, Math.min(100, Number(settings.minScore) || 60));
  const resumeForPrompt = compactAnalysisText(resumeText, MAX_RESUME_INPUT_CHARS);
  const jobDescriptionForPrompt = compactAnalysisText(job.jd, MAX_JOB_DESCRIPTION_INPUT_CHARS);
  const cityRule = settings.restrictTargetLocation && locationText
    ? `用户开启了“只分析城市偏好匹配岗位”。岗位城市或岗位文本若明显不在城市偏好「${locationText}」，应给 skip 或显著降低分数。`
    : "未开启目标城市硬性过滤时，不要仅因为城市不同就直接 skip；要参考岗位城市、公司办公地点、通勤便利性和到岗方式，把地理位置写进匹配理由或风险点。";
  const commuteAnswer = locationText
    ? `如果 HR 问居住地、通勤或到岗地点，围绕「${locationText}」诚实回答，不要编造。`
    : "如果 HR 问居住地、通勤或到岗地点，提醒用户先补充目标城市/通勤回答，不要编造具体地址。";
  return `
你是求职岗位快速批量评分器。请严格基于真实简历和岗位信息判断匹配度，并生成一句可给 HR 的简短话术。

核心要求：
- 不能编造简历中没有的经历、公司、项目、技能熟练度。
- 你拥有最终评分权。扩展只会把 score 限制在 0-100、执行用户明确配置的排除结论，并与用户分数线比较，不会用关键词规则二次抬分。
- 必须同时参考【前台求职配置】【所有已勾选简历】【岗位完整 JD】【公司与实际工作地点】。不得只看标题或关键词，也不得忽略简历中的可迁移经验。
- 评分目标是“是否值得投递/沟通”，不是严格技术面试通过率；应届/初级/不限经验岗位可以更宽松。
- 必须先从简历动态识别用户已有的技能、技术栈、项目、行业知识和可迁移能力，再与完整 JD 对照；不能要求用户把简历里的每项能力重复填写成目标关键词。
- “高级、资深、专家、负责人、5-10 年”等只是岗位门槛证据，不是自动淘汰条件。分别保留方向、技能和项目的匹配得分，再根据简历实际年限与职责深度调整岗位门槛分，禁止仅凭标题统一给低分。
- 岗位详情不完整时应降低结论置信度并进入人工复核区间，不能把信息不足等同于不匹配。
- ${cityRule}
- 地理位置是辅助判断，默认不应大幅扣分；除非用户开启目标城市硬性过滤且岗位明显不满足，或岗位有明确不可接受的到岗要求。优先依据职位工作内容、岗位职责、岗位要求和简历证据评分。
- 对方未回复时，不生成追发话术。
- ${commuteAnswer}
- 遵守【求职偏好】，但求职偏好不能覆盖“不编造经历”和“诚实表达限制”的核心约束。
- 这是快速批量评分：直接完成判断并输出紧凑 JSON，不要输出思考过程、长篇解释或重复输入内容。

目标方向加权：
- 只围绕用户在【我的目标方向】里填写的方向、关键词和求职偏好加权。
- 如果用户未配置目标方向，请主要依据简历证据、岗位门槛和岗位文本判断，不要默认偏向某个行业或职位。
- 用户填写的目标方向关键词是强信号。岗位标题、标签或 JD 只要明确命中用户关键词、关键词核心词，或明显同义表达，不能给 0-19 这种淘汰分，除非存在明显硬性不满足条件。
- 多词职业方向必须按完整语义判断，不能因为共享一个宽泛尾词就视为命中。例如“技术支持”不等于客户支持或业务支持，“前端开发”也不等于任意开发岗位。
- 先概括岗位的主要职业类型，再判断它与用户目标是直接匹配、能力可迁移、无关还是信息不足。不要用代码式字面规则代替语义判断；软技能相通不等于职业方向相同，但有明确简历证据的可迁移能力可以合理加分。
- 对命中关键词的岗位，先默认进入可复核区间，再根据经验年限、学历、地点、职责和简历证据上下调整。
- 对用户配置的任意方向都要宽召回：只要标题/JD 出现相关信号，且没有明显硬性冲突，通常进入可复核区间。

排除岗位边界：
- 先概括岗位的主要职业类型，再与【绝不投递岗位/职业类型】逐项进行完整语义比较。
- 排除列表为空时，excluded 必须为 false。
- 只有岗位核心工作内容明确属于某个排除职业类型时才能 excluded=true。共享一个宽泛词不算命中，例如“产品运营”不等于“直播运营”，“技术支持”不等于“电话客服”，“市场策划”不等于“电话销售”。
- 排除项优先级高于目标方向和分数。明确命中时 decision=skip，score 应为 0-19，并写清 exclusion_match 与 exclusion_reason。
- 未明确命中时 excluded=false，不得因为相似、可能包含少量相关任务或公司行业相近而误排除。

统一评分参考：
- 最终 score = 方向相关性 0-30 + 简历证据 0-25 + 岗位门槛 0-20 + 地理位置 0-10 + 机会质量 0-15。
- 方向相关性必须综合岗位职业类型、核心职责和用户目标，不能只看标题。
- 简历证据必须来自真实工作、实习、项目、技能、作品、课程或可迁移经历。
- 岗位门槛 0-20 中，技能深度、学历和职责要求占 0-14 分；经验年限与应届身份合计 0-6 分，不能单独触发淘汰、skip 或 excluded。
- 对照职位卡片城市旁及完整 JD 中的“经验不限、1-3 年、3-5 年、应届”等要求；配置留空时只能依据简历时间线谨慎推断，无法确认时写入 risks，不得编造。
- “高级、资深、5年”等不是自动淘汰词。经验或应届身份不完全匹配时，应结合真实项目、实习和可迁移能力在 0-6 分范围内调整，不得覆盖方向与简历证据。
- 地理位置默认只是辅助因素，只有城市硬限制或明确不可接受的到岗要求才可大幅扣分。
- 与目标方向、简历主线和可迁移能力都基本无关的岗位，即使门槛低，也应低于 50 分，不得为了凑投递量给高分。
- 信息不足应降低置信度和分数，不能自行补全事实。
- ${passScore} 分是用户设置的达标线。score >= ${passScore} 且 excluded=false 时 decision=recommend；低于线但值得查看时 manual_review；明显无关或排除岗位用 skip。
- reasons 最多 3 条，每条一句，合计说明方向、简历证据和岗位门槛。
- risks 最多 2 条，每条一句；没有明确风险时返回空数组。

输出必须是 JSON，不要 Markdown，不要解释 JSON 外的内容。
JSON 格式：
{
  "score": 0,
  "decision": "recommend|manual_review|skip",
  "excluded": false,
  "exclusion_match": "命中的排除职业类型；未命中时为空",
  "exclusion_reason": "命中或未命中的语义判断依据",
  "occupation_family": "岗位主要职业类型",
  "target_alignment": "direct|transferable|unrelated|unclear",
  "reasons": ["匹配理由"],
  "risks": ["风险点"],
  "location_fit": "good|acceptable|unclear|poor",
  "greeting": "第一句 HR 沟通话术，60字以内"
}

【前台求职配置：目标方向】
${directions}

【前台求职配置：绝不投递岗位/职业类型】
${exclusions || "未配置"}

【前台求职配置：额外分析提示词与话术偏好】
${customInstructions || "无"}

【前台求职配置：目标城市/通勤回答】
${locationText || "未配置"}

【前台求职配置：城市偏好方式】
${settings.restrictTargetLocation ? "用户要求把目标城市/地区作为硬性条件，由 AI 结合岗位真实地点和通勤信息判断。" : "城市与通勤是综合评分因素，不是代码硬过滤条件。"}

【前台求职配置：个人经验与应届状态】
${experienceProfile}

【所有已勾选简历】
${resumeForPrompt}

【岗位信息】
平台：${job.platform || "boss"}
岗位：${job.title || ""}
公司：${job.company || ""}
岗位卡片城市/地区：${job.city || ""}
薪资：${job.salary || ""}
链接：${job.url || ""}
JD：
${jobDescriptionForPrompt}
岗位详情完整度：${job.jdComplete === false ? "仅岗位卡片，信息可能不完整" : "已读取完整岗位详情"}
`.trim();
}

function parseJson(text) {
  return parseJsonWithDiagnostics(text).value;
}

function parseJsonWithDiagnostics(text) {
  const source = String(text || "").trim();
  const withoutFence = source
    .replace(/^\s*```(?:json|javascript|js)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const extracted = extractFirstJsonObject(withoutFence);
  const escaped = escapeJsonStringControlCharacters(extracted);
  const normalized = normalizeCommonJsonSyntax(escaped);
  const smartQuoteNormalized = normalizeCommonJsonSyntax(
    escapeJsonStringControlCharacters(extracted.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'"))
  );
  const candidates = [
    { value: source, strategy: "strict" },
    { value: withoutFence, strategy: "markdown_fence" },
    { value: extracted, strategy: "object_extraction" },
    { value: escaped, strategy: "control_characters" },
    { value: normalized, strategy: "common_syntax" },
    { value: closeTruncatedJson(normalized), strategy: "truncated_closure" },
    { value: smartQuoteNormalized, strategy: "smart_quotes" },
    { value: closeTruncatedJson(smartQuoteNormalized), strategy: "smart_quotes_truncated_closure" }
  ];
  let lastError = null;
  const seen = new Set();
  for (const candidate of candidates) {
    const value = String(candidate.value || "").trim();
    if (seen.has(value)) continue;
    seen.add(value);
    if (!value) continue;
    try {
      return {
        value: JSON.parse(value),
        repaired: candidate.strategy !== "strict",
        strategy: candidate.strategy
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new SyntaxError("模型未返回 JSON 对象");
}

function extractFirstJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start < 0) return source.trim();
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1).trim();
    }
  }
  return source.slice(start).replace(/\s*```\s*$/i, "").trim();
}

function normalizeCommonJsonSyntax(text) {
  const doubleQuoted = convertSingleQuotedJsonStrings(String(text || ""));
  return transformOutsideJsonStrings(doubleQuoted, (outside) => outside
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n\r]*/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, "$1\"$2\"$3")
    .replace(/:\s*(True|False|None|undefined|NaN)\b/g, (_match, literal) => {
      if (literal === "True") return ": true";
      if (literal === "False") return ": false";
      return ": null";
    })
    .replace(/:\s*((?!(?:true|false|null)\b)[A-Za-z_$][\w$-]*)(\s*[,}\]])/gi, ': "$1"$2')
    .replace(/,\s*([}\]])/g, "$1"));
}

function transformOutsideJsonStrings(text, transform) {
  let output = "";
  let outside = "";
  let insideString = false;
  let escaped = false;
  const flushOutside = () => {
    output += transform(outside);
    outside = "";
  };
  for (const char of String(text || "")) {
    if (!insideString) {
      if (char === "\"") {
        flushOutside();
        output += char;
        insideString = true;
      } else {
        outside += char;
      }
      continue;
    }
    output += char;
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "\"") {
      insideString = false;
    }
  }
  flushOutside();
  return output;
}

function convertSingleQuotedJsonStrings(text) {
  let output = "";
  let quote = "";
  let escaped = false;
  const source = String(text || "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (!quote) {
      if (char === "\"" || char === "'") {
        quote = char;
        output += "\"";
      } else {
        output += char;
      }
      continue;
    }
    if (quote === "\"") {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") quote = "";
      continue;
    }
    if (escaped) {
      if (char === "'") output += "'";
      else if (char === "\"") output += "\\\"";
      else output += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
    } else if (char === "'") {
      output += "\"";
      quote = "";
    } else if (char === "\"") {
      output += "\\\"";
    } else {
      output += char;
    }
  }
  if (escaped) output += "\\";
  if (quote === "'") output += "\"";
  return output;
}

function closeTruncatedJson(text) {
  let source = String(text || "").trim();
  if (!source) return source;
  const stack = [];
  let insideString = false;
  let escaped = false;
  for (const char of source) {
    if (insideString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") insideString = false;
      continue;
    }
    if (char === "\"") {
      insideString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" && stack.at(-1) === "{") {
      stack.pop();
    } else if (char === "]" && stack.at(-1) === "[") {
      stack.pop();
    }
  }
  if (insideString) source += escaped ? "\\\"" : "\"";
  source = source.replace(/,\s*$/, "");
  if (/:\s*$/.test(source)) source += " null";
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    source += stack[index] === "{" ? "}" : "]";
  }
  return source;
}

function escapeJsonStringControlCharacters(text) {
  let output = "";
  let insideString = false;
  let escaped = false;
  for (const char of String(text || "")) {
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (insideString && char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char === "\"") {
      insideString = !insideString;
      output += char;
      continue;
    }
    if (insideString && char.charCodeAt(0) < 0x20) {
      if (char === "\n") output += "\\n";
      else if (char === "\r") output += "\\r";
      else if (char === "\t") output += "\\t";
      else output += " ";
      continue;
    }
    output += char;
  }
  return output;
}

function normalizeAnalysis(data) {
  const excluded = data?.excluded === true;
  return {
    score: excluded ? Math.min(19, clampScore(data?.score)) : clampScore(data?.score),
    decision: excluded ? "skip" : String(data?.decision || "manual_review"),
    excluded,
    exclusion_match: String(data?.exclusion_match || ""),
    exclusion_reason: String(data?.exclusion_reason || ""),
    occupation_family: String(data?.occupation_family || ""),
    target_alignment: String(data?.target_alignment || "unclear"),
    reasons: Array.isArray(data?.reasons) ? data.reasons : [],
    risks: Array.isArray(data?.risks) ? data.risks : [],
    resume_tips: Array.isArray(data?.resume_tips) ? data.resume_tips : [],
    location_fit: String(data?.location_fit || "unclear"),
    greeting: String(data?.greeting || ""),
    qa: Array.isArray(data?.qa) ? data.qa : []
  };
}

function validateAnalysisShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("AI 结构化输出必须是 JSON 对象");
  }
  const requiredStrings = [
    "decision", "exclusion_match", "exclusion_reason", "occupation_family",
    "target_alignment", "location_fit", "greeting"
  ];
  if (!Number.isFinite(Number(data.score))) throw new TypeError("AI 结构化输出缺少有效 score");
  if (typeof data.excluded !== "boolean") throw new TypeError("AI 结构化输出缺少布尔值 excluded");
  if (!requiredStrings.every((key) => typeof data[key] === "string")) {
    throw new TypeError("AI 结构化输出缺少必需文本字段");
  }
  if (!["recommend", "manual_review", "skip"].includes(data.decision)) {
    throw new TypeError("AI 结构化输出的 decision 无效");
  }
  if (!["direct", "transferable", "unrelated", "unclear"].includes(data.target_alignment)) {
    throw new TypeError("AI 结构化输出的 target_alignment 无效");
  }
  if (!["good", "acceptable", "unclear", "poor"].includes(data.location_fit)) {
    throw new TypeError("AI 结构化输出的 location_fit 无效");
  }
  for (const key of ["reasons", "risks"]) {
    if (!Array.isArray(data[key]) || !data[key].every((item) => typeof item === "string")) {
      throw new TypeError(`AI 结构化输出的 ${key} 必须是字符串数组`);
    }
  }
  return data;
}

function clampScore(score) {
  const value = Number(score || 0);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

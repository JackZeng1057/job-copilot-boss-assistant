const DEFAULT_SETTINGS = {
  aiProvider: "deepseek",
  apiProtocol: "openai_chat",
  apiAuthType: "bearer",
  apiBaseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-v4-flash",
  minScore: 60,
  autoRunOnJobsPage: false,
  restrictTargetLocation: false,
  profile: "default",
  currentLocation: "",
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
const AUTOMATION_LOG_LIMIT = 200;
const IDLE_DETECTION_INTERVAL_SECONDS = 60;
const ISOLATED_CONTACT_LOAD_TIMEOUT_MS = 18000;
// The content script may spend 10s locating BOSS's button and another 34.2s
// on its bounded confirmation flow. Inactive disposable tabs can be timer-
// throttled by Chromium, so that nominal duration is not a reliable wall-clock
// upper bound. This timeout is
// only a hung-channel guard; normal confirmation is allowed a wider budget.
const ISOLATED_CONTACT_ACTION_TIMEOUT_MS = 120000;
// If the action callback is lost, keep the disposable tab alive and let the
// extension resolve/check the native confirmation itself before giving up.
const ISOLATED_CONTACT_RECOVERY_TIMEOUT_MS = 30000;
const automationStorage = chrome.storage.session || chrome.storage.local;

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
    communicateInIsolatedTab(sender.tab, message.job)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
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
    "summary", "status", "contactInFlight", "currentJobKey", "completedJobKeys",
    "batchNumber", "batchKeys", "updatedAt", "autoPausedByIdle"
  ];
  for (const key of allowed) {
    if (value[key] !== undefined) safe[key] = value[key];
  }
  return safe;
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

  const chatTabs = await queryTabs({
    url: ["https://www.zhipin.com/web/geek/chat*"],
    windowId: senderTab.windowId
  });
  const existing = chatTabs.find((tab) => tab.id && tab.id !== senderTab.id);
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
  const workerUrl = isolatedContactUrl(job?.url);
  // Never attach an opener to the disposable tab. BOSS scripts running there
  // must have no reference capable of navigating the dedicated jobs tab.
  const worker = await createTabWithTransientRetry({
    url: workerUrl,
    active: false,
    windowId: senderTab.windowId,
    index: Number.isInteger(senderTab.index) ? senderTab.index + 1 : undefined
  });
  if (!worker?.id) throw new Error("无法创建临时沟通标签");
  await setTabAutoDiscardable(worker.id, false);

  await appendAutomationLog({
    event: "isolated_contact_tab_opened",
    title: job?.title,
    page: workerUrl
  }, senderTab.id);

  let stage = "loading";
  try {
    try {
      await waitForTabComplete(worker.id, ISOLATED_CONTACT_LOAD_TIMEOUT_MS);
    } catch (loadError) {
      // Some BOSS detail pages keep the tab loading flag alive even though the
      // content script and React view are already usable. Probe readiness before
      // treating the browser-level loading timeout as a real failure.
      const readiness = await sendTabMessageWithTimeout(worker.id, {
        type: "inspectIsolatedCommunicationResult",
        resolvePendingConfirmation: true
      }, 2500);
      if (!readiness?.ok) throw loadError;
      if (readiness.confirmed) return { status: "stayed" };
      if (readiness.status) return { status: readiness.status };
      await appendAutomationLog({
        event: "isolated_contact_loaded_via_probe",
        title: job?.title,
        page: workerUrl,
        detail: "tab_status_timeout_but_content_ready"
      }, senderTab.id);
    }
    stage = "action";
    const response = await sendTabMessageWithTimeout(worker.id, {
      type: "performIsolatedCommunication",
      expectedJob: {
        key: String(job?.key || ""),
        title: String(job?.title || ""),
        company: String(job?.company || ""),
        url: workerUrl
      }
    }, ISOLATED_CONTACT_ACTION_TIMEOUT_MS);
    if (response?.ok) {
      const status = response.status === "chat_route" ? "navigated_chat" : (response.status || "unknown");
      if (status === "stay_missing" || status === "unknown") {
        stage = "verification";
        const recoveredStatus = await verifyIsolatedContactOutcome(
          worker.id,
          ISOLATED_CONTACT_RECOVERY_TIMEOUT_MS
        );
        if (recoveredStatus) {
          await appendAutomationLog({
            event: "isolated_contact_verified_after_wait",
            title: job?.title,
            page: workerUrl,
            detail: `status=${recoveredStatus}`
          }, senderTab.id);
          return { status: recoveredStatus };
        }
      }
      await appendAutomationLog({
        event: `isolated_contact_${status}`,
        title: job?.title,
        page: workerUrl
      }, senderTab.id);
      return { status };
    }

    // A long sendMessage callback can be lost while BOSS is navigating or
    // replacing its React tree. Perform a fresh verification and resolve any
    // pending stay-on-page confirmation before reporting failure; never repeat
    // the communication click here.
    stage = "timeout_recovery";
    const recoveredStatus = await verifyIsolatedContactOutcome(
      worker.id,
      ISOLATED_CONTACT_RECOVERY_TIMEOUT_MS
    );
    if (recoveredStatus) {
      await appendAutomationLog({
        event: "isolated_contact_recovered_after_error",
        title: job?.title,
        page: workerUrl,
        detail: `error=${String(response?.error || "unknown").slice(0, 120)};status=${recoveredStatus}`
      }, senderTab.id);
      return { status: recoveredStatus };
    }
    throw new Error(response?.error || "临时沟通标签未返回结果");
  } catch (error) {
    const current = await getTab(worker.id).catch(() => null);
    await appendAutomationLog({
      event: "isolated_contact_failed",
      title: job?.title,
      page: current?.url || workerUrl,
      detail: `stage=${stage};error=${String(error?.message || error).slice(0, 180)}`
    }, senderTab.id);
    throw error;
  } finally {
    await setTabAutoDiscardable(worker.id, true);
    await removeTab(worker.id).catch(() => {});
  }
}

async function verifyIsolatedContactOutcome(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const tab = await getTab(tabId).catch(() => null);
    const url = tab?.url || "";
    if (isBossChatUrl(url)) return "navigated_chat";
    if (/\/web\/passport\/|security|captcha|verify/i.test(url)) return "blocked_security";

    const inspection = await sendTabMessageWithTimeout(tabId, {
      type: "inspectIsolatedCommunicationResult",
      resolvePendingConfirmation: true
    }, Math.min(2000, Math.max(500, deadline - Date.now())));
    if (inspection?.ok) {
      if (inspection.confirmed) return "stayed";
      if (inspection.status) return inspection.status;
    }
    if (Date.now() >= deadline) break;
    await delay(400);
  } while (Date.now() < deadline);
  return "";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isolatedContactUrl(value) {
  const url = new URL(String(value || ""), "https://www.zhipin.com");
  if (url.hostname !== "www.zhipin.com" || !/\/job_detail\//.test(url.pathname)) {
    throw new Error("岗位缺少可用的 BOSS 详情链接");
  }
  return url.href;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated?.removeListener?.(onUpdated);
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(() => finish(new Error("临时沟通标签加载超时")), timeoutMs);
    chrome.tabs.onUpdated?.addListener?.(onUpdated);
    getTab(tabId).then((tab) => {
      if (tab?.status === "complete") finish();
    }).catch((error) => finish(error));
  });
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
    const timer = setTimeout(() => finish({ ok: false, error: "临时沟通动作超时" }), timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = consumeRuntimeLastError();
      if (error) finish({ ok: false, error: error.message });
      else finish(response || { ok: false, error: "临时沟通标签没有响应" });
    });
  });
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
  return sendAutomationControl(session.tabId, action, "manual");
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
  if (!session?.active || session.tabId !== tabId || !session.jobsUrl) return;
  if (isAutomationJobsUrl(url)) return;

  // Never repair a departed SPA page with history.back() or a saved URL. Both
  // reload BOSS's in-memory job list and can silently switch categories. The
  // Automatic communication runs in a disposable tab, so the owner jobs tab
  // should only leave because of an explicit user action or an external route.
  const progress = { ...(session.progress || {}) };
  if (session.contactInFlight && session.currentJobKey) {
    progress[session.currentJobKey] = {
      status: "attention",
      detail: "BOSS 异常离开职位页，已暂停且不会自动返回或重复沟通",
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
    status: "职位标签已离开职位页，自动投递已暂停；页面不会被自动刷新。",
    updatedAt: Date.now()
  });
  await setTabAutoDiscardable(tabId, true);
  await appendAutomationLog({
    event: "automation_tab_navigation_paused",
    page: url,
    detail: `restore=disabled;from=${session.jobsUrl}`
  }, tabId);
}

function isBossChatUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.zhipin.com" && /\/web\/geek\/chat(?:[/?#]|$)/.test(parsed.pathname + parsed.search);
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

async function createTabWithTransientRetry(options, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await createTab(options);
    } catch (error) {
      lastError = error;
      const transientTabLock = /tabs cannot be edited right now|user may be dragging a tab/i
        .test(String(error?.message || error || ""));
      if (!transientTabLock || attempt === attempts - 1) throw error;
      await delay(250 * (attempt + 1));
    }
  }
  throw lastError;
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => chrome.tabs.query(queryInfo, (tabs) => {
    const error = consumeRuntimeLastError();
    if (error) reject(new Error(error.message));
    else resolve(Array.isArray(tabs) ? tabs : []);
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
  const raw = await callAi(settings, prompt, 0.3);
  let parsed;
  try {
    parsed = parseJson(raw);
  } catch (firstError) {
    // Spend at most one extra request repairing provider formatting. The
    // second prompt may fix truncation or structural errors that local control-
    // character escaping cannot repair.
    const repairedRaw = await callAi(settings, buildJsonRepairPrompt(raw, firstError), 0);
    parsed = parseJson(repairedRaw);
  }
  const analysis = normalizeAnalysis(parsed);
  return { ok: true, analysis };
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
      resolve(settings);
    });
  });
}

function publicRuntimeSettings(settings) {
  const allowed = [
    "minScore", "autoRunOnJobsPage", "restrictTargetLocation", "profile",
    "currentLocation", "targetDirections", "excludedDirections", "customInstructions", "greetingStyle"
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

async function callAi(settings, content, temperature) {
  const protocol = normalizeApiProtocol(settings.apiProtocol);
  if (protocol === "anthropic_messages") return callAnthropic(settings, content, temperature);
  if (protocol === "gemini_generate_content") return callGemini(settings, content, temperature);
  if (protocol === "openai_responses") return callOpenAiResponses(settings, content, temperature);
  return callOpenAiCompatible(settings, content, temperature, protocol === "azure_openai");
}

async function callOpenAiCompatible(settings, content, temperature, azure = false) {
  const endpoint = azure
    ? exactApiEndpoint(settings.apiBaseUrl)
    : chatEndpoint(settings.apiBaseUrl);
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...apiAuthenticationHeaders(settings, azure ? "api-key" : settings.apiAuthType)
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: settings.model,
      temperature,
      messages: [{ role: "user", content }]
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AI request failed: status=${response.status}, body=${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text);
  return normalizeTextContent(data.choices?.[0]?.message?.content);
}

async function callAnthropic(settings, content, temperature) {
  const endpoint = appendApiPath(settings.apiBaseUrl, "/v1/messages", /\/v1\/messages$/i);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 4096,
      temperature,
      messages: [{ role: "user", content }]
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AI request failed: status=${response.status}, body=${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text);
  return normalizeTextContent(data.content);
}

async function callOpenAiResponses(settings, content, temperature) {
  const endpoint = responsesEndpoint(settings.apiBaseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...apiAuthenticationHeaders(settings, settings.apiAuthType)
    },
    body: JSON.stringify({
      model: settings.model,
      temperature,
      input: content
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AI request failed: status=${response.status}, body=${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text);
  if (typeof data.output_text === "string") return data.output_text;
  const parts = Array.isArray(data.output)
    ? data.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    : [];
  return normalizeTextContent(parts);
}

async function callGemini(settings, content, temperature) {
  const endpoint = geminiEndpoint(settings.apiBaseUrl, settings.model);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-goog-api-key": settings.apiKey
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: content }] }],
      generationConfig: { temperature, maxOutputTokens: 4096 }
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AI request failed: status=${response.status}, body=${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text);
  return normalizeTextContent(data.candidates?.[0]?.content?.parts);
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
  const passScore = Math.max(0, Math.min(100, Number(settings.minScore) || 60));
  const cityRule = settings.restrictTargetLocation && locationText
    ? `用户开启了“只分析城市偏好匹配岗位”。岗位城市或岗位文本若明显不在城市偏好「${locationText}」，应给 skip 或显著降低分数。`
    : "未开启目标城市硬性过滤时，不要仅因为城市不同就直接 skip；要参考岗位城市、公司办公地点、通勤便利性和到岗方式，把地理位置写进匹配理由或风险点。";
  const commuteAnswer = locationText
    ? `如果 HR 问居住地、通勤或到岗地点，围绕「${locationText}」诚实回答，不要编造。`
    : "如果 HR 问居住地、通勤或到岗地点，提醒用户先补充目标城市/通勤回答，不要编造具体地址。";
  return `
你是我的求职辅助助手。请严格基于我的真实简历和岗位信息判断匹配度，并生成可给 HR 的话术。

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
- 岗位门槛综合经验、学历、技能深度、应届友好度和明确硬性要求；“高级、资深、5年”等不是自动淘汰词。
- 地理位置默认只是辅助因素，只有城市硬限制或明确不可接受的到岗要求才可大幅扣分。
- 与目标方向、简历主线和可迁移能力都基本无关的岗位，即使门槛低，也应低于 50 分，不得为了凑投递量给高分。
- 信息不足应降低置信度和分数，不能自行补全事实。
- ${passScore} 分是用户设置的达标线。score >= ${passScore} 且 excluded=false 时 decision=recommend；低于线但值得查看时 manual_review；明显无关或排除岗位用 skip。
- reasons 至少说明方向、简历证据和岗位门槛三方面的依据。

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
  "resume_tips": ["简历或表达调整建议"],
  "location_fit": "good|acceptable|unclear|poor",
  "greeting": "第一句 HR 沟通话术，80字以内",
  "qa": [{"question": "你住在哪里/通勤是否方便？", "answer": "${locationText ? `我目前的通勤范围是${locationText}，具体到岗方式可以沟通。` : "我会根据实际居住地和通勤安排如实回复。"}"}]
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

【所有已勾选简历】
${String(resumeText || "")}

【岗位信息】
平台：${job.platform || "boss"}
岗位：${job.title || ""}
公司：${job.company || ""}
岗位卡片城市/地区：${job.city || ""}
薪资：${job.salary || ""}
链接：${job.url || ""}
JD：
${String(job.jd || "")}
岗位详情完整度：${job.jdComplete === false ? "仅岗位卡片，信息可能不完整" : "已读取完整岗位详情"}
`.trim();
}

function parseJson(text) {
  let stripped = String(text || "").trim();
  if (stripped.startsWith("```")) {
    stripped = stripped.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end >= start) stripped = stripped.slice(start, end + 1);
  try {
    return JSON.parse(stripped);
  } catch (error) {
    // JSON forbids literal control characters inside quoted strings. Some
    // models still place real newlines or tabs in greeting/reason fields.
    return JSON.parse(escapeJsonStringControlCharacters(stripped));
  }
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

function buildJsonRepairPrompt(raw, error) {
  return `
请把下面这段模型输出修复成一个严格合法的 JSON 对象。
只修复 JSON 语法和转义，不改变分数、结论、理由或话术含义；不要输出 Markdown 或解释。
解析错误：${String(error?.message || error || "JSON 格式错误").slice(0, 300)}
原始输出：
${String(raw || "").slice(0, 14000)}
`.trim();
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

function clampScore(score) {
  const value = Number(score || 0);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// 会话持久化、快照裁剪和标签所有权；存储失败必须向调用方传播。
function storageGet(area, keys) {
  return new Promise((resolve) => area.get(keys, (items) => {
    if (consumeRuntimeLastError()) resolve({});
    else resolve(items && typeof items === "object" ? items : {});
  }));
}

function storageSet(area, values) {
  return new Promise((resolve, reject) => area.set(values, () => {
    const error = consumeRuntimeLastError();
    if (error) reject(new Error(error.message || "浏览器存储写入失败"));
    else resolve();
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
  const safeSession = normalizeSessionContactMarker(sanitizeAutomationSession(session));
  await storageSet(automationStorage, { [AUTOMATION_SESSION_KEY]: safeSession });
  return safeSession;
}

function normalizeSessionContactMarker(session) {
  const currentJobKey = String(session?.currentJobKey || "");
  const contactInFlight = session?.contactInFlight === true && Boolean(currentJobKey);
  return {
    ...session,
    contactInFlight,
    currentJobKey: contactInFlight ? currentJobKey : ""
  };
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

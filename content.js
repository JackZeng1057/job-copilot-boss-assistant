// Content runtime: scans BOSS jobs, renders the assistant panel, and drives the
// analysis and communication queue on the protected jobs tab.
const JC_STATE = {
  jobs: [],
  analyses: new Map(),
  analysisPayloads: new Map(),
  reanalysisInFlightKeys: new Set(),
  jobProgress: new Map(),
  dismissedJobKeys: new Set(),
  completedJobKeys: new Set(),
  selectedKey: "",
  currentJobKey: "",
  retryJobKey: "",
  retryContactJobKey: "",
  sessionOwner: false,
  remoteSession: null,
  page: {
    initialized: false,
    fingerprint: "",
    generation: 0,
    url: ""
  },
  pipeline: {
    active: false,
    starting: false,
    mode: "idle",
    phase: "idle",
    allPaused: false,
    pauseReason: "",
    controlActionInFlight: false,
    contactInFlight: false,
    ownerRouteEscaped: false,
    contextInvalidated: false,
    batchNumber: 1,
    batchKeys: [],
    batchSize: 0,
    batchWaitRemainingMs: 0,
    waitingForNextBatch: false,
    loadingNextBatch: false
  },
  settings: {
    minScore: 60,
    analysisSpeed: "fast",
    autoRunOnJobsPage: false,
    restrictTargetLocation: false,
    profile: "default",
    currentLocation: "",
    experienceYears: "",
    graduateStatus: "unspecified",
    targetDirections: "",
    excludedDirections: "",
    customInstructions: "",
    greetingStyle: "简洁、真诚，突出匹配经历和到岗意愿。"
  },
  analyzing: false,
  analysisRunId: 0
};

const PAGE_SYNC_DEBOUNCE_MS = 450;
const PAGE_SNAPSHOT_POLL_MS = 5000;
const JOB_SNAPSHOT_STABILITY_ATTEMPTS = 2;
const MANUAL_CHAT_SCAN_DELAY_MS = 120;
const MANUAL_CHAT_SCAN_FALLBACK_MS = 2000;
const CONTACT_CONFIRMATION_MIN_INTERVAL_MS = 250;
const CONTACT_CONFIRMATION_FALLBACK_MS = 500;
const CONTACT_CONFIRMATION_TIMEOUT_MS = 15000;
const POST_ANALYSIS_CONTACT_DELAY_MS = 3000;
const BETWEEN_JOBS_DELAY_MS = 5000;
const JOB_BATCH_SIZE = 15;
const BETWEEN_BATCHES_DELAY_MS = 60000;
const MAX_DETACHED_JOBS = 50;
const MAX_COMPLETED_JOB_KEYS = 500;
const CONTACT_STATUS_SELECTOR = [
  "[role='dialog']", "[role='status']", "[aria-live]", ".dialog", ".modal", ".boss-dialog",
  "[class*='dialog']", "[class*='modal']", "[class*='toast']", "[class*='message']"
].join(",");
const EXTENSION_VERSION = chrome.runtime.getManifest?.()?.version || "1.0.0";
const CONTENT_SCRIPT_VERSION = `${EXTENSION_VERSION}-manual-contact-v6`;
// The service worker reads settings fresh on every analysis, so the page must
// follow along or the AI scores against one pass mark while the queue gates on
// another. Mirrors publicRuntimeSettings() in background.js.
const RUNTIME_SETTING_KEYS = [
  "minScore", "autoRunOnJobsPage", "restrictTargetLocation", "profile",
  "currentLocation", "experienceYears", "graduateStatus", "targetDirections",
  "excludedDirections", "customInstructions", "greetingStyle", "analysisSpeed"
];
const RUNTIME_PROBE_EVENT = "job-copilot-runtime-probe";
const RUNTIME_ACK_EVENT = "job-copilot-runtime-ack";
const OWNER_NAVIGATION_GUARD_START_EVENT = "job-copilot-owner-navigation-guard-start";
const OWNER_NAVIGATION_GUARD_STOP_EVENT = "job-copilot-owner-navigation-guard-stop";
let pageSyncTimer = null;
let pageSyncRunning = false;
let pageSyncRequested = false;
let pageObserver = null;
let sessionPersistTimer = null;
let manualChatScanTimer = null;
let manualChatHitbox = null;
let manualChatOpenAt = 0;
const manualContactInFlightKeys = new Set();
const nativeAutomationContactKeys = new Set();
const trustedManualContactEvents = new WeakSet();

const SHOULD_BOOT_CONTENT_RUNTIME = !hasLiveContentRuntime();
if (SHOULD_BOOT_CONTENT_RUNTIME) {
  initPanel();
  installManualChatTabHandler(true);
  installContentRuntimeResponder();
  registerJobsTabProtection();
}

function registerJobsTabProtection() {
  if (!isJobsPage()) return;
  document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_START_EVENT, {
    detail: { persistent: true }
  }));
  sendMessage({ type: "protectJobsTab" }).catch(() => {});
}

function hasLiveContentRuntime() {
  if (!document.getElementById("job-copilot-panel")) return false;
  const token = `${CONTENT_SCRIPT_VERSION}:${Date.now()}:${Math.random()}`;
  let acknowledged = false;
  const receiveAck = (event) => {
    if (event.detail === token) acknowledged = true;
  };
  document.addEventListener(RUNTIME_ACK_EVENT, receiveAck);
  document.dispatchEvent(new CustomEvent(RUNTIME_PROBE_EVENT, { detail: token }));
  document.removeEventListener(RUNTIME_ACK_EVENT, receiveAck);
  return acknowledged;
}

function installContentRuntimeResponder() {
  document.addEventListener(RUNTIME_PROBE_EVENT, (event) => {
    document.dispatchEvent(new CustomEvent(RUNTIME_ACK_EVENT, { detail: event.detail }));
  });
}

function installManualChatTabHandler(force = false) {
  if (!force && document.documentElement.dataset.jcManualChatHandler === CONTENT_SCRIPT_VERSION) return;
  document.documentElement.dataset.jcManualChatHandler = CONTENT_SCRIPT_VERSION;
  hardenManualChatLinks();
  const linkObserver = new MutationObserver(() => scheduleManualChatLinkHardening());
  linkObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", scheduleManualChatLinkHardening, true);
  window.addEventListener("scroll", scheduleManualChatLinkHardening, { capture: true, passive: true });
  window.setInterval(scheduleManualChatLinkHardening, MANUAL_CHAT_SCAN_FALLBACK_MS);
  window.addEventListener("pointerdown", handleManualChatHitboxEvent, true);
  window.addEventListener("click", handleManualChatHitboxEvent, true);
  document.addEventListener("click", handleManualChatClick, true);
  document.addEventListener("click", handleManualJobContactClick, true);
  document.addEventListener("click", containTrustedManualContactNavigation, false);
}

function scheduleManualChatLinkHardening() {
  if (manualChatScanTimer) return;
  manualChatScanTimer = setTimeout(() => {
    manualChatScanTimer = null;
    hardenManualChatLinks();
  }, MANUAL_CHAT_SCAN_DELAY_MS);
}

function handleManualChatHitboxEvent(event) {
  const box = manualChatHitbox;
  if (!box || !event.isTrusted || !isJobsPage()
    || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (event.target instanceof Element && event.target.closest("#job-copilot-message-overlay")) return;
  if (Number.isInteger(event.button) && event.button !== 0) return;
  if (event.clientX < box.left || event.clientX > box.right
    || event.clientY < box.top || event.clientY > box.bottom) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (Date.now() - manualChatOpenAt < 800) return;
  manualChatOpenAt = Date.now();
  openManualChatCompanion(event);
}

function handleManualChatClick(event) {
  if (!isTrustedTopNavigationChatClick(event) || !isJobsPage()) return;
  openManualChatCompanion(event);
}

function handleManualJobContactClick(event) {
  if (!event.isTrusted || !isJobsPage() || !(event.target instanceof Element)) return false;
  const button = event.target.closest("a,button,[role='button']");
  if (!button || isInsideJobCopilot(button)) return false;
  const label = cleanText(button.innerText || button.textContent || "");
  if (!/^(立即沟通|继续沟通|继续聊|再次沟通)$/.test(label)) return false;
  const job = findJobForCommunicationButton(button);
  if (!job) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (/^(继续沟通|继续聊|再次沟通)$/.test(label)) {
      openExistingConversationInCompanion();
    } else {
      setStatus("无法确认当前沟通按钮对应的队列岗位，已阻止页面跳转；请重新扫描后再试。");
    }
    return true;
  }
  if (nativeAutomationContactKeys.has(job.key)) {
    // The browser-level input is trusted, so it passes through this same
    // capture boundary. Reuse the navigation containment but leave success
    // ownership with communicateOnOwnerPage to avoid two competing waiters.
    trustedManualContactEvents.add(event);
    if (typeof window === "undefined" || !window.navigation) event.preventDefault();
    return true;
  }
  if (manualContactInFlightKeys.has(job.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }
  if (/^(继续沟通|继续聊|再次沟通)$/.test(label)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    openExistingConversationInCompanion(job);
    return true;
  }
  // Modern Chromium's main-world Navigation API guard cancels the navigation
  // without changing this click's defaultPrevented flag, so BOSS receives the
  // trusted event unchanged. Older browsers fall back to cancelling the link
  // default during capture; preventDefault() still allows propagation.
  if (typeof window === "undefined" || !window.navigation) event.preventDefault();
  // Keep the user's original trusted event alive so BOSS can execute its real
  // communication handler. Synthetic element.click() is not an equivalent
  // substitute and can be ignored by production event guards.
  trustedManualContactEvents.add(event);
  // Arm the main-world guard synchronously, before BOSS's delegated handler
  // receives the trusted click. This blocks both SPA history writes and a
  // target=_blank/browser fallback without swallowing the real click.
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_START_EVENT, {
      detail: { durationMs: 13000 }
    }));
  }
  contactManuallyWithoutOwnerNavigation(job);
  return true;
}

function containTrustedManualContactNavigation(event) {
  if (!trustedManualContactEvents.has(event)) return;
  trustedManualContactEvents.delete(event);
  // Run after BOSS's delegated handler, but before the browser performs an
  // anchor's native default navigation. SPA history/window routes are covered
  // by the main-world guard started synchronously in the capture listener.
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (anchor && !event.defaultPrevented) event.preventDefault();
}

async function contactManuallyWithoutOwnerNavigation(job) {
  manualContactInFlightKeys.add(job.key);
  setJobProgress(job, "contacting", "正在当前职位页确认手动沟通");
  setStatus(`正在确认手动沟通，职位列表保持不变：${job.title}`);
  renderList();
  try {
    const result = await observeManualCommunicationOnOwnerPage(job);
    if (result !== "confirmed") throw new Error(`当前页面未确认沟通成功：${result}`);
    if (dismissJob(job.key, { reason: "manual_contact" })) {
      logContactEvent("manual_contact_removed_from_queue", job);
    }
  } catch (error) {
    logContactEvent("manual_contact_failed", job);
    if (JC_STATE.jobs.some((item) => item.key === job.key)) {
      setJobProgress(job, "attention", "手动沟通结果未确认，岗位仍保留");
      renderList();
    }
    setStatus(`手动沟通未完成，岗位仍保留在队列：${job.title}。${friendlyContactError(error)}`);
  } finally {
    manualContactInFlightKeys.delete(job.key);
  }
}

async function observeManualCommunicationOnOwnerPage(job) {
  const ownerJobsUrl = location.href;
  const stayWaiter = createStayOnCurrentPageWaiter(12000, job);
  document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_START_EVENT, {
    detail: { durationMs: 13000 }
  }));
  try {
    const result = await stayWaiter.promise;
    if (isBossChatUrl(location.href) || isBossJobDetailUrl(location.href)) {
      const restored = await restoreManualOwnerJobsRoute(ownerJobsUrl);
      if (!restored) return "owner_route_escape";
    }
    if (result === "stayed_confirmed" || result === "chat_route" || manualCommunicationConfirmed(job)) {
      return "confirmed";
    }
    return communicationBlockStatus() || result || "stay_missing";
  } finally {
    document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_STOP_EVENT));
    stayWaiter.cancel();
  }
}

async function restoreManualOwnerJobsRoute(ownerJobsUrl) {
  if (!isBossChatUrl(location.href) && !isBossJobDetailUrl(location.href)) return true;
  history.back();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(100);
    if (!isBossChatUrl(location.href) && !isBossJobDetailUrl(location.href)) return true;
  }
  return location.href === ownerJobsUrl;
}

function manualCommunicationConfirmed(job) {
  const button = findCommunicationButtonForJob(job);
  const label = cleanText(button?.innerText || button?.textContent || "");
  return /^(继续沟通|继续聊|再次沟通|已沟通|发消息)$/.test(label)
    || hasSuccessfulContactEvidence(job);
}

function openExistingConversationInCompanion(job = null) {
  sendMessage({ type: "openManualChatTab" })
    .then((result) => {
      if (!result?.ok) throw new Error(result?.error || "无法打开消息标签");
      if (job && dismissJob(job.key, { reason: "manual_contact" })) {
        logContactEvent("manual_contact_removed_from_queue", job);
      }
    })
    .catch((error) => setStatus(`打开独立消息标签失败：${String(error.message || error)}`));
}

function openManualChatCompanion(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  sendMessage({ type: "openManualChatTab" })
    .then((result) => {
      if (!result?.ok) throw new Error(result?.error || "无法打开消息标签");
    })
    .catch((error) => setStatus(`打开消息标签失败：${String(error.message || error)}`));
}

function hardenManualChatLinks() {
  if (!isJobsPage()) {
    manualChatHitbox = null;
    document.getElementById("job-copilot-message-overlay")?.remove();
    return;
  }
  for (const anchor of document.links) {
    const label = normalizeManualChatLabel(anchor.innerText || anchor.textContent || "");
    const rect = anchor.getBoundingClientRect();
    if (label !== "消息" || rect.top < 0 || rect.top >= Math.min(180, window.innerHeight * 0.25)) continue;
    const hardened = anchor;
    hardened.dataset.jcManualChatLink = "true";
    hardened.setAttribute("href", `${location.pathname}${location.search}`);
    hardened.target = "_blank";
    hardened.rel = "noopener noreferrer";
    hardened.style.pointerEvents = "none";
    manualChatHitbox = {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom
    };
    if (hardened.dataset.jcManualChatBound !== CONTENT_SCRIPT_VERSION) {
      hardened.dataset.jcManualChatBound = CONTENT_SCRIPT_VERSION;
      hardened.addEventListener("click", handleManualChatClick, true);
    }
    positionManualChatOverlay(hardened);
    return;
  }
  document.getElementById("job-copilot-message-overlay")?.remove();
}

function positionManualChatOverlay(anchor) {
  let overlay = document.getElementById("job-copilot-message-overlay");
  if (!overlay) {
    overlay = document.createElement("a");
    overlay.id = "job-copilot-message-overlay";
    overlay.tabIndex = 0;
    overlay.href = "https://www.zhipin.com/web/geek/chat";
    overlay.target = "_blank";
    overlay.rel = "noopener noreferrer";
    overlay.title = "在独立标签打开消息";
    overlay.setAttribute("aria-label", "在独立标签打开消息");
    overlay.addEventListener("click", (event) => {
      // Stop BOSS's SPA router, but keep the native `_blank` default action.
      event.stopImmediatePropagation();
    }, true);
    // Keep the overlay outside BOSS's transformed navigation containers so
    // `position: fixed` always uses viewport coordinates on Chrome and Edge.
    document.documentElement.appendChild(overlay);
  }
  const rect = anchor.getBoundingClientRect();
  Object.assign(overlay.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    padding: "0",
    border: "0",
    background: "transparent",
    opacity: "0.01",
    cursor: "pointer",
    zIndex: "2147483646",
    textDecoration: "none"
  });
}

function isTrustedTopNavigationChatClick(event) {
  if (!event.isTrusted || (Number.isInteger(event.button) && event.button !== 0)
    || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor || anchor.closest("#job-copilot-panel, #job-copilot-launcher")) return false;
  if (anchor.dataset.jcManualChatLink !== "true") return false;
  const label = normalizeManualChatLabel(anchor.innerText || anchor.textContent || "");
  if (label !== "消息") return false;
  const rect = anchor.getBoundingClientRect();
  return rect.top >= 0 && rect.top < Math.min(180, window.innerHeight * 0.25);
}

function normalizeManualChatLabel(value) {
  // BOSS appends an unread badge to the same anchor, for example "消息 1" or
  // "消息 99+". Normalize after removing the badge so no trailing whitespace
  // can disable the new-tab interception.
  return cleanText(String(value || "").replace(/[0-9０-９]+\+?/g, ""));
}

function initPanel() {
  const existingPanel = document.getElementById("job-copilot-panel");
  existingPanel?.remove();
  document.getElementById("job-copilot-launcher")?.remove();
  const launcher = document.createElement("button");
  launcher.id = "job-copilot-launcher";
  launcher.textContent = "JC";
  launcher.title = "打开 Job Copilot，可上下拖动调整位置";
  launcher.setAttribute("aria-label", "打开 Job Copilot");
  launcher.style.display = "flex";
  const panel = document.createElement("div");
  panel.id = "job-copilot-panel";
  panel.dataset.scriptVersion = CONTENT_SCRIPT_VERSION;
  panel.style.display = "none";
  panel.innerHTML = `
    <div class="jc-header">
      <span>Job Copilot <small class="jc-version">v${EXTENSION_VERSION}</small></span>
      <div class="jc-header-actions">
        <button class="jc-icon-button" id="jc-minimize" title="缩小">−</button>
        <button class="jc-icon-button" id="jc-close" title="关闭">×</button>
      </div>
    </div>
    <div class="jc-body" id="jc-body">
      <div class="jc-status-card">
        <div class="jc-status-heading">
          <div class="jc-status-label">当前页面</div>
          <button class="jc-text-button" id="jc-rescan">重新扫描</button>
        </div>
        <div class="jc-page-context" id="jc-page-context">正在识别当前岗位列表...</div>
        <div class="jc-status" id="jc-status">准备扫描当前 BOSS 页面。</div>
      </div>
      <div class="jc-progress-summary" aria-label="当前页处理进度">
        <div><strong id="jc-total-count">0</strong><span>岗位</span></div>
        <div><strong id="jc-analyzed-count">0</strong><span>已分析</span></div>
        <div><strong id="jc-qualified-count">0</strong><span>达标</span></div>
        <div><strong id="jc-contacted-count">0</strong><span>已沟通</span></div>
      </div>
      <div class="jc-primary-actions">
        <button class="jc-button wide" id="jc-pipeline-control">开始自动投递</button>
      </div>
      <div class="jc-automation-box">
        <div class="jc-automation-title">换页行为</div>
        <div class="jc-control-line">
          <div>
            <span>换页后自动投递</span>
            <small id="jc-jobs-state">关闭时只刷新岗位列表，需手动开始</small>
          </div>
          <button class="jc-switch" id="jc-toggle-jobs" type="button" role="switch" aria-checked="false" aria-label="切换职位页面后自动投递"><span></span></button>
        </div>
      </div>
      <div class="jc-list-heading">
        <span>当前页岗位进度</span>
        <button class="jc-text-button" id="jc-next">定位下一个达标岗位</button>
      </div>
      <div id="jc-list"></div>
    </div>
    <div class="jc-resize-handle jc-resize-edge jc-resize-n" data-jc-resize="n"></div>
    <div class="jc-resize-handle jc-resize-edge jc-resize-e" data-jc-resize="e"></div>
    <div class="jc-resize-handle jc-resize-edge jc-resize-s" data-jc-resize="s"></div>
    <div class="jc-resize-handle jc-resize-edge jc-resize-w" data-jc-resize="w"></div>
    <div class="jc-resize-handle jc-resize-corner jc-resize-nw" data-jc-resize="nw"></div>
    <div class="jc-resize-handle jc-resize-corner jc-resize-ne" data-jc-resize="ne"></div>
    <div class="jc-resize-handle jc-resize-corner jc-resize-sw" data-jc-resize="sw"></div>
    <div class="jc-resize-handle jc-resize-corner jc-resize-se" data-jc-resize="se"></div>
  `;
  document.documentElement.appendChild(launcher);
  document.documentElement.appendChild(panel);
  panel.style.visibility = "hidden";
  panel.style.display = "block";
  if (!restorePanelGeometry(panel)) placePanelDefault(panel);
  panel.style.display = "none";
  panel.style.visibility = "";
  restoreLauncherTop(launcher);
  enableLauncherDock(launcher);
  enablePanelDrag(panel);
  enablePanelResize(panel);
  launcher.addEventListener("click", () => {
    if (launcher.dataset.skipClick === "1") {
      launcher.dataset.skipClick = "0";
      return;
    }
    openPanel(panel, launcher);
  });
  window.addEventListener("resize", () => {
    restoreLauncherTop(launcher);
    if (panel.style.display !== "none") {
      ensurePanelInViewport(panel);
      savePanelGeometry(panel);
    }
  });
  document.getElementById("jc-rescan").addEventListener("click", handleRescanOrFocusAutomationTab);
  document.getElementById("jc-pipeline-control").addEventListener("click", handlePipelineControl);
  document.getElementById("jc-toggle-jobs").addEventListener("click", toggleJobsPageAutomation);
  document.getElementById("jc-next").addEventListener("click", focusNextQualifiedJob);
  document.getElementById("jc-minimize").addEventListener("click", () => {
    const body = document.getElementById("jc-body");
    const collapsed = body.style.display !== "none";
    body.style.display = collapsed ? "none" : "block";
    panel.classList.toggle("jc-minimized", collapsed);
  });
  document.getElementById("jc-close").addEventListener("click", () => closePanel(panel, launcher));
  chrome.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "automationControl") return false;
    applyExternalAutomationControl(message.action, message.reason);
    sendResponse({ ok: true });
    return false;
  });
  sendMessage({ type: "getSettings" }).then((response) => {
    if (response?.ok) JC_STATE.settings = { ...JC_STATE.settings, ...response.settings };
    updateAutomationControls();
    watchRuntimeSettingChanges();
    startPageContextWatcher();
    bootstrapAutomationContext().catch((error) => setStatus(`恢复自动投递状态失败：${error.message || error}`));
  }).catch((error) => setStatus(`读取插件设置失败：${error.message || error}`));
}

function watchRuntimeSettingChanges() {
  if (!chrome.storage?.onChanged?.addListener) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !RUNTIME_SETTING_KEYS.some((key) => key in changes)) return;
    refreshRuntimeSettings().catch(() => {});
  });
}

async function refreshRuntimeSettings() {
  // Read back through the service worker rather than storage directly so the
  // page sees the same normalized values the analysis prompt is built from.
  const response = await sendMessage({ type: "getSettings" });
  if (!response?.ok) return false;
  const previousMinScore = Number(JC_STATE.settings.minScore);
  JC_STATE.settings = { ...JC_STATE.settings, ...response.settings };
  updateAutomationControls();
  // The pass mark decides which analyzed jobs count as qualified, so the list
  // and the progress counters are stale the moment it moves. Already-completed
  // jobs stay completed: lowering the bar mid-run must not silently reopen
  // contact attempts on jobs the user already saw rejected.
  if (Number(JC_STATE.settings.minScore) !== previousMinScore) {
    renderList();
    schedulePersistAutomationSession();
    setStatus(`达标线已更新为 ${JC_STATE.settings.minScore} 分，当前列表判定已刷新。`);
  }
  return true;
}

async function bootstrapAutomationContext() {
  if (isJobsPage()) await synchronizePageContext({ force: true, source: "bootstrap" });
  await refreshAutomationSession();
  setInterval(() => {
    if (!JC_STATE.sessionOwner) refreshAutomationSession().catch(() => {});
  }, 2000);
}

async function refreshAutomationSession() {
  const response = await sendMessage({ type: "getAutomationSession" });
  if (!response?.ok || !response.session?.active) {
    JC_STATE.remoteSession = null;
    const rescan = document.getElementById("jc-rescan");
    if (rescan) rescan.textContent = "重新扫描";
    if (!isJobsPage()) {
      setNodeText("jc-page-context", "当前页面不是职位列表");
      setStatus("请在 BOSS 职位列表页启动自动投递。");
    }
    updateAutomationControls();
    return;
  }
  if (response.isOwner && isJobsPage()) {
    restoreOwnedAutomationSession(response.session);
    return;
  }
  if (response.isOwner) {
    JC_STATE.remoteSession = null;
    JC_STATE.sessionOwner = true;
    setNodeText("jc-page-context", "受保护职位标签已离开职位列表");
    setStatus(response.session.status
      || "当前职位标签误入非职位页，自动投递已暂停；请先返回职位列表。");
    updateAutomationControls();
    return;
  }
  JC_STATE.remoteSession = response.session;
  JC_STATE.sessionOwner = false;
  renderRemoteAutomationState();
}

function restoreOwnedAutomationSession(session) {
  if (!session) return;
  JC_STATE.dismissedJobKeys = new Set(
    (Array.isArray(session.dismissedJobKeys) ? session.dismissedJobKeys : []).slice(-MAX_COMPLETED_JOB_KEYS)
  );
  JC_STATE.jobs = JC_STATE.jobs.filter((job) => !JC_STATE.dismissedJobKeys.has(job.key));
  const currentKeys = new Set(JC_STATE.jobs.map((job) => job.key));
  const restoredAnalyses = Object.entries(session.analyses || {}).filter(([key]) => currentKeys.has(key));
  const restoredProgress = Object.entries(session.progress || {}).filter(([key]) => currentKeys.has(key));
  JC_STATE.sessionOwner = true;
  JC_STATE.remoteSession = null;
  JC_STATE.analyses = new Map(restoredAnalyses);
  JC_STATE.jobProgress = new Map(restoredProgress);
  JC_STATE.completedJobKeys = new Set(
    (Array.isArray(session.completedJobKeys) ? session.completedJobKeys : []).slice(-MAX_COMPLETED_JOB_KEYS)
  );
  for (const job of JC_STATE.jobs) {
    if (!JC_STATE.jobProgress.has(job.key)) JC_STATE.jobProgress.set(job.key, { status: "pending", detail: "" });
  }
  JC_STATE.pipeline.active = session.active === true;
  JC_STATE.pipeline.mode = session.mode === "auto" ? "auto" : "idle";
  JC_STATE.pipeline.phase = String(session.phase
    || (session.paused ? "paused" : (session.active && session.mode === "auto" ? "analysis" : "idle")));
  JC_STATE.pipeline.allPaused = session.paused === true;
  JC_STATE.pipeline.pauseReason = String(session.pauseReason || "");
  // Batch counters only describe the list they were counted on. A reload that
  // renders a different list (BOSS re-queries on refresh) must start over
  // instead of inheriting "batch 7" from the previous list.
  if (String(session.fingerprint || "") === String(JC_STATE.page.fingerprint || "")) {
    JC_STATE.pipeline.batchNumber = Math.max(1, Number(session.batchNumber) || 1);
    JC_STATE.pipeline.batchKeys = Array.isArray(session.batchKeys)
      ? session.batchKeys.filter((key) => currentKeys.has(key)).slice(0, JOB_BATCH_SIZE)
      : [];
    JC_STATE.pipeline.batchSize = Math.max(0, Number(session.batchSize)
      || JC_STATE.pipeline.batchKeys.length);
    JC_STATE.pipeline.batchWaitRemainingMs = Math.max(0, Number(session.batchWaitRemainingMs) || 0);
    JC_STATE.pipeline.waitingForNextBatch = session.waitingForNextBatch === true
      || JC_STATE.pipeline.batchWaitRemainingMs > 0;
    JC_STATE.pipeline.loadingNextBatch = session.loadingNextBatch === true;
  } else {
    resetBatchProgress();
  }
  const restoredContactJobKey = String(session.currentJobKey || "");
  JC_STATE.pipeline.contactInFlight = session.contactInFlight === true && Boolean(restoredContactJobKey);
  JC_STATE.currentJobKey = JC_STATE.pipeline.contactInFlight ? restoredContactJobKey : "";
  renderList();
  setStatus(session.status || "已恢复专用职位标签的自动投递进度。");
  updateAutomationControls();
  if (JC_STATE.pipeline.active && !JC_STATE.pipeline.allPaused) ensureAnalysisWorker();
}

function renderRemoteAutomationState() {
  const session = JC_STATE.remoteSession;
  if (!session?.active) return;
  setNodeText("jc-page-context", "自动投递正在另一个职位标签运行");
  setStatus(session.status || "可以继续浏览当前页面，投递任务不会中断。");
  const summary = session.summary || {};
  setNodeText("jc-total-count", summary.total || 0);
  setNodeText("jc-analyzed-count", summary.analyzed || 0);
  setNodeText("jc-qualified-count", summary.qualified || 0);
  setNodeText("jc-contacted-count", summary.contacted || 0);
  const rescan = document.getElementById("jc-rescan");
  if (rescan) rescan.textContent = "打开投递标签";
  updateAnalysisControls();
}

async function handleRescanOrFocusAutomationTab() {
  if (JC_STATE.remoteSession?.active && !JC_STATE.sessionOwner) {
    await sendMessage({ type: "focusAutomationTab" });
    return;
  }
  await synchronizePageContext({ force: true, source: "manual" });
}

function applyExternalAutomationControl(action, reason = "manual") {
  if (!JC_STATE.sessionOwner) return;
  if (action === "pause") {
    JC_STATE.pipeline.allPaused = true;
    JC_STATE.pipeline.phase = "paused";
    JC_STATE.pipeline.pauseReason = reason === "machine_locked" ? "machine_locked" : "external";
    if (reason === "machine_locked") {
      setStatus("电脑已锁定，自动投递将在当前步骤结束后暂停。");
    } else {
      setStatus("已从其他标签暂停自动投递，当前步骤结束后停止。");
    }
  } else if (action === "resume") {
    JC_STATE.pipeline.allPaused = false;
    JC_STATE.pipeline.phase = JC_STATE.pipeline.waitingForNextBatch
      ? "batch_wait"
      : (JC_STATE.pipeline.loadingNextBatch
        ? "batch_loading"
        : (JC_STATE.pipeline.active ? "analysis" : "idle"));
    JC_STATE.pipeline.pauseReason = "";
    setStatus(reason === "machine_active"
      ? "电脑恢复使用，自动投递已自动继续。"
      : "已从其他标签继续自动投递。");
    if (JC_STATE.pipeline.waitingForNextBatch) {
      advanceToNextBatch().catch((error) => setStatus(`恢复批次等待失败：${error.message || error}`));
    } else {
      ensureAnalysisWorker();
    }
  }
  updateAutomationControls();
  schedulePersistAutomationSession();
}

async function setJobsPageAutomation(enabled) {
  await setAutomationFlag("autoRunOnJobsPage", enabled);
  setStatus(enabled
    ? "已开启换页自动投递。切换职位分类或搜索结果后，新页面会自动分析，达标后按保守节奏沟通。"
    : "已关闭换页自动投递。切换页面时只刷新岗位列表，需要手动点击开始。"
  );
  updateAutomationControls();
}

function setAutomationFlag(key, value) {
  JC_STATE.settings[key] = value;
  return new Promise((resolve, reject) => {
    if (!extensionContextAvailable()) {
      invalidateExtensionContext();
      resolve(false);
      return;
    }
    try {
      chrome.storage.local.set({ [key]: value }, () => {
        let error = null;
        try {
          error = chrome.runtime.lastError;
        } catch (runtimeError) {
          invalidateExtensionContext();
          resolve(false);
          return;
        }
        if (error) reject(new Error(error.message));
        else resolve(true);
      });
    } catch (error) {
      if (isExtensionContextError(error)) {
        invalidateExtensionContext();
        resolve(false);
      } else {
        reject(error);
      }
    }
  });
}

function updateAutomationControls() {
  updateSwitch("jc-toggle-jobs", JC_STATE.settings.autoRunOnJobsPage);
  updateAutomationStateLabels();
  updateAnalysisControls();
}

function updateAutomationStateLabels() {
  const recommendNode = document.getElementById("jc-jobs-state");
  if (recommendNode) {
    recommendNode.textContent = JC_STATE.settings.autoRunOnJobsPage
      ? "开启：换页后自动分析，达标后稍候沟通"
      : "关闭：只刷新岗位列表，需手动开始";
  }
}

function updateSwitch(id, active) {
  const node = document.getElementById(id);
  if (!node) return;
  node.setAttribute("aria-checked", active ? "true" : "false");
  node.classList.toggle("is-on", Boolean(active));
}

async function toggleJobsPageAutomation() {
  await setJobsPageAutomation(!JC_STATE.settings.autoRunOnJobsPage);
}

async function handlePipelineControl() {
  if (JC_STATE.pipeline.controlActionInFlight) return;
  JC_STATE.pipeline.controlActionInFlight = true;
  try {
    if (JC_STATE.remoteSession?.active && !JC_STATE.sessionOwner) {
      const action = JC_STATE.remoteSession.paused ? "resume" : "pause";
      await sendMessage({ type: "controlAutomationTab", action });
      await sleep(250);
      await refreshAutomationSession();
      return;
    }
    if (JC_STATE.pipeline.contextInvalidated) {
      setStatus("扩展已重新加载；为保护当前职位列表，插件不会自动刷新。请确认筛选条件已保存后，使用浏览器刷新按钮手动加载新版。");
      updateAutomationControls();
      return;
    }
    if (JC_STATE.pipeline.allPaused) {
      JC_STATE.pipeline.allPaused = false;
      JC_STATE.pipeline.pauseReason = "";
      JC_STATE.pipeline.phase = JC_STATE.pipeline.waitingForNextBatch
        ? "batch_wait"
        : (JC_STATE.pipeline.loadingNextBatch
          ? "batch_loading"
          : (JC_STATE.pipeline.active ? "analysis" : "idle"));
      setStatus("自动投递已继续，将从未完成岗位接着执行。");
      logAutomationEvent("automation_resumed_manual", {
        detail: "source=owner_panel"
      });
      updateAutomationControls();
      if (JC_STATE.pipeline.waitingForNextBatch) {
        advanceToNextBatch().catch((error) => setStatus(`恢复批次等待失败：${error.message || error}`));
      } else {
        ensureAnalysisWorker();
      }
      return;
    }
    if (JC_STATE.pipeline.waitingForNextBatch || JC_STATE.pipeline.loadingNextBatch) {
      JC_STATE.pipeline.allPaused = true;
      JC_STATE.pipeline.pauseReason = "manual";
      JC_STATE.pipeline.phase = "paused";
      setStatus("正在暂停连续投递，批次进度会保留。");
      logAutomationEvent("automation_paused_manual", {
        detail: "source=owner_panel;phase=batch_transition"
      });
      updateAutomationControls();
      schedulePersistAutomationSession();
      return;
    }
    if (JC_STATE.analyzing) {
      JC_STATE.pipeline.allPaused = true;
      JC_STATE.pipeline.pauseReason = "manual";
      JC_STATE.pipeline.phase = "paused";
      setStatus("正在暂停自动投递。当前步骤结束后停止，岗位进度会保留。");
      logAutomationEvent("automation_paused_manual", {
        detail: "source=owner_panel;phase=analysis"
      });
      updateAutomationControls();
      return;
    }
    if (JC_STATE.pipeline.mode === "auto" && JC_STATE.pipeline.active
        && !JC_STATE.jobs.some((job) => jobNeedsProcessing(job))) {
      setStatus("当前页已经处理完成。切换职位页面后可开始处理新岗位。");
      updateAutomationControls();
      return;
    }
    await startAutoPipeline();
  } finally {
    JC_STATE.pipeline.controlActionInFlight = false;
    updateAutomationControls();
  }
}

function openPanel(panel, launcher) {
  panel.style.display = "block";
  launcher.style.display = "none";
  panel.classList.remove("jc-minimized");
  const body = document.getElementById("jc-body");
  if (body) body.style.display = "block";
  updateAutomationControls();
  ensurePanelInViewport(panel);
}

function closePanel(panel, launcher) {
  panel.style.display = "none";
  launcher.style.display = "flex";
  restoreLauncherTop(launcher);
}

function buildCustomInstructions() {
  return [
    JC_STATE.settings.customInstructions ? `评分偏好：${JC_STATE.settings.customInstructions}` : "",
    JC_STATE.settings.greetingStyle ? `话术风格：${JC_STATE.settings.greetingStyle}` : ""
  ].filter(Boolean).join("\n");
}

function progressFor(job) {
  return JC_STATE.jobProgress.get(job.key) || {
    status: JC_STATE.analyses.has(job.key) ? analysisProgressStatus(job) : "pending",
    detail: ""
  };
}

function setJobProgress(jobOrKey, status, detail = "") {
  const key = typeof jobOrKey === "string" ? jobOrKey : jobOrKey?.key;
  if (!key) return;
  JC_STATE.jobProgress.set(key, { status, detail, updatedAt: Date.now() });
  schedulePersistAutomationSession();
}

function analysisProgressStatus(job) {
  const analysis = JC_STATE.analyses.get(job.key);
  if (!analysis) return "pending";
  if (["error", "network_error"].includes(analysis.decision)) return "error";
  return isQualifiedJob(job) ? "qualified" : "not_qualified";
}

async function analyzeJobs(options = {}) {
  const force = Boolean(options.force);
  if (JC_STATE.analyzing) {
    return { completed: false, reason: "running" };
  }
  if (JC_STATE.pipeline.allPaused) {
    setStatus("当前处理已暂停，点击“继续自动投递”后从保留进度继续。");
    return { completed: false, reason: "paused" };
  }
  JC_STATE.pipeline.ownerRouteEscaped = false;
  if (!JC_STATE.page.initialized || !JC_STATE.jobs.length) {
    await synchronizePageContext({ force: true, source: "analysis" });
  }
  if (!JC_STATE.jobs.length) {
    setStatus("当前页没有可分析的岗位。");
    return { completed: true, analyzed: 0 };
  }
  if (force) discardAnalysesForForcedRun();
  // A list-row retry is a single-job recovery action. Keep this local flag
  // after retryJobKey is consumed so completing the retry cannot silently
  // advance into the next batch while the user expects the run to stay paused.
  const retryContactOnlyRun = Boolean(JC_STATE.retryContactJobKey);
  const retryOnlyRun = Boolean(JC_STATE.retryJobKey) || retryContactOnlyRun;
  prepareCurrentBatch();
  if (!JC_STATE.jobs.some((job) => jobNeedsProcessing(job))) {
    return settleRunWithNothingToProcess(retryOnlyRun, retryContactOnlyRun);
  }

  const runId = JC_STATE.analysisRunId + 1;
  const pageGeneration = JC_STATE.page.generation;
  JC_STATE.analysisRunId = runId;
  JC_STATE.analyzing = true;
  updateAnalysisControls();

  let analyzedCount = 0;
  // One loop owns both steps: analyze a job, then immediately communicate if it
  // passes. There is no second queue, timer, or delayed hand-off.
  while (true) {
    if (isRunSuperseded(runId, pageGeneration)) {
      return { completed: false, reason: "superseded", analyzed: analyzedCount };
    }
    if (JC_STATE.pipeline.allPaused) {
      JC_STATE.analyzing = false;
      JC_STATE.pipeline.phase = "paused";
      updateAnalysisControls();
      setStatus(`当前处理已暂停，本轮新分析 ${analyzedCount} 个岗位；进度已保留。`);
      return { completed: false, reason: "paused", analyzed: analyzedCount };
    }
    if (pageNeedsHuman()) {
      JC_STATE.analyzing = false;
      JC_STATE.pipeline.allPaused = true;
      JC_STATE.pipeline.phase = "paused";
      updateAnalysisControls();
      setStatus("页面出现登录、验证码或安全验证，已暂停处理，请先人工处理。");
      return { completed: false, reason: "human_verification", analyzed: analyzedCount };
    }

    const job = takeNextJobForProcessing();
    if (!job) break;

    const existingAnalysis = JC_STATE.analyses.get(job.key);
    if (existingAnalysis) {
      const contactResult = await contactQualifiedJob(job, { runId, pageGeneration });
      const halted = contactOutcomeToRunResult(contactResult, analyzedCount);
      if (halted) return halted;
      await sleep(BETWEEN_JOBS_DELAY_MS);
      continue;
    }

    setJobProgress(job, "analyzing");
    setStatus(`正在定位并读取完整岗位详情：${job.title}`);
    renderList();
    const jobDescription = await collectJobDescriptionForAnalysis(job);
    if (isRunSuperseded(runId, pageGeneration)) {
      return { completed: false, reason: "superseded", analyzed: analyzedCount };
    }
    if (JC_STATE.pipeline.ownerRouteEscaped) {
      JC_STATE.analyzing = false;
      updateAutomationControls();
      renderList();
      return { completed: false, reason: "owner_route_escape", analyzed: analyzedCount };
    }
    if (JC_STATE.pipeline.allPaused) {
      JC_STATE.analyzing = false;
      JC_STATE.pipeline.phase = "paused";
      setJobProgress(job, "pending", "已暂停，尚未请求 AI");
      updateAutomationControls();
      renderList();
      return { completed: false, reason: "paused", analyzed: analyzedCount };
    }
    setStatus(`AI 分析中：${job.title}${jobDescription.complete ? "（完整 JD）" : "（卡片信息）"}`);
    const payload = buildAnalysisPayload(job, jobDescription);
    JC_STATE.analysisPayloads.set(job.key, payload);
    const response = await requestAiAnalysis(job, payload);
    if (isRunSuperseded(runId, pageGeneration)) {
      return { completed: false, reason: "superseded", analyzed: analyzedCount };
    }
    if (response?.ok) {
      applyAnalysisPerformance(response.analysis, response.performance);
      JC_STATE.analyses.set(job.key, response.analysis);
      analyzedCount += 1;
      if (isQualifiedJob(job)) {
        setJobProgress(job, "qualified");
        renderList();
        if (JC_STATE.pipeline.mode === "auto") {
          const contactResult = await contactQualifiedJob(job, { runId, pageGeneration });
          const halted = contactOutcomeToRunResult(contactResult, analyzedCount);
          if (halted) return halted;
        }
      } else {
        setJobProgress(job, "not_qualified");
        completeJob(job);
        setStatus(`岗位未达标，${Math.round(BETWEEN_JOBS_DELAY_MS / 1000)} 秒后处理下一个：${job.title}`);
      }
    } else {
      const halted = recordFailedAnalysis(job, response, analyzedCount);
      if (halted) return halted;
    }
    renderList();
    await sleep(BETWEEN_JOBS_DELAY_MS);
  }

  if (JC_STATE.analysisRunId === runId) JC_STATE.analyzing = false;
  if (retryOnlyRun) {
    JC_STATE.pipeline.allPaused = true;
    updateAutomationControls();
    setStatus(retryContactOnlyRun
      ? "单岗位沟通重试已完成，自动投递保持暂停。"
      : "重新分析已完成，自动投递保持暂停；需要时可手动继续。");
    schedulePersistAutomationSession();
    return { completed: true, reason: "retry_completed", analyzed: analyzedCount };
  }
  if (JC_STATE.pipeline.mode === "auto" && JC_STATE.pipeline.active) {
    updateAnalysisControls();
    return advanceToNextBatch();
  }
  JC_STATE.pipeline.active = false;
  JC_STATE.pipeline.phase = "idle";
  updateAnalysisControls();
  setStatus(JC_STATE.pipeline.mode === "auto"
    ? "当前页处理完成：未达标岗位未沟通，达标岗位均已完成沟通或标明具体失败原因。"
    : "当前页 AI 分析已完成。达标岗位已在下方列表标记。"
  );
  schedulePersistAutomationSession();
  return { completed: true, analyzed: analyzedCount };
}

function discardAnalysesForForcedRun() {
  for (const job of JC_STATE.jobs) {
    JC_STATE.analyses.delete(job.key);
    JC_STATE.analysisPayloads.delete(job.key);
    JC_STATE.completedJobKeys.delete(job.key);
    setJobProgress(job, "pending");
  }
  JC_STATE.pipeline.batchKeys = [];
}

function settleRunWithNothingToProcess(retryOnlyRun, retryContactOnlyRun) {
  if (retryOnlyRun) {
    JC_STATE.pipeline.allPaused = true;
    setStatus(retryContactOnlyRun
      ? "单岗位沟通重试已完成，自动投递保持暂停。"
      : "重新分析已完成，自动投递保持暂停；需要时可手动继续。");
    updateAutomationControls();
    schedulePersistAutomationSession();
    return { completed: true, reason: "retry_completed", analyzed: 0 };
  }
  if (JC_STATE.pipeline.mode === "auto" && JC_STATE.pipeline.active) {
    return advanceToNextBatch();
  }
  JC_STATE.pipeline.active = false;
  JC_STATE.pipeline.phase = "idle";
  setStatus(JC_STATE.pipeline.mode === "auto"
    ? "当前页岗位已处理完成，所有达标岗位都已完成沟通尝试。"
    : "当前页岗位已全部分析，无需重复请求 AI。"
  );
  renderList();
  schedulePersistAutomationSession();
  return { completed: true, analyzed: 0 };
}

// A user-requested retry always runs before untouched jobs, while retaining the
// stable job key so a failed request cannot be applied to another card. The
// retry key is consumed here so the retry runs exactly once.
function takeNextJobForProcessing() {
  const requestedRetryKey = JC_STATE.retryContactJobKey || JC_STATE.retryJobKey;
  const retryJob = requestedRetryKey
    ? JC_STATE.jobs.find((item) => item.key === requestedRetryKey && jobNeedsProcessing(item))
    : null;
  const job = retryJob || JC_STATE.jobs.find((item) => jobNeedsProcessing(item));
  if (!job) return null;
  if (job.key === JC_STATE.retryJobKey) JC_STATE.retryJobKey = "";
  if (job.key === JC_STATE.retryContactJobKey) JC_STATE.retryContactJobKey = "";
  return job;
}

// A page swap or a newer run invalidates everything the current run is holding,
// so its result must be discarded rather than written back over fresher state.
function isRunSuperseded(runId, pageGeneration) {
  return JC_STATE.analysisRunId !== runId || JC_STATE.page.generation !== pageGeneration;
}

// Translates a contact outcome into the result analyzeJobs returns, or null
// when the run should carry on to the next job.
function contactOutcomeToRunResult(contactResult, analyzedCount) {
  if (contactResult === "superseded") {
    return { completed: false, reason: "superseded", analyzed: analyzedCount };
  }
  if (contactResult === "paused" || contactResult === "halted") {
    JC_STATE.analyzing = false;
    updateAutomationControls();
    return {
      completed: false,
      reason: contactResult === "paused" ? "paused" : "contact_halted",
      analyzed: analyzedCount
    };
  }
  return null;
}

function buildAnalysisPayload(job, jobDescription) {
  return {
    platform: "boss",
    title: job.title,
    company: job.company,
    city: job.city || "",
    salary: salaryForAi(job.salary),
    jd: jobDescription.text,
    jdComplete: jobDescription.complete,
    url: job.url,
    resumeProfile: JC_STATE.settings.profile,
    currentLocation: JC_STATE.settings.currentLocation,
    targetDirections: JC_STATE.settings.targetDirections,
    excludedDirections: JC_STATE.settings.excludedDirections,
    customInstructions: buildCustomInstructions()
  };
}

// Records the failure on the job row, and returns a run result only when the
// failure has to stop the whole run instead of just this job.
function recordFailedAnalysis(job, response, analyzedCount) {
  const error = response?.error || "分析失败";
  if (isExtensionContextError(error)) {
    stopForInvalidatedExtensionContext(job);
    return { completed: false, reason: "extension_context_invalidated", analyzed: analyzedCount };
  }
  JC_STATE.analyses.set(job.key, {
    score: "--",
    decision: "network_error",
    greeting: "",
    reasons: [friendlyAiError(error)],
    rawError: error
  });
  setJobProgress(job, "error", friendlyAiError(error));
  // A transient network fault must not burn the job: drop the placeholder so it
  // stays pending, and pause so the user can resume from the same job.
  if (isTransientAiError(error)) {
    JC_STATE.analyses.delete(job.key);
    JC_STATE.analyzing = false;
    JC_STATE.pipeline.allPaused = true;
    JC_STATE.pipeline.phase = "paused";
    updateAutomationControls();
    renderList();
    setStatus(`AI 网络暂时不可用，当前处理已暂停。\n${friendlyAiError(error)}`);
    return { completed: false, reason: "network_error", analyzed: analyzedCount };
  }
  completeJob(job);
  return null;
}

function ensureAnalysisWorker() {
  if (!JC_STATE.pipeline.active || JC_STATE.pipeline.allPaused || JC_STATE.analyzing
      || JC_STATE.pipeline.waitingForNextBatch || JC_STATE.pipeline.loadingNextBatch) return;
  analyzeJobs({ force: false }).catch((error) => {
    if (isExtensionContextError(error)) {
      stopForInvalidatedExtensionContext();
      return;
    }
    JC_STATE.analyzing = false;
    setStatus(`AI 分析异常：${error.message || error}`);
    updateAutomationControls();
  });
}

function updateAnalysisControls() {
  const button = document.getElementById("jc-pipeline-control");
  if (!button) return;
  if (JC_STATE.pipeline.controlActionInFlight) {
    button.disabled = true;
    button.textContent = "正在更新自动投递状态…";
    return;
  }
  button.disabled = false;
  if (JC_STATE.remoteSession?.active && !JC_STATE.sessionOwner) {
    button.textContent = JC_STATE.remoteSession.paused ? "继续另一个标签" : "暂停另一个标签";
    return;
  }
  if (!isJobsPage()) {
    button.textContent = "请在职位页开始";
    button.disabled = true;
    return;
  }
  if (JC_STATE.pipeline.contextInvalidated) {
    button.textContent = "扩展已更新，请手动刷新";
    button.disabled = true;
    return;
  }
  if (JC_STATE.pipeline.starting) {
    button.textContent = "正在启动自动投递…";
    button.disabled = true;
    return;
  }
  if (JC_STATE.pipeline.allPaused) {
    button.textContent = "继续自动投递";
    return;
  }
  if (JC_STATE.pipeline.active
      && (JC_STATE.pipeline.waitingForNextBatch || JC_STATE.pipeline.loadingNextBatch)) {
    button.textContent = "暂停连续投递";
    return;
  }
  if (JC_STATE.analyzing) {
    button.textContent = "暂停自动投递";
    return;
  }
  if (JC_STATE.pipeline.mode === "auto" && JC_STATE.pipeline.active
      && !JC_STATE.jobs.some((job) => jobNeedsProcessing(job))) {
    button.textContent = "当前页已完成";
    button.disabled = true;
    return;
  }
  button.textContent = "确认并开始自动投递";
}

async function startAutoPipeline() {
  if (JC_STATE.pipeline.starting) return false;
  if (pageNeedsHuman()) {
    setStatus("页面疑似需要登录、验证码或安全验证，请先人工处理。");
    return false;
  }
  JC_STATE.pipeline.starting = true;
  updateAutomationControls();
  try {
    if (!canReuseJobSnapshotForPipeline()) {
      await synchronizePageContext({ source: "pipeline" });
    }
    if (!JC_STATE.jobs.length) {
      setStatus("当前职位页没有识别到岗位，暂时不能启动自动投递。");
      return false;
    }
    if (!JC_STATE.pipeline.active || JC_STATE.pipeline.mode !== "auto") {
      resetBatchProgress();
      // Starting a new run on the current list must analyze its first card;
      // completion markers belong to the previous run, not this queue.
      JC_STATE.completedJobKeys.clear();
    }
    JC_STATE.pipeline.active = true;
    JC_STATE.pipeline.mode = "auto";
    JC_STATE.pipeline.phase = "analysis";
    JC_STATE.pipeline.allPaused = false;
    JC_STATE.pipeline.pauseReason = "";
    JC_STATE.pipeline.ownerRouteEscaped = false;
    JC_STATE.sessionOwner = true;
    JC_STATE.remoteSession = null;
    await registerAutomationSession();
    setStatus("自动投递已启动：逐个分析岗位，达标后按保守节奏沟通并留在当前页。");
    ensureAnalysisWorker();
    return true;
  } finally {
    JC_STATE.pipeline.starting = false;
    updateAutomationControls();
  }
}

function canReuseJobSnapshotForPipeline() {
  if (!JC_STATE.page.initialized || !JC_STATE.jobs.length) return false;
  if (JC_STATE.page.url !== location.href.split("#")[0]) return false;
  const cards = findCards();
  const liveJobs = JC_STATE.jobs.filter((job) => !job.detached);
  if (!cards.length || cards.length !== liveJobs.length) return false;
  return cards.every((card, index) => liveJobs[index]?.card === card && card.isConnected);
}

async function registerAutomationSession() {
  const response = await sendMessage({
    type: "registerAutomationSession",
    session: buildAutomationSessionPayload({ active: true })
  });
  if (!response?.ok) throw new Error(response?.error || "无法登记自动投递标签");
}

function buildAutomationSessionPayload(overrides = {}) {
  const jobs = JC_STATE.jobs;
  const payload = {
    active: JC_STATE.pipeline.active,
    paused: JC_STATE.pipeline.allPaused,
    pauseReason: JC_STATE.pipeline.pauseReason,
    mode: JC_STATE.pipeline.mode,
    phase: JC_STATE.pipeline.phase,
    jobsUrl: JC_STATE.page.url || location.href.split("#")[0],
    fingerprint: JC_STATE.page.fingerprint,
    analyses: Object.fromEntries(JC_STATE.analyses),
    progress: Object.fromEntries(JC_STATE.jobProgress),
    dismissedJobKeys: Array.from(JC_STATE.dismissedJobKeys).slice(-MAX_COMPLETED_JOB_KEYS),
    completedJobKeys: Array.from(JC_STATE.completedJobKeys).slice(-500),
    batchNumber: JC_STATE.pipeline.batchNumber,
    batchKeys: JC_STATE.pipeline.batchKeys.slice(0, JOB_BATCH_SIZE),
    batchSize: JC_STATE.pipeline.batchSize,
    batchWaitRemainingMs: JC_STATE.pipeline.batchWaitRemainingMs,
    waitingForNextBatch: JC_STATE.pipeline.waitingForNextBatch,
    loadingNextBatch: JC_STATE.pipeline.loadingNextBatch,
    summary: {
      total: jobs.length,
      analyzed: jobs.filter((job) => JC_STATE.analyses.has(job.key)).length,
      qualified: jobs.filter((job) => isQualifiedJob(job)).length,
      contacted: jobs.filter((job) => progressFor(job).status === "contacted").length
    },
    status: document.getElementById("jc-status")?.textContent || "",
    contactInFlight: JC_STATE.pipeline.contactInFlight === true,
    currentJobKey: JC_STATE.currentJobKey,
    updatedAt: Date.now(),
    ...overrides
  };
  return payload;
}

function schedulePersistAutomationSession() {
  if (!JC_STATE.sessionOwner || JC_STATE.pipeline.contextInvalidated) return;
  if (!extensionContextAvailable()) {
    invalidateExtensionContext();
    return;
  }
  clearTimeout(sessionPersistTimer);
  sessionPersistTimer = setTimeout(() => {
    if (!extensionContextAvailable()) {
      invalidateExtensionContext();
      return;
    }
    sendMessage({
      type: "updateAutomationSession",
      patch: buildAutomationSessionPayload()
    }).catch(() => {});
  }, 120);
}

async function persistAutomationSessionNow() {
  if (!JC_STATE.sessionOwner || JC_STATE.pipeline.contextInvalidated) {
    throw new Error("当前标签无法保存自动投递状态");
  }
  clearTimeout(sessionPersistTimer);
  sessionPersistTimer = null;
  const response = await sendMessage({
    type: "updateAutomationSession",
    patch: buildAutomationSessionPayload()
  });
  if (!response?.ok) throw new Error(response?.error || "无法保存自动投递状态");
  return true;
}

function isQualifiedJob(job) {
  const analysis = JC_STATE.analyses.get(job.key);
  return Boolean(analysis)
    && analysis.excluded !== true
    && Number(analysis.score) >= Number(JC_STATE.settings.minScore || 0);
}

function jobNeedsProcessing(job) {
  if (JC_STATE.completedJobKeys.has(job.key)) return false;
  if (JC_STATE.pipeline.batchKeys.length && !JC_STATE.pipeline.batchKeys.includes(job.key)) return false;
  const analysis = JC_STATE.analyses.get(job.key);
  if (!analysis) return progressFor(job).status !== "analyzing";
  if (JC_STATE.pipeline.mode !== "auto" || !isQualifiedJob(job)) return false;
  return !["contacted", "unavailable", "detail_mismatch", "attention"].includes(progressFor(job).status);
}

function resetBatchProgress() {
  JC_STATE.pipeline.batchNumber = 1;
  JC_STATE.pipeline.batchKeys = [];
  JC_STATE.pipeline.batchSize = 0;
  JC_STATE.pipeline.batchWaitRemainingMs = 0;
  JC_STATE.pipeline.waitingForNextBatch = false;
  JC_STATE.pipeline.loadingNextBatch = false;
}

function prepareCurrentBatch() {
  for (const job of JC_STATE.jobs) {
    const progress = progressFor(job);
    const analysis = JC_STATE.analyses.get(job.key);
    if (analysis && (!isQualifiedJob(job)
        || ["contacted", "unavailable", "detail_mismatch", "attention"].includes(progress.status))) {
      rememberCompletedJobKey(job.key);
    }
  }
  const current = JC_STATE.pipeline.batchKeys.filter((key) => {
    const job = JC_STATE.jobs.find((item) => item.key === key);
    return job && !job.detached && !JC_STATE.completedJobKeys.has(key);
  });
  if (current.length) {
    JC_STATE.pipeline.batchKeys = current;
    JC_STATE.pipeline.batchSize = current.length;
    return current;
  }
  JC_STATE.pipeline.batchKeys = JC_STATE.jobs
    .filter((job) => !job.detached && !JC_STATE.completedJobKeys.has(job.key))
    .slice(0, JOB_BATCH_SIZE)
    .map((job) => job.key);
  JC_STATE.pipeline.batchSize = JC_STATE.pipeline.batchKeys.length;
  schedulePersistAutomationSession();
  return JC_STATE.pipeline.batchKeys;
}

function completeJob(job) {
  if (!job?.key) return;
  rememberCompletedJobKey(job.key);
  schedulePersistAutomationSession();
}

function rememberCompletedJobKey(key) {
  rememberBoundedJobKey(JC_STATE.completedJobKeys, key);
}

function rememberDismissedJobKey(key) {
  rememberBoundedJobKey(JC_STATE.dismissedJobKeys, key);
}

// Both key sets are capped at the same size the session payload is trimmed to.
// Without the cap the in-memory set and the persisted one drift apart, and
// applyJobSnapshot pays an O(n) copy of the set on every page sync.
function rememberBoundedJobKey(keys, key) {
  if (!key) return;
  keys.delete(key);
  keys.add(key);
  while (keys.size > MAX_COMPLETED_JOB_KEYS) {
    keys.delete(keys.values().next().value);
  }
}

async function advanceToNextBatch() {
  if (JC_STATE.pipeline.loadingNextBatch) {
    return { completed: false, reason: "batch_transition" };
  }
  const resumingBatchWait = JC_STATE.pipeline.waitingForNextBatch;
  JC_STATE.pipeline.waitingForNextBatch = true;
  JC_STATE.pipeline.phase = "batch_wait";
  if (!resumingBatchWait) {
    JC_STATE.pipeline.batchKeys = [];
    JC_STATE.pipeline.batchWaitRemainingMs = BETWEEN_BATCHES_DELAY_MS;
  }
  updateAutomationControls();

  const waitDuration = resumingBatchWait
    ? JC_STATE.pipeline.batchWaitRemainingMs
    : BETWEEN_BATCHES_DELAY_MS;
  const deadline = Date.now() + Math.max(0, waitDuration);
  logAutomationEvent(resumingBatchWait ? "batch_wait_resumed" : "batch_wait_started", {
    detail: `batch=${JC_STATE.pipeline.batchNumber};delayMs=${Math.max(0, waitDuration)}`
  });
  schedulePersistAutomationSession();
  while (Date.now() < deadline) {
    if (!JC_STATE.pipeline.active || JC_STATE.pipeline.allPaused) {
      JC_STATE.pipeline.batchWaitRemainingMs = Math.max(0, deadline - Date.now());
      JC_STATE.pipeline.phase = "paused";
      updateAutomationControls();
      setStatus("连续投递已暂停，批次进度已保留。");
      logAutomationEvent("batch_wait_interrupted", {
        detail: `batch=${JC_STATE.pipeline.batchNumber};reason=paused`
      });
      schedulePersistAutomationSession();
      return { completed: false, reason: "paused" };
    }
    const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    JC_STATE.pipeline.batchWaitRemainingMs = Math.max(0, deadline - Date.now());
    setStatus(`第 ${JC_STATE.pipeline.batchNumber} 批已完成，${seconds} 秒后加载后续岗位。`);
    await sleep(Math.min(1000, deadline - Date.now()));
  }

  logAutomationEvent("batch_wait_completed", {
    detail: `batch=${JC_STATE.pipeline.batchNumber}`
  });
  JC_STATE.pipeline.waitingForNextBatch = false;
  JC_STATE.pipeline.batchWaitRemainingMs = 0;
  JC_STATE.pipeline.loadingNextBatch = true;
  JC_STATE.pipeline.phase = "batch_loading";
  setStatus("正在加载当前列表后面的岗位...");
  updateAutomationControls();

  try {
    // Some BOSS layouts render more than 15 cards in advance. Consume those
    // before scrolling so each batch remains stable and no card is skipped.
    let nextKeys = prepareCurrentBatch();
    for (let attempt = 0; !nextKeys.length && attempt < 4; attempt += 1) {
      revealMoreJobs();
      await sleep(1800);
      await synchronizePageContext({ source: "next-batch" });
      JC_STATE.pipeline.batchKeys = [];
      nextKeys = prepareCurrentBatch();
    }

    if (!nextKeys.length) {
      JC_STATE.pipeline.active = false;
      JC_STATE.pipeline.mode = "idle";
      JC_STATE.pipeline.phase = "idle";
      setStatus("没有识别到更多新岗位，连续投递已完成。");
      return { completed: true, reason: "no_more_jobs" };
    }

    JC_STATE.pipeline.batchNumber += 1;
    JC_STATE.pipeline.phase = "analysis";
    updatePageContextLabel();
    setStatus(`已加载第 ${JC_STATE.pipeline.batchNumber} 批，共 ${nextKeys.length} 个新岗位，继续自动投递。`);
    return { completed: false, reason: "next_batch_ready" };
  } finally {
    JC_STATE.pipeline.loadingNextBatch = false;
    updateAutomationControls();
    schedulePersistAutomationSession();
    if (JC_STATE.pipeline.active && !JC_STATE.pipeline.allPaused) {
      setTimeout(ensureAnalysisWorker, 0);
    }
  }
}

function revealMoreJobs() {
  const connectedJobs = JC_STATE.jobs.filter((job) => job.card?.isConnected && !job.detached);
  const lastCard = connectedJobs.at(-1)?.card;
  if (lastCard) {
    lastCard.scrollIntoView({ behavior: "smooth", block: "end" });
    const scroller = findScrollableAncestor(lastCard);
    if (scroller) scroller.scrollBy({ top: Math.max(400, scroller.clientHeight * 0.85), behavior: "smooth" });
    else window.scrollBy({ top: Math.max(600, window.innerHeight * 0.85), behavior: "smooth" });
  }

  const nextButton = Array.from(document.querySelectorAll("button,a"))
    .find((node) => isElementVisible(node)
      && /^(下一页|下一批|加载更多)$/.test(cleanText(node.innerText || node.textContent || ""))
      && !node.disabled
      && node.getAttribute("aria-disabled") !== "true");
  if (nextButton) nextButton.click();
}

function findScrollableAncestor(node) {
  let parent = node?.parentElement;
  while (parent && parent !== document.body) {
    const style = getComputedStyle(parent);
    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 20) return parent;
    parent = parent.parentElement;
  }
  return null;
}

async function contactQualifiedJob(job, context) {
  // A thin wrapper so the in-flight marker is cleared on every exit — including
  // the early returns and any throw from the outcome handling below.
  try {
    return await runQualifiedJobContact(job, context);
  } finally {
    clearContactInFlight();
  }
}

async function markContactInFlight(key) {
  JC_STATE.currentJobKey = key;
  JC_STATE.pipeline.contactInFlight = true;
  try {
    await persistAutomationSessionNow();
  } catch (error) {
    JC_STATE.currentJobKey = "";
    JC_STATE.pipeline.contactInFlight = false;
    schedulePersistAutomationSession();
    throw error;
  }
}

function clearContactInFlight() {
  if (!JC_STATE.pipeline.contactInFlight && !JC_STATE.currentJobKey) return;
  JC_STATE.currentJobKey = "";
  JC_STATE.pipeline.contactInFlight = false;
  schedulePersistAutomationSession();
}

async function runQualifiedJobContact(job, context) {
  if (!job.card?.isConnected) {
    setJobProgress(job, "unavailable", "岗位已离开当前页面");
    completeJob(job);
    renderList();
    return "continue";
  }
  setJobProgress(job, "qualified", "分析完成，稍后开始沟通");
  setStatus(`岗位已达标，${Math.round(POST_ANALYSIS_CONTACT_DELAY_MS / 1000)} 秒后沟通：${job.title}`);
  renderList();
  const pacingResult = await waitForPacingDelay(POST_ANALYSIS_CONTACT_DELAY_MS, context);
  if (pacingResult !== "ready") return pacingResult;
  setJobProgress(job, "contacting");
  setStatus(`分数达标，正在点击沟通按钮：${job.title}`);
  renderList();
  // Publish which job the click belongs to before it fires. If BOSS pulls the
  // tab into chat/detail mid-click, the service worker reads these off the
  // session to mark this specific job for review instead of losing track of it.
  let result;
  try {
    await markContactInFlight(job.key);
    result = await clickCommunicateForJob(job);
  } catch (error) {
    const detail = friendlyContactError(error);
    setJobProgress(job, "attention", detail);
    completeJob(job);
    setStatus(`${detail} 已记录当前岗位，继续处理下一个岗位。`);
    renderList();
    return "continue";
  }
  if (JC_STATE.analysisRunId !== context.runId || JC_STATE.page.generation !== context.pageGeneration) {
    return "superseded";
  }

  if (["stayed", "stayed_confirmed", "navigated_chat", "already_contacted"].includes(result)) {
    setJobProgress(job, "contacted");
    completeJob(job);
    setStatus(result === "already_contacted"
      ? `该岗位已有沟通记录，未进入消息页：${job.title}。${Math.round(BETWEEN_JOBS_DELAY_MS / 1000)} 秒后继续下一个岗位。`
      : `已在后台完成沟通，职位列表保持不变：${job.title}。${Math.round(BETWEEN_JOBS_DELAY_MS / 1000)} 秒后继续下一个岗位。`);
    renderList();
    return "continue";
  }
  if (result === "detail_mismatch") {
    setJobProgress(job, "detail_mismatch", "当前职位详情与目标岗位不一致");
    completeJob(job);
    setStatus(`当前职位详情与目标岗位不一致，未点击沟通：${job.title}。继续处理下一个岗位。`);
    renderList();
    return "continue";
  }
  if (result === "no_button") {
    setJobProgress(job, "unavailable", "没有可点击的沟通按钮");
    completeJob(job);
    setStatus(`该岗位没有“立即沟通”或“继续沟通”按钮：${job.title}。继续处理下一个岗位。`);
    renderList();
    return "continue";
  }
  if (result === "stay_missing") {
    const detail = "插件自动核验后仍未得到 BOSS 明确结果，已记录当前岗位";
    setJobProgress(job, "attention", detail);
    completeJob(job);
    setStatus(`${detail}：${job.title}。继续处理下一个岗位。`);
    renderList();
    return "continue";
  }
  if (result === "manual_required") {
    const detail = "BOSS 未返回明确的沟通成功确认，已保留该岗位并继续处理后续岗位";
    setJobProgress(job, "attention", detail);
    completeJob(job);
    setStatus(`${detail}：${job.title}。`);
    renderList();
    return "continue";
  }
  const blockingMessage = {
    blocked_rate: "BOSS 提示操作频繁，已暂停后续岗位。",
    blocked_limit: "BOSS 提示沟通数量或额度已达上限，已暂停后续岗位。",
    blocked_security: "BOSS 要求安全验证，已暂停后续岗位，请先人工完成验证。",
    blocked_generic: "BOSS 拒绝了本次沟通，已暂停后续岗位。"
  }[result] || "本次沟通状态不明确，已停止处理。";
  setJobProgress(job, "attention", blockingMessage);
  completeJob(job);
  JC_STATE.pipeline.allPaused = true;
  JC_STATE.pipeline.phase = "paused";
  setStatus(blockingMessage);
  renderList();
  return "halted";
}

function friendlyContactError(error) {
  const text = String(error?.message || error || "");
  if (/超时|timeout|timed out/i.test(text)) {
    return "沟通结果确认超时，请人工查看该岗位是否已发送";
  }
  return `沟通结果未确认：${text || "未知错误"}`;
}

async function waitForPacingDelay(durationMs, context) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (JC_STATE.analysisRunId !== context.runId || JC_STATE.page.generation !== context.pageGeneration) {
      return "superseded";
    }
    if (JC_STATE.pipeline.allPaused) return "paused";
    await sleep(Math.min(250, deadline - Date.now()));
  }
  return "ready";
}

function startPageContextWatcher() {
  if (pageObserver || !document.body) return;
  pageObserver = new MutationObserver((mutations) => {
    if (mutations.some(mutationAffectsJobList)) schedulePageContextSync();
  });
  pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener("popstate", () => schedulePageContextSync(80));
  window.addEventListener("hashchange", () => schedulePageContextSync(80));
  setInterval(() => {
    if (!isJobsPage() || JC_STATE.analyzing || JC_STATE.pipeline.loadingNextBatch) return;
    const snapshot = captureJobSnapshot();
    if (snapshot.jobs.length && snapshot.fingerprint !== JC_STATE.page.fingerprint) {
      schedulePageContextSync(80);
    }
  }, PAGE_SNAPSHOT_POLL_MS);
}

function mutationAffectsJobList(mutation) {
  if (isInsideJobCopilot(mutation.target)) return false;
  const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
  if (target?.closest?.(JOB_CARD_SELECTOR)) return true;
  const changedNodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
  return changedNodes.some((node) => node instanceof Element
    && (node.matches?.(JOB_CARD_SELECTOR) || node.querySelector?.(JOB_CARD_SELECTOR)));
}

function schedulePageContextSync(delay = PAGE_SYNC_DEBOUNCE_MS) {
  clearTimeout(pageSyncTimer);
  pageSyncTimer = setTimeout(() => {
    synchronizePageContext({ source: "watcher" }).catch((error) => {
      setStatus(`页面识别失败：${error.message || error}`);
    });
  }, delay);
}

async function synchronizePageContext(options = {}) {
  if (pageSyncRunning) {
    pageSyncRequested = true;
    return false;
  }
  if (!isJobsPage()) return false;
  pageSyncRunning = true;
  try {
    const snapshot = await waitForStableJobSnapshot();
    if (!snapshot.jobs.length) return false;
    return applyJobSnapshot(snapshot, { source: options.source || "sync", force: options.force === true });
  } finally {
    pageSyncRunning = false;
    if (pageSyncRequested) {
      pageSyncRequested = false;
      schedulePageContextSync(80);
    }
  }
}

async function waitForStableJobSnapshot() {
  let previous = captureJobSnapshot();
  for (let attempt = 0; attempt < JOB_SNAPSHOT_STABILITY_ATTEMPTS; attempt += 1) {
    await sleep(180);
    const current = captureJobSnapshot();
    if (current.jobs.length && current.fingerprint === previous.fingerprint) return current;
    previous = current;
  }
  return previous;
}

function applyJobSnapshot(snapshot, options = {}) {
  const previousJobs = JC_STATE.jobs;
  const initialized = JC_STATE.page.initialized;
  const previousJobsForOverlap = previousJobs.concat(
    Array.from(JC_STATE.dismissedJobKeys, (key) => ({ key }))
  );
  const overlap = jobKeyOverlap(previousJobsForOverlap, snapshot.jobs);
  // BOSS updates category/search results without a full navigation. Low key
  // overlap means this is a new page context, so late work from the old context
  // must be invalidated before any new result can be rendered or contacted.
  const pageReplaced = initialized && previousJobs.length > 0 && snapshot.jobs.length > 0 && overlap < 0.35;
  const visibleSnapshot = {
    ...snapshot,
    jobs: snapshot.jobs.filter((job) => !JC_STATE.dismissedJobKeys.has(job.key))
  };
  snapshot = visibleSnapshot;

  if (!initialized || pageReplaced) {
    const restartMode = JC_STATE.pipeline.active && JC_STATE.pipeline.mode === "auto"
      ? "auto"
      : (JC_STATE.settings.autoRunOnJobsPage ? "auto" : "idle");
    if (initialized) invalidateCurrentPageWork();
    if (restartMode === "idle") {
      JC_STATE.pipeline.active = false;
      JC_STATE.pipeline.mode = "idle";
      JC_STATE.pipeline.allPaused = false;
    }
    JC_STATE.page.initialized = true;
    JC_STATE.page.generation += 1;
    JC_STATE.page.fingerprint = snapshot.fingerprint;
    JC_STATE.page.url = snapshot.url;
    JC_STATE.jobs = snapshot.jobs;
    JC_STATE.analyses.clear();
    JC_STATE.analysisPayloads.clear();
    JC_STATE.reanalysisInFlightKeys.clear();
    JC_STATE.jobProgress.clear();
    // A rebound or replaced list starts its own batch sequence. Keeping the
    // previous counter made a freshly reloaded 15-job page report "batch 7".
    resetBatchProgress();
    // A replaced list is a new legacy queue context. Do not let completion
    // markers from the previous search silently skip its first card.
    if (pageReplaced) JC_STATE.completedJobKeys.clear();
    JC_STATE.selectedKey = "";
    for (const job of JC_STATE.jobs) setJobProgress(job, "pending");
    renderList();
    updatePageContextLabel();
    if (initialized) {
      setStatus(`已识别到新的职位列表，旧页面的处理已作废。当前页共有 ${JC_STATE.jobs.length} 个岗位。`);
    } else {
      setStatus(`已绑定当前职位列表，共 ${JC_STATE.jobs.length} 个岗位。`);
    }
    if (restartMode !== "idle") restartPipelineForGeneration(restartMode, JC_STATE.page.generation);
    return true;
  }

  const previousByKey = new Map(previousJobs.map((job) => [job.key, job]));
  const nextKeys = new Set(snapshot.jobs.map((job) => job.key));
  const analyzingJobWasRemoved = previousJobs.some((job) => !nextKeys.has(job.key)
    && progressFor(job).status === "analyzing");
  if (analyzingJobWasRemoved) {
    JC_STATE.analysisRunId += 1;
    JC_STATE.analyzing = false;
  }
  const reconciled = snapshot.jobs.map((job) => ({ ...previousByKey.get(job.key), ...job, detached: false }));
  const detachedHistory = [];
  for (const oldJob of previousJobs) {
    const status = progressFor(oldJob).status;
    if (!nextKeys.has(oldJob.key) && ["contacted", "unavailable", "detail_mismatch", "attention"].includes(status)) {
      detachedHistory.push(detachJobRecord(oldJob));
    }
  }
  reconciled.push(...detachedHistory.slice(-MAX_DETACHED_JOBS));
  const added = snapshot.jobs.filter((job) => !previousByKey.has(job.key));
  JC_STATE.jobs = reconciled.map((job, index) => ({ ...job, index }));
  pruneJobState(new Set(JC_STATE.jobs.map((job) => job.key)));
  JC_STATE.page.fingerprint = snapshot.fingerprint;
  JC_STATE.page.url = snapshot.url;
  for (const job of added) setJobProgress(job, "pending");
  renderList();
  updatePageContextLabel();
  if ((added.length || analyzingJobWasRemoved) && JC_STATE.pipeline.active) {
    ensureAnalysisWorker();
  } else if (options.force) {
    setStatus(`当前职位列表已刷新，共 ${JC_STATE.jobs.length} 个岗位。`);
  }
  return added.length > 0;
}

function detachJobRecord(job) {
  return {
    ...job,
    card: null,
    text: String(job?.text || "").slice(0, 3000),
    detached: true
  };
}

function pruneJobState(retainedKeys) {
  for (const key of JC_STATE.analyses.keys()) {
    if (!retainedKeys.has(key)) JC_STATE.analyses.delete(key);
  }
  for (const key of JC_STATE.analysisPayloads.keys()) {
    if (!retainedKeys.has(key)) JC_STATE.analysisPayloads.delete(key);
  }
  for (const key of JC_STATE.reanalysisInFlightKeys) {
    if (!retainedKeys.has(key)) JC_STATE.reanalysisInFlightKeys.delete(key);
  }
  for (const key of JC_STATE.jobProgress.keys()) {
    if (!retainedKeys.has(key)) JC_STATE.jobProgress.delete(key);
  }
}

function jobKeyOverlap(previousJobs, nextJobs) {
  if (!previousJobs.length || !nextJobs.length) return 0;
  const previousKeys = new Set(previousJobs.map((job) => job.key));
  const matches = nextJobs.filter((job) => previousKeys.has(job.key)).length;
  return matches / Math.max(1, Math.min(previousJobs.length, nextJobs.length));
}

function invalidateCurrentPageWork() {
  JC_STATE.analysisRunId += 1;
  JC_STATE.analyzing = false;
  JC_STATE.retryJobKey = "";
  JC_STATE.retryContactJobKey = "";
  clearHighlights();
}

function restartPipelineForGeneration(mode, generation) {
  setTimeout(() => {
    if (JC_STATE.page.generation !== generation || JC_STATE.pipeline.allPaused) return;
    if (mode === "auto") startAutoPipeline();
  }, 300);
}

function isInsideJobCopilot(node) {
  const element = node?.closest ? node : node?.parentElement;
  return Boolean(element?.closest?.("#job-copilot-panel, #job-copilot-launcher"));
}

function isJobsPage() {
  const url = location.href;
  if (isBossChatUrl(url)) return false;
  if (/\/web\/geek\/job|\/web\/geek\/recommend|query=/.test(url)) return true;
  return findCards().length > 0 || /推荐|职位|立即沟通|继续沟通/.test(cleanText(document.body?.innerText || "").slice(0, 2000));
}

function preventJavascriptUrlDefaultOnce(node) {
  const anchor = node?.closest?.("a[href]");
  const href = anchor?.getAttribute?.("href") || "";
  if (!/^javascript:/i.test(href)) return;
  anchor.addEventListener("click", (event) => event.preventDefault(), {
    capture: true,
    once: true
  });
}

function safeClick(node) {
  if (!node) return false;
  preventJavascriptUrlDefaultOnce(node);
  node.click();
  return true;
}

function isElementVisible(node) {
  if (!node || node.nodeType !== 1 || typeof node.getBoundingClientRect !== "function") return false;
  const rect = node.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = getComputedStyle(node);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0;
}

function renderList() {
  const list = document.getElementById("jc-list");
  if (!list) return;
  installJobListEventDelegation(list);
  const existingRows = new Map(
    Array.from(list.children)
      .filter((node) => node instanceof HTMLElement && node.dataset.jobKey)
      .map((node) => [node.dataset.jobKey, node])
  );
  const retainedKeys = new Set();
  JC_STATE.jobs.forEach((job, index) => {
    retainedKeys.add(job.key);
    let item = existingRows.get(job.key);
    if (!item) {
      item = document.createElement("div");
      item.dataset.jobKey = job.key;
    }
    updateJobRow(item, job);
    const currentAtIndex = list.children[index] || null;
    if (currentAtIndex !== item) list.insertBefore(item, currentAtIndex);
  });
  for (const [key, item] of existingRows) {
    if (!retainedKeys.has(key)) item.remove();
  }
  updateProgressSummary();
}

function updateJobRow(item, job) {
  const analysis = JC_STATE.analyses.get(job.key);
  const score = analysis?.score ?? "--";
  const exclusionSummary = analysis?.excluded
    ? `已排除：${analysis.exclusion_match || analysis.occupation_family || "命中绝不投递岗位"}`
    : "";
  const progress = progressFor(job);
  const progressInfo = jobProgressInfo(progress.status);
  const reanalysisInFlight = JC_STATE.reanalysisInFlightKeys.has(job.key);
  const hasReplayPayload = JC_STATE.analysisPayloads.has(job.key);
  const reanalysisDisabled = job.detached || !hasReplayPayload || reanalysisInFlight
    || ["analyzing", "contacting"].includes(progress.status);
  const canRetryContact = !job.detached && progress.status === "attention" && isQualifiedJob(job);
  const contactRetryDisabled = JC_STATE.analyzing || reanalysisInFlight;
  const dismissalDisabled = progress.status === "contacting";
  const meta = [job.company, job.city, job.requirements].filter(Boolean).slice(0, 2).join(" · ");
  const renderSignature = JSON.stringify([
    job.index, job.title, job.jobName, job.salary, job.salaryFontFamily, meta, job.detached,
    progress.status, progress.detail, score, exclusionSummary, reanalysisInFlight, reanalysisDisabled,
    canRetryContact, contactRetryDisabled
  ]);
  if (item.dataset.renderSignature === renderSignature) return;
  item.dataset.renderSignature = renderSignature;
  item.className = `jc-job-row is-${progressInfo.tone}`;
  item.innerHTML = `
    <div class="jc-job-index">${job.index + 1}</div>
    <div class="jc-job-content">
      <strong>${renderTitleHtml(job)}</strong>
      <div class="jc-job-meta">${escapeHtml(meta || "岗位信息待展开")}</div>
      ${exclusionSummary ? `<div class="jc-audit-summary is-invalid">${escapeHtml(exclusionSummary)}</div>` : ""}
      ${progress.detail ? `<div class="jc-job-detail">${escapeHtml(progress.detail)}</div>` : ""}
    </div>
    <div class="jc-job-result">
      <div class="jc-job-result-heading">
        <span class="jc-progress-chip is-${progressInfo.tone}">${progressInfo.label}</span>
        <button class="jc-dismiss-job" type="button" data-dismiss-key="${escapeAttr(job.key)}"
          aria-label="关闭检测：${escapeAttr(job.title)}"
          title="${dismissalDisabled ? "正在沟通，暂时无法关闭" : "关闭检测并移出投递列表"}"
          ${dismissalDisabled ? "disabled" : ""}>×</button>
      </div>
      <span class="jc-score">${score === "--" ? "" : `${escapeHtml(String(score))} 分`}</span>
      <div class="jc-job-actions">
        ${canRetryContact ? `<button class="jc-locate-button jc-contact-retry-button"
          data-retry-contact-key="${escapeAttr(job.key)}"
          title="只重新尝试沟通，不重复请求 AI"
          ${contactRetryDisabled ? "disabled" : ""}>重试沟通</button>` : ""}
        <button class="jc-locate-button jc-retry-button" data-reanalyze-key="${escapeAttr(job.key)}"
          title="${!hasReplayPayload ? "该岗位尚无可复用的分析输入" : "使用上次采集的 JD 独立重新分析，不影响主队列"}"
          ${reanalysisDisabled ? "disabled" : ""}>${reanalysisInFlight ? "重分析中…" : "重新分析"}</button>
        <button class="jc-locate-button" data-focus-key="${escapeAttr(job.key)}"
          ${job.detached ? "disabled" : ""}>定位</button>
      </div>
    </div>
  `;
  mountSalaryVisualClone(item, job);
}

function dismissJob(key, options = {}) {
  const job = JC_STATE.jobs.find((item) => item.key === key);
  if (!job) return false;
  const progress = progressFor(job);
  const manuallyContacted = options.reason === "manual_contact";
  if (progress.status === "contacting" && !manuallyContacted) {
    setStatus(`正在沟通，暂时无法关闭：${job.title}`);
    return false;
  }

  const interruptsCurrentRun = progress.status === "analyzing"
    || progress.status === "qualified"
    || (progress.status === "contacting" && !manuallyContacted)
    || JC_STATE.currentJobKey === key;
  rememberDismissedJobKey(key);
  rememberCompletedJobKey(key);
  JC_STATE.jobs = JC_STATE.jobs
    .filter((item) => item.key !== key)
    .map((item, index) => ({ ...item, index }));
  JC_STATE.analyses.delete(key);
  JC_STATE.analysisPayloads.delete(key);
  JC_STATE.reanalysisInFlightKeys.delete(key);
  JC_STATE.jobProgress.delete(key);
  JC_STATE.pipeline.batchKeys = JC_STATE.pipeline.batchKeys.filter((item) => item !== key);
  if (JC_STATE.retryJobKey === key) JC_STATE.retryJobKey = "";
  if (JC_STATE.retryContactJobKey === key) JC_STATE.retryContactJobKey = "";
  if (JC_STATE.selectedKey === key) {
    JC_STATE.selectedKey = "";
    clearHighlights();
  }
  if (JC_STATE.currentJobKey === key) clearContactInFlight();
  if (interruptsCurrentRun) {
    JC_STATE.analysisRunId += 1;
    JC_STATE.analyzing = false;
  }

  setStatus(manuallyContacted
    ? `已手动沟通并移出投递列表：${job.title}`
    : `已关闭检测并移出投递列表：${job.title}`);
  renderList();
  updateAutomationControls();
  schedulePersistAutomationSession();
  if (interruptsCurrentRun && JC_STATE.pipeline.active && !JC_STATE.pipeline.allPaused) {
    setTimeout(ensureAnalysisWorker, 0);
  }
  return true;
}

function mountSalaryVisualClone(item, job) {
  const slot = item.querySelector("[data-jc-salary-slot]");
  const source = job.salaryNode;
  if (!slot || !source?.isConnected) return;
  const clone = source.cloneNode(true);
  const sourceNodes = [source, ...Array.from(source.querySelectorAll("*"))];
  const cloneNodes = [clone, ...Array.from(clone.querySelectorAll("*"))];
  cloneNodes.forEach((node, index) => {
    for (const attribute of Array.from(node.attributes || [])) {
      if (/^on/i.test(attribute.name)
          || ["id", "href", "src", "srcset", "target", "form", "action"].includes(attribute.name)) {
        node.removeAttribute(attribute.name);
      }
    }
    const original = sourceNodes[index];
    if (!original) return;
    const style = getComputedStyle(original);
    node.style.fontFamily = style.fontFamily;
    node.style.fontFeatureSettings = style.fontFeatureSettings;
    node.style.fontVariationSettings = style.fontVariationSettings;
  });
  slot.replaceChildren(clone);
}

function installJobListEventDelegation(list) {
  if (list.dataset.jcDelegated === "true") return;
  list.dataset.jcDelegated = "true";
  list.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("[data-focus-key], [data-reanalyze-key], [data-retry-contact-key], [data-dismiss-key]")
      : null;
    if (!button || !list.contains(button) || button.disabled) return;
    if (button.dataset.dismissKey) {
      dismissJob(button.dataset.dismissKey);
      return;
    }
    if (button.dataset.focusKey) {
      focusJob(button.dataset.focusKey);
      return;
    }
    if (button.dataset.reanalyzeKey) {
      reanalyzeJobInParallel(button.dataset.reanalyzeKey).catch((error) => {
        setStatus(`重新分析启动失败：${friendlyAiError(error?.message || error)}`);
      });
      return;
    }
    if (button.dataset.retryContactKey) {
      retryContactForJob(button.dataset.retryContactKey).catch((error) => {
        setStatus(`重新沟通启动失败：${friendlyContactError(error)}`);
        updateAutomationControls();
      });
    }
  });
}

async function reanalyzeJobInParallel(key) {
  const job = JC_STATE.jobs.find((item) => item.key === key);
  const payload = JC_STATE.analysisPayloads.get(key);
  if (!job || !payload || job.detached) return { ok: false, reason: "missing_payload" };
  if (JC_STATE.reanalysisInFlightKeys.has(key)) return { ok: false, reason: "already_running" };
  if (["analyzing", "contacting"].includes(progressFor(job).status)) {
    return { ok: false, reason: "job_busy" };
  }

  JC_STATE.reanalysisInFlightKeys.add(key);
  renderList();
  logAutomationEvent("ai_reanalysis_started", { job, detail: "source=manual_parallel" });
  try {
    const response = await requestAiAnalysis(job, payload, {
      updateGlobalStatus: false,
      source: "manual_parallel"
    });
    if (!JC_STATE.jobs.some((item) => item.key === key)) return { ok: false, reason: "job_removed" };
    if (!response?.ok) {
      const error = friendlyAiError(response?.error || "重新分析失败");
      if (!JC_STATE.analyzing) setStatus(`重新分析失败，保留原结果：${job.title}。${error}`);
      return { ok: false, reason: "analysis_failed", error };
    }

    applyAnalysisPerformance(response.analysis, response.performance);
    JC_STATE.analyses.set(key, response.analysis);
    const currentStatus = progressFor(job).status;
    if (["error", "not_qualified", "qualified"].includes(currentStatus)) {
      setJobProgress(job, analysisProgressStatus(job), "独立重新分析已完成");
    }
    schedulePersistAutomationSession();
    if (!JC_STATE.analyzing) setStatus(`重新分析完成：${job.title}，最新评分 ${response.analysis.score} 分。`);
    logAutomationEvent("ai_reanalysis_completed", {
      job,
      detail: `source=manual_parallel;score=${Number(response.analysis.score)}`
    });
    return { ok: true, analysis: response.analysis };
  } finally {
    JC_STATE.reanalysisInFlightKeys.delete(key);
    renderList();
  }
}

async function retryContactForJob(key) {
  const job = JC_STATE.jobs.find((item) => item.key === key);
  if (!job || job.detached || !job.card?.isConnected) throw new Error("岗位已离开当前页面");
  if (!isQualifiedJob(job)) throw new Error("该岗位当前评分未达到自动沟通门槛");
  if (JC_STATE.analyzing || progressFor(job).status === "contacting") {
    throw new Error("当前已有自动投递步骤正在执行");
  }

  JC_STATE.completedJobKeys.delete(job.key);
  JC_STATE.retryContactJobKey = job.key;
  JC_STATE.pipeline.batchKeys = [job.key];
  setJobProgress(job, "qualified", "等待重新尝试沟通，不重复分析");
  JC_STATE.pipeline.active = true;
  JC_STATE.pipeline.mode = "auto";
  JC_STATE.pipeline.phase = "analysis";
  JC_STATE.pipeline.allPaused = false;
  JC_STATE.pipeline.pauseReason = "";
  JC_STATE.sessionOwner = true;
  JC_STATE.remoteSession = null;
  await registerAutomationSession();
  setStatus(`准备重新沟通：${job.title}`);
  renderList();
  updateAutomationControls();
  ensureAnalysisWorker();
}

function jobProgressInfo(status) {
  const states = {
    pending: { label: "待分析", tone: "neutral" },
    analyzing: { label: "分析中", tone: "active" },
    qualified: { label: "已达标", tone: "success" },
    contacting: { label: "沟通中", tone: "warning" },
    contacted: { label: "已沟通", tone: "success" },
    not_qualified: { label: "未达标", tone: "muted" },
    unavailable: { label: "不可沟通", tone: "muted" },
    detail_mismatch: { label: "定位失败", tone: "danger" },
    error: { label: "分析失败", tone: "danger" },
    attention: { label: "需确认", tone: "warning" }
  };
  return states[status] || states.pending;
}

function updateProgressSummary() {
  const jobs = JC_STATE.jobs;
  const analyzed = jobs.filter((job) => JC_STATE.analyses.has(job.key)).length;
  const qualified = jobs.filter((job) => isQualifiedJob(job)).length;
  const contacted = jobs.filter((job) => progressFor(job).status === "contacted").length;
  setNodeText("jc-total-count", jobs.length);
  setNodeText("jc-analyzed-count", analyzed);
  setNodeText("jc-qualified-count", qualified);
  setNodeText("jc-contacted-count", contacted);
  updatePageContextLabel();
}

function updatePageContextLabel() {
  const node = document.getElementById("jc-page-context");
  if (!node) return;
  if (!JC_STATE.page.initialized) {
    node.textContent = "正在识别当前岗位列表...";
    return;
  }
  const visible = JC_STATE.jobs.filter((job) => !job.detached).length;
  const batch = Math.max(1, Number(JC_STATE.pipeline.batchNumber) || 1);
  const batchSize = Math.max(0, Number(JC_STATE.pipeline.batchSize) || 0);
  node.textContent = `第 ${batch} 批 · 当前列表总数 ${visible} 个 · 本批 ${batchSize} 个`;
}

function setNodeText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = String(value);
}

function isTransientAiError(error) {
  // Browser and service-worker fetch failures vary across Chromium platforms.
  // Treat network failures and truncated model JSON as retryable so the current
  // job stays pending instead of being skipped or allowing later communication.
  return /Tunnel connection failed|Failed to fetch|NetworkError|network request failed|Load failed|ERR_(?:NETWORK|INTERNET|CONNECTION|TIMED_OUT)|429|503|502|504|请求超时|timeout|timed out|Too Many Requests|Service Unavailable|Bad Gateway|Gateway Timeout|Unexpected end of JSON input|unterminated JSON|JSON.*(?:incomplete|truncated)/i.test(String(error || ""));
}

function isExtensionContextError(error) {
  return /Extension context invalidated|context invalidated|receiving end does not exist|No SW/i.test(String(error || ""));
}

function aiErrorDiagnostic(error) {
  const raw = String(error?.message || error || "");
  const statusMatch = raw.match(/(?:status\s*[=:]\s*|HTTP\s+)(\d{3})/i);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  let category = "unknown";
  if (/Tunnel connection failed|proxy tunnel|ERR_TUNNEL_CONNECTION_FAILED/i.test(raw)) category = "proxy";
  else if (/Unexpected end of JSON input|unterminated JSON|JSON.*(?:incomplete|truncated)/i.test(raw)) category = "invalid_response";
  else if (/请求超时|timeout|timed out|ERR_TIMED_OUT/i.test(raw)) category = "timeout";
  else if (status === 401 || status === 403 || /Unauthorized|invalid.*key/i.test(raw)) category = "auth";
  else if (status === 429 || /Too Many Requests|rate limit/i.test(raw)) category = "rate_limited";
  else if ([502, 503, 504].includes(status) || /Service Unavailable|Bad Gateway|Gateway Timeout/i.test(raw)) category = "upstream_unavailable";
  else if (/Failed to fetch|NetworkError|network request failed|Load failed|ERR_(?:NETWORK|INTERNET|CONNECTION)/i.test(raw)) category = "network";
  else if (status >= 400) category = "provider_error";
  const message = raw
    .replace(/(Authorization\s*:\s*Bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/((?:api[-_ ]?key|x-api-key|x-goog-api-key)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return { category, status, message };
}

function stopForInvalidatedExtensionContext(job) {
  JC_STATE.analysisRunId += 1;
  JC_STATE.analyzing = false;
  JC_STATE.pipeline.active = false;
  JC_STATE.pipeline.allPaused = true;
  JC_STATE.pipeline.phase = "paused";
  JC_STATE.pipeline.contextInvalidated = true;
  if (job) {
    JC_STATE.analyses.delete(job.key);
    setJobProgress(job, "attention", "扩展已更新，请刷新当前页面后继续");
  }
  setStatus("扩展已重新加载，当前页面仍是旧脚本。为保护当前职位列表，插件不会自动刷新；请使用浏览器刷新按钮手动加载新版。");
  renderList();
  updateAutomationControls();
}

function friendlyAiError(error) {
  const text = String(error || "");
  if (isExtensionContextError(text)) {
    return "扩展已更新，请刷新当前 BOSS 页面加载新版。";
  }
  const diagnostic = aiErrorDiagnostic(text);
  if (diagnostic.category === "invalid_response") {
    return "AI 服务返回内容不完整，已暂停并保留当前岗位；恢复后可从该岗位重新分析。";
  }
  if (diagnostic.category === "timeout") {
    return "AI 响应超时，已暂停并保留当前岗位；网络恢复后可从该岗位继续。";
  }
  if (diagnostic.category === "proxy") {
    return "AI 代理通道连接失败，已暂停并保留当前岗位；请检查代理服务后重试。";
  }
  if (diagnostic.category === "upstream_unavailable") {
    return `AI 服务商暂时不可用${diagnostic.status ? `（HTTP ${diagnostic.status}）` : ""}，已暂停并保留当前岗位；这不代表本机代理故障。`;
  }
  if (diagnostic.category === "network") {
    return "浏览器无法连接 AI 接口，可能是网络、接口域名权限或跨域限制；已暂停并保留当前岗位。";
  }
  if (diagnostic.category === "rate_limited") {
    return "AI 服务请求频率受限（HTTP 429），已暂停并保留当前岗位；请稍后重试。";
  }
  if (diagnostic.category === "auth") {
    return "AI 服务的 API Key 或权限异常，请检查服务商、协议和 Key。";
  }
  return text || "AI 分析失败";
}

function focusNextQualifiedJob() {
  const selectedIndex = JC_STATE.jobs.findIndex((job) => job.key === JC_STATE.selectedKey);
  const start = selectedIndex + 1;
  const ordered = JC_STATE.jobs.slice(start).concat(JC_STATE.jobs.slice(0, start));
  const next = ordered.find((job) => {
    const analysis = JC_STATE.analyses.get(job.key);
    return !job.detached && analysis && Number(analysis.score) >= JC_STATE.settings.minScore;
  });
  if (next) focusJob(next.key);
  else setStatus("当前页没有可定位的达标岗位。");
}

function focusJob(key) {
  clearHighlights();
  const job = JC_STATE.jobs.find((item) => item.key === key);
  if (!job) return;
  if (!job.card?.isConnected) {
    setStatus("该岗位已经离开当前页面，无法定位。");
    return;
  }
  JC_STATE.selectedKey = key;
  job.card.classList.add("jc-highlight");
  job.card.scrollIntoView({ behavior: "smooth", block: "center" });
  setStatus(`已定位：${job.title}`);
}

async function clickCommunicateForJob(job) {
  const selected = await selectJobDetail(job);
  if (!selected) return "detail_mismatch";
  const button = findCommunicationButtonForJob(job);
  if (!button) return "no_button";

  const label = cleanText(button.innerText || button.textContent || "");
  if (/^(继续沟通|继续聊|再次沟通)$/.test(label)) {
    logContactEvent("existing_conversation_skipped", job);
    return "already_contacted";
  }
  // Communication must happen in the visible owner jobs page.  A hidden
  // iframe makes BOSS treat the interaction as automation and can suppress
  // the normal "留在此页 / 继续沟通" dialog.  The owner-page guard prevents
  // the same click from taking the jobs tab to chat or opening a new tab.
  const status = await communicateOnOwnerPage(job, button);
  logContactEvent(`owner_${status}`, job);
  return status;
}

async function communicateOnOwnerPage(job, button = findCommunicationButtonForJob(job)) {
  if (!isJobsPage() || !button) return button ? "owner_page_unavailable" : "no_button";
  const ownerJobsUrl = location.href;
  button.scrollIntoView?.({ block: "center", inline: "center" });
  button.focus?.({ preventScroll: true });
  const waiter = createStayOnCurrentPageWaiter(CONTACT_CONFIRMATION_TIMEOUT_MS, job);
  document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_START_EVENT, {
    detail: { durationMs: CONTACT_CONFIRMATION_TIMEOUT_MS }
  }));
  try {
    await dispatchNativeContactClick(job, button);
    const result = await waiter.promise;
    if (result === "chat_route" || isBossChatUrl(location.href) || isBossJobDetailUrl(location.href)) {
      const restored = await restoreManualOwnerJobsRoute(ownerJobsUrl);
      if (!restored) return "owner_route_escape";
      return manualCommunicationConfirmed(job) ? "stayed_confirmed" : "owner_route_escape";
    }
    if (result === "stay_missing" && !manualCommunicationConfirmed(job)) {
      // The browser-level click was delivered, but BOSS exposed no positive
      // confirmation. Keep the job for review instead of guessing success.
      return "manual_required";
    }
    return result;
  } finally {
    waiter.cancel();
    document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_STOP_EVENT));
  }
}

async function dispatchNativeContactClick(job, button) {
  // The panel is a fixed, maximum-z-index overlay and commonly sits above the
  // detail pane. It must not intercept the native hit test for a BOSS control
  // underneath it. Keep real page overlays active so login/security dialogs
  // still block automation.
  const restorePointerEvents = temporarilyDisableJobCopilotPointerEvents();
  try {
    let point = null;
    let preflightError = "立即沟通按钮被其他页面元素遮挡";
    // scrollIntoView can remain in motion when the host page enables smooth
    // scrolling. Give layout and hit testing a short bounded period to settle.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (!button?.isConnected || !isElementVisible(button) || !communicationButtonMatchesJob(button, job)) {
        throw new Error("立即沟通按钮已变化，已取消原生点击");
      }
      const rect = button.getBoundingClientRect();
      const x = rect.left + (rect.width / 2);
      const y = rect.top + (rect.height / 2);
      if (rect.width < 2 || rect.height < 2 || x < 0 || y < 0
          || x >= window.innerWidth || y >= window.innerHeight) {
        preflightError = "立即沟通按钮不在当前可点击视口内";
      } else {
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === button || button.contains(hit))) {
          point = { x, y };
          break;
        }
        preflightError = "立即沟通按钮被 BOSS 页面其他元素遮挡";
      }
      if (attempt < 11) await sleep(50);
    }
    if (!point) throw new Error(preflightError);

    nativeAutomationContactKeys.add(job.key);
    try {
      const response = await sendMessage({
        type: "dispatchTrustedContactClick",
        x: point.x,
        y: point.y,
        pageUrl: location.href,
        jobKey: job.key,
        jobUrl: job.url
      });
      if (!response?.ok || response.dispatched !== true) {
        throw new Error(response?.error || "浏览器原生点击未执行");
      }
      return true;
    } finally {
      nativeAutomationContactKeys.delete(job.key);
    }
  } finally {
    restorePointerEvents();
  }
}

function temporarilyDisableJobCopilotPointerEvents() {
  const nodes = [
    document.getElementById("job-copilot-panel"),
    document.getElementById("job-copilot-launcher"),
    document.getElementById("job-copilot-message-overlay")
  ].filter(Boolean);
  const previous = nodes.map((node) => ({
    node,
    value: node.style.getPropertyValue("pointer-events"),
    priority: node.style.getPropertyPriority("pointer-events")
  }));
  for (const { node } of previous) node.style.setProperty("pointer-events", "none", "important");
  return () => {
    for (const { node, value, priority } of previous) {
      if (value) node.style.setProperty("pointer-events", value, priority);
      else node.style.removeProperty("pointer-events");
    }
  };
}

function communicationBlockStatus() {
  const text = cleanText(document.body?.textContent || "");
  if (/安全验证|验证码|拖动滑块|滑块验证|访问异常|账号异常/.test(text)) return "blocked_security";
  if (/沟通.{0,8}(?:上限|额度|数量)|今日.{0,8}(?:沟通|招呼).{0,8}(?:上限|用完)|已达.{0,8}(?:沟通|招呼)/.test(text)) {
    return "blocked_limit";
  }
  if (/操作频繁|请求频繁|请稍后再试|操作过快|访问过于频繁/.test(text)) return "blocked_rate";
  if (/沟通失败|发送失败|暂时无法沟通|无法发起沟通/.test(text)) return "blocked_generic";
  return "";
}

async function selectJobDetail(job) {
  clearHighlights();
  JC_STATE.selectedKey = job.key;
  job.card.classList.add("jc-highlight");
  job.card.scrollIntoView({ behavior: "smooth", block: "center" });
  if (detailMatchesJob(job)) return true;

  const targets = findJobCardActivationTargets(job.card);
  if (!targets.length) return false;
  // Trigger selection handlers while always cancelling an anchor's default
  // navigation. The owner jobs tab must never become a detail/chat route.
  const ownerJobsUrl = location.href;
  document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_START_EVENT, {
    detail: { durationMs: 6000 }
  }));
  try {
    for (const target of targets) {
      const stayedOnJobsPage = await clickWithoutOwnerNavigation(target, ownerJobsUrl);
      if (!stayedOnJobsPage) {
        pauseForOwnerRouteEscape(job);
        return false;
      }
      for (let attempt = 0; attempt < 18; attempt += 1) {
        await sleep(100);
        if (!restoreOwnerJobsRoute(ownerJobsUrl)) {
          pauseForOwnerRouteEscape(job);
          return false;
        }
        if (detailMatchesJob(job)) return true;
        if (isBossChatUrl(location.href)) return false;
      }
    }
    logContactEvent("detail_mismatch", job);
    return false;
  } finally {
    document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_STOP_EVENT));
  }
}

function findJobCardActivationTargets(card) {
  const nodes = [
    card,
    card.querySelector(".job-name, [class*='job-name'], .job-title, [class*='job-title']")
  ].filter((node) => node && isElementVisible(node));
  const targets = [];
  for (const node of nodes) {
    const target = node === card ? card : (node.closest("a,button") || node);
    if (!targets.includes(target)) targets.push(target);
  }
  return targets;
}

function isBossJobDetailUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(String(url), location.href);
    return parsed.hostname === "www.zhipin.com" && /\/job_detail\//.test(parsed.pathname);
  } catch {
    return /\/job_detail\//.test(String(url));
  }
}

function restoreOwnerJobsRoute(ownerJobsUrl) {
  if (isBossJobDetailUrl(ownerJobsUrl) || !isBossJobDetailUrl(location.href)) return true;
  history.back();
  return false;
}

async function clickWithoutOwnerNavigation(node, ownerJobsUrl = location.href) {
  if (!node) return false;
  const anchor = node.closest?.("a[href]");
  anchor?.addEventListener("click", (event) => event.preventDefault(), {
    capture: true,
    once: true
  });
  node.click();
  if (!restoreOwnerJobsRoute(ownerJobsUrl)) return false;
  // BOSS may schedule router.push() in a microtask after its click handler.
  // Check once more before allowing the caller to wait for detail content.
  await Promise.resolve();
  return restoreOwnerJobsRoute(ownerJobsUrl);
}

function pauseForOwnerRouteEscape(job) {
  JC_STATE.pipeline.allPaused = true;
  JC_STATE.pipeline.ownerRouteEscaped = true;
  setJobProgress(job, "attention", "读取 JD 时职位标签误入详情页，已后退并暂停");
  setStatus("检测到 BOSS 将职位列表标签切到详情页，已自动后退并暂停。请确认列表恢复后再继续。");
  logAutomationEvent("owner_job_detail_route_restored", {
    job,
    detail: "action=history.back;automation=paused"
  });
  renderList();
  updateAutomationControls();
}

function detailMatchesJob(job) {
  return Boolean(findCommunicationButtonForJob(job));
}

function communicationButtonMatchesJob(button, job) {
  const detail = findJobDetailScope(button);
  if (!detail) return false;
  const targetJobId = bossJobIdFromUrl(job.url);
  const detailJobId = bossJobIdForCommunicationButton(button, detail);
  if (targetJobId && detailJobId) return targetJobId === detailJobId;
  const targetTitle = comparableJobText(job.jobName || job.title || "");
  const detailText = comparableJobText(detail.innerText || "");
  const headingTexts = Array.from(detail.querySelectorAll(
    "h1,h2,h3,.job-name,.job-title,[class*='job-name'],[class*='job-title'],[class*='name']"
  )).filter((node) => isElementVisible(node))
    .map((node) => comparableJobText(node.innerText || node.textContent || ""))
    .filter((text) => text.length >= 2);
  const titleMatched = targetTitle.length >= 2 && (
    detailText.includes(targetTitle)
    || headingTexts.some((text) => text.includes(targetTitle) || targetTitle.includes(text))
  );
  // Never identify a queue job by company alone. One company can have
  // multiple cards and a broad detail container can include neighboring jobs.
  return titleMatched;
}

function findJobForCommunicationButton(button) {
  const detail = findJobDetailScope(button);
  const detailJobId = bossJobIdForCommunicationButton(button, detail);
  if (detailJobId) {
    return JC_STATE.jobs.find((job) => bossJobIdFromUrl(job.url) === detailJobId) || null;
  }
  const matches = JC_STATE.jobs.filter((job) => communicationButtonMatchesJob(button, job));
  return matches.length === 1 ? matches[0] : null;
}

function bossJobIdFromUrl(value) {
  try {
    const url = new URL(String(value || ""), "https://www.zhipin.com");
    if (url.hostname !== "www.zhipin.com") return "";
    return url.pathname.match(/\/job_detail\/([^/?#]+)/i)?.[1] || "";
  } catch {
    return String(value || "").match(/\/job_detail\/([^/?#]+)/i)?.[1] || "";
  }
}

function bossJobIdForCommunicationButton(button, detail = findJobDetailScope(button)) {
  const routeId = bossJobIdFromUrl(location.href);
  if (routeId) return routeId;
  if (!detail) return "";
  const detailLinks = Array.from(detail.querySelectorAll("a[href*='/job_detail/']"));
  const primary = detailLinks.find((link) => /查看更多信息|职位详情|查看详情/.test(
    cleanText(link.innerText || link.textContent || "")
  ));
  if (primary) return bossJobIdFromUrl(primary.href || primary.getAttribute("href"));
  const ids = [...new Set(detailLinks
    .map((link) => bossJobIdFromUrl(link.href || link.getAttribute("href")))
    .filter(Boolean))];
  return ids.length === 1 ? ids[0] : "";
}

function findJobDetailScope(button) {
  const rootSelectors = [
    ".job-detail-box",
    ".job-detail-container",
    ".job-detail-content",
    ".job-detail-wrapper",
    "[class*='job-detail-box']",
    "[class*='job-detail-container']",
    "[class*='job-detail-content']",
    "[class*='job-detail-wrap']"
  ];
  for (const selector of rootSelectors) {
    const scope = button.closest(selector);
    if (!scope || cleanText(scope.innerText || "").length < 10) continue;
    const hasJobContext = scope.querySelector(
      "h1,h2,h3,.job-name,.job-title,[class*='job-name'],[class*='job-title']"
    ) || /职位描述|职位详情|岗位职责|任职要求|职位要求/.test(cleanText(scope.innerText || ""));
    if (hasJobContext) return scope;
  }

  let node = button.parentElement;
  let compactFallback = null;
  while (node && node !== document.body && node !== document.documentElement) {
    const text = cleanText(node.innerText || "");
    if (!compactFallback && text.length >= 40) compactFallback = node;
    const hasJobHeading = node.querySelector(
      "h1,h2,h3,.job-name,.job-title,[class*='job-name'],[class*='job-title']"
    );
    if (hasJobHeading && text.length >= 10) return node;
    if (/职位描述|职位详情|岗位职责|任职要求|职位要求/.test(text)) return node;
    node = node.parentElement;
  }
  return compactFallback;
}

function comparableJobText(value) {
  return stripObfuscatedSalary(String(value || ""))
    .toLowerCase()
    .replace(/\d+\s*[-~—]\s*\d+\s*k(?:\s*[·,，、|｜/\\-]?\s*\d+\s*薪)?/gi, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
}

function isBossChatUrl(url) {
  if (!url) return false;
  try {
    return /\/web\/geek\/chat(?:[/?#]|$)/.test(new URL(String(url), location.href).pathname + new URL(String(url), location.href).search);
  } catch {
    return /\/web\/geek\/chat/.test(String(url));
  }
}

function logAutomationEvent(event, options = {}) {
  const job = options.job;
  const entry = {
    event,
    jobIndex: Number(job?.index ?? options.jobIndex ?? -1),
    title: cleanText(job?.jobName || job?.title || "").slice(0, 40),
    page: location.pathname,
    detail: cleanText(options.detail || "").slice(0, 240)
  };
  console.info("[Job Copilot] automation", entry);
  sendMessage({
    type: "appendAutomationLog",
    entry
  }).catch(() => {});
}

function logContactEvent(event, job) {
  logAutomationEvent(event, {
    job,
    detail: `jobIndex=${Number(job?.index ?? -1)}`
  });
}

function applyAnalysisPerformance(analysis, performance = {}) {
  analysis.tokenUsage = performance.usage || {};
  Object.assign(analysis.tokenUsage, {
    analysisVisibleOutputTokens: Number(performance.analysisUsage?.visibleOutputTokens || 0),
    requestCount: Number(performance.requestCount || 1),
    repairMethod: String(performance.repairMethod || "none"),
    durationMs: Number(performance.durationMs || 0)
  });
  return analysis;
}

async function requestAiAnalysis(job, payload, options = {}) {
  const startedAt = Date.now();
  const baseDetail = `jobIndex=${Number(job?.index ?? -1)};source=${String(options.source || "queue")}`;
  logAutomationEvent("ai_analysis_started", { job, detail: baseDetail });

  const progressTimer = options.updateGlobalStatus === false ? null : setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    setStatus(`AI 分析中（已等待 ${elapsedSeconds} 秒）：${job.title}`);
  }, 5000);

  try {
    const response = await sendMessage({ type: "analyzeJob", payload });
    const durationMs = Date.now() - startedAt;
    const usage = response?.performance?.usage;
    const diagnosticDetail = response?.ok
      ? `;providerDurationMs=${Number(response?.performance?.durationMs || durationMs)};repairMethod=${String(response?.performance?.repairMethod || "none")};requestCount=${Number(response?.performance?.requestCount || 1)};inputTokens=${Number(usage?.inputTokens || 0)};visibleOutputTokens=${Number(usage?.visibleOutputTokens || 0)};reasoningTokens=${Number(usage?.reasoningTokens || 0)};totalTokens=${Number(usage?.totalTokens || 0)}`
      : `;diagnostic=${JSON.stringify(aiErrorDiagnostic(response?.error || "分析失败"))}`;
    logAutomationEvent(response?.ok ? "ai_analysis_completed" : "ai_analysis_failed", {
      job,
      detail: `${baseDetail};durationMs=${durationMs};outcome=${response?.ok ? "ok" : "error"}${diagnosticDetail}`
    });
    return response;
  } catch (error) {
    const diagnostic = aiErrorDiagnostic(error);
    logAutomationEvent("ai_analysis_failed", {
      job,
      detail: `${baseDetail};durationMs=${Date.now() - startedAt};outcome=message_error;diagnostic=${JSON.stringify(diagnostic)}`
    });
    throw error;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

function createStayOnCurrentPageWaiter(timeoutMs = 10000, expectedJob = null) {
  let settled = false;
  let confirmationClicked = false;
  let observer = null;
  let intervalId = null;
  let timeoutId = null;
  let probeTimer = null;
  let lastProbeAt = 0;
  let resolvePromise = null;

  const cleanup = () => {
    observer?.disconnect();
    if (intervalId) clearInterval(intervalId);
    if (timeoutId) clearTimeout(timeoutId);
    if (probeTimer) clearTimeout(probeTimer);
  };
  const finish = (result) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(result);
  };
  const probe = () => {
    if (settled || confirmationClicked) return;
    lastProbeAt = Date.now();
    if (isBossChatUrl(location.href)) {
      finish("chat_route");
      return;
    }
    const button = findStayOnCurrentPageButton();
    if (button) {
      confirmationClicked = true;
      const dialogConfirmedSend = stayOnPageDialogConfirmsSend(button);
      safeClick(button);
      setTimeout(() => finish(dialogConfirmedSend || hasSuccessfulContactEvidence(expectedJob)
        ? "stayed_confirmed"
        : "stayed"), 300);
      return;
    }
    if (hasSuccessfulContactEvidence(expectedJob)) finish("stayed");
  };
  const scheduleProbe = (immediate = false) => {
    if (settled || confirmationClicked || probeTimer) return;
    const elapsed = Date.now() - lastProbeAt;
    const delay = immediate ? 0 : Math.max(0, CONTACT_CONFIRMATION_MIN_INTERVAL_MS - elapsed);
    probeTimer = setTimeout(() => {
      probeTimer = null;
      probe();
    }, delay);
  };
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
    observer = new MutationObserver(() => scheduleProbe());
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    intervalId = setInterval(scheduleProbe, CONTACT_CONFIRMATION_FALLBACK_MS);
    timeoutId = setTimeout(() => finish("stay_missing"), timeoutMs);
    scheduleProbe(true);
  });

  return {
    promise,
    cancel() {
      if (!settled) finish("cancelled");
    }
  };
}

function hasSuccessfulContactEvidence(expectedJob = null) {
  const controls = Array.from(document.querySelectorAll("a,button"));
  const changedControl = controls.some((item) => {
    if (isInsideJobCopilot(item) || !isElementVisible(item)) return false;
    const text = cleanText(item.innerText || item.textContent || "");
    if (!/^(继续沟通|继续聊|再次沟通|已沟通|发消息)$/.test(text)) return false;
    return !expectedJob || communicationButtonMatchesJob(item, expectedJob);
  });
  if (changedControl) return true;
  const statusNodes = Array.from(document.querySelectorAll(CONTACT_STATUS_SELECTOR));
  return statusNodes.some((node) => /已向BOSS发送消息|消息发送成功|消息已发送|招呼已发送|已与BOSS沟通|已发起沟通/
    .test(cleanText(node.textContent || "")));
}

function findStayOnCurrentPageButton() {
  const candidates = Array.from(document.querySelectorAll("button,a,div[class*='btn'],span[class*='btn']"));
  return candidates.find((item) => {
    if (!isElementVisible(item)) return false;
    const text = cleanText(item.innerText || item.textContent || "");
    if (!/^(留在此页|留在当前页|暂不进入聊天)$/.test(text)) return false;
    const dialog = item.closest("[role='dialog'], .dialog, .modal, .boss-dialog, [class*='dialog'], [class*='modal']");
    const scopeText = cleanText((dialog || item.parentElement || item).innerText || "");
    return /已向BOSS发送消息|消息已发送|留在此页|留在当前页|暂不进入聊天/.test(scopeText);
  });
}

function stayOnPageDialogConfirmsSend(button) {
  const dialog = button?.closest?.(
    "[role='dialog'], .dialog, .modal, .boss-dialog, [class*='dialog'], [class*='modal']"
  );
  if (!dialog) return false;
  return /已向BOSS发送消息|消息发送成功|消息已发送|招呼已发送|已与BOSS沟通|已发起沟通/
    .test(cleanText(dialog.textContent || dialog.innerText || ""));
}

function findCommunicationButtons(root) {
  const items = Array.from(root.querySelectorAll("a,button"));
  return items.filter((item) => !isInsideJobCopilot(item)
    && isElementVisible(item)
    && /^(立即沟通|继续沟通|继续聊|再次沟通)$/.test(cleanText(item.innerText || item.textContent || "")));
}

function findCommunicationButtonForJob(job) {
  return findCommunicationButtons(document)
    .find((button) => communicationButtonMatchesJob(button, job)) || null;
}

function renderTitleHtml(job) {
  const pieces = [escapeHtml(job.jobName || job.title)];
  const salary = normalizeDisplaySalary(job.salary) || normalizeDisplaySalary(findSalaryLine(job.text));
  if (salary) {
    pieces.push(`<span class="jc-salary-text">${escapeHtml(salary)}</span>`);
  } else if (job.salaryNode) {
    pieces.push('<span class="jc-salary-source" data-jc-salary-slot="true"></span>');
  } else if (job.salaryVisualHtml) {
    pieces.push(job.salaryVisualHtml);
  }
  return pieces.join(" ");
}

function clearHighlights() {
  document.querySelectorAll(".jc-highlight").forEach((node) => node.classList.remove("jc-highlight"));
}

function setStatus(text) {
  const node = document.getElementById("jc-status");
  if (node) node.textContent = text;
  schedulePersistAutomationSession();
}

function pageNeedsHuman() {
  const text = cleanText(document.body?.innerText || "");
  return /请登录|扫码登录|安全验证|验证码|拖动滑块|滑块验证|访问异常/.test(text);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    if (!extensionContextAvailable()) {
      invalidateExtensionContext();
      resolve({ ok: false, error: "Extension context invalidated." });
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        let error = null;
        try {
          error = chrome.runtime.lastError;
        } catch (runtimeError) {
          invalidateExtensionContext();
          resolve({ ok: false, error: String(runtimeError?.message || runtimeError) });
          return;
        }
        if (error) {
          if (/message channel closed|receiving end does not exist|context invalidated/i.test(error.message || "")) {
            if (/context invalidated/i.test(error.message || "")) invalidateExtensionContext();
            resolve({ ok: false, error: error.message });
            return;
          }
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      if (/context invalidated/i.test(String(error?.message || error))) {
        invalidateExtensionContext();
        resolve({ ok: false, error: String(error?.message || error) });
        return;
      }
      reject(error);
    }
  });
}

function extensionContextAvailable() {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function invalidateExtensionContext() {
  if (JC_STATE.pipeline.contextInvalidated) return;
  JC_STATE.pipeline.contextInvalidated = true;
  JC_STATE.pipeline.active = false;
  JC_STATE.pipeline.allPaused = true;
  JC_STATE.analyzing = false;
  JC_STATE.analysisRunId += 1;
  JC_STATE.sessionOwner = false;
  clearTimeout(sessionPersistTimer);
  sessionPersistTimer = null;
  const node = document.getElementById("jc-status");
  if (node) node.textContent = "扩展已重新加载，请刷新当前职位页后继续。为保护当前职位列表，插件不会自动刷新。";
  updateAutomationControls();
}

async function collectJobDescriptionForAnalysis(job) {
  const startedAt = Date.now();
  const cardText = buildJobTextForAi(job);
  const selected = await selectJobDetail(job);
  if (!selected) {
    logAutomationEvent("job_detail_collected", {
      job,
      detail: `durationMs=${Date.now() - startedAt};complete=false;length=${cardText.length}`
    });
    return { text: cardText, complete: false };
  }
  const communicateButton = findCommunicationButtonForJob(job);
  const detailScope = communicateButton ? findJobDetailScope(communicateButton) : null;
  const detailText = stripObfuscatedSalary(detailScope?.innerText || "")
    .replace(/[█▉▊▋▌▍▎▏■]+/g, "")
    .slice(0, 9000);
  if (detailText.length < 80) {
    logAutomationEvent("job_detail_collected", {
      job,
      detail: `durationMs=${Date.now() - startedAt};complete=false;length=${cardText.length}`
    });
    return { text: cardText, complete: false };
  }
  logAutomationEvent("job_detail_collected", {
    job,
    detail: `durationMs=${Date.now() - startedAt};complete=true;length=${detailText.length}`
  });
  return {
    text: `【岗位卡片】\n${cardText}\n\n【完整职位详情】\n${detailText}`,
    complete: true
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

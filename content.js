const JC_STATE = {
  jobs: [],
  analyses: new Map(),
  jobProgress: new Map(),
  completedJobKeys: new Set(),
  selectedKey: "",
  currentJobKey: "",
  retryJobKey: "",
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
    mode: "idle",
    allPaused: false,
    contextInvalidated: false,
    batchNumber: 1,
    batchKeys: [],
    waitingForNextBatch: false,
    loadingNextBatch: false
  },
  settings: {
    minScore: 60,
    autoRunOnJobsPage: false,
    restrictTargetLocation: false,
    profile: "default",
    currentLocation: "",
    targetDirections: "",
    customInstructions: "",
    greetingStyle: "简洁、真诚，突出匹配经历和到岗意愿。"
  },
  analyzing: false,
  analysisRunId: 0
};

const PANEL_GEOMETRY_KEY = "jobCopilotPanelGeometryV2";
const LAUNCHER_TOP_KEY = "jobCopilotLauncherTop";
const PAGE_SYNC_DEBOUNCE_MS = 450;
const POST_ANALYSIS_CONTACT_DELAY_MS = 8000;
const BETWEEN_JOBS_DELAY_MS = 10000;
const JOB_BATCH_SIZE = 15;
const BETWEEN_BATCHES_DELAY_MS = 60000;
const KNOWN_JOB_CITIES = [
  "北京", "上海", "广州", "深圳", "杭州", "南京", "苏州", "成都", "重庆", "武汉", "西安", "天津",
  "长沙", "郑州", "青岛", "厦门", "合肥", "佛山", "东莞", "宁波", "无锡", "珠海", "福州"
];
const EXTENSION_VERSION = chrome.runtime.getManifest?.()?.version || "0.6.5";
const CONTENT_SCRIPT_VERSION = `${EXTENSION_VERSION}-isolated-contact-v42`;
const RUNTIME_PROBE_EVENT = "job-copilot-runtime-probe";
const RUNTIME_ACK_EVENT = "job-copilot-runtime-ack";
let pageSyncTimer = null;
let pageSyncRunning = false;
let pageSyncRequested = false;
let pageObserver = null;
let sessionPersistTimer = null;
let manualChatHitbox = null;
let manualChatOpenAt = 0;

const SHOULD_BOOT_CONTENT_RUNTIME = !hasLiveContentRuntime();
if (SHOULD_BOOT_CONTENT_RUNTIME) {
  initPanel();
  installManualChatTabHandler(true);
  installContentRuntimeResponder();
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
  const linkObserver = new MutationObserver(hardenManualChatLinks);
  linkObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", hardenManualChatLinks, true);
  window.addEventListener("scroll", hardenManualChatLinks, true);
  window.setInterval(hardenManualChatLinks, 250);
  window.addEventListener("pointerdown", handleManualChatHitboxEvent, true);
  window.addEventListener("click", handleManualChatHitboxEvent, true);
  document.addEventListener("click", handleManualChatClick, true);
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
    if (message?.type === "performIsolatedCommunication") {
      performIsolatedCommunication(message.expectedJob || { title: message.expectedTitle })
        .then((status) => sendResponse({ ok: true, status }))
        .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
      return true;
    }
    if (message?.type === "inspectIsolatedCommunicationResult") {
      sendResponse({ ok: true, confirmed: hasSuccessfulContactEvidence() || isBossChatUrl(location.href) });
      return false;
    }
    if (message?.type !== "automationControl") return false;
    applyExternalAutomationControl(message.action, message.reason);
    sendResponse({ ok: true });
    return false;
  });
  sendMessage({ type: "getSettings" }).then((response) => {
    if (response?.ok) JC_STATE.settings = { ...JC_STATE.settings, ...response.settings };
    updateAutomationControls();
    startPageContextWatcher();
    bootstrapAutomationContext().catch((error) => setStatus(`恢复自动投递状态失败：${error.message || error}`));
  }).catch((error) => setStatus(`读取插件设置失败：${error.message || error}`));
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
  JC_STATE.remoteSession = response.session;
  JC_STATE.sessionOwner = false;
  renderRemoteAutomationState();
}

function restoreOwnedAutomationSession(session) {
  if (!session) return;
  const currentKeys = new Set(JC_STATE.jobs.map((job) => job.key));
  const restoredAnalyses = Object.entries(session.analyses || {}).filter(([key]) => currentKeys.has(key));
  const restoredProgress = Object.entries(session.progress || {}).filter(([key]) => currentKeys.has(key));
  JC_STATE.sessionOwner = true;
  JC_STATE.remoteSession = null;
  JC_STATE.analyses = new Map(restoredAnalyses);
  JC_STATE.jobProgress = new Map(restoredProgress);
  JC_STATE.completedJobKeys = new Set(Array.isArray(session.completedJobKeys) ? session.completedJobKeys : []);
  for (const job of JC_STATE.jobs) {
    if (!JC_STATE.jobProgress.has(job.key)) JC_STATE.jobProgress.set(job.key, { status: "pending", detail: "" });
  }
  JC_STATE.pipeline.active = session.active === true;
  JC_STATE.pipeline.mode = session.mode === "auto" ? "auto" : "idle";
  JC_STATE.pipeline.allPaused = session.paused === true;
  JC_STATE.pipeline.batchNumber = Math.max(1, Number(session.batchNumber) || 1);
  JC_STATE.pipeline.batchKeys = Array.isArray(session.batchKeys)
    ? session.batchKeys.filter((key) => currentKeys.has(key)).slice(0, JOB_BATCH_SIZE)
    : [];
  JC_STATE.currentJobKey = String(session.currentJobKey || "");
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
    if (reason === "machine_locked") {
      setStatus("电脑已锁定，自动投递将在当前步骤结束后暂停。");
    } else if (reason === "machine_idle") {
      setStatus("电脑长时间无操作，自动投递将在当前步骤结束后暂停。");
    } else {
      setStatus("已从其他标签暂停自动投递，当前步骤结束后停止。");
    }
  } else if (action === "resume") {
    JC_STATE.pipeline.allPaused = false;
    setStatus(reason === "machine_active"
      ? "电脑恢复使用，自动投递已自动继续。"
      : "已从其他标签继续自动投递。");
    ensureAnalysisWorker();
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
  if (JC_STATE.remoteSession?.active && !JC_STATE.sessionOwner) {
    const action = JC_STATE.remoteSession.paused ? "resume" : "pause";
    await sendMessage({ type: "controlAutomationTab", action });
    await sleep(250);
    await refreshAutomationSession();
    return;
  }
  if (JC_STATE.pipeline.contextInvalidated) {
    location.reload();
    return;
  }
  if (JC_STATE.pipeline.allPaused) {
    JC_STATE.pipeline.allPaused = false;
    setStatus("自动投递已继续，将从未完成岗位接着执行。");
    updateAutomationControls();
    ensureAnalysisWorker();
    return;
  }
  if (JC_STATE.pipeline.waitingForNextBatch || JC_STATE.pipeline.loadingNextBatch) {
    JC_STATE.pipeline.allPaused = true;
    setStatus("正在暂停连续投递，批次进度会保留。");
    updateAutomationControls();
    schedulePersistAutomationSession();
    return;
  }
  if (JC_STATE.analyzing) {
    JC_STATE.pipeline.allPaused = true;
    setStatus("正在暂停自动投递。当前步骤结束后停止，岗位进度会保留。");
    updateAutomationControls();
    return;
  }
  if (JC_STATE.pipeline.mode === "auto" && JC_STATE.pipeline.active
      && !JC_STATE.jobs.some((job) => jobNeedsProcessing(job))) {
    setStatus("当前页已经处理完成。切换职位页面后可开始处理新岗位。");
    updateAutomationControls();
    return;
  }
  await startAutoPipeline({ confirmUser: true });
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

function placePanelDefault(panel) {
  const width = Math.min(380, Math.max(300, window.innerWidth - 32));
  const height = Math.min(560, Math.max(300, window.innerHeight - 112));
  panel.style.width = `${width}px`;
  panel.style.height = `${height}px`;
  panel.style.maxHeight = "none";
  panel.style.left = `${clamp(window.innerWidth - width - 18, 8, window.innerWidth - width - 8)}px`;
  panel.style.top = `${clamp(88, 8, window.innerHeight - height - 8)}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}

function restorePanelGeometry(panel) {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_GEOMETRY_KEY) || "{}");
    if (!saved || typeof saved !== "object") return false;
    const minWidth = 260;
    const minHeight = 180;
    const maxWidth = Math.min(680, window.innerWidth - 24);
    const maxHeight = Math.min(860, window.innerHeight - 24);
    if (Number.isFinite(saved.width)) panel.style.width = `${clamp(saved.width, minWidth, maxWidth)}px`;
    if (Number.isFinite(saved.height)) {
      panel.style.height = `${clamp(saved.height, minHeight, maxHeight)}px`;
      panel.style.maxHeight = "none";
    }
    if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      const width = panel.getBoundingClientRect().width || saved.width || 330;
      const height = panel.getBoundingClientRect().height || saved.height || 360;
      panel.style.left = `${clamp(saved.left, 8, window.innerWidth - width - 8)}px`;
      panel.style.top = `${clamp(saved.top, 8, window.innerHeight - height - 8)}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    }
    ensurePanelInViewport(panel);
    return true;
  } catch {
    localStorage.removeItem(PANEL_GEOMETRY_KEY);
    return false;
  }
}

function ensurePanelInViewport(panel) {
  const rect = panel.getBoundingClientRect();
  const width = rect.width || 330;
  const height = rect.height || 360;
  panel.style.left = `${clamp(rect.left || window.innerWidth - width - 18, 8, Math.max(8, window.innerWidth - width - 8))}px`;
  panel.style.top = `${clamp(rect.top || 88, 8, Math.max(8, window.innerHeight - height - 8))}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}

function restoreLauncherTop(launcher) {
  const savedTop = Number(localStorage.getItem(LAUNCHER_TOP_KEY));
  const fallbackTop = Math.round(window.innerHeight * 0.58);
  setLauncherTop(launcher, Number.isFinite(savedTop) ? savedTop : fallbackTop);
}

function setLauncherTop(launcher, top) {
  const launcherHeight = launcher.offsetHeight || 72;
  launcher.style.top = `${clamp(top, 86, Math.max(86, window.innerHeight - launcherHeight - 22))}px`;
  launcher.style.right = "0";
  launcher.style.bottom = "auto";
}

function enableLauncherDock(launcher) {
  let startY = 0;
  let startTop = 0;
  let moved = false;
  launcher.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    startY = event.clientY;
    startTop = launcher.getBoundingClientRect().top;
    moved = false;
    launcher.setPointerCapture?.(event.pointerId);

    const onMove = (moveEvent) => {
      const nextTop = startTop + moveEvent.clientY - startY;
      if (Math.abs(moveEvent.clientY - startY) > 4) moved = true;
      if (moved) {
        moveEvent.preventDefault();
        launcher.classList.add("jc-launcher-dragging");
        setLauncherTop(launcher, nextTop);
      }
    };
    const onUp = () => {
      launcher.classList.remove("jc-launcher-dragging");
      localStorage.setItem(LAUNCHER_TOP_KEY, String(Math.round(launcher.getBoundingClientRect().top)));
      if (moved) {
        launcher.dataset.skipClick = "1";
        setTimeout(() => {
          launcher.dataset.skipClick = "0";
        }, 0);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function enablePanelDrag(panel) {
  const header = panel.querySelector(".jc-header");
  if (!header) return;
  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    panel.classList.add("jc-dragging");
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";

    const onMove = (moveEvent) => {
      const current = panel.getBoundingClientRect();
      panel.style.left = `${clamp(moveEvent.clientX - offsetX, 8, window.innerWidth - current.width - 8)}px`;
      panel.style.top = `${clamp(moveEvent.clientY - offsetY, 8, window.innerHeight - current.height - 8)}px`;
    };
    const onUp = () => {
      panel.classList.remove("jc-dragging");
      savePanelGeometry(panel);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function enablePanelResize(panel) {
  const handles = Array.from(panel.querySelectorAll("[data-jc-resize]"));
  if (!handles.length) return;
  handles.forEach((handle) => handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const direction = handle.dataset.jcResize || "se";
    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;
    const startRight = rect.right;
    const startBottom = rect.bottom;
    panel.classList.add("jc-resizing");
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.maxHeight = "none";
    handle.setPointerCapture?.(event.pointerId);

    const onMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      let nextLeft = rect.left;
      let nextTop = rect.top;
      let nextWidth = startWidth;
      let nextHeight = startHeight;

      if (direction.includes("e")) {
        nextWidth = clamp(startWidth + deltaX, 260, Math.min(680, window.innerWidth - rect.left - 8));
      }
      if (direction.includes("s")) {
        nextHeight = clamp(startHeight + deltaY, 180, Math.min(860, window.innerHeight - rect.top - 8));
      }
      if (direction.includes("w")) {
        nextWidth = clamp(startWidth - deltaX, 260, Math.min(680, startRight - 8));
        nextLeft = startRight - nextWidth;
      }
      if (direction.includes("n")) {
        nextHeight = clamp(startHeight - deltaY, 180, Math.min(860, startBottom - 8));
        nextTop = startBottom - nextHeight;
      }

      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
      panel.style.width = `${nextWidth}px`;
      panel.style.height = `${nextHeight}px`;
    };
    let finished = false;
    const finishResize = () => {
      if (finished) return;
      finished = true;
      panel.classList.remove("jc-resizing");
      savePanelGeometry(panel);
      if (handle.hasPointerCapture?.(event.pointerId)) {
        handle.releasePointerCapture?.(event.pointerId);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      handle.removeEventListener("lostpointercapture", finishResize);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    handle.addEventListener("lostpointercapture", finishResize);
  }));
}

function savePanelGeometry(panel) {
  const rect = panel.getBoundingClientRect();
  localStorage.setItem(PANEL_GEOMETRY_KEY, JSON.stringify({
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }));
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value), min), max);
}

function buildCustomInstructions() {
  return [
    JC_STATE.settings.customInstructions ? `评分偏好：${JC_STATE.settings.customInstructions}` : "",
    JC_STATE.settings.greetingStyle ? `话术风格：${JC_STATE.settings.greetingStyle}` : ""
  ].filter(Boolean).join("\n");
}

function extractJobCity(text) {
  return KNOWN_JOB_CITIES.find((locationName) => String(text || "").includes(locationName)) || "";
}

function isLocationMetadata(text) {
  const value = cleanText(text);
  if (!value) return false;
  const hasKnownCity = KNOWN_JOB_CITIES.some((city) => value.includes(city));
  const looksLikeAddress = /(?:省|市|区|县|镇|街道|园区)(?:[·・\s]|$)/.test(value)
    || /^[\u4e00-\u9fa5]{2,12}(?:·[\u4e00-\u9fa5]{2,12}){1,3}$/.test(value);
  const hasRequirementSignal = /经验|学历|本科|大专|应届|不限|在校|实习|全职|兼职|技能|职责|要求/.test(value);
  return (hasKnownCity || looksLikeAddress) && !hasRequirementSignal;
}

function captureJobSnapshot() {
  const jobs = findCards().map((card, index) => {
    const text = cleanText(card.innerText || "");
    const salaryInfo = extractSalaryInfo(card, text);
    const jobName = extractJobName(card, text);
    const title = buildDisplayTitle(jobName, salaryInfo.text, text);
    const job = {
      index,
      card,
      text,
      title,
      jobName,
      company: extractCompany(card, text),
      city: extractJobCity(text),
      salary: salaryInfo.text,
      salaryFontFamily: salaryInfo.fontFamily,
      requirements: extractRequirements(card, text),
      url: extractUrl(card)
    };
    job.key = stableJobKey(job);
    return job;
  }).filter((job) => job.text.length > 10);
  return {
    jobs,
    fingerprint: fingerprintJobs(jobs),
    url: location.href.split("#")[0]
  };
}

function stableJobKey(job) {
  const idMatch = String(job.url || "").match(/\/job_detail\/([^/?#]+)/i);
  if (idMatch?.[1]) return `job:${idMatch[1]}`;
  const signature = [
    cleanText(job.jobName).toLowerCase(),
    cleanText(job.company).toLowerCase(),
    cleanText(job.city),
    cleanText(job.requirements).toLowerCase()
  ].join("|");
  return `card:${hashText(signature)}`;
}

function fingerprintJobs(jobs) {
  return hashText(jobs.map((job) => job.key).join("|"));
}

function hashText(text) {
  let hash = 2166136261;
  for (const char of String(text || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
  if (!JC_STATE.page.initialized || !JC_STATE.jobs.length) {
    await synchronizePageContext({ force: true, source: "analysis" });
  }
  if (!JC_STATE.jobs.length) {
    setStatus("当前页没有可分析的岗位。");
    return { completed: true, analyzed: 0 };
  }
  if (force) {
    for (const job of JC_STATE.jobs) {
      JC_STATE.analyses.delete(job.key);
      JC_STATE.completedJobKeys.delete(job.key);
      setJobProgress(job, "pending");
    }
    JC_STATE.pipeline.batchKeys = [];
  }
  // A list-row retry is a single-job recovery action. Keep this local flag
  // after retryJobKey is consumed so completing the retry cannot silently
  // advance into the next batch while the user expects the run to stay paused.
  const retryOnlyRun = Boolean(JC_STATE.retryJobKey);
  prepareCurrentBatch();
  if (!JC_STATE.jobs.some((job) => jobNeedsProcessing(job))) {
    if (retryOnlyRun) {
      JC_STATE.pipeline.allPaused = true;
      setStatus("重新分析已完成，自动投递保持暂停；需要时可手动继续。");
      updateAutomationControls();
      schedulePersistAutomationSession();
      return { completed: true, reason: "retry_completed", analyzed: 0 };
    }
    if (JC_STATE.pipeline.mode === "auto" && JC_STATE.pipeline.active) {
      return advanceToNextBatch();
    }
    JC_STATE.pipeline.active = false;
    setStatus(JC_STATE.pipeline.mode === "auto"
      ? "当前页岗位已处理完成，所有达标岗位都已完成沟通尝试。"
      : "当前页岗位已全部分析，无需重复请求 AI。"
    );
    renderList();
    schedulePersistAutomationSession();
    return { completed: true, analyzed: 0 };
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
    if (JC_STATE.analysisRunId !== runId || JC_STATE.page.generation !== pageGeneration) {
      return { completed: false, reason: "superseded", analyzed: analyzedCount };
    }
    if (JC_STATE.pipeline.allPaused) {
      JC_STATE.analyzing = false;
      updateAnalysisControls();
      setStatus(`当前处理已暂停，本轮新分析 ${analyzedCount} 个岗位；进度已保留。`);
      return { completed: false, reason: "paused", analyzed: analyzedCount };
    }
    if (pageNeedsHuman()) {
      JC_STATE.analyzing = false;
      JC_STATE.pipeline.allPaused = true;
      updateAnalysisControls();
      setStatus("页面出现登录、验证码或安全验证，已暂停处理，请先人工处理。");
      return { completed: false, reason: "human_verification", analyzed: analyzedCount };
    }

    // A user-requested retry always runs before untouched jobs, while retaining
    // the stable job key so a failed request cannot be applied to another card.
    const retryJob = JC_STATE.retryJobKey
      ? JC_STATE.jobs.find((item) => item.key === JC_STATE.retryJobKey && jobNeedsProcessing(item))
      : null;
    const job = retryJob || JC_STATE.jobs.find((item) => jobNeedsProcessing(item));
    if (!job) break;
    if (job.key === JC_STATE.retryJobKey) JC_STATE.retryJobKey = "";

    const existingAnalysis = JC_STATE.analyses.get(job.key);
    if (existingAnalysis) {
      const contactResult = await contactQualifiedJob(job, { runId, pageGeneration });
      if (contactResult === "superseded") {
        return { completed: false, reason: "superseded", analyzed: analyzedCount };
      }
      if (contactResult === "paused") {
        JC_STATE.analyzing = false;
        updateAutomationControls();
        return { completed: false, reason: "paused", analyzed: analyzedCount };
      }
      if (contactResult === "halted") {
        JC_STATE.analyzing = false;
        updateAutomationControls();
        return { completed: false, reason: "contact_halted", analyzed: analyzedCount };
      }
      await sleep(BETWEEN_JOBS_DELAY_MS);
      continue;
    }

    setJobProgress(job, "analyzing");
    setStatus(`正在定位并读取完整岗位详情：${job.title}`);
    renderList();
    const jobDescription = await collectJobDescriptionForAnalysis(job);
    if (JC_STATE.analysisRunId !== runId || JC_STATE.page.generation !== pageGeneration) {
      return { completed: false, reason: "superseded", analyzed: analyzedCount };
    }
    if (JC_STATE.pipeline.allPaused) {
      JC_STATE.analyzing = false;
      setJobProgress(job, "pending", "已暂停，尚未请求 AI");
      updateAutomationControls();
      renderList();
      return { completed: false, reason: "paused", analyzed: analyzedCount };
    }
    setStatus(`AI 分析中：${job.title}${jobDescription.complete ? "（完整 JD）" : "（卡片信息）"}`);
    const payload = {
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
      customInstructions: buildCustomInstructions()
    };
    const response = await sendMessage({ type: "analyzeJob", payload });
    if (JC_STATE.analysisRunId !== runId || JC_STATE.page.generation !== pageGeneration) {
      return { completed: false, reason: "superseded", analyzed: analyzedCount };
    }
    if (response?.ok) {
      JC_STATE.analyses.set(job.key, response.analysis);
      analyzedCount += 1;
      if (isQualifiedJob(job)) {
        setJobProgress(job, "qualified");
        renderList();
        if (JC_STATE.pipeline.mode === "auto") {
          const contactResult = await contactQualifiedJob(job, { runId, pageGeneration });
          if (contactResult === "superseded") {
            return { completed: false, reason: "superseded", analyzed: analyzedCount };
          }
          if (contactResult === "paused") {
            JC_STATE.analyzing = false;
            updateAutomationControls();
            return { completed: false, reason: "paused", analyzed: analyzedCount };
          }
          if (contactResult === "halted") {
            JC_STATE.analyzing = false;
            updateAutomationControls();
            return { completed: false, reason: "contact_halted", analyzed: analyzedCount };
          }
        }
      } else {
        setJobProgress(job, "not_qualified");
        completeJob(job);
        setStatus(`岗位未达标，${Math.round(BETWEEN_JOBS_DELAY_MS / 1000)} 秒后处理下一个：${job.title}`);
      }
    } else {
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
      if (isTransientAiError(error)) {
        JC_STATE.analyses.delete(job.key);
        JC_STATE.analyzing = false;
        JC_STATE.pipeline.allPaused = true;
        updateAutomationControls();
        renderList();
        setStatus(`AI 网络暂时不可用，当前处理已暂停。\n${friendlyAiError(error)}`);
        return { completed: false, reason: "network_error", analyzed: analyzedCount };
      }
      completeJob(job);
    }
    renderList();
    await sleep(BETWEEN_JOBS_DELAY_MS);
  }

  if (JC_STATE.analysisRunId === runId) JC_STATE.analyzing = false;
  if (retryOnlyRun) {
    JC_STATE.pipeline.allPaused = true;
    updateAutomationControls();
    setStatus("重新分析已完成，自动投递保持暂停；需要时可手动继续。");
    schedulePersistAutomationSession();
    return { completed: true, reason: "retry_completed", analyzed: analyzedCount };
  }
  if (JC_STATE.pipeline.mode === "auto" && JC_STATE.pipeline.active) {
    updateAnalysisControls();
    return advanceToNextBatch();
  }
  JC_STATE.pipeline.active = false;
  updateAnalysisControls();
  setStatus(JC_STATE.pipeline.mode === "auto"
    ? "当前页处理完成：未达标岗位未沟通，达标岗位均已完成沟通或标明具体失败原因。"
    : "当前页 AI 分析已完成。达标岗位已在下方列表标记。"
  );
  schedulePersistAutomationSession();
  return { completed: true, analyzed: analyzedCount };
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
    button.textContent = "刷新页面加载新版";
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
  button.textContent = "开始自动投递";
}

async function startAutoPipeline(options = {}) {
  const confirmUser = options.confirmUser === true;
  if (pageNeedsHuman()) {
    setStatus("页面疑似需要登录、验证码或安全验证，请先人工处理。");
    return false;
  }
  await synchronizePageContext({ force: true, source: "pipeline" });
  if (!JC_STATE.jobs.length) {
    setStatus("当前职位页没有识别到岗位，暂时不能启动自动投递。");
    return false;
  }
  if (confirmUser) {
    const locationRule = JC_STATE.settings.restrictTargetLocation
      ? `AI 会把目标城市/地区作为硬性偏好，并仅沟通最终分达到 ${JC_STATE.settings.minScore} 分的岗位`
      : `AI 会综合岗位实际地点，并仅沟通最终分达到 ${JC_STATE.settings.minScore} 分的岗位`;
    const ok = window.confirm(
      `确认开始连续自动投递？\n\n${locationRule}。每批最多 ${JOB_BATCH_SIZE} 个岗位；岗位达标后等待约 ${Math.round(POST_ANALYSIS_CONTACT_DELAY_MS / 1000)} 秒，再点击“立即沟通”和“留在此页”；每个岗位结束后等待约 ${Math.round(BETWEEN_JOBS_DELAY_MS / 1000)} 秒，每批结束后等待 ${Math.round(BETWEEN_BATCHES_DELAY_MS / 1000)} 秒再加载后续岗位。插件不会主动进入消息页。`
    );
    if (!ok) return false;
  }

  if (!JC_STATE.pipeline.active || JC_STATE.pipeline.mode !== "auto") {
    JC_STATE.pipeline.batchNumber = 1;
    JC_STATE.pipeline.batchKeys = [];
    JC_STATE.pipeline.waitingForNextBatch = false;
    JC_STATE.pipeline.loadingNextBatch = false;
  }
  JC_STATE.pipeline.active = true;
  JC_STATE.pipeline.mode = "auto";
  JC_STATE.pipeline.allPaused = false;
  JC_STATE.sessionOwner = true;
  JC_STATE.remoteSession = null;
  await registerAutomationSession();
  setStatus("自动投递已启动：逐个分析岗位，达标后按保守节奏沟通并留在当前页。");
  updateAutomationControls();
  ensureAnalysisWorker();
  return true;
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
    mode: JC_STATE.pipeline.mode,
    jobsUrl: JC_STATE.page.url || location.href.split("#")[0],
    fingerprint: JC_STATE.page.fingerprint,
    analyses: Object.fromEntries(JC_STATE.analyses),
    progress: Object.fromEntries(JC_STATE.jobProgress),
    completedJobKeys: Array.from(JC_STATE.completedJobKeys).slice(-500),
    batchNumber: JC_STATE.pipeline.batchNumber,
    batchKeys: JC_STATE.pipeline.batchKeys.slice(0, JOB_BATCH_SIZE),
    summary: {
      total: jobs.length,
      analyzed: jobs.filter((job) => JC_STATE.analyses.has(job.key)).length,
      qualified: jobs.filter((job) => isQualifiedJob(job)).length,
      contacted: jobs.filter((job) => progressFor(job).status === "contacted").length
    },
    status: document.getElementById("jc-status")?.textContent || "",
    contactInFlight: false,
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

async function updateContactSession(contactInFlight, job) {
  if (!JC_STATE.sessionOwner) return;
  JC_STATE.currentJobKey = contactInFlight ? String(job?.key || "") : "";
  await sendMessage({
    type: "updateAutomationSession",
    patch: buildAutomationSessionPayload({
      contactInFlight,
      currentJobKey: JC_STATE.currentJobKey
    })
  });
}

function isQualifiedJob(job) {
  const analysis = JC_STATE.analyses.get(job.key);
  return Boolean(analysis)
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

function prepareCurrentBatch() {
  for (const job of JC_STATE.jobs) {
    const progress = progressFor(job);
    const analysis = JC_STATE.analyses.get(job.key);
    if (analysis && (!isQualifiedJob(job)
        || ["contacted", "unavailable", "detail_mismatch", "attention"].includes(progress.status))) {
      JC_STATE.completedJobKeys.add(job.key);
    }
  }
  const current = JC_STATE.pipeline.batchKeys.filter((key) => {
    const job = JC_STATE.jobs.find((item) => item.key === key);
    return job && !job.detached && !JC_STATE.completedJobKeys.has(key);
  });
  if (current.length) {
    JC_STATE.pipeline.batchKeys = current;
    return current;
  }
  JC_STATE.pipeline.batchKeys = JC_STATE.jobs
    .filter((job) => !job.detached && !JC_STATE.completedJobKeys.has(job.key))
    .slice(0, JOB_BATCH_SIZE)
    .map((job) => job.key);
  schedulePersistAutomationSession();
  return JC_STATE.pipeline.batchKeys;
}

function completeJob(job) {
  if (!job?.key) return;
  JC_STATE.completedJobKeys.add(job.key);
  schedulePersistAutomationSession();
}

async function advanceToNextBatch() {
  if (JC_STATE.pipeline.waitingForNextBatch || JC_STATE.pipeline.loadingNextBatch) {
    return { completed: false, reason: "batch_transition" };
  }
  JC_STATE.pipeline.waitingForNextBatch = true;
  JC_STATE.pipeline.batchKeys = [];
  updateAutomationControls();

  const deadline = Date.now() + BETWEEN_BATCHES_DELAY_MS;
  while (Date.now() < deadline) {
    if (!JC_STATE.pipeline.active || JC_STATE.pipeline.allPaused) {
      JC_STATE.pipeline.waitingForNextBatch = false;
      updateAutomationControls();
      schedulePersistAutomationSession();
      return { completed: false, reason: "paused" };
    }
    const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    setStatus(`第 ${JC_STATE.pipeline.batchNumber} 批已完成，${seconds} 秒后加载后续岗位。`);
    await sleep(Math.min(1000, deadline - Date.now()));
  }

  JC_STATE.pipeline.waitingForNextBatch = false;
  JC_STATE.pipeline.loadingNextBatch = true;
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
      setStatus("没有识别到更多新岗位，连续投递已完成。");
      return { completed: true, reason: "no_more_jobs" };
    }

    JC_STATE.pipeline.batchNumber += 1;
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
  setStatus(`分数达标，正在立即沟通：${job.title}`);
  renderList();
  let result;
  try {
    result = await clickCommunicateForJob(job);
  } catch (error) {
    const detail = friendlyContactError(error);
    setJobProgress(job, "attention", detail);
    completeJob(job);
    JC_STATE.pipeline.allPaused = true;
    setStatus(`${detail} 已暂停后续岗位，避免重复沟通。`);
    renderList();
    return "halted";
  }
  if (JC_STATE.analysisRunId !== context.runId || JC_STATE.page.generation !== context.pageGeneration) {
    return "superseded";
  }

  if (result === "stayed") {
    setJobProgress(job, "contacted");
    completeJob(job);
    setStatus(`已沟通并留在当前页：${job.title}。${Math.round(BETWEEN_JOBS_DELAY_MS / 1000)} 秒后继续下一个岗位。`);
    renderList();
    return "continue";
  }
  if (result === "detail_mismatch") {
    setJobProgress(job, "detail_mismatch", "临时标签未能确认目标岗位");
    completeJob(job);
    setStatus(`临时标签未能确认目标岗位，未点击沟通：${job.title}。继续处理下一个岗位。`);
    renderList();
    return "continue";
  }
  if (result === "no_button") {
    setJobProgress(job, "unavailable", "没有“立即沟通”按钮");
    completeJob(job);
    setStatus(`该岗位没有“立即沟通”按钮：${job.title}。继续处理下一个岗位。`);
    renderList();
    return "continue";
  }
  const blockingMessage = {
    stay_missing: "两次沟通点击均未得到 BOSS 确认，已停止处理，原职位页保持不动。",
    blocked_rate: "BOSS 提示操作频繁，已暂停后续岗位。",
    blocked_limit: "BOSS 提示沟通数量或额度已达上限，已暂停后续岗位。",
    blocked_security: "BOSS 要求安全验证，已暂停后续岗位，请先人工完成验证。",
    blocked_generic: "BOSS 拒绝了本次沟通，已暂停后续岗位。"
  }[result] || "本次沟通状态不明确，已停止处理。";
  setJobProgress(job, "attention", blockingMessage);
  completeJob(job);
  JC_STATE.pipeline.allPaused = true;
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
    const hasExternalChange = mutations.some((mutation) => !isInsideJobCopilot(mutation.target));
    if (hasExternalChange) schedulePageContextSync();
  });
  pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener("popstate", () => schedulePageContextSync(80));
  window.addEventListener("hashchange", () => schedulePageContextSync(80));
  setInterval(() => {
    if (!isJobsPage()) return;
    const snapshot = captureJobSnapshot();
    if (snapshot.jobs.length && snapshot.fingerprint !== JC_STATE.page.fingerprint) {
      schedulePageContextSync(80);
    }
  }, 1200);
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
  for (let attempt = 0; attempt < 4; attempt += 1) {
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
  const overlap = jobKeyOverlap(previousJobs, snapshot.jobs);
  // BOSS updates category/search results without a full navigation. Low key
  // overlap means this is a new page context, so late work from the old context
  // must be invalidated before any new result can be rendered or contacted.
  const pageReplaced = initialized && previousJobs.length > 0 && snapshot.jobs.length > 0 && overlap < 0.35;

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
    JC_STATE.jobProgress.clear();
    JC_STATE.pipeline.batchKeys = [];
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
  for (const oldJob of previousJobs) {
    const status = progressFor(oldJob).status;
    if (!nextKeys.has(oldJob.key) && ["contacted", "unavailable", "detail_mismatch", "attention"].includes(status)) {
      reconciled.push({ ...oldJob, detached: true });
    }
  }
  const added = snapshot.jobs.filter((job) => !previousByKey.has(job.key));
  JC_STATE.jobs = reconciled.map((job, index) => ({ ...job, index }));
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

function jobKeyOverlap(previousJobs, nextJobs) {
  if (!previousJobs.length || !nextJobs.length) return 0;
  const previousKeys = new Set(previousJobs.map((job) => job.key));
  const matches = nextJobs.filter((job) => previousKeys.has(job.key)).length;
  return matches / Math.max(1, Math.min(previousJobs.length, nextJobs.length));
}

function invalidateCurrentPageWork() {
  JC_STATE.analysisRunId += 1;
  JC_STATE.analyzing = false;
  clearHighlights();
}

function restartPipelineForGeneration(mode, generation) {
  setTimeout(() => {
    if (JC_STATE.page.generation !== generation || JC_STATE.pipeline.allPaused) return;
    if (mode === "auto") startAutoPipeline({ confirmUser: false });
  }, 300);
}

function isInsideJobCopilot(node) {
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element?.closest?.("#job-copilot-panel, #job-copilot-launcher"));
}

function isJobsPage() {
  const url = location.href;
  if (isBossChatUrl(url)) return false;
  if (/\/web\/geek\/job|\/web\/geek\/recommend|query=/.test(url)) return true;
  return findCards().length > 0 || /推荐|职位|立即沟通/.test(cleanText(document.body?.innerText || "").slice(0, 2000));
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

function clickWithoutNavigation(node) {
  if (!node) return false;
  const anchor = node.closest?.("a[href]");
  const href = anchor?.getAttribute?.("href") || "";
  // The click runs in a disposable worker tab, so normal BOSS navigation is
  // safe there. Keep the href visible to BOSS's delegated handler; removing it
  // can make some job-detail button variants ignore an otherwise valid click.
  // Only cancel javascript: URL execution, which Chromium rejects under the
  // extension page CSP after BOSS's own click handler has already run.
  if (anchor && /^javascript:/i.test(href)) {
    anchor.addEventListener("click", (event) => event.preventDefault(), {
      capture: true,
      once: true
    });
  }
  node.click();
  return true;
}

function isElementVisible(node) {
  if (!node || !(node instanceof Element)) return false;
  const rect = node.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = getComputedStyle(node);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0;
}

function renderList() {
  const list = document.getElementById("jc-list");
  if (!list) return;
  list.innerHTML = "";
  for (const job of JC_STATE.jobs) {
    const analysis = JC_STATE.analyses.get(job.key);
    const score = analysis?.score ?? "--";
    const progress = progressFor(job);
    const progressInfo = jobProgressInfo(progress.status);
    const meta = [job.company, job.city, job.requirements].filter(Boolean).slice(0, 2).join(" · ");
    const item = document.createElement("div");
    item.className = `jc-job-row is-${progressInfo.tone}`;
    item.innerHTML = `
      <div class="jc-job-index">${job.index + 1}</div>
      <div class="jc-job-content">
        <strong>${renderTitleHtml(job)}</strong>
        <div class="jc-job-meta">${escapeHtml(meta || "岗位信息待展开")}</div>
        ${progress.detail ? `<div class="jc-job-detail">${escapeHtml(progress.detail)}</div>` : ""}
      </div>
      <div class="jc-job-result">
        <span class="jc-progress-chip is-${progressInfo.tone}">${progressInfo.label}</span>
        <span class="jc-score">${score === "--" ? "" : `${escapeHtml(String(score))} 分`}</span>
        ${progress.status === "error"
          ? `<button class="jc-locate-button jc-retry-button" data-retry-key="${escapeAttr(job.key)}" ${job.detached ? "disabled" : ""}>重新分析</button>`
          : `<button class="jc-locate-button" data-focus-key="${escapeAttr(job.key)}" ${job.detached ? "disabled" : ""}>定位</button>`}
      </div>
    `;
    list.appendChild(item);
  }
  list.querySelectorAll("[data-focus-key]").forEach((button) => {
    button.addEventListener("click", () => focusJob(button.dataset.focusKey));
  });
  list.querySelectorAll("[data-retry-key]").forEach((button) => {
    button.addEventListener("click", () => {
      retryFailedJob(button.dataset.retryKey).catch((error) => {
        setStatus(`重新分析启动失败：${friendlyAiError(error?.message || error)}`);
        updateAutomationControls();
      });
    });
  });
  updateProgressSummary();
}

async function retryFailedJob(key) {
  const previous = JC_STATE.jobs.find((job) => job.key === key);
  if (!previous) return;

  // Invalidate an in-flight result before moving the page detail pane. This
  // prevents a late response for another job from being written after retry.
  if (JC_STATE.analyzing) {
    JC_STATE.analysisRunId += 1;
    JC_STATE.analyzing = false;
    for (const job of JC_STATE.jobs) {
      if (progressFor(job).status === "analyzing") setJobProgress(job, "pending", "等待后续分析");
    }
  }

  await synchronizePageContext({ force: true, source: "retry" });
  const job = JC_STATE.jobs.find((item) => item.key === key);
  if (!job || !job.card?.isConnected) {
    setJobProgress(key, "error", "原岗位已离开当前页面，无法重新分析");
    setStatus(`无法重新分析：${previous.title} 已不在当前职位列表。`);
    renderList();
    return;
  }

  setStatus(`正在定位失败岗位：${job.title}`);
  const located = await selectJobDetail(job);
  if (!located) {
    setJobProgress(job, "error", "未能确认原岗位右侧详情，请刷新职位列表后重试");
    setStatus(`未能定位回原岗位：${job.title}。请刷新职位列表后再点“重新分析”。`);
    renderList();
    return;
  }

  JC_STATE.analyses.delete(job.key);
  JC_STATE.completedJobKeys.delete(job.key);
  JC_STATE.retryJobKey = job.key;
  JC_STATE.pipeline.batchKeys = [job.key];
  setJobProgress(job, "pending", "已定位原岗位，等待重新分析");
  JC_STATE.pipeline.active = true;
  JC_STATE.pipeline.mode = "auto";
  JC_STATE.pipeline.allPaused = false;
  JC_STATE.sessionOwner = true;
  JC_STATE.remoteSession = null;
  await registerAutomationSession();
  setStatus(`已定位回原岗位，准备重新分析：${job.title}`);
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
  node.textContent = `第 ${batch} 批 · 当前列表 ${visible} 个岗位`;
}

function setNodeText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = String(value);
}

function isTransientAiError(error) {
  // Browser and service-worker fetch failures vary across Chromium platforms.
  // Treat network failures and truncated model JSON as retryable so the current
  // job stays pending instead of being skipped or allowing later communication.
  return /Tunnel connection failed|Failed to fetch|NetworkError|network request failed|Load failed|ERR_(?:NETWORK|INTERNET|CONNECTION|TIMED_OUT)|503|502|504|timeout|timed out|Service Unavailable|Bad Gateway|Gateway Timeout|Unexpected end of JSON input|unterminated JSON|JSON.*(?:incomplete|truncated)/i.test(String(error || ""));
}

function isExtensionContextError(error) {
  return /Extension context invalidated|context invalidated|receiving end does not exist|No SW/i.test(String(error || ""));
}

function stopForInvalidatedExtensionContext(job) {
  JC_STATE.analysisRunId += 1;
  JC_STATE.analyzing = false;
  JC_STATE.pipeline.active = false;
  JC_STATE.pipeline.allPaused = true;
  JC_STATE.pipeline.contextInvalidated = true;
  if (job) {
    JC_STATE.analyses.delete(job.key);
    setJobProgress(job, "attention", "扩展已更新，请刷新当前页面后继续");
  }
  setStatus("扩展已重新加载，当前页面仍是旧脚本。请点击下方按钮刷新页面加载新版。");
  renderList();
  updateAutomationControls();
}

function friendlyAiError(error) {
  const text = String(error || "");
  if (isExtensionContextError(text)) {
    return "扩展已更新，请刷新当前 BOSS 页面加载新版。";
  }
  if (/Unexpected end of JSON input|unterminated JSON|JSON.*(?:incomplete|truncated)/i.test(text)) {
    return "AI 服务返回内容不完整，已暂停并保留当前岗位；恢复后可从该岗位重新分析。";
  }
  if (isTransientAiError(text)) {
    return "AI 服务网络/代理暂时不可用，建议稍后重试；这不是岗位不匹配。";
  }
  if (/401|403|Unauthorized|invalid.*key/i.test(text)) {
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
  }) || ordered.find((job) => !job.detached);
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
  await updateContactSession(true, job);
  try {
    // Communication runs in a disposable inactive tab. BOSS may navigate that
    // tab to chat, but the dedicated jobs tab and its in-memory list never move.
    const result = await sendMessage({
      type: "communicateInIsolatedTab",
      job: {
        key: job.key,
        title: job.jobName || job.title,
        company: job.company,
        url: job.url
      }
    });
    if (!result?.ok) throw new Error(result?.error || "隔离沟通失败");
    if (result.status === "stayed" || result.status === "navigated_chat") {
      logContactEvent(`isolated_${result.status}`, job);
      return "stayed";
    }
    logContactEvent(`isolated_${result.status || "unknown"}`, job);
    return result.status || "stay_missing";
  } finally {
    await updateContactSession(false, job).catch(() => {});
  }
}

async function performIsolatedCommunication(expectedJob) {
  const expectation = typeof expectedJob === "string" ? { title: expectedJob } : (expectedJob || {});
  let sawCommunicateButton = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const button = findImmediateCommunicateButtons(document).find((node) => isElementVisible(node));
    if (button) {
      sawCommunicateButton = true;
      // BOSS may report document complete before its React detail pane finishes
      // replacing the default job. Keep waiting instead of failing on that
      // transient pane, and never click while the job identity is uncertain.
      if (!isolatedJobMatchesExpectation(button, expectation)) {
        await sleep(100);
        continue;
      }
      for (let clickAttempt = 0; clickAttempt < 2; clickAttempt += 1) {
        const currentButton = findImmediateCommunicateButtons(document)
          .find((node) => isElementVisible(node) && isolatedJobMatchesExpectation(node, expectation));
        if (!currentButton) {
          if (hasSuccessfulContactEvidence()) return "stayed";
          return communicationBlockStatus() || "stay_missing";
        }
        currentButton.scrollIntoView?.({ block: "center", inline: "center" });
        currentButton.focus?.({ preventScroll: true });
        const stayWaiter = createStayOnCurrentPageWaiter(clickAttempt === 0 ? 18000 : 15000);
        try {
          if (clickAttempt === 0) clickWithoutNavigation(currentButton);
          else dispatchCommunicationRetryClick(currentButton);
          const result = await stayWaiter.promise;
          if (result !== "stay_missing") return result;
        } finally {
          stayWaiter.cancel();
        }
        const blocked = communicationBlockStatus();
        if (blocked) return blocked;
        if (hasSuccessfulContactEvidence()) return "stayed";
        if (clickAttempt === 0) await sleep(1200);
      }
      return communicationBlockStatus() || "stay_missing";
    }
    await sleep(100);
  }
  return sawCommunicateButton ? "detail_mismatch" : "no_button";
}

function dispatchCommunicationRetryClick(node) {
  if (!node) return false;
  preventJavascriptUrlDefaultOnce(node);
  const eventOptions = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    buttons: 1
  };
  node.dispatchEvent(new MouseEvent("mousedown", eventOptions));
  node.dispatchEvent(new MouseEvent("mouseup", { ...eventOptions, buttons: 0 }));
  node.dispatchEvent(new MouseEvent("click", { ...eventOptions, buttons: 0 }));
  return true;
}

function communicationBlockStatus() {
  const text = cleanText(document.body?.innerText || "");
  if (/安全验证|验证码|拖动滑块|滑块验证|访问异常|账号异常/.test(text)) return "blocked_security";
  if (/沟通.{0,8}(?:上限|额度|数量)|今日.{0,8}(?:沟通|招呼).{0,8}(?:上限|用完)|已达.{0,8}(?:沟通|招呼)/.test(text)) {
    return "blocked_limit";
  }
  if (/操作频繁|请求频繁|请稍后再试|操作过快|访问过于频繁/.test(text)) return "blocked_rate";
  if (/沟通失败|发送失败|暂时无法沟通|无法发起沟通/.test(text)) return "blocked_generic";
  return "";
}

function isolatedJobMatchesExpectation(button, expectedJob) {
  const detail = findJobDetailScope(button);
  if (!detail) return false;

  const expectedId = bossJobId(expectedJob?.url) || bossJobId(expectedJob?.key);
  const currentId = bossJobId(location.href);
  if (expectedId && currentId && expectedId !== currentId) return false;

  const titleVariants = comparableJobTitleVariants(expectedJob?.title);
  if (!titleVariants.length) return false;
  const detailText = comparableJobText(detail.innerText || "");
  const headingTexts = Array.from(detail.querySelectorAll(
    "h1,h2,h3,.job-name,.job-title,[class*='job-name'],[class*='job-title'],[class*='name']"
  )).filter((node) => isElementVisible(node))
    .map((node) => comparableJobText(node.innerText || node.textContent || ""))
    .filter(Boolean);
  const titleMatched = titleVariants.some((title) => detailText.includes(title)
    || headingTexts.some((heading) => heading.includes(title) || title.includes(heading)));
  if (!titleMatched) return false;

  // An exact job_detail ID is the strongest boundary. On list-style routes,
  // require the company too so a similarly named role cannot be contacted.
  if (expectedId && currentId) return true;
  const expectedCompany = comparableJobText(expectedJob?.company || "");
  return !expectedCompany || detailText.includes(expectedCompany);
}

function bossJobId(value) {
  const raw = String(value || "");
  const keyMatch = raw.match(/^job:([^/?#]+)/i);
  if (keyMatch?.[1]) return keyMatch[1].toLowerCase();
  try {
    const url = new URL(raw, "https://www.zhipin.com");
    const pathMatch = url.pathname.match(/\/job_detail\/([^/?#]+)/i);
    return pathMatch?.[1]?.toLowerCase() || "";
  } catch {
    return "";
  }
}

function comparableJobTitleVariants(value) {
  const raw = stripObfuscatedSalary(String(value || ""));
  const beforeSuffix = raw.split(/\s*(?:[-—|｜])\s*/)[0];
  const withoutParenthetical = raw.replace(/[（(][^）)]{1,40}[）)]/g, " ");
  const candidates = [raw, beforeSuffix, withoutParenthetical,
    beforeSuffix.replace(/[（(][^）)]{1,40}[）)]/g, " ")];
  return Array.from(new Set(candidates.map((item) => comparableJobText(item))))
    .filter((item) => item.length >= 4);
}

async function selectJobDetail(job) {
  clearHighlights();
  JC_STATE.selectedKey = job.key;
  job.card.classList.add("jc-highlight");
  job.card.scrollIntoView({ behavior: "smooth", block: "center" });
  if (detailMatchesJob(job)) return true;

  const targets = findJobCardActivationTargets(job.card);
  if (!targets.length) return false;
  // BOSS versions differ: some bind selection to the whole card, while others
  // bind it to the title or detail link. Try those real click surfaces in order.
  for (const target of targets) {
    safeClick(target);
    for (let attempt = 0; attempt < 18; attempt += 1) {
      await sleep(100);
      if (detailMatchesJob(job)) return true;
      if (isBossChatUrl(location.href)) return false;
    }
  }
  logContactEvent("detail_mismatch", job);
  return false;
}

function findJobCardActivationTargets(card) {
  const nodes = [
    card,
    card.querySelector(".job-name, .job-title, [class*='job-name'], [class*='job-title']"),
    card.querySelector("a[href*='/job_detail/']")
  ].filter((node) => node && isElementVisible(node));
  const targets = [];
  for (const node of nodes) {
    const target = node === card ? card : (node.closest("a,button") || node);
    if (!targets.includes(target)) targets.push(target);
  }
  return targets;
}

function detailMatchesJob(job) {
  return Boolean(findImmediateCommunicateButtonForJob(job));
}

function immediateCommunicateButtonMatchesJob(button, job) {
  const detail = findJobDetailScope(button);
  if (!detail) return false;
  const targetTitle = comparableJobText(job.jobName || job.title || "");
  const targetCompany = comparableJobText(job.company || "");
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
  const companyMatched = targetCompany.length >= 2 && detailText.includes(targetCompany);
  return titleMatched || companyMatched;
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

function logContactEvent(event, job) {
  const entry = {
    event,
    jobIndex: Number(job?.index ?? -1),
    title: cleanText(job?.jobName || job?.title || "").slice(0, 40),
    page: location.pathname
  };
  console.info("[Job Copilot] contact", entry);
  sendMessage({
    type: "appendAutomationLog",
    entry: { ...entry, detail: `jobIndex=${entry.jobIndex}` }
  }).catch(() => {});
}

function createStayOnCurrentPageWaiter(timeoutMs = 10000) {
  let settled = false;
  let confirmationClicked = false;
  let observer = null;
  let intervalId = null;
  let timeoutId = null;
  let resolvePromise = null;

  const cleanup = () => {
    observer?.disconnect();
    if (intervalId) clearInterval(intervalId);
    if (timeoutId) clearTimeout(timeoutId);
  };
  const finish = (result) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(result);
  };
  const probe = () => {
    if (settled || confirmationClicked) return;
    if (isBossChatUrl(location.href)) {
      finish("chat_route");
      return;
    }
    const button = findStayOnCurrentPageButton();
    if (button) {
      confirmationClicked = true;
      safeClick(button);
      setTimeout(() => finish("stayed"), 300);
      return;
    }
    if (hasSuccessfulContactEvidence()) finish("stayed");
  };
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
    observer = new MutationObserver(probe);
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    intervalId = setInterval(probe, 25);
    timeoutId = setTimeout(() => finish("stay_missing"), timeoutMs);
    probe();
  });

  return {
    promise,
    cancel() {
      if (!settled) finish("cancelled");
    }
  };
}

function hasSuccessfulContactEvidence() {
  const controls = Array.from(document.querySelectorAll("a,button"));
  const changedControl = controls.some((item) => {
    if (isInsideJobCopilot(item) || !isElementVisible(item)) return false;
    const text = cleanText(item.innerText || item.textContent || "");
    return text === "继续沟通" || text === "已沟通";
  });
  if (changedControl) return true;
  const pageText = cleanText(document.body?.innerText || "");
  return /已向BOSS发送消息|消息发送成功|招呼已发送|已与BOSS沟通|已发起沟通/.test(pageText);
}

function findStayOnCurrentPageButton() {
  const candidates = Array.from(document.querySelectorAll("button,a,div[class*='btn'],span[class*='btn']"));
  return candidates.find((item) => {
    if (!isElementVisible(item)) return false;
    const text = cleanText(item.innerText || item.textContent || "");
    if (text !== "留在此页") return false;
    const dialog = item.closest("[role='dialog'], .dialog, .modal, .boss-dialog, [class*='dialog'], [class*='modal']");
    const scopeText = cleanText((dialog || item.parentElement || item).innerText || "");
    return /已向BOSS发送消息|留在此页/.test(scopeText);
  });
}

function findCards() {
  const selectors = [".job-card-wrapper", ".job-list-box li", "li[class*='job-card']", "div[class*='job-card']"];
  for (const selector of selectors) {
    const cards = Array.from(document.querySelectorAll(selector));
    if (cards.length > 0) return cards;
  }
  return [];
}

function findImmediateCommunicateButtons(root) {
  const items = Array.from(root.querySelectorAll("a,button"));
  return items.filter((item) => !isInsideJobCopilot(item)
    && isElementVisible(item)
    && cleanText(item.innerText || item.textContent || "") === "立即沟通");
}

function findImmediateCommunicateButtonForJob(job) {
  return findImmediateCommunicateButtons(document)
    .find((button) => immediateCommunicateButtonMatchesJob(button, job)) || null;
}

function extractJobName(card, text) {
  const node = card.querySelector(".job-name, .job-title, [class*='job-name'], [class*='job-title']");
  const raw = cleanText(node?.innerText || "") || firstUsefulLine(card, text);
  return cleanTitleBase(raw).slice(0, 42) || "未知岗位";
}

function buildDisplayTitle(jobName, salary, cardText) {
  const displaySalary = normalizeDisplaySalary(salary) || normalizeDisplaySalary(findSalaryLine(cardText));
  return [jobName, displaySalary].filter(Boolean).join(" ").slice(0, 72);
}

function extractCompany(card, text) {
  const node = card.querySelector(".company-name, [class*='company']");
  return cleanText(node?.innerText || "").slice(0, 40) || "";
}

function extractSalaryInfo(card, text) {
  const node = findSalaryNode(card);
  const raw = cleanText(node?.innerText || node?.textContent || "");
  const sourceText = raw || text;
  const fontFamily = node ? getComputedStyle(node).fontFamily : "";
  const normal = sourceText.match(/\d+\s*-\s*\d+\s*K/i) || sourceText.match(/\d+\s*-\s*\d+千/);
  if (normal) return { text: normalizeDisplaySalary(sourceText) || normal[0], fontFamily };
  const obfuscated = sourceText.match(/[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{2,}\s*[-~—]\s*[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{2,}\s*[Kk]?/);
  if (obfuscated) return { text: normalizeDisplaySalary(sourceText) || obfuscated[0], fontFamily };
  return { text: "", fontFamily };
}

function normalizeDisplaySalary(text) {
  const value = cleanText(text || "");
  if (!value) return "";
  const salary = value.match(/\d+\s*[-~—]\s*\d+\s*[Kk](?:\s*[·,，、|｜/\\-]?\s*\d+\s*薪)?/);
  if (salary) return cleanText(salary[0].replace(/\s+/g, ""));
  const obfuscated = value.match(/[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{1,}\s*[-~—]\s*[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{1,}\s*[Kk](?:\s*[·,，、|｜/\\-]?\s*[█▉▊▋▌▍▎▏■\uE000-\uF8FF\d]{1,}\s*薪)?/);
  if (obfuscated) return cleanText(obfuscated[0].replace(/\s+/g, ""));
  return "";
}

function findSalaryLine(text) {
  const lines = String(text || "").split(/\n+|\s{2,}/).map((line) => cleanText(line));
  return lines.find((line) => /\d+\s*[-~—]\s*\d+\s*[Kk]|[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{1,}\s*[-~—]\s*[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{1,}\s*[Kk]/.test(line)) || "";
}

function findSalaryNode(card) {
  const selectors = [".salary", ".job-salary", "[class*='salary']", "[class*='Salary']", "[class*='red']"];
  for (const selector of selectors) {
    const node = card.querySelector(selector);
    if (node && /[Kk千█▉▊▋▌▍▎▏■\uE000-\uF8FF]/.test(node.innerText || node.textContent || "")) return node;
  }
  const nodes = Array.from(card.querySelectorAll("span,em,b,p,div"));
  return nodes.find((node) => /[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{2,}|[Kk]|千/.test(cleanText(node.innerText || node.textContent || ""))) || null;
}

function salaryForAi(text) {
  const normal = text.match(/\d+\s*-\s*\d+\s*K/i) || text.match(/\d+\s*-\s*\d+千/);
  return normal ? normal[0] : "";
}

function renderTitleHtml(job) {
  const pieces = [escapeHtml(job.jobName || job.title)];
  const salary = normalizeDisplaySalary(job.salary) || normalizeDisplaySalary(findSalaryLine(job.text));
  if (salary) {
    const style = job.salaryFontFamily ? ` style="font-family:${escapeAttr(job.salaryFontFamily)}"` : "";
    pieces.push(`<span${style}>${escapeHtml(salary)}</span>`);
  }
  return pieces.join(" ");
}

function cleanTitleBase(text) {
  return cleanText(String(text || "")
    .replace(/[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{1,}\s*[-~—]\s*[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{1,}\s*[Kk]?/g, "")
    .replace(/[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{1,}\s*薪/g, "")
    .replace(/[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{1,}/g, "")
    .replace(/\d+\s*[-~—]\s*\d+\s*[Kk]/g, "")
    .replace(/\d+\s*薪/g, "")
    .replace(/[-~—]\s*[Kk]\b/g, "")
    .replace(/[·,，、|｜/\\-]+\s*$/g, "")
    .replace(/\s+[·,，、|｜/\\-]+/g, " "));
}

function extractRequirements(card, text) {
  const lines = String(card.innerText || "").split(/\n+/).map((line) => cleanText(line)).filter(Boolean);
  const candidates = lines.concat(text.split(/\s{2,}| · | 丨 |\|/).map((item) => cleanText(item)));
  const requirementParts = [];
  for (const item of candidates) {
    if (!item || requirementParts.includes(item)) continue;
    if (/^\d+\s*[-~—]\s*\d+\s*[Kk]$/.test(item)) continue;
    if (isLocationMetadata(item)) continue;
    if (/经验|学历|本科|大专|应届|不限|在校|实习|Java|后端|前端|测试|运维|Python|SQL|全职|兼职/.test(item)) {
      requirementParts.push(item.slice(0, 24));
    }
    if (requirementParts.length >= 3) break;
  }
  return requirementParts.join(" · ");
}

function extractUrl(card) {
  const link = card.querySelector("a[href]");
  if (!link) return "";
  const href = link.getAttribute("href") || "";
  if (!href || /^javascript:/i.test(href)) return "";
  return new URL(href, location.href).href;
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
  if (node) node.textContent = "扩展已重新加载，请刷新当前职位页后继续。";
  updateAutomationControls();
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function firstUsefulLine(card, fallbackText) {
  const lines = String(card.innerText || "").split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const line = lines.find((item) => !/沟通|收藏|薪|发布|经验|学历/.test(item) && !isLocationMetadata(item))
    || lines[0]
    || fallbackText;
  return line || "";
}

function stripObfuscatedSalary(text) {
  return cleanText(String(text || "")
    .replace(/[█▉▊▋▌▍▎▏■]{2,}\s*[-~—]\s*[█▉▊▋▌▍▎▏■]{2,}\s*[Kk]?/g, "")
    .replace(/\d+\s*[-~—]\s*\d+\s*[Kk]/g, "")
    .replace(/[█▉▊▋▌▍▎▏■]{2,}\s*薪?/g, "")
    .replace(/薪资已隐藏/g, ""));
}

function buildJobTextForAi(job) {
  return stripObfuscatedSalary(job.text)
    .replace(/[█▉▊▋▌▍▎▏■]+/g, "")
    .slice(0, 3000);
}

async function collectJobDescriptionForAnalysis(job) {
  const cardText = buildJobTextForAi(job);
  const selected = await selectJobDetail(job);
  if (!selected) {
    return { text: cardText, complete: false };
  }
  const communicateButton = findImmediateCommunicateButtonForJob(job);
  const detailScope = communicateButton ? findJobDetailScope(communicateButton) : null;
  const detailText = stripObfuscatedSalary(detailScope?.innerText || "")
    .replace(/[█▉▊▋▌▍▎▏■]+/g, "")
    .slice(0, 9000);
  if (detailText.length < 80) {
    return { text: cardText, complete: false };
  }
  return {
    text: `【岗位卡片】\n${cardText}\n\n【完整职位详情】\n${detailText}`,
    complete: true
  };
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function escapeAttr(text) {
  return String(text || "").replace(/[;"<>]/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 页面共享状态和时序常量；功能脚本通过 JC_STATE 协作，入口最后启动。
const JC_STATE = {
  jobs: [],
  analyses: new Map(),
  analysisPayloads: new Map(),
  reanalysisInFlightKeys: new Set(),
  jobProgress: new Map(),
  busyPageContactRetries: new Map(),
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
// 后台标签的计时器可能被显著延迟；按实际等待时长识别限速，避免误判岗位失败。
const THROTTLED_TICK_RATIO = 5;
const THROTTLED_TICK_MIN_MS = 2000;
const THROTTLE_RECOVERY_TIMEOUT_MS = 120000;
const THROTTLED_CONTACT_ERROR = "浏览器在后台限速了这个标签，本次沟通未能完成";
// 与后台原生点击超时保持一致；未送达的点击不能当作网站拒绝。
const NATIVE_CLICK_TIMEOUT_MS = 20000;
const NATIVE_CLICK_TIMEOUT_PATTERN = /原生点击超时/;
const MAX_BUSY_PAGE_CONTACT_RETRIES = 1;
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
const CONTENT_SCRIPT_VERSION = `${EXTENSION_VERSION}-manual-contact-v7`;
// 后台每次分析读取最新设置，页面也需同步；字段与 publicRuntimeSettings 保持一致。
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

let contactTickTracker = null;
let lastContactTickReport = null;

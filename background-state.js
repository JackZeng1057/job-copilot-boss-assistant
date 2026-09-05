// 后台常量、默认配置与内存状态；仅在 service worker 内使用。
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
// 调试命令需等待渲染进程确认，因此每一步都设超时，避免页面忙碌时阻塞整条队列。
const NATIVE_CLICK_TIMEOUT_MS = 20000;
const NATIVE_CLICK_RELEASE_TIMEOUT_MS = 2000;
const IDLE_DETECTION_INTERVAL_SECONDS = 60;
const AI_REQUEST_TIMEOUT_MS = 60000;
// Anthropic 必须传 max_tokens；其他协议保留模型默认输出上限。
const ANTHROPIC_REQUIRED_MAX_OUTPUT_TOKENS = 16384;
const MAX_STORED_ANALYSES = 50;
const MAX_RESUME_INPUT_CHARS = 16000;
const MAX_JOB_DESCRIPTION_INPUT_CHARS = 7000;
const OWNER_ROUTE_RECOVERY_CHECKPOINTS_MS = [300, 700, 1500, 3000];
const MAX_ANALYSIS_REASONS = 3;
const MAX_ANALYSIS_RISKS = 2;
// 为兼容各服务商，schema 仅声明类型与枚举；数值范围和列表长度在本地归一化。
const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "integer" },
    decision: { type: "string", enum: ["recommend", "manual_review", "skip"] },
    excluded: { type: "boolean" },
    exclusion_match: { type: "string" },
    exclusion_reason: { type: "string" },
    occupation_family: { type: "string" },
    target_alignment: { type: "string", enum: ["direct", "transferable", "unrelated", "unclear"] },
    reasons: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    location_fit: { type: "string", enum: ["good", "acceptable", "unclear", "poor"] },
    greeting: { type: "string" }
  },
  required: [
    "score", "decision", "excluded", "exclusion_match", "exclusion_reason",
    "occupation_family", "target_alignment", "reasons", "risks", "location_fit", "greeting"
  ]
};
const automationStorage = chrome.storage.session || chrome.storage.local;
const ownerRouteRecoveryTabIds = new Set();
const nativeContactTabIds = new Set();
const unsupportedReasoningCapabilityKeys = new Set();

import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).toString();

const fields = {
  aiProvider: document.getElementById("aiProvider"),
  apiProtocol: document.getElementById("apiProtocol"),
  apiAuthType: document.getElementById("apiAuthType"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  minScore: document.getElementById("minScore"),
  profileDefault: document.getElementById("profileDefault"),
  profileAltA: document.getElementById("profileAltA"),
  profileAltB: document.getElementById("profileAltB"),
  currentLocation: document.getElementById("currentLocation"),
  targetDirections: document.getElementById("targetDirections"),
  excludedDirections: document.getElementById("excludedDirections"),
  customInstructions: document.getElementById("customInstructions"),
  greetingStyle: document.getElementById("greetingStyle"),
  resumeDefault: document.getElementById("resumeDefault"),
  resumeDefaultFile: document.getElementById("resumeDefaultFile"),
  resumeDefaultFilePicker: document.getElementById("resumeDefaultFilePicker"),
  resumeDefaultFileStatus: document.getElementById("resumeDefaultFileStatus"),
  resumeAltA: document.getElementById("resumeAltA"),
  resumeAltAFile: document.getElementById("resumeAltAFile"),
  resumeAltAFilePicker: document.getElementById("resumeAltAFilePicker"),
  resumeAltAFileStatus: document.getElementById("resumeAltAFileStatus"),
  resumeAltB: document.getElementById("resumeAltB"),
  resumeAltBFile: document.getElementById("resumeAltBFile"),
  resumeAltBFilePicker: document.getElementById("resumeAltBFilePicker"),
  resumeAltBFileStatus: document.getElementById("resumeAltBFileStatus"),
  restrictTargetLocation: document.getElementById("restrictTargetLocation"),
  autoRunOnJobsPage: document.getElementById("autoRunOnJobsPage")
};

const resumeFileNames = {
  resumeDefault: "",
  resumeAltA: "",
  resumeAltB: ""
};

const defaults = {
  aiProvider: "deepseek",
  apiProtocol: "openai_chat",
  apiAuthType: "bearer",
  apiBaseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-v4-flash",
  minScore: 60,
  profile: "default",
  currentLocation: "",
  targetDirections: "",
  excludedDirections: "",
  customInstructions: "",
  greetingStyle: "简洁、真诚，突出匹配经历和到岗意愿。",
  resumeDefault: "",
  resumeDefaultFileName: "",
  resumeAltA: "",
  resumeAltAFileName: "",
  resumeAltB: "",
  resumeAltBFileName: "",
  restrictTargetLocation: false,
  autoRunOnJobsPage: false,
};

chrome.storage.local.get(
  null,
  (items) => {
    const storageError = chrome.runtime.lastError;
    const raw = !storageError && items && typeof items === "object" ? items : {};
    const stored = { ...defaults, ...raw };
    fields.aiProvider.value = raw.aiProvider || inferProvider(stored.apiBaseUrl);
    fields.apiProtocol.value = raw.apiProtocol || providerPreset(fields.aiProvider.value).protocol;
    fields.apiAuthType.value = raw.apiAuthType || providerPreset(fields.aiProvider.value).auth;
    fields.apiBaseUrl.value = stored.apiBaseUrl;
    fields.apiKey.value = stored.apiKey;
    fields.model.value = stored.model;
    fields.minScore.value = stored.minScore;
    setSelectedProfiles(stored.profile);
    fields.currentLocation.value = stored.currentLocation;
    fields.targetDirections.value = stored.targetDirections;
    fields.excludedDirections.value = stored.excludedDirections;
    fields.customInstructions.value = stored.customInstructions;
    fields.greetingStyle.value = stored.greetingStyle;
    fields.resumeDefault.value = stored.resumeDefault;
    fields.resumeAltA.value = stored.resumeAltA;
    fields.resumeAltB.value = stored.resumeAltB;
    resumeFileNames.resumeDefault = stored.resumeDefaultFileName || "";
    resumeFileNames.resumeAltA = stored.resumeAltAFileName || "";
    resumeFileNames.resumeAltB = stored.resumeAltBFileName || "";
    syncResumeImportState("resumeDefault");
    syncResumeImportState("resumeAltA");
    syncResumeImportState("resumeAltB");
    fields.restrictTargetLocation.checked = stored.restrictTargetLocation === true;
    fields.autoRunOnJobsPage.checked = stored.autoRunOnJobsPage === true;
    updateApiFieldState();
    syncAdvancedState();
  }
);

fields.aiProvider.addEventListener("change", () => {
  const preset = providerPreset(fields.aiProvider.value);
  fields.apiProtocol.value = preset.protocol;
  fields.apiAuthType.value = preset.auth;
  fields.apiBaseUrl.value = preset.baseUrl;
  if (preset.model) fields.model.value = preset.model;
  updateApiFieldState();
  syncAdvancedState();
});
fields.apiProtocol.addEventListener("change", updateApiFieldState);
fields.apiAuthType.addEventListener("change", updateApiFieldState);

document.getElementById("save").addEventListener("click", async () => {
  const apiBaseUrl = fields.apiBaseUrl.value.trim();
  const model = fields.model.value.trim();
  if (!apiBaseUrl) {
    alert("请填写 AI 接口地址。");
    return;
  }
  if (!model) {
    alert("请填写服务商提供的模型 ID。");
    return;
  }
  let apiOrigin;
  try {
    apiOrigin = apiOriginPattern(apiBaseUrl);
  } catch (error) {
    alert(error.message || error);
    return;
  }
  const permissionGranted = await ensureApiOriginPermission(apiOrigin);
  if (!permissionGranted) {
    alert("未获得该 AI 接口域名的访问权限，配置尚未保存。");
    return;
  }
  const minScore = Math.max(0, Math.min(100, Math.round(Number(fields.minScore.value || defaults.minScore))));
  chrome.storage.local.set(
  {
    aiProvider: fields.aiProvider.value,
    apiProtocol: fields.apiProtocol.value,
    apiAuthType: fields.apiAuthType.value,
    apiBaseUrl,
    apiKey: fields.apiKey.value.trim(),
    model,
    minScore,
    profile: selectedProfiles(),
    currentLocation: fields.currentLocation.value.trim(),
    targetDirections: fields.targetDirections.value.trim(),
    excludedDirections: fields.excludedDirections.value.trim(),
    customInstructions: fields.customInstructions.value.trim(),
    greetingStyle: fields.greetingStyle.value.trim(),
    resumeDefault: fields.resumeDefault.value.trim(),
    resumeDefaultFileName: resumeFileNames.resumeDefault || "",
    resumeAltA: fields.resumeAltA.value.trim(),
    resumeAltAFileName: resumeFileNames.resumeAltA || "",
    resumeAltB: fields.resumeAltB.value.trim(),
    resumeAltBFileName: resumeFileNames.resumeAltB || "",
    restrictTargetLocation: fields.restrictTargetLocation.checked,
    autoRunOnJobsPage: fields.autoRunOnJobsPage.checked,
  },
    () => {
      if (chrome.runtime.lastError) return;
      window.close();
    }
  );
});

function apiOriginPattern(value) {
  const url = new URL(String(value || "").trim());
  const isLoopbackHttp = url.protocol === "http:"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    throw new Error("AI 接口必须使用 HTTPS；本机接口可使用 http://localhost 或 http://127.0.0.1。");
  }
  if (url.username || url.password) throw new Error("AI 接口地址不能包含用户名或密码。");
  return `${url.origin}/*`;
}

function ensureApiOriginPermission(origin) {
  if (!chrome.permissions?.contains || !chrome.permissions?.request) return Promise.resolve(true);
  return new Promise((resolve) => chrome.permissions.contains({ origins: [origin] }, (alreadyGranted) => {
    if (chrome.runtime.lastError) {
      resolve(false);
      return;
    }
    if (alreadyGranted) {
      resolve(true);
      return;
    }
    chrome.permissions.request({ origins: [origin] }, (granted) => {
      if (chrome.runtime.lastError) resolve(false);
      else resolve(granted === true);
    });
  }));
}

const API_PROVIDER_PRESETS = {
  deepseek: { protocol: "openai_chat", auth: "bearer", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
  openai: { protocol: "openai_chat", auth: "bearer", baseUrl: "https://api.openai.com/v1", model: "" },
  anthropic: { protocol: "anthropic_messages", auth: "x-api-key", baseUrl: "https://api.anthropic.com", model: "" },
  gemini: { protocol: "gemini_generate_content", auth: "x-api-key", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "" },
  qwen: { protocol: "openai_chat", auth: "bearer", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "" },
  moonshot: { protocol: "openai_chat", auth: "bearer", baseUrl: "https://api.moonshot.cn/v1", model: "" },
  zhipu: { protocol: "openai_chat", auth: "bearer", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "" },
  siliconflow: { protocol: "openai_chat", auth: "bearer", baseUrl: "https://api.siliconflow.cn/v1", model: "" },
  openrouter: { protocol: "openai_chat", auth: "bearer", baseUrl: "https://openrouter.ai/api/v1", model: "" },
  groq: { protocol: "openai_chat", auth: "bearer", baseUrl: "https://api.groq.com/openai/v1", model: "" },
  together: { protocol: "openai_chat", auth: "bearer", baseUrl: "https://api.together.xyz/v1", model: "" },
  ollama: { protocol: "openai_chat", auth: "none", baseUrl: "http://localhost:11434/v1", model: "" },
  azure: { protocol: "azure_openai", auth: "api-key", baseUrl: "", model: "" },
  custom: { protocol: "openai_chat", auth: "bearer", baseUrl: "", model: "" }
};

function providerPreset(provider) {
  return API_PROVIDER_PRESETS[provider] || API_PROVIDER_PRESETS.custom;
}

function inferProvider(baseUrl) {
  const value = String(baseUrl || "").toLowerCase();
  const matches = {
    "api.deepseek.com": "deepseek",
    "api.openai.com": "openai",
    "api.anthropic.com": "anthropic",
    "generativelanguage.googleapis.com": "gemini",
    "dashscope.aliyuncs.com": "qwen",
    "api.moonshot.cn": "moonshot",
    "open.bigmodel.cn": "zhipu",
    "api.siliconflow.cn": "siliconflow",
    "openrouter.ai": "openrouter",
    "api.groq.com": "groq",
    "api.together.xyz": "together",
    "localhost:11434": "ollama",
    "127.0.0.1:11434": "ollama",
    "openai.azure.com": "azure"
  };
  return Object.entries(matches).find(([host]) => value.includes(host))?.[1] || "custom";
}

function updateApiFieldState() {
  const protocol = fields.apiProtocol.value;
  const fixedAuth = {
    anthropic_messages: "x-api-key",
    gemini_generate_content: "x-api-key",
    azure_openai: "api-key"
  }[protocol];
  if (fixedAuth) fields.apiAuthType.value = fixedAuth;
  fields.apiAuthType.disabled = Boolean(fixedAuth);
  const hints = {
    openai_chat: "可填写 Base URL，也可直接填写 /chat/completions 完整地址。",
    openai_responses: "使用 /v1/responses；适合支持 OpenAI Responses 的新式模型和兼容服务。",
    anthropic_messages: "使用 /v1/messages 和 x-api-key；Base URL 可填写 https://api.anthropic.com。",
    gemini_generate_content: "使用 models/{模型}:generateContent 和 x-goog-api-key。",
    azure_openai: "请填写含部署名与 api-version 的完整 Chat Completions 端点。"
  };
  document.getElementById("apiEndpointHint").textContent = hints[protocol] || hints.openai_chat;
  fields.apiKey.disabled = fields.apiAuthType.value === "none";
  fields.apiKey.placeholder = fields.apiKey.disabled ? "本机接口无需填写" : "由服务商提供";
}

function syncAdvancedState() {
  const advanced = document.getElementById("apiAdvanced");
  if (advanced) advanced.open = ["custom", "azure"].includes(fields.aiProvider.value);
}

document.querySelectorAll("[data-file-trigger]").forEach((button) => {
  button.addEventListener("click", () => fields[button.dataset.fileTrigger]?.click());
});
document.querySelectorAll("[data-file-clear]").forEach((button) => {
  button.addEventListener("click", () => clearResumeImport(button.dataset.fileClear));
});

fields.resumeDefaultFile.addEventListener("change", () => importResumeFile("resumeDefault", fields.resumeDefaultFile));
fields.resumeAltAFile.addEventListener("change", () => importResumeFile("resumeAltA", fields.resumeAltAFile));
fields.resumeAltBFile.addEventListener("change", () => importResumeFile("resumeAltB", fields.resumeAltBFile));

fields.resumeDefault.addEventListener("input", () => markResumeTextEdited("resumeDefault"));
fields.resumeAltA.addEventListener("input", () => markResumeTextEdited("resumeAltA"));
fields.resumeAltB.addEventListener("input", () => markResumeTextEdited("resumeAltB"));

function setSelectedProfiles(value) {
  const selected = normalizeProfiles(value);
  fields.profileDefault.checked = selected.includes("default");
  fields.profileAltA.checked = selected.includes("altA");
  fields.profileAltB.checked = selected.includes("altB");
}

function selectedProfiles() {
  const selected = [];
  if (fields.profileDefault.checked) selected.push("default");
  if (fields.profileAltA.checked) selected.push("altA");
  if (fields.profileAltB.checked) selected.push("altB");
  return selected.length ? selected : ["default"];
}

function normalizeProfiles(value) {
  const raw = (Array.isArray(value) ? value : [value || "default"])
    .map((item) => item === "test" ? "altA" : item === "ops" ? "altB" : item);
  const allowed = ["default", "altA", "altB"];
  const selected = raw.filter((item) => allowed.includes(item));
  return selected.length ? selected : ["default"];
}

async function importResumeFile(fieldName, fileInput) {
  const [targetTextarea, statusNode, pickerNode] = resumeUi(fieldName);
  const file = fileInput.files?.[0];
  if (!file || !targetTextarea) return;
  setFileStatus(statusNode, pickerNode, `正在解析：${file.name}...`);
  try {
    const text = await readResumeFile(file);
    if (!text.trim()) {
      setFileStatus(statusNode, pickerNode, "未读取到可用文本", "error");
      alert("没有从文件中读取到文本。PDF 可能是扫描件/图片型简历，请先 OCR 或直接复制简历正文粘贴。");
      return;
    }
    targetTextarea.value = text.trim();
    resumeFileNames[fieldName] = file.name;
    setFileStatus(statusNode, pickerNode, `已导入：${file.name}`, "ok");
  } catch (error) {
    setFileStatus(statusNode, pickerNode, `导入失败：${error.message || error}`, "error");
    alert(`读取简历失败：${error.message || error}`);
  } finally {
    fileInput.value = "";
  }
}

function setFileStatus(node, pickerNode, text, state = "") {
  if (!node) return;
  node.textContent = text;
  pickerNode?.classList.toggle("is-imported", state === "ok");
  pickerNode?.classList.toggle("is-error", state === "error");
}

function syncResumeImportState(fieldName) {
  const [textarea, statusNode, pickerNode] = resumeUi(fieldName);
  if (!textarea) return;
  if (textarea.value.trim()) {
    const fileName = resumeFileNames[fieldName];
    const prefix = fileName ? `已导入：${fileName}` : "已导入文本";
    setFileStatus(statusNode, pickerNode, prefix, "ok");
  } else {
    setFileStatus(statusNode, pickerNode, "未导入文件");
  }
}

function clearResumeImport(fieldName) {
  const [textarea, statusNode, pickerNode] = resumeUi(fieldName);
  if (!textarea) return;
  textarea.value = "";
  resumeFileNames[fieldName] = "";
  setFileStatus(statusNode, pickerNode, "未导入文件");
}

function markResumeTextEdited(fieldName) {
  resumeFileNames[fieldName] = "";
  syncResumeImportState(fieldName);
}

function resumeUi(fieldName) {
  const map = {
    resumeDefault: [fields.resumeDefault, fields.resumeDefaultFileStatus, fields.resumeDefaultFilePicker],
    resumeAltA: [fields.resumeAltA, fields.resumeAltAFileStatus, fields.resumeAltAFilePicker],
    resumeAltB: [fields.resumeAltB, fields.resumeAltBFileStatus, fields.resumeAltBFilePicker]
  };
  return map[fieldName] || [];
}

async function readResumeFile(file) {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return extractPdfText(await file.arrayBuffer());
  }
  return await file.text();
}

async function extractPdfText(buffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    cMapUrl: new URL("./vendor/pdfjs/cmaps/", import.meta.url).toString(),
    cMapPacked: true,
    useWorkerFetch: true
  });
  let pdf;
  try {
    pdf = await loadingTask.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/[^\S\r\n]+/g, " ")
        .trim();
      if (pageText) pages.push(pageText);
    }
    return pages.join("\n\n").trim();
  } finally {
    await loadingTask.destroy();
  }
}

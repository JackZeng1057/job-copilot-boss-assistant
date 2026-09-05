// 接口地址、协议和认证校验；不允许凭证出现在 URL 中。
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

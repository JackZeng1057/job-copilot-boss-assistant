// AI 请求超时、Chat Completions 兼容回退及推理配置。
async function callAi(settings, content, options = {}) {
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
    const response = await fetch(endpoint, { ...options, signal: controller.signal });
    // fetch 在响应头到达后就返回；正文读取也必须纳入超时窗口。
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
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
  let text = response.text;
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
    text = response.text;
  }
  if (!response.ok) {
    throw new Error(`AI request failed: status=${response.status}, body=${text.slice(0, 500)}`);
  }
  const data = JSON.parse(text);
  const choice = data.choices?.[0];
  const visibleText = normalizeTextContent(choice?.message?.content);
  const reasoningText = normalizeTextContent(choice?.message?.reasoning_content);
  return {
    text: visibleText || reasoningText,
    textSource: visibleText ? "content" : reasoningText ? "reasoning_content" : "empty",
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
  // 按现有 DeepSeek V4 适配规则设置开关和 high/max 强度，避免发送不支持的档位。
  // 适配依据：https://api-docs.deepseek.com/guides/thinking_mode
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
  // 按模型族选择 none 或 minimal；Pro 模型保留服务端默认值。
  // 适配依据：https://platform.openai.com/docs/api-reference/responses
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

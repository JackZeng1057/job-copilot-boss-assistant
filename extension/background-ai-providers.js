// Anthropic、Responses 和 Gemini 协议适配，统一正文与结束原因。
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
  const text = response.text;
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
  // 仅为明确支持的 Claude 模型族设置输出强度，未知模型保留服务端默认值。
  // 适配依据：https://platform.claude.com/docs/en/api/messages/create
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
  const text = response.text;
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
  const text = response.text;
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
  // Gemini 2.5 使用 token 预算，Gemini 3 使用级别；Flash 与 Pro 分别处理。
  // 适配依据：https://ai.google.dev/gemini-api/docs/generate-content/thinking
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

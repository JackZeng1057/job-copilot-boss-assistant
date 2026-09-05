// 统一各服务商 token 口径；缺失用量与实际零用量分别记录。
function emptyTokenUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    visibleOutputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    reported: false
  };
}

function normalizedTokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

function finalizeTokenUsage(value, reported = true) {
  const usage = { ...emptyTokenUsage(), ...value };
  usage.inputTokens = normalizedTokenCount(usage.inputTokens);
  usage.outputTokens = normalizedTokenCount(usage.outputTokens);
  usage.reasoningTokens = Math.min(
    usage.outputTokens,
    normalizedTokenCount(usage.reasoningTokens)
  );
  usage.visibleOutputTokens = value?.visibleOutputTokens === undefined
    ? Math.max(0, usage.outputTokens - usage.reasoningTokens)
    : normalizedTokenCount(value.visibleOutputTokens);
  usage.cachedInputTokens = normalizedTokenCount(usage.cachedInputTokens);
  usage.totalTokens = normalizedTokenCount(usage.totalTokens)
    || usage.inputTokens + usage.outputTokens;
  usage.reported = reported && [
    usage.inputTokens, usage.outputTokens, usage.totalTokens
  ].some((count) => count > 0);
  return usage;
}

function normalizeOpenAiTokenUsage(value, responses = false) {
  if (!value || typeof value !== "object") return emptyTokenUsage();
  const inputTokens = responses ? value.input_tokens : value.prompt_tokens;
  const outputTokens = responses ? value.output_tokens : value.completion_tokens;
  const inputDetails = responses ? value.input_tokens_details : value.prompt_tokens_details;
  const outputDetails = responses ? value.output_tokens_details : value.completion_tokens_details;
  return finalizeTokenUsage({
    inputTokens,
    outputTokens,
    reasoningTokens: outputDetails?.reasoning_tokens,
    cachedInputTokens: inputDetails?.cached_tokens,
    totalTokens: value.total_tokens
  });
}

function normalizeAnthropicTokenUsage(value) {
  if (!value || typeof value !== "object") return emptyTokenUsage();
  const cacheRead = normalizedTokenCount(value.cache_read_input_tokens);
  const cacheCreation = normalizedTokenCount(value.cache_creation_input_tokens);
  return finalizeTokenUsage({
    inputTokens: normalizedTokenCount(value.input_tokens) + cacheRead + cacheCreation,
    outputTokens: value.output_tokens,
    reasoningTokens: value.output_tokens_details?.thinking_tokens,
    cachedInputTokens: cacheRead
  });
}

function normalizeGeminiTokenUsage(value) {
  if (!value || typeof value !== "object") return emptyTokenUsage();
  const visibleOutputTokens = normalizedTokenCount(value.candidatesTokenCount);
  const reasoningTokens = normalizedTokenCount(value.thoughtsTokenCount);
  return finalizeTokenUsage({
    inputTokens: value.promptTokenCount,
    outputTokens: visibleOutputTokens + reasoningTokens,
    visibleOutputTokens,
    reasoningTokens,
    cachedInputTokens: value.cachedContentTokenCount,
    totalTokens: value.totalTokenCount
  });
}

function aggregateTokenUsage(values) {
  const reported = (Array.isArray(values) ? values : [])
    .filter((value) => value?.reported === true);
  if (!reported.length) return emptyTokenUsage();
  return finalizeTokenUsage(reported.reduce((total, usage) => ({
    inputTokens: total.inputTokens + normalizedTokenCount(usage.inputTokens),
    outputTokens: total.outputTokens + normalizedTokenCount(usage.outputTokens),
    visibleOutputTokens: total.visibleOutputTokens + normalizedTokenCount(usage.visibleOutputTokens),
    reasoningTokens: total.reasoningTokens + normalizedTokenCount(usage.reasoningTokens),
    cachedInputTokens: total.cachedInputTokens + normalizedTokenCount(usage.cachedInputTokens),
    totalTokens: total.totalTokens + normalizedTokenCount(usage.totalTokens)
  }), emptyTokenUsage()));
}

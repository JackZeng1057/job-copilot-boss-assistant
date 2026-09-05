// 岗位分析入口、设置读取和简历选择；仅返回规范化结果与用量。
async function analyzeJob(payload) {
  const startedAt = Date.now();
  const settings = await getSettings();
  const resumeText = payload.resumeText || resumeTextForProfile(settings, payload.resumeProfile);
  if (apiKeyRequired(settings) && !settings.apiKey) {
    return { ok: false, error: "请先在插件设置里填写当前 AI 服务商的 API Key" };
  }
  if (!resumeText.trim()) return { ok: false, error: "请先在插件设置里粘贴完整简历文本" };
  const prompt = buildAnalysisPrompt({
    resumeText,
    job: payload,
    settings,
    customInstructions: payload.customInstructions || buildCustomInstructions(settings),
    targetDirections: payload.targetDirections || settings.targetDirections,
    excludedDirections: payload.excludedDirections || settings.excludedDirections,
    currentLocation: payload.currentLocation || settings.currentLocation
  });
  const retryPrompt = `${prompt}\n\n【输出纠正】上一次请求没有返回可见正文。请关闭推理展开，只输出一个完整 JSON 对象，不要输出解释或 Markdown。`;
  const retrySettings = { ...settings, analysisSpeed: "fast" };
  const responses = [await callAi(settings, prompt)];
  let initialResponse = responses[0];
  if (!String(initialResponse.text || "").trim()) {
    const retryResponse = await callAi(retrySettings, retryPrompt);
    responses.push(retryResponse);
    initialResponse = retryResponse;
  }
  if (initialResponse.truncated) {
    throw new Error(
      `AI 输出因 token 上限被截断（${initialResponse.finishReason || "unknown"}），已停止本岗位分析，请重试`
    );
  }
  let raw = initialResponse.text;
  let parsedResult;
  try {
    parsedResult = parseJsonWithDiagnostics(raw, validateAnalysisShape);
  } catch (firstError) {
    if (responses.length === 1 && initialResponse.textSource === "reasoning_content") {
      const retryResponse = await callAi(retrySettings, retryPrompt);
      responses.push(retryResponse);
      initialResponse = retryResponse;
      if (initialResponse.truncated) {
        throw new Error(
          `AI 输出因 token 上限被截断（${initialResponse.finishReason || "unknown"}），已停止本岗位分析，请重试`
        );
      }
      raw = initialResponse.text;
      try {
        parsedResult = parseJsonWithDiagnostics(raw, validateAnalysisShape);
      } catch (retryError) {
        throw new Error(`${analysisParseFailureLabel(retryError)}，空正文自动重试后仍失败：${String(retryError?.message || retryError)}`);
      }
    } else {
      const retryDetail = responses.length > 1 ? "，空正文自动重试后仍失败" : "且不会发起二次修复请求";
      throw new Error(`${analysisParseFailureLabel(firstError)}，已停止本岗位分析${retryDetail}：${String(firstError?.message || firstError)}`);
    }
  }
  const parsed = parsedResult.value;
  const recoveryMethods = [];
  if (responses.length > 1) recoveryMethods.push("retry:empty_output");
  if (initialResponse.textSource === "reasoning_content") {
    recoveryMethods.push("local:reasoning_content");
  }
  if (parsedResult.repaired) recoveryMethods.push(`local:${parsedResult.strategy}`);
  const repaired = recoveryMethods.length > 0;
  const repairMethod = recoveryMethods.join("+") || "none";
  const analysis = normalizeAnalysis(parsed);
  const usage = aggregateTokenUsage(responses.map((response) => response.usage));
  return {
    ok: true,
    analysis,
    performance: {
      durationMs: Date.now() - startedAt,
      repaired,
      repairMethod,
      requestCount: responses.reduce(
        (total, response) => total + Math.max(1, Number(response.requestCount) || 1),
        0
      ),
      usage,
      analysisUsage: initialResponse.usage
    }
  };
}

// 语法错误与字段错误分别提示，便于区分 JSON 解析失败和结果结构不符。
function analysisParseFailureLabel(error) {
  return error instanceof TypeError
    ? "AI 结构化输出字段不符合预期"
    : "AI 结构化输出不是合法 JSON";
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      if (consumeRuntimeLastError()) {
        resolve({ ...DEFAULT_SETTINGS, profile: ["default"] });
        return;
      }
      const stored = items && typeof items === "object" ? items : {};
      const settings = { ...DEFAULT_SETTINGS };
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (stored[key] !== undefined) settings[key] = stored[key];
      }
      settings.minScore = clampScore(settings.minScore);
      settings.profile = normalizeProfiles(stored.profile);
      settings.experienceYears = normalizeExperienceYears(settings.experienceYears);
      settings.graduateStatus = normalizeGraduateStatus(settings.graduateStatus);
      settings.analysisSpeed = normalizeAnalysisSpeed(settings.analysisSpeed);
      resolve(settings);
    });
  });
}

function publicRuntimeSettings(settings) {
  const allowed = [
    "minScore", "autoRunOnJobsPage", "restrictTargetLocation", "profile",
    "currentLocation", "experienceYears", "graduateStatus", "targetDirections",
    "excludedDirections", "customInstructions", "greetingStyle", "analysisSpeed"
  ];
  return Object.fromEntries(allowed.map((key) => [key, settings[key]]));
}

function resumeTextForProfile(settings, profile) {
  const profiles = normalizeProfiles(profile);
  const chunks = profiles
    .map((item) => resumeChunkForProfile(settings, item))
    .filter((chunk) => chunk.text.trim());
  if (chunks.length) {
    return chunks
      .map((chunk) => `【${chunk.label}】\n${chunk.text.trim()}`)
      .join("\n\n---\n\n");
  }
  return "";
}

function resumeChunkForProfile(settings, profile) {
  if (profile === "altA") return { label: "备选简历 A", text: settings.resumeAltA || "" };
  if (profile === "altB") return { label: "备选简历 B", text: settings.resumeAltB || "" };
  return { label: "主简历", text: settings.resumeDefault || "" };
}

function normalizeProfiles(profile) {
  const raw = (Array.isArray(profile) ? profile : [profile || "default"])
    .map((item) => item === "test" ? "altA" : item === "ops" ? "altB" : item);
  const allowed = ["default", "altA", "altB"];
  const profiles = raw.filter((item) => allowed.includes(item));
  return profiles.length ? profiles : ["default"];
}

function normalizeExperienceYears(value) {
  if (String(value ?? "").trim() === "") return "";
  const years = Number(value);
  if (!Number.isFinite(years)) return "";
  return Math.round(Math.max(0, Math.min(50, years)) * 10) / 10;
}

function normalizeGraduateStatus(value) {
  return ["graduate", "experienced"].includes(value) ? value : "unspecified";
}

function normalizeAnalysisSpeed(value) {
  return ["balanced", "accurate"].includes(value) ? value : "fast";
}

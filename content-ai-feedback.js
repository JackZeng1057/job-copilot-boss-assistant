// AI 错误分类、用户提示与达标岗位定位。
function isTransientAiError(error) {
  // 不同 Chromium 平台的网络错误文案不同；临时网络故障和截断结果应保留岗位并暂停。
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


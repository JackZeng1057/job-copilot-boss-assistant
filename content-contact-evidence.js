// 岗位身份匹配、沟通证据和确认窗口；仅将可确认的结果记为成功。
function detailMatchesJob(job) {
  return Boolean(findCommunicationButtonForJob(job));
}

function communicationButtonMatchesJob(button, job) {
  const detail = findJobDetailScope(button);
  if (!detail) return false;
  const targetJobId = bossJobIdFromUrl(job.url);
  const detailJobId = bossJobIdForCommunicationButton(button, detail);
  if (targetJobId && detailJobId) return targetJobId === detailJobId;
  const targetTitle = comparableJobText(job.jobName || job.title || "");
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
  // 同一公司可能有多个岗位，不能仅凭公司名确认岗位身份。
  return titleMatched;
}

function findJobForCommunicationButton(button) {
  const detail = findJobDetailScope(button);
  const detailJobId = bossJobIdForCommunicationButton(button, detail);
  if (detailJobId) {
    return JC_STATE.jobs.find((job) => bossJobIdFromUrl(job.url) === detailJobId) || null;
  }
  const matches = JC_STATE.jobs.filter((job) => communicationButtonMatchesJob(button, job));
  return matches.length === 1 ? matches[0] : null;
}

function bossJobIdFromUrl(value) {
  try {
    const url = new URL(String(value || ""), "https://www.zhipin.com");
    if (url.hostname !== "www.zhipin.com") return "";
    return url.pathname.match(/\/job_detail\/([^/?#]+)/i)?.[1] || "";
  } catch {
    return String(value || "").match(/\/job_detail\/([^/?#]+)/i)?.[1] || "";
  }
}

function bossJobIdForCommunicationButton(button, detail = findJobDetailScope(button)) {
  const routeId = bossJobIdFromUrl(location.href);
  if (routeId) return routeId;
  if (!detail) return "";
  const detailLinks = Array.from(detail.querySelectorAll("a[href*='/job_detail/']"));
  const primary = detailLinks.find((link) => /查看更多信息|职位详情|查看详情/.test(
    cleanText(link.innerText || link.textContent || "")
  ));
  if (primary) return bossJobIdFromUrl(primary.href || primary.getAttribute("href"));
  const ids = [...new Set(detailLinks
    .map((link) => bossJobIdFromUrl(link.href || link.getAttribute("href")))
    .filter(Boolean))];
  return ids.length === 1 ? ids[0] : "";
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

function logAutomationEvent(event, options = {}) {
  const job = options.job;
  const entry = {
    event,
    jobIndex: Number(job?.index ?? options.jobIndex ?? -1),
    title: cleanText(job?.jobName || job?.title || "").slice(0, 40),
    page: location.pathname,
    detail: cleanText(options.detail || "").slice(0, 240)
  };
  console.info("[Job Copilot] automation", entry);
  sendMessage({
    type: "appendAutomationLog",
    entry
  }).catch(() => {});
}

function logContactEvent(event, job) {
  logAutomationEvent(event, {
    job,
    detail: `jobIndex=${Number(job?.index ?? -1)}`
  });
}

function applyAnalysisPerformance(analysis, performance = {}) {
  analysis.tokenUsage = performance.usage || {};
  Object.assign(analysis.tokenUsage, {
    analysisVisibleOutputTokens: Number(performance.analysisUsage?.visibleOutputTokens || 0),
    requestCount: Number(performance.requestCount || 1),
    repairMethod: String(performance.repairMethod || "none"),
    durationMs: Number(performance.durationMs || 0)
  });
  return analysis;
}

async function requestAiAnalysis(job, payload, options = {}) {
  const startedAt = Date.now();
  const baseDetail = `jobIndex=${Number(job?.index ?? -1)};source=${String(options.source || "queue")}`;
  logAutomationEvent("ai_analysis_started", { job, detail: baseDetail });

  const progressTimer = options.updateGlobalStatus === false ? null : setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    setStatus(`AI 分析中（已等待 ${elapsedSeconds} 秒）：${job.title}`);
  }, 5000);

  try {
    const response = await sendMessage({ type: "analyzeJob", payload });
    const durationMs = Date.now() - startedAt;
    const usage = response?.performance?.usage;
    const diagnosticDetail = response?.ok
      ? `;providerDurationMs=${Number(response?.performance?.durationMs || durationMs)};repairMethod=${String(response?.performance?.repairMethod || "none")};requestCount=${Number(response?.performance?.requestCount || 1)};inputTokens=${Number(usage?.inputTokens || 0)};visibleOutputTokens=${Number(usage?.visibleOutputTokens || 0)};reasoningTokens=${Number(usage?.reasoningTokens || 0)};totalTokens=${Number(usage?.totalTokens || 0)}`
      : `;diagnostic=${JSON.stringify(aiErrorDiagnostic(response?.error || "分析失败"))}`;
    logAutomationEvent(response?.ok ? "ai_analysis_completed" : "ai_analysis_failed", {
      job,
      detail: `${baseDetail};durationMs=${durationMs};outcome=${response?.ok ? "ok" : "error"}${diagnosticDetail}`
    });
    return response;
  } catch (error) {
    const diagnostic = aiErrorDiagnostic(error);
    logAutomationEvent("ai_analysis_failed", {
      job,
      detail: `${baseDetail};durationMs=${Date.now() - startedAt};outcome=message_error;diagnostic=${JSON.stringify(diagnostic)}`
    });
    throw error;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

function createStayOnCurrentPageWaiter(timeoutMs = 10000, expectedJob = null, evidenceOptions = {}) {
  let settled = false;
  let confirmationClicked = false;
  let observer = null;
  let intervalId = null;
  let timeoutId = null;
  let probeTimer = null;
  let lastProbeAt = 0;
  let resolvePromise = null;

  const cleanup = () => {
    observer?.disconnect();
    if (intervalId) clearInterval(intervalId);
    if (timeoutId) clearTimeout(timeoutId);
    if (probeTimer) clearTimeout(probeTimer);
  };
  const finish = (result) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(result);
  };
  const probe = () => {
    if (settled || confirmationClicked) return;
    lastProbeAt = Date.now();
    if (isBossChatUrl(location.href)) {
      finish("chat_route");
      return;
    }
    const button = findStayOnCurrentPageButton();
    if (button) {
      confirmationClicked = true;
      const dialogConfirmedSend = stayOnPageDialogConfirmsSend(button);
      safeClick(button);
      setTimeout(() => finish(dialogConfirmedSend || hasSuccessfulContactEvidence(expectedJob, evidenceOptions)
        ? "stayed_confirmed"
        : "stayed"), 300);
      return;
    }
    if (hasSuccessfulContactEvidence(expectedJob, evidenceOptions)) finish("stayed");
  };
  const scheduleProbe = (immediate = false) => {
    if (settled || confirmationClicked || probeTimer) return;
    const elapsed = Date.now() - lastProbeAt;
    const delay = immediate ? 0 : Math.max(0, CONTACT_CONFIRMATION_MIN_INTERVAL_MS - elapsed);
    probeTimer = setTimeout(() => {
      probeTimer = null;
      probe();
    }, delay);
  };
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
    observer = new MutationObserver(() => scheduleProbe());
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    intervalId = setInterval(scheduleProbe, CONTACT_CONFIRMATION_FALLBACK_MS);
    timeoutId = setTimeout(() => finish("stay_missing"), timeoutMs);
    scheduleProbe(true);
  });

  return {
    promise,
    cancel() {
      if (!settled) finish("cancelled");
    }
  };
}

function hasSuccessfulContactEvidence(expectedJob = null, evidenceOptions = {}) {
  // 点击前已有的“继续沟通”状态不能证明本次发送成功，需依赖明确的发送确认。
  const controls = evidenceOptions.allowButtonLabel === false
    ? []
    : Array.from(document.querySelectorAll("a,button"));
  const changedControl = controls.some((item) => {
    if (isInsideJobCopilot(item) || !isElementVisible(item)) return false;
    const text = cleanText(item.innerText || item.textContent || "");
    if (!/^(继续沟通|继续聊|再次沟通|已沟通|发消息)$/.test(text)) return false;
    return !expectedJob || communicationButtonMatchesJob(item, expectedJob);
  });
  if (changedControl) return true;
  const statusNodes = Array.from(document.querySelectorAll(CONTACT_STATUS_SELECTOR));
  return statusNodes.some((node) => /已向BOSS发送消息|消息发送成功|消息已发送|招呼已发送|已与BOSS沟通|已发起沟通/
    .test(cleanText(node.textContent || "")));
}

function findStayOnCurrentPageButton() {
  const candidates = Array.from(document.querySelectorAll("button,a,div[class*='btn'],span[class*='btn']"));
  return candidates.find((item) => {
    if (!isElementVisible(item)) return false;
    const text = cleanText(item.innerText || item.textContent || "");
    if (!/^(留在此页|留在当前页|暂不进入聊天)$/.test(text)) return false;
    const dialog = item.closest("[role='dialog'], .dialog, .modal, .boss-dialog, [class*='dialog'], [class*='modal']");
    const scopeText = cleanText((dialog || item.parentElement || item).innerText || "");
    return /已向BOSS发送消息|消息已发送|留在此页|留在当前页|暂不进入聊天/.test(scopeText);
  });
}

function stayOnPageDialogConfirmsSend(button) {
  const dialog = button?.closest?.(
    "[role='dialog'], .dialog, .modal, .boss-dialog, [class*='dialog'], [class*='modal']"
  );
  if (!dialog) return false;
  return /已向BOSS发送消息|消息发送成功|消息已发送|招呼已发送|已与BOSS沟通|已发起沟通/
    .test(cleanText(dialog.textContent || dialog.innerText || ""));
}

function findCommunicationButtons(root) {
  const items = Array.from(root.querySelectorAll("a,button,[role='button']"));
  return items.filter((item) => !isInsideJobCopilot(item)
    && isElementVisible(item)
    && isContactActionLabel(item.innerText || item.textContent || ""));
}

function findCommunicationButtonForJob(job) {
  return findCommunicationButtons(document)
    .find((button) => communicationButtonMatchesJob(button, job)) || null;
}

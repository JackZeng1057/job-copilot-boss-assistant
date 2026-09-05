// 串行分析队列及失败恢复；runId 和 page.generation 共同阻止旧结果回写。
function buildCustomInstructions() {
  return [
    JC_STATE.settings.customInstructions ? `评分偏好：${JC_STATE.settings.customInstructions}` : "",
    JC_STATE.settings.greetingStyle ? `话术风格：${JC_STATE.settings.greetingStyle}` : ""
  ].filter(Boolean).join("\n");
}

function progressFor(job) {
  return JC_STATE.jobProgress.get(job.key) || {
    status: JC_STATE.analyses.has(job.key) ? analysisProgressStatus(job) : "pending",
    detail: ""
  };
}

function setJobProgress(jobOrKey, status, detail = "") {
  const key = typeof jobOrKey === "string" ? jobOrKey : jobOrKey?.key;
  if (!key) return;
  JC_STATE.jobProgress.set(key, { status, detail, updatedAt: Date.now() });
  schedulePersistAutomationSession();
}

function analysisProgressStatus(job) {
  const analysis = JC_STATE.analyses.get(job.key);
  if (!analysis) return "pending";
  if (["error", "network_error"].includes(analysis.decision)) return "error";
  return isQualifiedJob(job) ? "qualified" : "not_qualified";
}

async function analyzeJobs(options = {}) {
  const force = Boolean(options.force);
  if (JC_STATE.analyzing) {
    return { completed: false, reason: "running" };
  }
  if (JC_STATE.pipeline.allPaused) {
    setStatus("当前处理已暂停，点击“继续自动投递”后从保留进度继续。");
    return { completed: false, reason: "paused" };
  }
  JC_STATE.pipeline.ownerRouteEscaped = false;
  if (!JC_STATE.page.initialized || !JC_STATE.jobs.length) {
    await synchronizePageContext({ force: true, source: "analysis" });
  }
  if (!JC_STATE.jobs.length) {
    setStatus("当前页没有可分析的岗位。");
    return { completed: true, analyzed: 0 };
  }
  if (force) discardAnalysesForForcedRun();
  // 重试标记被消费后仍保留本轮类型，确保单岗位重试结束时不会自动进入下一批。
  const retryContactOnlyRun = Boolean(JC_STATE.retryContactJobKey);
  const retryOnlyRun = Boolean(JC_STATE.retryJobKey) || retryContactOnlyRun;
  prepareCurrentBatch();
  if (!JC_STATE.jobs.some((job) => jobNeedsProcessing(job))) {
    return settleRunWithNothingToProcess(retryOnlyRun, retryContactOnlyRun);
  }

  const runId = JC_STATE.analysisRunId + 1;
  const pageGeneration = JC_STATE.page.generation;
  JC_STATE.analysisRunId = runId;
  JC_STATE.analyzing = true;
  updateAnalysisControls();

  let analyzedCount = 0;
  // 同一循环顺序执行分析与达标沟通，避免两个队列竞争岗位状态。
  while (true) {
    if (isRunSuperseded(runId, pageGeneration)) {
      return { completed: false, reason: "superseded", analyzed: analyzedCount };
    }
    if (JC_STATE.pipeline.allPaused) {
      JC_STATE.analyzing = false;
      JC_STATE.pipeline.phase = "paused";
      updateAnalysisControls();
      setStatus(`当前处理已暂停，本轮新分析 ${analyzedCount} 个岗位；进度已保留。`);
      return { completed: false, reason: "paused", analyzed: analyzedCount };
    }
    if (pageNeedsHuman()) {
      JC_STATE.analyzing = false;
      JC_STATE.pipeline.allPaused = true;
      JC_STATE.pipeline.phase = "paused";
      updateAnalysisControls();
      setStatus("页面出现登录、验证码或安全验证，已暂停处理，请先人工处理。");
      return { completed: false, reason: "human_verification", analyzed: analyzedCount };
    }

    const job = takeNextJobForProcessing();
    if (!job) break;

    const existingAnalysis = JC_STATE.analyses.get(job.key);
    if (existingAnalysis) {
      const contactResult = await contactQualifiedJob(job, { runId, pageGeneration });
      const halted = contactOutcomeToRunResult(contactResult, analyzedCount);
      if (halted) return halted;
      await sleep(BETWEEN_JOBS_DELAY_MS);
      continue;
    }

    setJobProgress(job, "analyzing");
    setStatus(`正在定位并读取完整岗位详情：${job.title}`);
    renderList();
    const jobDescription = await collectJobDescriptionForAnalysis(job);
    if (isRunSuperseded(runId, pageGeneration)) {
      return { completed: false, reason: "superseded", analyzed: analyzedCount };
    }
    if (JC_STATE.pipeline.ownerRouteEscaped) {
      JC_STATE.analyzing = false;
      updateAutomationControls();
      renderList();
      return { completed: false, reason: "owner_route_escape", analyzed: analyzedCount };
    }
    if (JC_STATE.pipeline.allPaused) {
      JC_STATE.analyzing = false;
      JC_STATE.pipeline.phase = "paused";
      setJobProgress(job, "pending", "已暂停，尚未请求 AI");
      updateAutomationControls();
      renderList();
      return { completed: false, reason: "paused", analyzed: analyzedCount };
    }
    setStatus(`AI 分析中：${job.title}${jobDescription.complete ? "（完整 JD）" : "（卡片信息）"}`);
    const payload = buildAnalysisPayload(job, jobDescription);
    JC_STATE.analysisPayloads.set(job.key, payload);
    const response = await requestAiAnalysis(job, payload);
    if (isRunSuperseded(runId, pageGeneration)) {
      return { completed: false, reason: "superseded", analyzed: analyzedCount };
    }
    if (response?.ok) {
      applyAnalysisPerformance(response.analysis, response.performance);
      JC_STATE.analyses.set(job.key, response.analysis);
      analyzedCount += 1;
      if (isQualifiedJob(job)) {
        setJobProgress(job, "qualified");
        renderList();
        if (JC_STATE.pipeline.mode === "auto") {
          const contactResult = await contactQualifiedJob(job, { runId, pageGeneration });
          const halted = contactOutcomeToRunResult(contactResult, analyzedCount);
          if (halted) return halted;
        }
      } else {
        setJobProgress(job, "not_qualified");
        completeJob(job);
        setStatus(`岗位未达标，${Math.round(BETWEEN_JOBS_DELAY_MS / 1000)} 秒后处理下一个：${job.title}`);
      }
    } else {
      const halted = recordFailedAnalysis(job, response, analyzedCount);
      if (halted) return halted;
    }
    renderList();
    await sleep(BETWEEN_JOBS_DELAY_MS);
  }

  if (JC_STATE.analysisRunId === runId) JC_STATE.analyzing = false;
  if (retryOnlyRun) {
    JC_STATE.pipeline.allPaused = true;
    updateAutomationControls();
    setStatus(retryContactOnlyRun
      ? "单岗位沟通重试已完成，自动投递保持暂停。"
      : "重新分析已完成，自动投递保持暂停；需要时可手动继续。");
    schedulePersistAutomationSession();
    return { completed: true, reason: "retry_completed", analyzed: analyzedCount };
  }
  if (JC_STATE.pipeline.mode === "auto" && JC_STATE.pipeline.active) {
    updateAnalysisControls();
    return advanceToNextBatch();
  }
  JC_STATE.pipeline.active = false;
  JC_STATE.pipeline.phase = "idle";
  updateAnalysisControls();
  setStatus(JC_STATE.pipeline.mode === "auto"
    ? "当前页处理完成：未达标岗位未沟通，达标岗位均已完成沟通或标明具体失败原因。"
    : "当前页 AI 分析已完成。达标岗位已在下方列表标记。"
  );
  schedulePersistAutomationSession();
  return { completed: true, analyzed: analyzedCount };
}

function discardAnalysesForForcedRun() {
  for (const job of JC_STATE.jobs) {
    JC_STATE.analyses.delete(job.key);
    JC_STATE.analysisPayloads.delete(job.key);
    JC_STATE.completedJobKeys.delete(job.key);
    setJobProgress(job, "pending");
  }
  JC_STATE.pipeline.batchKeys = [];
}

function settleRunWithNothingToProcess(retryOnlyRun, retryContactOnlyRun) {
  if (retryOnlyRun) {
    JC_STATE.pipeline.allPaused = true;
    setStatus(retryContactOnlyRun
      ? "单岗位沟通重试已完成，自动投递保持暂停。"
      : "重新分析已完成，自动投递保持暂停；需要时可手动继续。");
    updateAutomationControls();
    schedulePersistAutomationSession();
    return { completed: true, reason: "retry_completed", analyzed: 0 };
  }
  if (JC_STATE.pipeline.mode === "auto" && JC_STATE.pipeline.active) {
    return advanceToNextBatch();
  }
  JC_STATE.pipeline.active = false;
  JC_STATE.pipeline.phase = "idle";
  setStatus(JC_STATE.pipeline.mode === "auto"
    ? "当前页岗位已处理完成，所有达标岗位都已完成沟通尝试。"
    : "当前页岗位已全部分析，无需重复请求 AI。"
  );
  renderList();
  schedulePersistAutomationSession();
  return { completed: true, analyzed: 0 };
}

// 优先消费用户指定的重试键，仍以稳定岗位键匹配结果，确保只重试一次。
function takeNextJobForProcessing() {
  const requestedRetryKey = JC_STATE.retryContactJobKey || JC_STATE.retryJobKey;
  const retryJob = requestedRetryKey
    ? JC_STATE.jobs.find((item) => item.key === requestedRetryKey && jobNeedsProcessing(item))
    : null;
  const job = retryJob || JC_STATE.jobs.find((item) => jobNeedsProcessing(item));
  if (!job) return null;
  if (job.key === JC_STATE.retryJobKey) JC_STATE.retryJobKey = "";
  if (job.key === JC_STATE.retryContactJobKey) JC_STATE.retryContactJobKey = "";
  return job;
}

// 新运行或换页使旧结果失效，禁止覆盖当前页面的状态。
function isRunSuperseded(runId, pageGeneration) {
  return JC_STATE.analysisRunId !== runId || JC_STATE.page.generation !== pageGeneration;
}

// 将沟通结果转成 analyzeJobs 的退出结果；返回 null 表示继续处理下一岗位。
function contactOutcomeToRunResult(contactResult, analyzedCount) {
  if (contactResult === "superseded") {
    return { completed: false, reason: "superseded", analyzed: analyzedCount };
  }
  if (contactResult === "paused" || contactResult === "halted") {
    JC_STATE.analyzing = false;
    updateAutomationControls();
    return {
      completed: false,
      reason: contactResult === "paused" ? "paused" : "contact_halted",
      analyzed: analyzedCount
    };
  }
  return null;
}

function buildAnalysisPayload(job, jobDescription) {
  return {
    platform: "boss",
    title: job.title,
    company: job.company,
    city: job.city || "",
    salary: salaryForAi(job.salary),
    jd: jobDescription.text,
    jdComplete: jobDescription.complete,
    url: job.url,
    resumeProfile: JC_STATE.settings.profile,
    currentLocation: JC_STATE.settings.currentLocation,
    targetDirections: JC_STATE.settings.targetDirections,
    excludedDirections: JC_STATE.settings.excludedDirections,
    customInstructions: buildCustomInstructions()
  };
}

// 记录岗位失败；只有需要暂停整轮任务时才返回运行结果。
function recordFailedAnalysis(job, response, analyzedCount) {
  const error = response?.error || "分析失败";
  if (isExtensionContextError(error)) {
    stopForInvalidatedExtensionContext(job);
    return { completed: false, reason: "extension_context_invalidated", analyzed: analyzedCount };
  }
  JC_STATE.analyses.set(job.key, {
    score: "--",
    decision: "network_error",
    greeting: "",
    reasons: [friendlyAiError(error)],
    rawError: error
  });
  setJobProgress(job, "error", friendlyAiError(error));
  // 临时网络故障不消耗岗位，清掉占位结果后暂停，允许从当前岗位继续。
  if (isTransientAiError(error)) {
    JC_STATE.analyses.delete(job.key);
    JC_STATE.analyzing = false;
    JC_STATE.pipeline.allPaused = true;
    JC_STATE.pipeline.phase = "paused";
    updateAutomationControls();
    renderList();
    setStatus(`AI 网络暂时不可用，当前处理已暂停。\n${friendlyAiError(error)}`);
    return { completed: false, reason: "network_error", analyzed: analyzedCount };
  }
  completeJob(job);
  return null;
}

function ensureAnalysisWorker() {
  if (!JC_STATE.pipeline.active || JC_STATE.pipeline.allPaused || JC_STATE.analyzing
      || JC_STATE.pipeline.waitingForNextBatch || JC_STATE.pipeline.loadingNextBatch) return;
  analyzeJobs({ force: false }).catch((error) => {
    if (isExtensionContextError(error)) {
      stopForInvalidatedExtensionContext();
      return;
    }
    JC_STATE.analyzing = false;
    setStatus(`AI 分析异常：${error.message || error}`);
    updateAutomationControls();
  });
}

function updateAnalysisControls() {
  const button = document.getElementById("jc-pipeline-control");
  if (!button) return;
  if (JC_STATE.pipeline.controlActionInFlight) {
    button.disabled = true;
    button.textContent = "正在更新自动投递状态…";
    return;
  }
  button.disabled = false;
  if (JC_STATE.remoteSession?.active && !JC_STATE.sessionOwner) {
    button.textContent = JC_STATE.remoteSession.paused ? "继续另一个标签" : "暂停另一个标签";
    return;
  }
  if (!isJobsPage()) {
    button.textContent = "请在职位页开始";
    button.disabled = true;
    return;
  }
  if (JC_STATE.pipeline.contextInvalidated) {
    button.textContent = "扩展已更新，请手动刷新";
    button.disabled = true;
    return;
  }
  if (JC_STATE.pipeline.starting) {
    button.textContent = "正在启动自动投递…";
    button.disabled = true;
    return;
  }
  if (JC_STATE.pipeline.allPaused) {
    button.textContent = "继续自动投递";
    return;
  }
  if (JC_STATE.pipeline.active
      && (JC_STATE.pipeline.waitingForNextBatch || JC_STATE.pipeline.loadingNextBatch)) {
    button.textContent = "暂停连续投递";
    return;
  }
  if (JC_STATE.analyzing) {
    button.textContent = "暂停自动投递";
    return;
  }
  if (JC_STATE.pipeline.mode === "auto" && JC_STATE.pipeline.active
      && !JC_STATE.jobs.some((job) => jobNeedsProcessing(job))) {
    button.textContent = "当前页已完成";
    button.disabled = true;
    return;
  }
  button.textContent = "确认并开始自动投递";
}

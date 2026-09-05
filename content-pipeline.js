// 批次推进、会话快照和队列选择；保持既有投递间隔与冷却时间。
async function startAutoPipeline() {
  if (JC_STATE.pipeline.starting) return false;
  if (pageNeedsHuman()) {
    setStatus("页面疑似需要登录、验证码或安全验证，请先人工处理。");
    return false;
  }
  JC_STATE.pipeline.starting = true;
  updateAutomationControls();
  try {
    if (!canReuseJobSnapshotForPipeline()) {
      await synchronizePageContext({ source: "pipeline" });
    }
    if (!JC_STATE.jobs.length) {
      setStatus("当前职位页没有识别到岗位，暂时不能启动自动投递。");
      return false;
    }
    if (!JC_STATE.pipeline.active || JC_STATE.pipeline.mode !== "auto") {
      resetBatchProgress();
      // 新运行从当前列表首项分析，旧运行的完成标记不应跳过新队列。
      JC_STATE.completedJobKeys.clear();
    }
    JC_STATE.pipeline.active = true;
    JC_STATE.pipeline.mode = "auto";
    JC_STATE.pipeline.phase = "analysis";
    JC_STATE.pipeline.allPaused = false;
    JC_STATE.pipeline.pauseReason = "";
    JC_STATE.pipeline.ownerRouteEscaped = false;
    JC_STATE.sessionOwner = true;
    JC_STATE.remoteSession = null;
    await registerAutomationSession();
    setStatus("自动投递已启动：逐个分析岗位，达标后按保守节奏沟通并留在当前页。");
    ensureAnalysisWorker();
    return true;
  } finally {
    JC_STATE.pipeline.starting = false;
    updateAutomationControls();
  }
}

function canReuseJobSnapshotForPipeline() {
  if (!JC_STATE.page.initialized || !JC_STATE.jobs.length) return false;
  if (JC_STATE.page.url !== location.href.split("#")[0]) return false;
  const cards = findCards();
  const liveJobs = JC_STATE.jobs.filter((job) => !job.detached);
  if (!cards.length || cards.length !== liveJobs.length) return false;
  return cards.every((card, index) => liveJobs[index]?.card === card && card.isConnected);
}

async function registerAutomationSession() {
  const response = await sendMessage({
    type: "registerAutomationSession",
    session: buildAutomationSessionPayload({ active: true })
  });
  if (!response?.ok) throw new Error(response?.error || "无法登记自动投递标签");
}

function buildAutomationSessionPayload(overrides = {}) {
  const jobs = JC_STATE.jobs;
  const payload = {
    active: JC_STATE.pipeline.active,
    paused: JC_STATE.pipeline.allPaused,
    pauseReason: JC_STATE.pipeline.pauseReason,
    mode: JC_STATE.pipeline.mode,
    phase: JC_STATE.pipeline.phase,
    jobsUrl: JC_STATE.page.url || location.href.split("#")[0],
    fingerprint: JC_STATE.page.fingerprint,
    analyses: Object.fromEntries(JC_STATE.analyses),
    progress: Object.fromEntries(JC_STATE.jobProgress),
    dismissedJobKeys: Array.from(JC_STATE.dismissedJobKeys).slice(-MAX_COMPLETED_JOB_KEYS),
    completedJobKeys: Array.from(JC_STATE.completedJobKeys).slice(-500),
    batchNumber: JC_STATE.pipeline.batchNumber,
    batchKeys: JC_STATE.pipeline.batchKeys.slice(0, JOB_BATCH_SIZE),
    batchSize: JC_STATE.pipeline.batchSize,
    batchWaitRemainingMs: JC_STATE.pipeline.batchWaitRemainingMs,
    waitingForNextBatch: JC_STATE.pipeline.waitingForNextBatch,
    loadingNextBatch: JC_STATE.pipeline.loadingNextBatch,
    summary: {
      total: jobs.length,
      analyzed: jobs.filter((job) => JC_STATE.analyses.has(job.key)).length,
      qualified: jobs.filter((job) => isQualifiedJob(job)).length,
      contacted: jobs.filter((job) => progressFor(job).status === "contacted").length
    },
    status: document.getElementById("jc-status")?.textContent || "",
    contactInFlight: JC_STATE.pipeline.contactInFlight === true,
    currentJobKey: JC_STATE.currentJobKey,
    updatedAt: Date.now(),
    ...overrides
  };
  return payload;
}

function schedulePersistAutomationSession() {
  if (!JC_STATE.sessionOwner || JC_STATE.pipeline.contextInvalidated) return;
  if (!extensionContextAvailable()) {
    invalidateExtensionContext();
    return;
  }
  clearTimeout(sessionPersistTimer);
  sessionPersistTimer = setTimeout(() => {
    if (!extensionContextAvailable()) {
      invalidateExtensionContext();
      return;
    }
    sendMessage({
      type: "updateAutomationSession",
      patch: buildAutomationSessionPayload()
    }).catch(() => {});
  }, 120);
}

async function persistAutomationSessionNow() {
  if (!JC_STATE.sessionOwner || JC_STATE.pipeline.contextInvalidated) {
    throw new Error("当前标签无法保存自动投递状态");
  }
  clearTimeout(sessionPersistTimer);
  sessionPersistTimer = null;
  const response = await sendMessage({
    type: "updateAutomationSession",
    patch: buildAutomationSessionPayload()
  });
  if (!response?.ok) throw new Error(response?.error || "无法保存自动投递状态");
  return true;
}

function isQualifiedJob(job) {
  const analysis = JC_STATE.analyses.get(job.key);
  return Boolean(analysis)
    && analysis.excluded !== true
    && Number(analysis.score) >= Number(JC_STATE.settings.minScore || 0);
}

function jobNeedsProcessing(job) {
  if (JC_STATE.completedJobKeys.has(job.key)) return false;
  if (JC_STATE.pipeline.batchKeys.length && !JC_STATE.pipeline.batchKeys.includes(job.key)) return false;
  const analysis = JC_STATE.analyses.get(job.key);
  if (!analysis) return progressFor(job).status !== "analyzing";
  if (JC_STATE.pipeline.mode !== "auto" || !isQualifiedJob(job)) return false;
  return !["contacted", "unavailable", "detail_mismatch", "attention"].includes(progressFor(job).status);
}

function resetBatchProgress() {
  JC_STATE.pipeline.batchNumber = 1;
  JC_STATE.pipeline.batchKeys = [];
  JC_STATE.pipeline.batchSize = 0;
  JC_STATE.pipeline.batchWaitRemainingMs = 0;
  JC_STATE.pipeline.waitingForNextBatch = false;
  JC_STATE.pipeline.loadingNextBatch = false;
}

function prepareCurrentBatch() {
  for (const job of JC_STATE.jobs) {
    const progress = progressFor(job);
    const analysis = JC_STATE.analyses.get(job.key);
    if (analysis && (!isQualifiedJob(job)
        || ["contacted", "unavailable", "detail_mismatch", "attention"].includes(progress.status))) {
      rememberCompletedJobKey(job.key);
    }
  }
  const current = JC_STATE.pipeline.batchKeys.filter((key) => {
    const job = JC_STATE.jobs.find((item) => item.key === key);
    return job && !job.detached && !JC_STATE.completedJobKeys.has(key);
  });
  if (current.length) {
    JC_STATE.pipeline.batchKeys = current;
    JC_STATE.pipeline.batchSize = current.length;
    return current;
  }
  JC_STATE.pipeline.batchKeys = JC_STATE.jobs
    .filter((job) => !job.detached && !JC_STATE.completedJobKeys.has(job.key))
    .slice(0, JOB_BATCH_SIZE)
    .map((job) => job.key);
  JC_STATE.pipeline.batchSize = JC_STATE.pipeline.batchKeys.length;
  schedulePersistAutomationSession();
  return JC_STATE.pipeline.batchKeys;
}

function completeJob(job) {
  if (!job?.key) return;
  rememberCompletedJobKey(job.key);
  schedulePersistAutomationSession();
}

function rememberCompletedJobKey(key) {
  rememberBoundedJobKey(JC_STATE.completedJobKeys, key);
}

function rememberDismissedJobKey(key) {
  rememberBoundedJobKey(JC_STATE.dismissedJobKeys, key);
}

// 内存键集合与持久化快照使用相同上限，避免长时间运行后不断累积。
function rememberBoundedJobKey(keys, key) {
  if (!key) return;
  keys.delete(key);
  keys.add(key);
  while (keys.size > MAX_COMPLETED_JOB_KEYS) {
    keys.delete(keys.values().next().value);
  }
}

async function advanceToNextBatch() {
  if (JC_STATE.pipeline.loadingNextBatch) {
    return { completed: false, reason: "batch_transition" };
  }
  const resumingBatchWait = JC_STATE.pipeline.waitingForNextBatch;
  JC_STATE.pipeline.waitingForNextBatch = true;
  JC_STATE.pipeline.phase = "batch_wait";
  if (!resumingBatchWait) {
    JC_STATE.pipeline.batchKeys = [];
    JC_STATE.pipeline.batchWaitRemainingMs = BETWEEN_BATCHES_DELAY_MS;
  }
  updateAutomationControls();

  const waitDuration = resumingBatchWait
    ? JC_STATE.pipeline.batchWaitRemainingMs
    : BETWEEN_BATCHES_DELAY_MS;
  const deadline = Date.now() + Math.max(0, waitDuration);
  logAutomationEvent(resumingBatchWait ? "batch_wait_resumed" : "batch_wait_started", {
    detail: `batch=${JC_STATE.pipeline.batchNumber};delayMs=${Math.max(0, waitDuration)}`
  });
  schedulePersistAutomationSession();
  while (Date.now() < deadline) {
    if (!JC_STATE.pipeline.active || JC_STATE.pipeline.allPaused) {
      JC_STATE.pipeline.batchWaitRemainingMs = Math.max(0, deadline - Date.now());
      JC_STATE.pipeline.phase = "paused";
      updateAutomationControls();
      setStatus("连续投递已暂停，批次进度已保留。");
      logAutomationEvent("batch_wait_interrupted", {
        detail: `batch=${JC_STATE.pipeline.batchNumber};reason=paused`
      });
      schedulePersistAutomationSession();
      return { completed: false, reason: "paused" };
    }
    const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    JC_STATE.pipeline.batchWaitRemainingMs = Math.max(0, deadline - Date.now());
    setStatus(`第 ${JC_STATE.pipeline.batchNumber} 批已完成，${seconds} 秒后加载后续岗位。`);
    await sleep(Math.min(1000, deadline - Date.now()));
  }

  logAutomationEvent("batch_wait_completed", {
    detail: `batch=${JC_STATE.pipeline.batchNumber}`
  });
  JC_STATE.pipeline.waitingForNextBatch = false;
  JC_STATE.pipeline.batchWaitRemainingMs = 0;
  JC_STATE.pipeline.loadingNextBatch = true;
  JC_STATE.pipeline.phase = "batch_loading";
  setStatus("正在加载当前列表后面的岗位...");
  updateAutomationControls();

  try {
    // 优先消费已加载的额外卡片，再触发滚动，避免跨批次漏掉岗位。
    let nextKeys = prepareCurrentBatch();
    for (let attempt = 0; !nextKeys.length && attempt < 4; attempt += 1) {
      revealMoreJobs();
      await sleep(1800);
      await synchronizePageContext({ source: "next-batch" });
      JC_STATE.pipeline.batchKeys = [];
      nextKeys = prepareCurrentBatch();
    }

    if (!nextKeys.length) {
      JC_STATE.pipeline.active = false;
      JC_STATE.pipeline.mode = "idle";
      JC_STATE.pipeline.phase = "idle";
      setStatus("没有识别到更多新岗位，连续投递已完成。");
      return { completed: true, reason: "no_more_jobs" };
    }

    JC_STATE.pipeline.batchNumber += 1;
    JC_STATE.pipeline.phase = "analysis";
    updatePageContextLabel();
    setStatus(`已加载第 ${JC_STATE.pipeline.batchNumber} 批，共 ${nextKeys.length} 个新岗位，继续自动投递。`);
    return { completed: false, reason: "next_batch_ready" };
  } finally {
    JC_STATE.pipeline.loadingNextBatch = false;
    updateAutomationControls();
    schedulePersistAutomationSession();
    if (JC_STATE.pipeline.active && !JC_STATE.pipeline.allPaused) {
      setTimeout(ensureAnalysisWorker, 0);
    }
  }
}

function revealMoreJobs() {
  const connectedJobs = JC_STATE.jobs.filter((job) => job.card?.isConnected && !job.detached);
  const lastCard = connectedJobs.at(-1)?.card;
  if (lastCard) {
    lastCard.scrollIntoView({ behavior: "smooth", block: "end" });
    const scroller = findScrollableAncestor(lastCard);
    if (scroller) scroller.scrollBy({ top: Math.max(400, scroller.clientHeight * 0.85), behavior: "smooth" });
    else window.scrollBy({ top: Math.max(600, window.innerHeight * 0.85), behavior: "smooth" });
  }

  const nextButton = Array.from(document.querySelectorAll("button,a"))
    .find((node) => isElementVisible(node)
      && /^(下一页|下一批|加载更多)$/.test(cleanText(node.innerText || node.textContent || ""))
      && !node.disabled
      && node.getAttribute("aria-disabled") !== "true");
  if (nextButton) nextButton.click();
}

function findScrollableAncestor(node) {
  let parent = node?.parentElement;
  while (parent && parent !== document.body) {
    const style = getComputedStyle(parent);
    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 20) return parent;
    parent = parent.parentElement;
  }
  return null;
}

// 页面设置与会话恢复；仅所属标签恢复本地执行状态。
function watchRuntimeSettingChanges() {
  if (!chrome.storage?.onChanged?.addListener) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !RUNTIME_SETTING_KEYS.some((key) => key in changes)) return;
    refreshRuntimeSettings().catch(() => {});
  });
}

async function refreshRuntimeSettings() {
  // 通过后台读取归一化设置，使页面判断与分析提示词使用相同口径。
  const response = await sendMessage({ type: "getSettings" });
  if (!response?.ok) return false;
  const previousMinScore = Number(JC_STATE.settings.minScore);
  JC_STATE.settings = { ...JC_STATE.settings, ...response.settings };
  updateAutomationControls();
  // 分数线变化后刷新达标状态与计数；已处理岗位不因降低分数线而重新沟通。
  if (Number(JC_STATE.settings.minScore) !== previousMinScore) {
    renderList();
    schedulePersistAutomationSession();
    setStatus(`达标线已更新为 ${JC_STATE.settings.minScore} 分，当前列表判定已刷新。`);
  }
  return true;
}

async function bootstrapAutomationContext() {
  if (isJobsPage()) await synchronizePageContext({ force: true, source: "bootstrap" });
  await refreshAutomationSession();
  setInterval(() => {
    if (!JC_STATE.sessionOwner) refreshAutomationSession().catch(() => {});
  }, 2000);
}

async function refreshAutomationSession() {
  const response = await sendMessage({ type: "getAutomationSession" });
  if (!response?.ok || !response.session?.active) {
    JC_STATE.remoteSession = null;
    const rescan = document.getElementById("jc-rescan");
    if (rescan) rescan.textContent = "重新扫描";
    if (!isJobsPage()) {
      setNodeText("jc-page-context", "当前页面不是职位列表");
      setStatus("请在 BOSS 职位列表页启动自动投递。");
    }
    updateAutomationControls();
    return;
  }
  if (response.isOwner && isJobsPage()) {
    restoreOwnedAutomationSession(response.session);
    return;
  }
  if (response.isOwner) {
    JC_STATE.remoteSession = null;
    JC_STATE.sessionOwner = true;
    setNodeText("jc-page-context", "受保护职位标签已离开职位列表");
    setStatus(response.session.status
      || "当前职位标签误入非职位页，自动投递已暂停；请先返回职位列表。");
    updateAutomationControls();
    return;
  }
  JC_STATE.remoteSession = response.session;
  JC_STATE.sessionOwner = false;
  renderRemoteAutomationState();
}

function restoreOwnedAutomationSession(session) {
  if (!session) return;
  JC_STATE.dismissedJobKeys = new Set(
    (Array.isArray(session.dismissedJobKeys) ? session.dismissedJobKeys : []).slice(-MAX_COMPLETED_JOB_KEYS)
  );
  JC_STATE.jobs = JC_STATE.jobs.filter((job) => !JC_STATE.dismissedJobKeys.has(job.key));
  const currentKeys = new Set(JC_STATE.jobs.map((job) => job.key));
  const restoredAnalyses = Object.entries(session.analyses || {}).filter(([key]) => currentKeys.has(key));
  const restoredProgress = Object.entries(session.progress || {}).filter(([key]) => currentKeys.has(key));
  JC_STATE.sessionOwner = true;
  JC_STATE.remoteSession = null;
  JC_STATE.analyses = new Map(restoredAnalyses);
  JC_STATE.jobProgress = new Map(restoredProgress);
  JC_STATE.completedJobKeys = new Set(
    (Array.isArray(session.completedJobKeys) ? session.completedJobKeys : []).slice(-MAX_COMPLETED_JOB_KEYS)
  );
  for (const job of JC_STATE.jobs) {
    if (!JC_STATE.jobProgress.has(job.key)) JC_STATE.jobProgress.set(job.key, { status: "pending", detail: "" });
  }
  JC_STATE.pipeline.active = session.active === true;
  JC_STATE.pipeline.mode = session.mode === "auto" ? "auto" : "idle";
  JC_STATE.pipeline.phase = String(session.phase
    || (session.paused ? "paused" : (session.active && session.mode === "auto" ? "analysis" : "idle")));
  JC_STATE.pipeline.allPaused = session.paused === true;
  JC_STATE.pipeline.pauseReason = String(session.pauseReason || "");
  // 批次计数只对应原列表，刷新后列表变化时必须重新开始。
  if (String(session.fingerprint || "") === String(JC_STATE.page.fingerprint || "")) {
    JC_STATE.pipeline.batchNumber = Math.max(1, Number(session.batchNumber) || 1);
    JC_STATE.pipeline.batchKeys = Array.isArray(session.batchKeys)
      ? session.batchKeys.filter((key) => currentKeys.has(key)).slice(0, JOB_BATCH_SIZE)
      : [];
    JC_STATE.pipeline.batchSize = Math.max(0, Number(session.batchSize)
      || JC_STATE.pipeline.batchKeys.length);
    JC_STATE.pipeline.batchWaitRemainingMs = Math.max(0, Number(session.batchWaitRemainingMs) || 0);
    JC_STATE.pipeline.waitingForNextBatch = session.waitingForNextBatch === true
      || JC_STATE.pipeline.batchWaitRemainingMs > 0;
    JC_STATE.pipeline.loadingNextBatch = session.loadingNextBatch === true;
  } else {
    resetBatchProgress();
  }
  const restoredContactJobKey = String(session.currentJobKey || "");
  JC_STATE.pipeline.contactInFlight = session.contactInFlight === true && Boolean(restoredContactJobKey);
  JC_STATE.currentJobKey = JC_STATE.pipeline.contactInFlight ? restoredContactJobKey : "";
  renderList();
  setStatus(session.status || "已恢复专用职位标签的自动投递进度。");
  updateAutomationControls();
  if (JC_STATE.pipeline.active && !JC_STATE.pipeline.allPaused) ensureAnalysisWorker();
}

function renderRemoteAutomationState() {
  const session = JC_STATE.remoteSession;
  if (!session?.active) return;
  setNodeText("jc-page-context", "自动投递正在另一个职位标签运行");
  setStatus(session.status || "可以继续浏览当前页面，投递任务不会中断。");
  const summary = session.summary || {};
  setNodeText("jc-total-count", summary.total || 0);
  setNodeText("jc-analyzed-count", summary.analyzed || 0);
  setNodeText("jc-qualified-count", summary.qualified || 0);
  setNodeText("jc-contacted-count", summary.contacted || 0);
  const rescan = document.getElementById("jc-rescan");
  if (rescan) rescan.textContent = "打开投递标签";
  updateAnalysisControls();
}

async function handleRescanOrFocusAutomationTab() {
  if (JC_STATE.remoteSession?.active && !JC_STATE.sessionOwner) {
    await sendMessage({ type: "focusAutomationTab" });
    return;
  }
  await synchronizePageContext({ force: true, source: "manual" });
}

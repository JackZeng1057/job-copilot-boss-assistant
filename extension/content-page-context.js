// 观察职位列表变化、合并岗位快照并淘汰旧状态；详情区域变化不触发全量扫描。
function startPageContextWatcher() {
  if (pageObserver || !document.body) return;
  pageObserver = new MutationObserver((mutations) => {
    if (mutations.some(mutationAffectsJobList)) schedulePageContextSync();
  });
  pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener("popstate", () => schedulePageContextSync(80));
  window.addEventListener("hashchange", () => schedulePageContextSync(80));
  setInterval(() => {
    if (!isJobsPage() || JC_STATE.analyzing || JC_STATE.pipeline.loadingNextBatch) return;
    const snapshot = captureJobSnapshot();
    if (snapshot.jobs.length && snapshot.fingerprint !== JC_STATE.page.fingerprint) {
      schedulePageContextSync(80);
    }
  }, PAGE_SNAPSHOT_POLL_MS);
}

function mutationAffectsJobList(mutation) {
  if (isInsideJobCopilot(mutation.target)) return false;
  const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
  if (target?.closest?.(JOB_CARD_SELECTOR)) return true;
  const changedNodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
  return changedNodes.some((node) => node instanceof Element
    && (node.matches?.(JOB_CARD_SELECTOR) || node.querySelector?.(JOB_CARD_SELECTOR)));
}

function schedulePageContextSync(delay = PAGE_SYNC_DEBOUNCE_MS) {
  clearTimeout(pageSyncTimer);
  pageSyncTimer = setTimeout(() => {
    synchronizePageContext({ source: "watcher" }).catch((error) => {
      setStatus(`页面识别失败：${error.message || error}`);
    });
  }, delay);
}

async function synchronizePageContext(options = {}) {
  if (pageSyncRunning) {
    pageSyncRequested = true;
    return false;
  }
  if (!isJobsPage()) return false;
  pageSyncRunning = true;
  try {
    const snapshot = await waitForStableJobSnapshot();
    if (!snapshot.jobs.length) return false;
    return applyJobSnapshot(snapshot, { source: options.source || "sync", force: options.force === true });
  } finally {
    pageSyncRunning = false;
    if (pageSyncRequested) {
      pageSyncRequested = false;
      schedulePageContextSync(80);
    }
  }
}

async function waitForStableJobSnapshot() {
  let previous = captureJobSnapshot();
  for (let attempt = 0; attempt < JOB_SNAPSHOT_STABILITY_ATTEMPTS; attempt += 1) {
    await sleep(180);
    const current = captureJobSnapshot();
    if (current.jobs.length && current.fingerprint === previous.fingerprint) return current;
    previous = current;
  }
  return previous;
}

function applyJobSnapshot(snapshot, options = {}) {
  const previousJobs = JC_STATE.jobs;
  const initialized = JC_STATE.page.initialized;
  const previousJobsForOverlap = previousJobs.concat(
    Array.from(JC_STATE.dismissedJobKeys, (key) => ({ key }))
  );
  const overlap = jobKeyOverlap(previousJobsForOverlap, snapshot.jobs);
  // 岗位键重叠率过低视为新列表；先让旧异步工作失效，再渲染或沟通新岗位。
  const pageReplaced = initialized && previousJobs.length > 0 && snapshot.jobs.length > 0 && overlap < 0.35;
  const visibleSnapshot = {
    ...snapshot,
    jobs: snapshot.jobs.filter((job) => !JC_STATE.dismissedJobKeys.has(job.key))
  };
  snapshot = visibleSnapshot;

  if (!initialized || pageReplaced) {
    const restartMode = JC_STATE.pipeline.active && JC_STATE.pipeline.mode === "auto"
      ? "auto"
      : (JC_STATE.settings.autoRunOnJobsPage ? "auto" : "idle");
    if (initialized) invalidateCurrentPageWork();
    if (restartMode === "idle") {
      JC_STATE.pipeline.active = false;
      JC_STATE.pipeline.mode = "idle";
      JC_STATE.pipeline.allPaused = false;
    }
    JC_STATE.page.initialized = true;
    JC_STATE.page.generation += 1;
    JC_STATE.page.fingerprint = snapshot.fingerprint;
    JC_STATE.page.url = snapshot.url;
    JC_STATE.jobs = snapshot.jobs;
    JC_STATE.analyses.clear();
    JC_STATE.analysisPayloads.clear();
    JC_STATE.reanalysisInFlightKeys.clear();
    JC_STATE.jobProgress.clear();
    JC_STATE.busyPageContactRetries.clear();
    // 新列表重新计算批次，不能继承刷新前的批次编号。
    resetBatchProgress();
    // 清理旧搜索的完成标记，避免新队列首个岗位被误跳过。
    if (pageReplaced) JC_STATE.completedJobKeys.clear();
    JC_STATE.selectedKey = "";
    for (const job of JC_STATE.jobs) setJobProgress(job, "pending");
    renderList();
    updatePageContextLabel();
    if (initialized) {
      setStatus(`已识别到新的职位列表，旧页面的处理已作废。当前页共有 ${JC_STATE.jobs.length} 个岗位。`);
    } else {
      setStatus(`已绑定当前职位列表，共 ${JC_STATE.jobs.length} 个岗位。`);
    }
    if (restartMode !== "idle") restartPipelineForGeneration(restartMode, JC_STATE.page.generation);
    return true;
  }

  const previousByKey = new Map(previousJobs.map((job) => [job.key, job]));
  const nextKeys = new Set(snapshot.jobs.map((job) => job.key));
  const analyzingJobWasRemoved = previousJobs.some((job) => !nextKeys.has(job.key)
    && progressFor(job).status === "analyzing");
  if (analyzingJobWasRemoved) {
    JC_STATE.analysisRunId += 1;
    JC_STATE.analyzing = false;
  }
  const reconciled = snapshot.jobs.map((job) => ({ ...previousByKey.get(job.key), ...job, detached: false }));
  const detachedHistory = [];
  for (const oldJob of previousJobs) {
    const status = progressFor(oldJob).status;
    if (!nextKeys.has(oldJob.key) && ["contacted", "unavailable", "detail_mismatch", "attention"].includes(status)) {
      detachedHistory.push(detachJobRecord(oldJob));
    }
  }
  reconciled.push(...detachedHistory.slice(-MAX_DETACHED_JOBS));
  const added = snapshot.jobs.filter((job) => !previousByKey.has(job.key));
  JC_STATE.jobs = reconciled.map((job, index) => ({ ...job, index }));
  pruneJobState(new Set(JC_STATE.jobs.map((job) => job.key)));
  JC_STATE.page.fingerprint = snapshot.fingerprint;
  JC_STATE.page.url = snapshot.url;
  for (const job of added) setJobProgress(job, "pending");
  renderList();
  updatePageContextLabel();
  if ((added.length || analyzingJobWasRemoved) && JC_STATE.pipeline.active) {
    ensureAnalysisWorker();
  } else if (options.force) {
    setStatus(`当前职位列表已刷新，共 ${JC_STATE.jobs.length} 个岗位。`);
  }
  return added.length > 0;
}

function detachJobRecord(job) {
  return {
    ...job,
    card: null,
    text: String(job?.text || "").slice(0, 3000),
    detached: true
  };
}

function pruneJobState(retainedKeys) {
  for (const key of JC_STATE.analyses.keys()) {
    if (!retainedKeys.has(key)) JC_STATE.analyses.delete(key);
  }
  for (const key of JC_STATE.analysisPayloads.keys()) {
    if (!retainedKeys.has(key)) JC_STATE.analysisPayloads.delete(key);
  }
  for (const key of JC_STATE.reanalysisInFlightKeys) {
    if (!retainedKeys.has(key)) JC_STATE.reanalysisInFlightKeys.delete(key);
  }
  for (const key of JC_STATE.jobProgress.keys()) {
    if (!retainedKeys.has(key)) JC_STATE.jobProgress.delete(key);
  }
  for (const key of JC_STATE.busyPageContactRetries.keys()) {
    if (!retainedKeys.has(key)) JC_STATE.busyPageContactRetries.delete(key);
  }
}

function jobKeyOverlap(previousJobs, nextJobs) {
  if (!previousJobs.length || !nextJobs.length) return 0;
  const previousKeys = new Set(previousJobs.map((job) => job.key));
  const matches = nextJobs.filter((job) => previousKeys.has(job.key)).length;
  return matches / Math.max(1, Math.min(previousJobs.length, nextJobs.length));
}

function invalidateCurrentPageWork() {
  JC_STATE.analysisRunId += 1;
  JC_STATE.analyzing = false;
  JC_STATE.retryJobKey = "";
  JC_STATE.retryContactJobKey = "";
  clearHighlights();
}

function restartPipelineForGeneration(mode, generation) {
  setTimeout(() => {
    if (JC_STATE.page.generation !== generation || JC_STATE.pipeline.allPaused) return;
    if (mode === "auto") startAutoPipeline();
  }, 300);
}

function isInsideJobCopilot(node) {
  const element = node?.closest ? node : node?.parentElement;
  return Boolean(element?.closest?.("#job-copilot-panel, #job-copilot-launcher"));
}

function isJobsPage() {
  const url = location.href;
  if (isBossChatUrl(url)) return false;
  if (/\/web\/geek\/job|\/web\/geek\/recommend|query=/.test(url)) return true;
  return findCards().length > 0 || /推荐|职位|立即沟通|继续沟通/.test(cleanText(document.body?.innerText || "").slice(0, 2000));
}

function preventJavascriptUrlDefaultOnce(node) {
  const anchor = node?.closest?.("a[href]");
  const href = anchor?.getAttribute?.("href") || "";
  if (!/^javascript:/i.test(href)) return;
  anchor.addEventListener("click", (event) => event.preventDefault(), {
    capture: true,
    once: true
  });
}

function safeClick(node) {
  if (!node) return false;
  preventJavascriptUrlDefaultOnce(node);
  node.click();
  return true;
}

function isElementVisible(node) {
  if (!node || node.nodeType !== 1 || typeof node.getBoundingClientRect !== "function") return false;
  const rect = node.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = getComputedStyle(node);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0;
}

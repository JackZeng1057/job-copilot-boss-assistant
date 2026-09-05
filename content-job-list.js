// 岗位列表增量渲染、关闭与重试操作；事件委托保留在列表容器上。
function renderList() {
  const list = document.getElementById("jc-list");
  if (!list) return;
  installJobListEventDelegation(list);
  const existingRows = new Map(
    Array.from(list.children)
      .filter((node) => node instanceof HTMLElement && node.dataset.jobKey)
      .map((node) => [node.dataset.jobKey, node])
  );
  const retainedKeys = new Set();
  JC_STATE.jobs.forEach((job, index) => {
    retainedKeys.add(job.key);
    let item = existingRows.get(job.key);
    if (!item) {
      item = document.createElement("div");
      item.dataset.jobKey = job.key;
    }
    updateJobRow(item, job);
    const currentAtIndex = list.children[index] || null;
    if (currentAtIndex !== item) list.insertBefore(item, currentAtIndex);
  });
  for (const [key, item] of existingRows) {
    if (!retainedKeys.has(key)) item.remove();
  }
  updateProgressSummary();
}

function updateJobRow(item, job) {
  const analysis = JC_STATE.analyses.get(job.key);
  const score = analysis?.score ?? "--";
  const exclusionSummary = analysis?.excluded
    ? `已排除：${analysis.exclusion_match || analysis.occupation_family || "命中绝不投递岗位"}`
    : "";
  const progress = progressFor(job);
  const progressInfo = jobProgressInfo(progress.status);
  const reanalysisInFlight = JC_STATE.reanalysisInFlightKeys.has(job.key);
  const hasReplayPayload = JC_STATE.analysisPayloads.has(job.key);
  const reanalysisDisabled = job.detached || !hasReplayPayload || reanalysisInFlight
    || ["analyzing", "contacting"].includes(progress.status);
  const canRetryContact = !job.detached && progress.status === "attention" && isQualifiedJob(job);
  const contactRetryDisabled = JC_STATE.analyzing || reanalysisInFlight;
  const dismissalDisabled = progress.status === "contacting";
  const meta = [job.company, job.city, job.requirements].filter(Boolean).slice(0, 2).join(" · ");
  const renderSignature = JSON.stringify([
    job.index, job.title, job.jobName, job.salary, job.salaryFontFamily, meta, job.detached,
    progress.status, progress.detail, score, exclusionSummary, reanalysisInFlight, reanalysisDisabled,
    canRetryContact, contactRetryDisabled
  ]);
  if (item.dataset.renderSignature === renderSignature) return;
  item.dataset.renderSignature = renderSignature;
  item.className = `jc-job-row is-${progressInfo.tone}`;
  item.innerHTML = `
    <div class="jc-job-index">${job.index + 1}</div>
    <div class="jc-job-content">
      <strong>${renderTitleHtml(job)}</strong>
      <div class="jc-job-meta">${escapeHtml(meta || "岗位信息待展开")}</div>
      ${exclusionSummary ? `<div class="jc-audit-summary is-invalid">${escapeHtml(exclusionSummary)}</div>` : ""}
      ${progress.detail ? `<div class="jc-job-detail">${escapeHtml(progress.detail)}</div>` : ""}
    </div>
    <div class="jc-job-result">
      <div class="jc-job-result-heading">
        <span class="jc-progress-chip is-${progressInfo.tone}">${progressInfo.label}</span>
        <button class="jc-dismiss-job" type="button" data-dismiss-key="${escapeAttr(job.key)}"
          aria-label="关闭检测：${escapeAttr(job.title)}"
          title="${dismissalDisabled ? "正在沟通，暂时无法关闭" : "关闭检测并移出投递列表"}"
          ${dismissalDisabled ? "disabled" : ""}>×</button>
      </div>
      <span class="jc-score">${score === "--" ? "" : `${escapeHtml(String(score))} 分`}</span>
      <div class="jc-job-actions">
        ${canRetryContact ? `<button class="jc-locate-button jc-contact-retry-button"
          data-retry-contact-key="${escapeAttr(job.key)}"
          title="只重新尝试沟通，不重复请求 AI"
          ${contactRetryDisabled ? "disabled" : ""}>重试沟通</button>` : ""}
        <button class="jc-locate-button jc-retry-button" data-reanalyze-key="${escapeAttr(job.key)}"
          title="${!hasReplayPayload ? "该岗位尚无可复用的分析输入" : "使用上次采集的 JD 独立重新分析，不影响主队列"}"
          ${reanalysisDisabled ? "disabled" : ""}>${reanalysisInFlight ? "重分析中…" : "重新分析"}</button>
        <button class="jc-locate-button" data-focus-key="${escapeAttr(job.key)}"
          ${job.detached ? "disabled" : ""}>定位</button>
      </div>
    </div>
  `;
  mountSalaryVisualClone(item, job);
}

function dismissJob(key, options = {}) {
  const job = JC_STATE.jobs.find((item) => item.key === key);
  if (!job) return false;
  const progress = progressFor(job);
  const manuallyContacted = options.reason === "manual_contact";
  if (progress.status === "contacting" && !manuallyContacted) {
    setStatus(`正在沟通，暂时无法关闭：${job.title}`);
    return false;
  }

  const interruptsCurrentRun = progress.status === "analyzing"
    || progress.status === "qualified"
    || (progress.status === "contacting" && !manuallyContacted)
    || JC_STATE.currentJobKey === key;
  rememberDismissedJobKey(key);
  rememberCompletedJobKey(key);
  JC_STATE.jobs = JC_STATE.jobs
    .filter((item) => item.key !== key)
    .map((item, index) => ({ ...item, index }));
  JC_STATE.analyses.delete(key);
  JC_STATE.analysisPayloads.delete(key);
  JC_STATE.reanalysisInFlightKeys.delete(key);
  JC_STATE.jobProgress.delete(key);
  JC_STATE.pipeline.batchKeys = JC_STATE.pipeline.batchKeys.filter((item) => item !== key);
  if (JC_STATE.retryJobKey === key) JC_STATE.retryJobKey = "";
  if (JC_STATE.retryContactJobKey === key) JC_STATE.retryContactJobKey = "";
  if (JC_STATE.selectedKey === key) {
    JC_STATE.selectedKey = "";
    clearHighlights();
  }
  if (JC_STATE.currentJobKey === key) clearContactInFlight();
  if (interruptsCurrentRun) {
    JC_STATE.analysisRunId += 1;
    JC_STATE.analyzing = false;
  }

  setStatus(manuallyContacted
    ? `已手动沟通并移出投递列表：${job.title}`
    : `已关闭检测并移出投递列表：${job.title}`);
  renderList();
  updateAutomationControls();
  schedulePersistAutomationSession();
  if (interruptsCurrentRun && JC_STATE.pipeline.active && !JC_STATE.pipeline.allPaused) {
    setTimeout(ensureAnalysisWorker, 0);
  }
  return true;
}

function mountSalaryVisualClone(item, job) {
  const slot = item.querySelector("[data-jc-salary-slot]");
  const source = job.salaryNode;
  if (!slot || !source?.isConnected) return;
  const clone = source.cloneNode(true);
  const sourceNodes = [source, ...Array.from(source.querySelectorAll("*"))];
  const cloneNodes = [clone, ...Array.from(clone.querySelectorAll("*"))];
  cloneNodes.forEach((node, index) => {
    for (const attribute of Array.from(node.attributes || [])) {
      if (/^on/i.test(attribute.name)
          || ["id", "href", "src", "srcset", "target", "form", "action"].includes(attribute.name)) {
        node.removeAttribute(attribute.name);
      }
    }
    const original = sourceNodes[index];
    if (!original) return;
    const style = getComputedStyle(original);
    node.style.fontFamily = style.fontFamily;
    node.style.fontFeatureSettings = style.fontFeatureSettings;
    node.style.fontVariationSettings = style.fontVariationSettings;
  });
  slot.replaceChildren(clone);
}

function installJobListEventDelegation(list) {
  if (list.dataset.jcDelegated === "true") return;
  list.dataset.jcDelegated = "true";
  list.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("[data-focus-key], [data-reanalyze-key], [data-retry-contact-key], [data-dismiss-key]")
      : null;
    if (!button || !list.contains(button) || button.disabled) return;
    if (button.dataset.dismissKey) {
      dismissJob(button.dataset.dismissKey);
      return;
    }
    if (button.dataset.focusKey) {
      focusJob(button.dataset.focusKey);
      return;
    }
    if (button.dataset.reanalyzeKey) {
      reanalyzeJobInParallel(button.dataset.reanalyzeKey).catch((error) => {
        setStatus(`重新分析启动失败：${friendlyAiError(error?.message || error)}`);
      });
      return;
    }
    if (button.dataset.retryContactKey) {
      retryContactForJob(button.dataset.retryContactKey).catch((error) => {
        setStatus(`重新沟通启动失败：${friendlyContactError(error)}`);
        updateAutomationControls();
      });
    }
  });
}

async function reanalyzeJobInParallel(key) {
  const job = JC_STATE.jobs.find((item) => item.key === key);
  const payload = JC_STATE.analysisPayloads.get(key);
  if (!job || !payload || job.detached) return { ok: false, reason: "missing_payload" };
  if (JC_STATE.reanalysisInFlightKeys.has(key)) return { ok: false, reason: "already_running" };
  if (["analyzing", "contacting"].includes(progressFor(job).status)) {
    return { ok: false, reason: "job_busy" };
  }

  JC_STATE.reanalysisInFlightKeys.add(key);
  renderList();
  logAutomationEvent("ai_reanalysis_started", { job, detail: "source=manual_parallel" });
  try {
    const response = await requestAiAnalysis(job, payload, {
      updateGlobalStatus: false,
      source: "manual_parallel"
    });
    if (!JC_STATE.jobs.some((item) => item.key === key)) return { ok: false, reason: "job_removed" };
    if (!response?.ok) {
      const error = friendlyAiError(response?.error || "重新分析失败");
      if (!JC_STATE.analyzing) setStatus(`重新分析失败，保留原结果：${job.title}。${error}`);
      return { ok: false, reason: "analysis_failed", error };
    }

    applyAnalysisPerformance(response.analysis, response.performance);
    JC_STATE.analyses.set(key, response.analysis);
    const currentStatus = progressFor(job).status;
    if (["error", "not_qualified", "qualified"].includes(currentStatus)) {
      setJobProgress(job, analysisProgressStatus(job), "独立重新分析已完成");
    }
    schedulePersistAutomationSession();
    if (!JC_STATE.analyzing) setStatus(`重新分析完成：${job.title}，最新评分 ${response.analysis.score} 分。`);
    logAutomationEvent("ai_reanalysis_completed", {
      job,
      detail: `source=manual_parallel;score=${Number(response.analysis.score)}`
    });
    return { ok: true, analysis: response.analysis };
  } finally {
    JC_STATE.reanalysisInFlightKeys.delete(key);
    renderList();
  }
}

async function retryContactForJob(key) {
  const job = JC_STATE.jobs.find((item) => item.key === key);
  if (!job || job.detached || !job.card?.isConnected) throw new Error("岗位已离开当前页面");
  if (!isQualifiedJob(job)) throw new Error("该岗位当前评分未达到自动沟通门槛");
  if (JC_STATE.analyzing || progressFor(job).status === "contacting") {
    throw new Error("当前已有自动投递步骤正在执行");
  }

  JC_STATE.completedJobKeys.delete(job.key);
  JC_STATE.retryContactJobKey = job.key;
  JC_STATE.pipeline.batchKeys = [job.key];
  setJobProgress(job, "qualified", "等待重新尝试沟通，不重复分析");
  JC_STATE.pipeline.active = true;
  JC_STATE.pipeline.mode = "auto";
  JC_STATE.pipeline.phase = "analysis";
  JC_STATE.pipeline.allPaused = false;
  JC_STATE.pipeline.pauseReason = "";
  JC_STATE.sessionOwner = true;
  JC_STATE.remoteSession = null;
  await registerAutomationSession();
  setStatus(`准备重新沟通：${job.title}`);
  renderList();
  updateAutomationControls();
  ensureAnalysisWorker();
}

function jobProgressInfo(status) {
  const states = {
    pending: { label: "待分析", tone: "neutral" },
    analyzing: { label: "分析中", tone: "active" },
    qualified: { label: "已达标", tone: "success" },
    contacting: { label: "沟通中", tone: "warning" },
    contacted: { label: "已沟通", tone: "success" },
    not_qualified: { label: "未达标", tone: "muted" },
    unavailable: { label: "不可沟通", tone: "muted" },
    detail_mismatch: { label: "定位失败", tone: "danger" },
    error: { label: "分析失败", tone: "danger" },
    attention: { label: "需确认", tone: "warning" }
  };
  return states[status] || states.pending;
}

function updateProgressSummary() {
  const jobs = JC_STATE.jobs;
  const analyzed = jobs.filter((job) => JC_STATE.analyses.has(job.key)).length;
  const qualified = jobs.filter((job) => isQualifiedJob(job)).length;
  const contacted = jobs.filter((job) => progressFor(job).status === "contacted").length;
  setNodeText("jc-total-count", jobs.length);
  setNodeText("jc-analyzed-count", analyzed);
  setNodeText("jc-qualified-count", qualified);
  setNodeText("jc-contacted-count", contacted);
  updatePageContextLabel();
}

function updatePageContextLabel() {
  const node = document.getElementById("jc-page-context");
  if (!node) return;
  if (!JC_STATE.page.initialized) {
    node.textContent = "正在识别当前岗位列表...";
    return;
  }
  const visible = JC_STATE.jobs.filter((job) => !job.detached).length;
  const batch = Math.max(1, Number(JC_STATE.pipeline.batchNumber) || 1);
  const batchSize = Math.max(0, Number(JC_STATE.pipeline.batchSize) || 0);
  node.textContent = `第 ${batch} 批 · 当前列表总数 ${visible} 个 · 本批 ${batchSize} 个`;
}

function setNodeText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = String(value);
}

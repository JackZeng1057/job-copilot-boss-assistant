// 面板用户操作与暂停、继续控制；手动操作优先于自动恢复。
function applyExternalAutomationControl(action, reason = "manual") {
  if (!JC_STATE.sessionOwner) return;
  if (action === "pause") {
    JC_STATE.pipeline.allPaused = true;
    JC_STATE.pipeline.phase = "paused";
    JC_STATE.pipeline.pauseReason = reason === "machine_locked" ? "machine_locked" : "external";
    if (reason === "machine_locked") {
      setStatus("电脑已锁定，自动投递将在当前步骤结束后暂停。");
    } else {
      setStatus("已从其他标签暂停自动投递，当前步骤结束后停止。");
    }
  } else if (action === "resume") {
    JC_STATE.pipeline.allPaused = false;
    JC_STATE.pipeline.phase = JC_STATE.pipeline.waitingForNextBatch
      ? "batch_wait"
      : (JC_STATE.pipeline.loadingNextBatch
        ? "batch_loading"
        : (JC_STATE.pipeline.active ? "analysis" : "idle"));
    JC_STATE.pipeline.pauseReason = "";
    setStatus(reason === "machine_active"
      ? "电脑恢复使用，自动投递已自动继续。"
      : "已从其他标签继续自动投递。");
    if (JC_STATE.pipeline.waitingForNextBatch) {
      advanceToNextBatch().catch((error) => setStatus(`恢复批次等待失败：${error.message || error}`));
    } else {
      ensureAnalysisWorker();
    }
  }
  updateAutomationControls();
  schedulePersistAutomationSession();
}

async function setJobsPageAutomation(enabled) {
  await setAutomationFlag("autoRunOnJobsPage", enabled);
  setStatus(enabled
    ? "已开启换页自动投递。切换职位分类或搜索结果后，新页面会自动分析，达标后按保守节奏沟通。"
    : "已关闭换页自动投递。切换页面时只刷新岗位列表，需要手动点击开始。"
  );
  updateAutomationControls();
}

function setAutomationFlag(key, value) {
  JC_STATE.settings[key] = value;
  return new Promise((resolve, reject) => {
    if (!extensionContextAvailable()) {
      invalidateExtensionContext();
      resolve(false);
      return;
    }
    try {
      chrome.storage.local.set({ [key]: value }, () => {
        let error = null;
        try {
          error = chrome.runtime.lastError;
        } catch (runtimeError) {
          invalidateExtensionContext();
          resolve(false);
          return;
        }
        if (error) reject(new Error(error.message));
        else resolve(true);
      });
    } catch (error) {
      if (isExtensionContextError(error)) {
        invalidateExtensionContext();
        resolve(false);
      } else {
        reject(error);
      }
    }
  });
}

function updateAutomationControls() {
  updateSwitch("jc-toggle-jobs", JC_STATE.settings.autoRunOnJobsPage);
  updateAutomationStateLabels();
  updateAnalysisControls();
}

function updateAutomationStateLabels() {
  const recommendNode = document.getElementById("jc-jobs-state");
  if (recommendNode) {
    recommendNode.textContent = JC_STATE.settings.autoRunOnJobsPage
      ? "开启：换页后自动分析，达标后稍候沟通"
      : "关闭：只刷新岗位列表，需手动开始";
  }
}

function updateSwitch(id, active) {
  const node = document.getElementById(id);
  if (!node) return;
  node.setAttribute("aria-checked", active ? "true" : "false");
  node.classList.toggle("is-on", Boolean(active));
}

async function toggleJobsPageAutomation() {
  await setJobsPageAutomation(!JC_STATE.settings.autoRunOnJobsPage);
}

async function handlePipelineControl() {
  if (JC_STATE.pipeline.controlActionInFlight) return;
  JC_STATE.pipeline.controlActionInFlight = true;
  try {
    if (JC_STATE.remoteSession?.active && !JC_STATE.sessionOwner) {
      const action = JC_STATE.remoteSession.paused ? "resume" : "pause";
      await sendMessage({ type: "controlAutomationTab", action });
      await sleep(250);
      await refreshAutomationSession();
      return;
    }
    if (JC_STATE.pipeline.contextInvalidated) {
      setStatus("扩展已重新加载；为保护当前职位列表，插件不会自动刷新。请确认筛选条件已保存后，使用浏览器刷新按钮手动加载新版。");
      updateAutomationControls();
      return;
    }
    if (JC_STATE.pipeline.allPaused) {
      JC_STATE.pipeline.allPaused = false;
      JC_STATE.pipeline.pauseReason = "";
      JC_STATE.pipeline.phase = JC_STATE.pipeline.waitingForNextBatch
        ? "batch_wait"
        : (JC_STATE.pipeline.loadingNextBatch
          ? "batch_loading"
          : (JC_STATE.pipeline.active ? "analysis" : "idle"));
      setStatus("自动投递已继续，将从未完成岗位接着执行。");
      logAutomationEvent("automation_resumed_manual", {
        detail: "source=owner_panel"
      });
      updateAutomationControls();
      if (JC_STATE.pipeline.waitingForNextBatch) {
        advanceToNextBatch().catch((error) => setStatus(`恢复批次等待失败：${error.message || error}`));
      } else {
        ensureAnalysisWorker();
      }
      return;
    }
    if (JC_STATE.pipeline.waitingForNextBatch || JC_STATE.pipeline.loadingNextBatch) {
      JC_STATE.pipeline.allPaused = true;
      JC_STATE.pipeline.pauseReason = "manual";
      JC_STATE.pipeline.phase = "paused";
      setStatus("正在暂停连续投递，批次进度会保留。");
      logAutomationEvent("automation_paused_manual", {
        detail: "source=owner_panel;phase=batch_transition"
      });
      updateAutomationControls();
      schedulePersistAutomationSession();
      return;
    }
    if (JC_STATE.analyzing) {
      JC_STATE.pipeline.allPaused = true;
      JC_STATE.pipeline.pauseReason = "manual";
      JC_STATE.pipeline.phase = "paused";
      setStatus("正在暂停自动投递。当前步骤结束后停止，岗位进度会保留。");
      logAutomationEvent("automation_paused_manual", {
        detail: "source=owner_panel;phase=analysis"
      });
      updateAutomationControls();
      return;
    }
    if (JC_STATE.pipeline.mode === "auto" && JC_STATE.pipeline.active
        && !JC_STATE.jobs.some((job) => jobNeedsProcessing(job))) {
      setStatus("当前页已经处理完成。切换职位页面后可开始处理新岗位。");
      updateAutomationControls();
      return;
    }
    await startAutoPipeline();
  } finally {
    JC_STATE.pipeline.controlActionInFlight = false;
    updateAutomationControls();
  }
}

function openPanel(panel, launcher) {
  panel.style.display = "block";
  launcher.style.display = "none";
  panel.classList.remove("jc-minimized");
  const body = document.getElementById("jc-body");
  if (body) body.style.display = "block";
  updateAutomationControls();
  ensurePanelInViewport(panel);
}

function closePanel(panel, launcher) {
  panel.style.display = "none";
  launcher.style.display = "flex";
  restoreLauncherTop(launcher);
}

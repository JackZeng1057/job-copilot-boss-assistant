// 页面入口及通用消息桥；manifest 中必须最后加载，所有依赖已就绪后才能启动。
function renderTitleHtml(job) {
  const pieces = [escapeHtml(job.jobName || job.title)];
  const salary = normalizeDisplaySalary(job.salary) || normalizeDisplaySalary(findSalaryLine(job.text));
  if (salary) {
    pieces.push(`<span class="jc-salary-text">${escapeHtml(salary)}</span>`);
  } else if (job.salaryNode) {
    pieces.push('<span class="jc-salary-source" data-jc-salary-slot="true"></span>');
  } else if (job.salaryVisualHtml) {
    pieces.push(job.salaryVisualHtml);
  }
  return pieces.join(" ");
}

function clearHighlights() {
  document.querySelectorAll(".jc-highlight").forEach((node) => node.classList.remove("jc-highlight"));
}

function setStatus(text) {
  const node = document.getElementById("jc-status");
  if (node) node.textContent = text;
  schedulePersistAutomationSession();
}

function pageNeedsHuman() {
  const text = cleanText(document.body?.innerText || "");
  return /请登录|扫码登录|安全验证|验证码|拖动滑块|滑块验证|访问异常/.test(text);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    if (!extensionContextAvailable()) {
      invalidateExtensionContext();
      resolve({ ok: false, error: "Extension context invalidated." });
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        let error = null;
        try {
          error = chrome.runtime.lastError;
        } catch (runtimeError) {
          invalidateExtensionContext();
          resolve({ ok: false, error: String(runtimeError?.message || runtimeError) });
          return;
        }
        if (error) {
          if (/message channel closed|receiving end does not exist|context invalidated/i.test(error.message || "")) {
            if (/context invalidated/i.test(error.message || "")) invalidateExtensionContext();
            resolve({ ok: false, error: error.message });
            return;
          }
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      if (/context invalidated/i.test(String(error?.message || error))) {
        invalidateExtensionContext();
        resolve({ ok: false, error: String(error?.message || error) });
        return;
      }
      reject(error);
    }
  });
}

function extensionContextAvailable() {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function invalidateExtensionContext() {
  if (JC_STATE.pipeline.contextInvalidated) return;
  JC_STATE.pipeline.contextInvalidated = true;
  JC_STATE.pipeline.active = false;
  JC_STATE.pipeline.allPaused = true;
  JC_STATE.analyzing = false;
  JC_STATE.analysisRunId += 1;
  JC_STATE.sessionOwner = false;
  clearTimeout(sessionPersistTimer);
  sessionPersistTimer = null;
  const node = document.getElementById("jc-status");
  if (node) node.textContent = "扩展已重新加载，请刷新当前职位页后继续。为保护当前职位列表，插件不会自动刷新。";
  updateAutomationControls();
}

async function collectJobDescriptionForAnalysis(job) {
  const startedAt = Date.now();
  const cardText = buildJobTextForAi(job);
  const selected = await selectJobDetail(job);
  if (!selected) {
    logAutomationEvent("job_detail_collected", {
      job,
      detail: `durationMs=${Date.now() - startedAt};complete=false;length=${cardText.length}`
    });
    return { text: cardText, complete: false };
  }
  const communicateButton = findCommunicationButtonForJob(job);
  const detailScope = communicateButton ? findJobDetailScope(communicateButton) : null;
  const detailText = stripObfuscatedSalary(detailScope?.innerText || "")
    .replace(/[█▉▊▋▌▍▎▏■]+/g, "")
    .slice(0, 9000);
  if (detailText.length < 80) {
    logAutomationEvent("job_detail_collected", {
      job,
      detail: `durationMs=${Date.now() - startedAt};complete=false;length=${cardText.length}`
    });
    return { text: cardText, complete: false };
  }
  logAutomationEvent("job_detail_collected", {
    job,
    detail: `durationMs=${Date.now() - startedAt};complete=true;length=${detailText.length}`
  });
  return {
    text: `【岗位卡片】\n${cardText}\n\n【完整职位详情】\n${detailText}`,
    complete: true
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SHOULD_BOOT_CONTENT_RUNTIME = !hasLiveContentRuntime();
if (SHOULD_BOOT_CONTENT_RUNTIME) {
  initPanel();
  installManualChatTabHandler(true);
  installContentRuntimeResponder();
  registerJobsTabProtection();
}

// 自动沟通状态转换；先持久化在途标记，再执行点击，避免重载后重复操作。
// 页面忙导致点击未送达时，仅重试一次，再交由人工复核。
async function handleBusyPageContact(job, context) {
  const attempts = (JC_STATE.busyPageContactRetries.get(job.key) || 0) + 1;
  JC_STATE.busyPageContactRetries.set(job.key, attempts);
  logContactEvent(`contact_page_busy_attempt_${attempts}`, job);
  if (attempts > MAX_BUSY_PAGE_CONTACT_RETRIES) {
    const detail = "BOSS 页面长时间无响应，原生点击未能送达，请人工确认该岗位";
    setJobProgress(job, "attention", detail);
    completeJob(job);
    setStatus(`${detail}：${job.title}。继续处理下一个岗位。`);
    renderList();
    return "continue";
  }
  const detail = "BOSS 页面响应过慢，点击未送达，稍后重试该岗位";
  setJobProgress(job, "qualified", detail);
  JC_STATE.retryContactJobKey = job.key;
  setStatus(`${detail}：${job.title}`);
  renderList();
  const pacingResult = await waitForPacingDelay(BETWEEN_JOBS_DELAY_MS, context);
  return pacingResult === "ready" ? "continue" : pacingResult;
}

// 限速不能证明岗位失败，保留队列项，回到前台后继续。
async function handleThrottledContact(job) {
  const detail = "浏览器在后台限速了该标签，未能确认沟通结果，已保留岗位待重试";
  setJobProgress(job, "qualified", detail);
  JC_STATE.retryContactJobKey = job.key;
  logContactEvent("contact_throttled_retry_scheduled", job);
  setStatus(`${detail}：${job.title}。把职位标签切回前台即可继续。`);
  renderList();
  await waitForPageVisible(THROTTLE_RECOVERY_TIMEOUT_MS);
  return "continue";
}

async function contactQualifiedJob(job, context) {
  // 所有退出路径都清除在途标记，包括提前返回和异常。
  try {
    return await runQualifiedJobContact(job, context);
  } finally {
    clearContactInFlight();
  }
}

async function markContactInFlight(key) {
  JC_STATE.currentJobKey = key;
  JC_STATE.pipeline.contactInFlight = true;
  try {
    await persistAutomationSessionNow();
  } catch (error) {
    JC_STATE.currentJobKey = "";
    JC_STATE.pipeline.contactInFlight = false;
    schedulePersistAutomationSession();
    throw error;
  }
}

function clearContactInFlight() {
  if (!JC_STATE.pipeline.contactInFlight && !JC_STATE.currentJobKey) return;
  JC_STATE.currentJobKey = "";
  JC_STATE.pipeline.contactInFlight = false;
  schedulePersistAutomationSession();
}

async function runQualifiedJobContact(job, context) {
  if (!job.card?.isConnected) {
    setJobProgress(job, "unavailable", "岗位已离开当前页面");
    completeJob(job);
    renderList();
    return "continue";
  }
  setJobProgress(job, "qualified", "分析完成，稍后开始沟通");
  setStatus(`岗位已达标，${Math.round(POST_ANALYSIS_CONTACT_DELAY_MS / 1000)} 秒后沟通：${job.title}`);
  renderList();
  const pacingResult = await waitForPacingDelay(POST_ANALYSIS_CONTACT_DELAY_MS, context);
  if (pacingResult !== "ready") return pacingResult;
  setJobProgress(job, "contacting");
  setStatus(`分数达标，正在点击沟通按钮：${job.title}`);
  renderList();
  // 点击前保存岗位身份；若期间发生路由跳转，后台仍能定位待人工复核的岗位。
  let result;
  try {
    await markContactInFlight(job.key);
    result = await clickCommunicateForJob(job);
  } catch (error) {
    if (lastContactTickReport?.throttled) return handleThrottledContact(job);
    if (NATIVE_CLICK_TIMEOUT_PATTERN.test(String(error?.message || error))) {
      return handleBusyPageContact(job, context);
    }
    const detail = friendlyContactError(error);
    setJobProgress(job, "attention", detail);
    completeJob(job);
    setStatus(`${detail} 已记录当前岗位，继续处理下一个岗位。`);
    renderList();
    return "continue";
  }
  if (JC_STATE.analysisRunId !== context.runId || JC_STATE.page.generation !== context.pageGeneration) {
    return "superseded";
  }

  if (["stayed", "stayed_confirmed", "navigated_chat"].includes(result)) {
    JC_STATE.busyPageContactRetries.delete(job.key);
    setJobProgress(job, "contacted");
    completeJob(job);
    setStatus(`已在后台完成沟通，职位列表保持不变：${job.title}。${Math.round(BETWEEN_JOBS_DELAY_MS / 1000)} 秒后继续下一个岗位。`);
    renderList();
    return "continue";
  }
  if (result === "tab_throttled") return handleThrottledContact(job);
  if (result === "detail_mismatch") {
    setJobProgress(job, "detail_mismatch", "当前职位详情与目标岗位不一致");
    completeJob(job);
    setStatus(`当前职位详情与目标岗位不一致，未点击沟通：${job.title}。继续处理下一个岗位。`);
    renderList();
    return "continue";
  }
  if (result === "no_button") {
    setJobProgress(job, "unavailable", "没有可点击的沟通按钮");
    completeJob(job);
    setStatus(`该岗位没有“立即沟通”或“继续沟通”按钮：${job.title}。继续处理下一个岗位。`);
    renderList();
    return "continue";
  }
  if (result === "stay_missing") {
    const detail = "插件自动核验后仍未得到 BOSS 明确结果，已记录当前岗位";
    setJobProgress(job, "attention", detail);
    completeJob(job);
    setStatus(`${detail}：${job.title}。继续处理下一个岗位。`);
    renderList();
    return "continue";
  }
  if (result === "manual_required") {
    const detail = "BOSS 未返回明确的沟通成功确认，已保留该岗位并继续处理后续岗位";
    setJobProgress(job, "attention", detail);
    completeJob(job);
    setStatus(`${detail}：${job.title}。`);
    renderList();
    return "continue";
  }
  const blockingMessage = {
    blocked_rate: "BOSS 提示操作频繁，已暂停后续岗位。",
    blocked_limit: "BOSS 提示沟通数量或额度已达上限，已暂停后续岗位。",
    blocked_security: "BOSS 要求安全验证，已暂停后续岗位，请先人工完成验证。",
    blocked_generic: "BOSS 拒绝了本次沟通，已暂停后续岗位。"
  }[result] || "本次沟通状态不明确，已停止处理。";
  setJobProgress(job, "attention", blockingMessage);
  completeJob(job);
  JC_STATE.pipeline.allPaused = true;
  JC_STATE.pipeline.phase = "paused";
  setStatus(blockingMessage);
  renderList();
  return "halted";
}

function friendlyContactError(error) {
  const text = String(error?.message || error || "");
  if (/超时|timeout|timed out/i.test(text)) {
    return "沟通结果确认超时，请人工查看该岗位是否已发送";
  }
  return `沟通结果未确认：${text || "未知错误"}`;
}

async function waitForPacingDelay(durationMs, context) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (JC_STATE.analysisRunId !== context.runId || JC_STATE.page.generation !== context.pageGeneration) {
      return "superseded";
    }
    if (JC_STATE.pipeline.allPaused) return "paused";
    await sleep(Math.min(250, deadline - Date.now()));
  }
  return "ready";
}

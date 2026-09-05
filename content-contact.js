// 沟通点击、后台限速识别与岗位详情选择；操作必须留在所属职位页。
function beginContactTickTracking() {
  contactTickTracker = { throttled: false, maxTickMs: 0, startedAt: Date.now() };
  return contactTickTracker;
}

function endContactTickTracking() {
  lastContactTickReport = contactTickTracker;
  contactTickTracker = null;
  return lastContactTickReport;
}

// 记录实际等待时间；后台限速后，重试次数不能再近似代表墙钟时间。
async function contactSleep(ms) {
  const startedAt = Date.now();
  await sleep(ms);
  const elapsed = Date.now() - startedAt;
  if (contactTickTracker && elapsed >= Math.max(THROTTLED_TICK_MIN_MS, ms * THROTTLED_TICK_RATIO)) {
    contactTickTracker.throttled = true;
    contactTickTracker.maxTickMs = Math.max(contactTickTracker.maxTickMs, elapsed);
  }
  return elapsed;
}

function contactTabThrottled() {
  return contactTickTracker?.throttled === true;
}

function recordContactDispatchDuration(durationMs) {
  if (contactTickTracker) contactTickTracker.dispatchMs = durationMs;
}

function logContactAttemptTiming(job, report) {
  if (!report) return;
  const visibility = typeof document === "undefined" ? "unknown" : document.visibilityState;
  logAutomationEvent("contact_attempt_timing", {
    job,
    detail: [
      `totalMs=${Date.now() - report.startedAt}`,
      `selectMs=${Number(report.selectMs || 0)}`,
      `contactMs=${Number(report.contactMs || 0)}`,
      `dispatchMs=${Number(report.dispatchMs || 0)}`,
      `throttled=${report.throttled === true}`,
      `maxTickMs=${Number(report.maxTickMs || 0)}`,
      `visibility=${visibility}`
    ].join(";")
  });
}

// 通过可见性事件等待回到前台，避免依赖同样会被限速的轮询计时器。
function waitForPageVisible(timeoutMs) {
  if (typeof document === "undefined" || document.visibilityState === "visible") {
    return Promise.resolve("visible");
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimeout(timer);
      resolve(result);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") finish("visible");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

async function clickCommunicateForJob(job) {
  const tracker = beginContactTickTracking();
  try {
    return await runCommunicateForJob(job, tracker);
  } finally {
    logContactAttemptTiming(job, endContactTickTracking());
  }
}

async function runCommunicateForJob(job, tracker) {
  const selectStartedAt = Date.now();
  const selected = await selectJobDetail(job);
  tracker.selectMs = Date.now() - selectStartedAt;
  if (!selected) return tracker.throttled ? "tab_throttled" : "detail_mismatch";
  const button = findCommunicationButtonForJob(job);
  if (!button) return "no_button";

  // “继续沟通”属于 HR 会话状态，不代表当前岗位已投递；仍等待本次沟通确认。
  const label = cleanText(button.innerText || button.textContent || "");
  if (isContinuationContactLabel(label)) {
    logAutomationEvent("existing_conversation_contacted", { job, detail: `label=${label}` });
  }
  // 在可见的所属职位页执行沟通；导航保护覆盖跳转，保留网站正常确认流程。
  const contactStartedAt = Date.now();
  const status = await communicateOnOwnerPage(job, button);
  tracker.contactMs = Date.now() - contactStartedAt;
  // 后台限速也会拖慢网站脚本；没有响应不等于拒绝，应保留岗位。
  const outcome = status === "manual_required" && tracker.throttled ? "tab_throttled" : status;
  logContactEvent(`owner_${outcome}`, job);
  return outcome;
}

async function communicateOnOwnerPage(job, button = findCommunicationButtonForJob(job)) {
  if (!isJobsPage() || !button) return button ? "owner_page_unavailable" : "no_button";
  const ownerJobsUrl = location.href;
  // 点击前记录按钮文案，已有“继续沟通”不能充当本次成功证据。
  const startedFromExistingConversation = isContinuationContactLabel(
    button.innerText || button.textContent || ""
  );
  const evidenceOptions = { allowButtonLabel: !startedFromExistingConversation };
  button.scrollIntoView?.({ block: "center", inline: "center" });
  button.focus?.({ preventScroll: true });
  // 导航保护需覆盖点击耗时与完整确认窗口。
  document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_START_EVENT, {
    detail: { durationMs: NATIVE_CLICK_TIMEOUT_MS + CONTACT_CONFIRMATION_TIMEOUT_MS }
  }));
  let waiter = null;
  try {
    const dispatchStartedAt = Date.now();
    await dispatchNativeContactClick(job, button);
    recordContactDispatchDuration(Date.now() - dispatchStartedAt);
    // 确认窗口从点击送达后开始计时，避免慢点击耗尽网站可用的确认时间。
    waiter = createStayOnCurrentPageWaiter(CONTACT_CONFIRMATION_TIMEOUT_MS, job, evidenceOptions);
    document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_START_EVENT, {
      detail: { durationMs: CONTACT_CONFIRMATION_TIMEOUT_MS }
    }));
    const result = await waiter.promise;
    if (result === "chat_route" || isBossChatUrl(location.href) || isBossJobDetailUrl(location.href)) {
      const restored = await restoreManualOwnerJobsRoute(ownerJobsUrl);
      if (!restored) return "owner_route_escape";
      // 继续已有会话可能直接进入聊天路由，此时按已有会话的结果处理。
      if (startedFromExistingConversation) return "stayed_confirmed";
      return manualCommunicationConfirmed(job, evidenceOptions) ? "stayed_confirmed" : "owner_route_escape";
    }
    if (result === "stay_missing" && !manualCommunicationConfirmed(job, evidenceOptions)) {
      // 点击已送达但没有正向确认时，保留岗位待复核，不猜测成功。
      return "manual_required";
    }
    return result;
  } finally {
    waiter?.cancel();
    document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_STOP_EVENT));
  }
}

async function dispatchNativeContactClick(job, button) {
  // 仅临时禁用插件面板的命中测试；网站登录和安全弹窗仍需阻止自动操作。
  const restorePointerEvents = temporarilyDisableJobCopilotPointerEvents();
  try {
    let point = null;
    let preflightError = "立即沟通按钮被其他页面元素遮挡";
    // 平滑滚动可能尚未结束，给布局和命中测试一个有界的稳定时间。
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (!button?.isConnected || !isElementVisible(button) || !communicationButtonMatchesJob(button, job)) {
        throw new Error("立即沟通按钮已变化，已取消原生点击");
      }
      const rect = button.getBoundingClientRect();
      const x = rect.left + (rect.width / 2);
      const y = rect.top + (rect.height / 2);
      if (rect.width < 2 || rect.height < 2 || x < 0 || y < 0
          || x >= window.innerWidth || y >= window.innerHeight) {
        preflightError = "立即沟通按钮不在当前可点击视口内";
      } else {
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === button || button.contains(hit))) {
          point = { x, y };
          break;
        }
        preflightError = "立即沟通按钮被 BOSS 页面其他元素遮挡";
      }
      if (attempt < 11) await contactSleep(50);
      if (contactTabThrottled()) break;
    }
    if (!point) throw new Error(contactTabThrottled() ? THROTTLED_CONTACT_ERROR : preflightError);

    nativeAutomationContactKeys.add(job.key);
    try {
      const response = await sendMessage({
        type: "dispatchTrustedContactClick",
        x: point.x,
        y: point.y,
        pageUrl: location.href,
        jobKey: job.key,
        jobUrl: job.url
      });
      if (!response?.ok || response.dispatched !== true) {
        throw new Error(response?.error || "浏览器原生点击未执行");
      }
      return true;
    } finally {
      nativeAutomationContactKeys.delete(job.key);
    }
  } finally {
    restorePointerEvents();
  }
}

function temporarilyDisableJobCopilotPointerEvents() {
  const nodes = [
    document.getElementById("job-copilot-panel"),
    document.getElementById("job-copilot-launcher"),
    document.getElementById("job-copilot-message-overlay")
  ].filter(Boolean);
  const previous = nodes.map((node) => ({
    node,
    value: node.style.getPropertyValue("pointer-events"),
    priority: node.style.getPropertyPriority("pointer-events")
  }));
  for (const { node } of previous) node.style.setProperty("pointer-events", "none", "important");
  return () => {
    for (const { node, value, priority } of previous) {
      if (value) node.style.setProperty("pointer-events", value, priority);
      else node.style.removeProperty("pointer-events");
    }
  };
}

function communicationBlockStatus() {
  const text = cleanText(document.body?.textContent || "");
  if (/安全验证|验证码|拖动滑块|滑块验证|访问异常|账号异常/.test(text)) return "blocked_security";
  if (/沟通.{0,8}(?:上限|额度|数量)|今日.{0,8}(?:沟通|招呼).{0,8}(?:上限|用完)|已达.{0,8}(?:沟通|招呼)/.test(text)) {
    return "blocked_limit";
  }
  if (/操作频繁|请求频繁|请稍后再试|操作过快|访问过于频繁/.test(text)) return "blocked_rate";
  if (/沟通失败|发送失败|暂时无法沟通|无法发起沟通/.test(text)) return "blocked_generic";
  return "";
}

async function selectJobDetail(job) {
  clearHighlights();
  JC_STATE.selectedKey = job.key;
  job.card.classList.add("jc-highlight");
  job.card.scrollIntoView({ behavior: "smooth", block: "center" });
  if (detailMatchesJob(job)) return true;

  const targets = findJobCardActivationTargets(job.card);
  if (!targets.length) return false;
  // 触发选岗事件时取消链接默认跳转，保持所属标签处于职位列表。
  const ownerJobsUrl = location.href;
  document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_START_EVENT, {
    detail: { durationMs: 6000 }
  }));
  try {
    for (const target of targets) {
      const stayedOnJobsPage = await clickWithoutOwnerNavigation(target, ownerJobsUrl);
      if (!stayedOnJobsPage) {
        pauseForOwnerRouteEscape(job);
        return false;
      }
      for (let attempt = 0; attempt < 18; attempt += 1) {
        await contactSleep(100);
        if (!restoreOwnerJobsRoute(ownerJobsUrl)) {
          pauseForOwnerRouteEscape(job);
          return false;
        }
        if (detailMatchesJob(job)) return true;
        if (isBossChatUrl(location.href)) return false;
        // 检测到限速后立即退出，让上层在页面恢复响应后重试。
        if (contactTabThrottled()) return false;
      }
    }
    logContactEvent("detail_mismatch", job);
    return false;
  } finally {
    document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_STOP_EVENT));
  }
}

function findJobCardActivationTargets(card) {
  const nodes = [
    card,
    card.querySelector(".job-name, [class*='job-name'], .job-title, [class*='job-title']")
  ].filter((node) => node && isElementVisible(node));
  const targets = [];
  for (const node of nodes) {
    const target = node === card ? card : (node.closest("a,button") || node);
    if (!targets.includes(target)) targets.push(target);
  }
  return targets;
}

function isBossJobDetailUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(String(url), location.href);
    return parsed.hostname === "www.zhipin.com" && /\/job_detail\//.test(parsed.pathname);
  } catch {
    return /\/job_detail\//.test(String(url));
  }
}

function restoreOwnerJobsRoute(ownerJobsUrl) {
  if (isBossJobDetailUrl(ownerJobsUrl) || !isBossJobDetailUrl(location.href)) return true;
  history.back();
  return false;
}

async function clickWithoutOwnerNavigation(node, ownerJobsUrl = location.href) {
  if (!node) return false;
  const anchor = node.closest?.("a[href]");
  anchor?.addEventListener("click", (event) => event.preventDefault(), {
    capture: true,
    once: true
  });
  node.click();
  if (!restoreOwnerJobsRoute(ownerJobsUrl)) return false;
  // 网站可能在微任务中更新路由；等待详情前再检查一次是否离开列表。
  await Promise.resolve();
  return restoreOwnerJobsRoute(ownerJobsUrl);
}

function pauseForOwnerRouteEscape(job) {
  JC_STATE.pipeline.allPaused = true;
  JC_STATE.pipeline.ownerRouteEscaped = true;
  setJobProgress(job, "attention", "读取 JD 时职位标签误入详情页，已后退并暂停");
  setStatus("检测到 BOSS 将职位列表标签切到详情页，已自动后退并暂停。请确认列表恢复后再继续。");
  logAutomationEvent("owner_job_detail_route_restored", {
    job,
    detail: "action=history.back;automation=paused"
  });
  renderList();
  updateAutomationControls();
}

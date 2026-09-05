// 手动沟通拦截、运行时探测与聊天入口保护。
function registerJobsTabProtection() {
  if (!isJobsPage()) return;
  document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_START_EVENT, {
    detail: { persistent: true }
  }));
  sendMessage({ type: "protectJobsTab" }).catch(() => {});
}

function hasLiveContentRuntime() {
  if (!document.getElementById("job-copilot-panel")) return false;
  const token = `${CONTENT_SCRIPT_VERSION}:${Date.now()}:${Math.random()}`;
  let acknowledged = false;
  const receiveAck = (event) => {
    if (event.detail === token) acknowledged = true;
  };
  document.addEventListener(RUNTIME_ACK_EVENT, receiveAck);
  document.dispatchEvent(new CustomEvent(RUNTIME_PROBE_EVENT, { detail: token }));
  document.removeEventListener(RUNTIME_ACK_EVENT, receiveAck);
  return acknowledged;
}

function installContentRuntimeResponder() {
  document.addEventListener(RUNTIME_PROBE_EVENT, (event) => {
    document.dispatchEvent(new CustomEvent(RUNTIME_ACK_EVENT, { detail: event.detail }));
  });
}

function installManualChatTabHandler(force = false) {
  if (!force && document.documentElement.dataset.jcManualChatHandler === CONTENT_SCRIPT_VERSION) return;
  document.documentElement.dataset.jcManualChatHandler = CONTENT_SCRIPT_VERSION;
  hardenManualChatLinks();
  const linkObserver = new MutationObserver(() => scheduleManualChatLinkHardening());
  linkObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", scheduleManualChatLinkHardening, true);
  window.addEventListener("scroll", scheduleManualChatLinkHardening, { capture: true, passive: true });
  window.setInterval(scheduleManualChatLinkHardening, MANUAL_CHAT_SCAN_FALLBACK_MS);
  window.addEventListener("pointerdown", handleManualChatHitboxEvent, true);
  window.addEventListener("click", handleManualChatHitboxEvent, true);
  document.addEventListener("click", handleManualChatClick, true);
  document.addEventListener("click", handleManualJobContactClick, true);
  document.addEventListener("click", containTrustedManualContactNavigation, false);
}

function scheduleManualChatLinkHardening() {
  if (manualChatScanTimer) return;
  manualChatScanTimer = setTimeout(() => {
    manualChatScanTimer = null;
    hardenManualChatLinks();
  }, MANUAL_CHAT_SCAN_DELAY_MS);
}

function handleManualChatHitboxEvent(event) {
  const box = manualChatHitbox;
  if (!box || !event.isTrusted || !isJobsPage()
    || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (event.target instanceof Element && event.target.closest("#job-copilot-message-overlay")) return;
  if (Number.isInteger(event.button) && event.button !== 0) return;
  if (event.clientX < box.left || event.clientX > box.right
    || event.clientY < box.top || event.clientY > box.bottom) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (Date.now() - manualChatOpenAt < 800) return;
  manualChatOpenAt = Date.now();
  openManualChatCompanion(event);
}

function handleManualChatClick(event) {
  if (!isTrustedTopNavigationChatClick(event) || !isJobsPage()) return;
  openManualChatCompanion(event);
}

function isContactActionLabel(label) {
  return /^(立即沟通|沟通|继续沟通|继续聊|再次沟通)$/.test(cleanText(label || ""));
}

function isContinuationContactLabel(label) {
  return /^(继续沟通|继续聊|再次沟通)$/.test(cleanText(label || ""));
}

function handleManualJobContactClick(event) {
  if (!event.isTrusted || !isJobsPage() || !(event.target instanceof Element)) return false;
  const button = event.target.closest("a,button,[role='button']");
  if (!button || isInsideJobCopilot(button)) return false;
  const label = cleanText(button.innerText || button.textContent || "");
  if (!isContactActionLabel(label)) return false;
  const job = findJobForCommunicationButton(button);
  if (!job) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (isContinuationContactLabel(label)) {
      openExistingConversationInCompanion();
    } else {
      setStatus("无法确认当前沟通按钮对应的队列岗位，已阻止页面跳转；请重新扫描后再试。");
    }
    return true;
  }
  if (nativeAutomationContactKeys.has(job.key)) {
    // 原生自动点击也会经过捕获监听器；仅复用导航保护，确认结果仍由自动沟通流程负责。
    trustedManualContactEvents.add(event);
    if (typeof window === "undefined" || !window.navigation) event.preventDefault();
    return true;
  }
  if (manualContactInFlightKeys.has(job.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }
  // “继续沟通”只说明与该 HR 存在会话，不能跳过当前岗位。
  // 优先使用主世界导航保护保留原始点击；旧浏览器仅取消链接默认行为。
  if (typeof window === "undefined" || !window.navigation) event.preventDefault();
  // 保留用户原始可信事件供网站处理；合成 click 不能替代真实点击。
  trustedManualContactEvents.add(event);
  // 在网站的委托处理器执行前同步启用保护，拦截 SPA 与新标签导航但保留沟通事件。
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_START_EVENT, {
      detail: { durationMs: 13000 }
    }));
  }
  contactManuallyWithoutOwnerNavigation(job, {
    allowButtonLabel: !isContinuationContactLabel(label)
  });
  return true;
}

function containTrustedManualContactNavigation(event) {
  if (!trustedManualContactEvents.has(event)) return;
  trustedManualContactEvents.delete(event);
  // 网站委托处理器执行后再阻止链接默认导航；SPA 路由由捕获阶段启用的保护处理。
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (anchor && !event.defaultPrevented) event.preventDefault();
}

async function contactManuallyWithoutOwnerNavigation(job, evidenceOptions = {}) {
  manualContactInFlightKeys.add(job.key);
  setJobProgress(job, "contacting", "正在当前职位页确认手动沟通");
  setStatus(`正在确认手动沟通，职位列表保持不变：${job.title}`);
  renderList();
  try {
    const result = await observeManualCommunicationOnOwnerPage(job, evidenceOptions);
    if (result !== "confirmed") throw new Error(`当前页面未确认沟通成功：${result}`);
    if (dismissJob(job.key, { reason: "manual_contact" })) {
      logContactEvent("manual_contact_removed_from_queue", job);
    }
  } catch (error) {
    logContactEvent("manual_contact_failed", job);
    if (JC_STATE.jobs.some((item) => item.key === job.key)) {
      setJobProgress(job, "attention", "手动沟通结果未确认，岗位仍保留");
      renderList();
    }
    setStatus(`手动沟通未完成，岗位仍保留在队列：${job.title}。${friendlyContactError(error)}`);
  } finally {
    manualContactInFlightKeys.delete(job.key);
  }
}

async function observeManualCommunicationOnOwnerPage(job, evidenceOptions = {}) {
  const ownerJobsUrl = location.href;
  const stayWaiter = createStayOnCurrentPageWaiter(12000, job, evidenceOptions);
  document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_START_EVENT, {
    detail: { durationMs: 13000 }
  }));
  try {
    const result = await stayWaiter.promise;
    if (isBossChatUrl(location.href) || isBossJobDetailUrl(location.href)) {
      const restored = await restoreManualOwnerJobsRoute(ownerJobsUrl);
      if (!restored) return "owner_route_escape";
    }
    if (result === "stayed_confirmed" || result === "chat_route"
        || manualCommunicationConfirmed(job, evidenceOptions)) {
      return "confirmed";
    }
    return communicationBlockStatus() || result || "stay_missing";
  } finally {
    document.dispatchEvent(new CustomEvent(OWNER_NAVIGATION_GUARD_STOP_EVENT));
    stayWaiter.cancel();
  }
}

async function restoreManualOwnerJobsRoute(ownerJobsUrl) {
  if (!isBossChatUrl(location.href) && !isBossJobDetailUrl(location.href)) return true;
  history.back();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(100);
    if (!isBossChatUrl(location.href) && !isBossJobDetailUrl(location.href)) return true;
  }
  return location.href === ownerJobsUrl;
}

function manualCommunicationConfirmed(job, evidenceOptions = {}) {
  const button = findCommunicationButtonForJob(job);
  const label = cleanText(button?.innerText || button?.textContent || "");
  if (evidenceOptions.allowButtonLabel !== false
      && /^(继续沟通|继续聊|再次沟通|已沟通|发消息)$/.test(label)) {
    return true;
  }
  return hasSuccessfulContactEvidence(job, evidenceOptions);
}

function openExistingConversationInCompanion(job = null) {
  sendMessage({ type: "openManualChatTab" })
    .then((result) => {
      if (!result?.ok) throw new Error(result?.error || "无法打开消息标签");
      if (job && dismissJob(job.key, { reason: "manual_contact" })) {
        logContactEvent("manual_contact_removed_from_queue", job);
      }
    })
    .catch((error) => setStatus(`打开独立消息标签失败：${String(error.message || error)}`));
}

function openManualChatCompanion(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  sendMessage({ type: "openManualChatTab" })
    .then((result) => {
      if (!result?.ok) throw new Error(result?.error || "无法打开消息标签");
    })
    .catch((error) => setStatus(`打开消息标签失败：${String(error.message || error)}`));
}

function hardenManualChatLinks() {
  if (!isJobsPage()) {
    manualChatHitbox = null;
    document.getElementById("job-copilot-message-overlay")?.remove();
    return;
  }
  for (const anchor of document.links) {
    const label = normalizeManualChatLabel(anchor.innerText || anchor.textContent || "");
    const rect = anchor.getBoundingClientRect();
    if (label !== "消息" || rect.top < 0 || rect.top >= Math.min(180, window.innerHeight * 0.25)) continue;
    const hardened = anchor;
    hardened.dataset.jcManualChatLink = "true";
    hardened.setAttribute("href", `${location.pathname}${location.search}`);
    hardened.target = "_blank";
    hardened.rel = "noopener noreferrer";
    hardened.style.pointerEvents = "none";
    manualChatHitbox = {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom
    };
    if (hardened.dataset.jcManualChatBound !== CONTENT_SCRIPT_VERSION) {
      hardened.dataset.jcManualChatBound = CONTENT_SCRIPT_VERSION;
      hardened.addEventListener("click", handleManualChatClick, true);
    }
    positionManualChatOverlay(hardened);
    return;
  }
  document.getElementById("job-copilot-message-overlay")?.remove();
}

function positionManualChatOverlay(anchor) {
  let overlay = document.getElementById("job-copilot-message-overlay");
  if (!overlay) {
    overlay = document.createElement("a");
    overlay.id = "job-copilot-message-overlay";
    overlay.tabIndex = 0;
    overlay.href = "https://www.zhipin.com/web/geek/chat";
    overlay.target = "_blank";
    overlay.rel = "noopener noreferrer";
    overlay.title = "在独立标签打开消息";
    overlay.setAttribute("aria-label", "在独立标签打开消息");
    overlay.addEventListener("click", (event) => {
      // 阻止网站 SPA 路由接管，同时保留链接原生的新标签打开行为。
      event.stopImmediatePropagation();
    }, true);
    // 浮层放在网站带 transform 的容器之外，确保 fixed 定位使用视口坐标。
    document.documentElement.appendChild(overlay);
  }
  const rect = anchor.getBoundingClientRect();
  Object.assign(overlay.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    padding: "0",
    border: "0",
    background: "transparent",
    opacity: "0.01",
    cursor: "pointer",
    zIndex: "2147483646",
    textDecoration: "none"
  });
}

function isTrustedTopNavigationChatClick(event) {
  if (!event.isTrusted || (Number.isInteger(event.button) && event.button !== 0)
    || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor || anchor.closest("#job-copilot-panel, #job-copilot-launcher")) return false;
  if (anchor.dataset.jcManualChatLink !== "true") return false;
  const label = normalizeManualChatLabel(anchor.innerText || anchor.textContent || "");
  if (label !== "消息") return false;
  const rect = anchor.getBoundingClientRect();
  return rect.top >= 0 && rect.top < Math.min(180, window.innerHeight * 0.25);
}

function normalizeManualChatLabel(value) {
  // 移除“消息 1”“消息 99+”等未读角标后再归一化文本，避免漏掉聊天入口。
  return cleanText(String(value || "").replace(/[0-9０-９]+\+?/g, ""));
}

// 自动投递控制、空闲保护与职位页路由恢复。
async function controlAutomationTab(action) {
  const session = await getAutomationSession();
  if (!session?.tabId) return false;
  // 手动操作接管暂停状态，后续机器 active 事件不能撤销用户主动暂停。
  if (session.autoPausedByIdle) {
    await saveAutomationSession({
      ...session,
      autoPausedByIdle: false,
      updatedAt: Date.now()
    });
  }
  const sent = await sendAutomationControl(session.tabId, action, "manual");
  if (sent && ["pause", "resume"].includes(action)) {
    await appendAutomationLog({
      event: action === "pause" ? "automation_paused_manual" : "automation_resumed_manual",
      page: session.jobsUrl,
      detail: "source=remote_panel"
    }, session.tabId);
  }
  return sent;
}

function sendAutomationControl(tabId, action, reason) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "automationControl", action, reason }, () => {
      const error = consumeRuntimeLastError();
      resolve(!error);
    });
  });
}

async function handleMachineIdleState(state) {
  if (!["active", "idle", "locked"].includes(state)) return false;
  const session = await getAutomationSession();
  if (!session?.active || !session.tabId) return false;

  // idle 仅表示一段时间无键鼠输入，不能据此判定锁屏或休眠。
  if (state === "idle") return false;

  if (state === "active") {
    if (!session.autoPausedByIdle) return false;
    const resumed = await saveAutomationSession({
      ...session,
      paused: false,
      autoPausedByIdle: false,
      status: "电脑恢复使用，自动投递正在继续。",
      updatedAt: Date.now()
    });
    await sendAutomationControl(resumed.tabId, "resume", "machine_active");
    await appendAutomationLog({
      event: "automation_resumed_after_lock",
      page: resumed.jobsUrl,
      detail: "machine_state=active"
    }, resumed.tabId);
    return true;
  }

  // 仅自动恢复由空闲处理器暂停的任务，保留用户手动暂停。
  if (session.paused || session.autoPausedByIdle) return false;
  const paused = await saveAutomationSession({
    ...session,
    paused: true,
    autoPausedByIdle: true,
    status: "电脑已锁定，自动投递将在当前步骤结束后暂停。",
    updatedAt: Date.now()
  });
  await sendAutomationControl(paused.tabId, "pause", "machine_locked");
  await appendAutomationLog({
    event: "automation_paused_for_lock",
    page: paused.jobsUrl,
    detail: `machine_state=${state}`
  }, paused.tabId);
  return true;
}

async function handleAutomationTabNavigation(tabId, url) {
  const session = await getAutomationSession();
  const guard = await getJobsTabGuard(tabId);
  const ownsActiveSession = Boolean(session?.active && session.tabId === tabId && session.jobsUrl);
  if (!ownsActiveSession && !guard) return;
  if (isAutomationJobsUrl(url)) return;

  const enteredChat = isBossChatUrl(url);
  const enteredDetail = isBossJobDetailUrl(url);
  if (enteredChat || enteredDetail) {
    if (ownerRouteRecoveryTabIds.has(tabId)) return;
    ownerRouteRecoveryTabIds.add(tabId);
    if (ownsActiveSession) {
      const progress = { ...(session.progress || {}) };
      if (session.contactInFlight && session.currentJobKey) {
        progress[session.currentJobKey] = {
          status: "attention",
          detail: "职位标签异常进入消息/详情路由，已自动恢复并暂停",
          updatedAt: Date.now()
        };
      }
      await saveAutomationSession({
        ...session,
        active: true,
        paused: true,
        progress,
        contactInFlight: false,
        currentJobKey: "",
        status: enteredChat
          ? "职位标签误入消息页，已自动后退并暂停；消息页必须使用独立标签。"
          : "读取 JD 时职位标签误入详情页，已自动后退并暂停；请确认职位列表恢复后再继续。",
        updatedAt: Date.now()
      });
      await sendAutomationControl(tabId, "pause", enteredChat
        ? "owner_chat_route"
        : "owner_job_detail_route");
    }
    // 在稳定窗口内继续检查延迟路由；单次逃逸最多后退一次，避免越过原职位列表。
    try {
      const protectedJobsUrl = session?.jobsUrl || guard?.jobsUrl || "";
      const recovery = await stabilizeProtectedJobsRoute(tabId, protectedJobsUrl);
      await appendAutomationLog({
        event: enteredChat ? "owner_chat_route_restored" : "owner_job_detail_route_restored",
        page: url,
        detail: `restore=${recovery.historyBack ? "background_history.back" : "content_guard"};stable=${recovery.stable};final=${recovery.finalUrl};from=${protectedJobsUrl};automation=${ownsActiveSession ? "paused" : "inactive"}`
      }, tabId);
    } finally {
      ownerRouteRecoveryTabIds.delete(tabId);
    }
    return;
  }

  if (!ownsActiveSession) return;

  // 非当前沟通引起的导航是任务边界；不操作历史或重载，以免破坏筛选条件。
  const progress = { ...(session.progress || {}) };
  if (session.contactInFlight && session.currentJobKey) {
    progress[session.currentJobKey] = {
      status: "attention",
      detail: "BOSS 异常离开职位页，自动投递已暂停",
      updatedAt: Date.now()
    };
  }
  await saveAutomationSession({
    ...session,
    active: false,
    paused: true,
    progress,
    contactInFlight: false,
    currentJobKey: "",
    status: isBossChatUrl(url)
      ? "职位标签意外进入消息页，自动投递已暂停。"
      : "职位标签已离开职位页，自动投递已暂停；页面不会被自动刷新。",
    updatedAt: Date.now()
  });
  await setTabAutoDiscardable(tabId, true);
  await appendAutomationLog({
    event: "automation_tab_navigation_paused",
    page: url,
    detail: `restore=none;from=${session.jobsUrl};enteredChat=${isBossChatUrl(url)}`
  }, tabId);
}

async function stabilizeProtectedJobsRoute(tabId, protectedJobsUrl = "") {
  let historyBack = false;
  let historyBackAttempted = false;
  let finalUrl = "";
  let consecutiveJobsChecks = 0;
  for (const checkpointMs of OWNER_ROUTE_RECOVERY_CHECKPOINTS_MS) {
    await delay(checkpointMs);
    const currentTab = await getTab(tabId).catch(() => null);
    finalUrl = String(currentTab?.url || "");
    const escaped = isBossChatUrl(finalUrl) || isBossJobDetailUrl(finalUrl);
    if (escaped) {
      consecutiveJobsChecks = 0;
      if (!historyBackAttempted) {
        historyBackAttempted = true;
        historyBack = await goBackTab(tabId).then(() => true).catch(() => false);
      }
      continue;
    }
    if (isAutomationJobsUrl(finalUrl)) consecutiveJobsChecks += 1;
    else consecutiveJobsChecks = 0;
  }
  // 后退失败时保持暂停；重载保存的 URL 会丢失网站内存中的列表和筛选状态。
  return {
    historyBack,
    historyBackAttempted,
    finalUrl,
    stable: consecutiveJobsChecks >= 2 && isAutomationJobsUrl(finalUrl)
  };
}

function isBossChatUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.zhipin.com" && /\/web\/geek\/chat(?:[/?#]|$)/.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

function isBossJobDetailUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.zhipin.com" && /\/job_detail\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isAutomationJobsUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.zhipin.com") return false;
    // 只有列表与推荐路由能持有自动投递会话，进入详情页后必须暂停。
    return /\/web\/geek\/(?:jobs?|recommend)(?:[/?#]|$)/.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

// 浏览器原生点击与手动聊天页；超时后释放鼠标，避免留下按下状态。
async function dispatchTrustedContactClick(senderTab, payload) {
  if (!senderTab?.id || !isAutomationJobsUrl(senderTab.url || "")) {
    throw new Error("原生点击只能从 BOSS 职位页发起");
  }
  if (nativeContactTabIds.has(senderTab.id)) {
    throw new Error("当前职位页已有原生点击正在执行");
  }

  const pageUrl = new URL(String(payload?.pageUrl || ""));
  const senderUrl = new URL(String(senderTab.url || ""));
  if (pageUrl.origin !== senderUrl.origin
    || pageUrl.pathname !== senderUrl.pathname
    || pageUrl.search !== senderUrl.search) {
    throw new Error("职位页面已经变化，已拒绝过期点击");
  }
  if (!isBossJobDetailUrl(String(payload?.jobUrl || ""))) {
    throw new Error("原生点击缺少有效的 BOSS 岗位标识");
  }
  const jobKey = String(payload?.jobKey || "");
  if (!jobKey || jobKey.length > 240) throw new Error("原生点击岗位标识无效");

  const x = Number(payload?.x);
  const y = Number(payload?.y);
  const maxX = Number.isFinite(Number(senderTab.width)) ? Number(senderTab.width) : 10000;
  const maxY = Number.isFinite(Number(senderTab.height)) ? Number(senderTab.height) : 10000;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > maxX || y > maxY) {
    throw new Error("原生点击坐标超出当前标签页视口");
  }

  const debuggee = { tabId: senderTab.id };
  const pressState = { pressed: false };
  let attached = false;
  nativeContactTabIds.add(senderTab.id);
  try {
    // 通过 chrome.debugger 的 Input 域发送点击，完成后立即解除调试连接。
    // 适配依据：https://developer.chrome.com/docs/extensions/reference/api/debugger
    await withTimeout(debuggerAttach(debuggee), NATIVE_CLICK_TIMEOUT_MS,
      "原生点击超时：浏览器调试会话未能连接");
    attached = true;
    await withTimeout(dispatchClickSequence(debuggee, x, y, pressState), NATIVE_CLICK_TIMEOUT_MS,
      "原生点击超时：BOSS 页面长时间未响应点击");
    return { dispatched: true };
  } finally {
    try {
      if (attached) await releaseStuckMouseButton(debuggee, x, y, pressState);
    } finally {
      try {
        if (attached) await debuggerDetach(debuggee);
      } finally {
        nativeContactTabIds.delete(senderTab.id);
      }
    }
  }
}

async function dispatchClickSequence(debuggee, x, y, pressState) {
  await debuggerSendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, button: "none", buttons: 0
  });
  // 在 await 前标记按下：即使调用超时，渲染进程恢复后仍可能收到按下事件。
  pressState.pressed = true;
  await debuggerSendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1
  });
  await debuggerSendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1
  });
  pressState.pressed = false;
}

// 按下与松开之间发生超时时，补发松开事件，避免鼠标状态残留。
async function releaseStuckMouseButton(debuggee, x, y, pressState) {
  if (!pressState.pressed) return;
  try {
    await withTimeout(debuggerSendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1
    }), NATIVE_CLICK_RELEASE_TIMEOUT_MS, "原生点击超时：鼠标释放未确认");
  } catch (error) {
    // 松开失败不阻止清理；外层 finally 仍会解除调试连接。
  } finally {
    pressState.pressed = false;
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function openOrFocusManualChatTab(senderTab) {
  const session = await getAutomationSession();
  const ownsActiveSession = Boolean(session?.active && session.tabId === senderTab?.id);
  const isJobPage = isAutomationJobsUrl(senderTab?.url || "");
  if (!senderTab?.id || (!ownsActiveSession && !isJobPage)) {
    throw new Error("当前标签不是 BOSS 职位页");
  }
  await registerJobsTabGuard(senderTab);

  const chatTabs = await queryTabs({
    url: ["https://www.zhipin.com/web/geek/chat*"],
    windowId: senderTab.windowId
  });
  const existing = chatTabs.find((tab) => tab.id && tab.id !== senderTab.id);
  if (existing) {
    try {
      await updateTab(existing.id, { active: true });
      await focusWindow(existing.windowId);
      await appendAutomationLog({
        event: "manual_chat_tab_focused",
        page: existing.url || "https://www.zhipin.com/web/geek/chat"
      }, senderTab.id);
      return { tabId: existing.id, reused: true };
    } catch (error) {
      if (!isMissingTabError(error)) throw error;
      // 查询后标签可能已关闭，此时创建新的聊天页。
    }
  }

  // 直接创建聊天页，避免复制标签时 Edge 短暂激活副本，造成职位页被替换的错觉。
  const chatTab = await createTab({
    url: "https://www.zhipin.com/web/geek/chat",
    active: true,
    windowId: senderTab.windowId,
    index: Number.isInteger(senderTab.index) ? senderTab.index + 1 : undefined
  });
  if (!chatTab?.id) throw new Error("无法创建消息标签");
  await appendAutomationLog({
    event: "manual_chat_tab_opened",
    page: chatTab?.url || "https://www.zhipin.com/web/geek/chat"
  }, senderTab.id);
  return { tabId: chatTab.id, reused: false };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

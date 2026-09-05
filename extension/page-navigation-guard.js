// 主世界导航保护：让自动投递所属标签留在职位列表。
(() => {
  const START_EVENT = "job-copilot-owner-navigation-guard-start";
  const STOP_EVENT = "job-copilot-owner-navigation-guard-stop";
  const BLOCKED_EVENT = "job-copilot-owner-navigation-blocked";
  let guardUntil = 0;
  let persistentGuard = false;

  const shouldBlock = (value) => {
    if ((!persistentGuard && Date.now() >= guardUntil) || value === undefined || value === null) return false;
    try {
      const url = new URL(String(value), location.href);
      return url.hostname === "www.zhipin.com"
        && (/\/job_detail\//.test(url.pathname) || /\/web\/geek\/chat/.test(url.pathname));
    } catch {
      return /\/job_detail\/|\/web\/geek\/chat/.test(String(value));
    }
  };

  const wrapHistoryMethod = (name) => {
    const original = history[name].bind(history);
    history[name] = function guardedHistoryWrite(state, title, url) {
      if (shouldBlock(url)) {
        document.dispatchEvent(new CustomEvent(BLOCKED_EVENT, {
          detail: { method: name, url: String(url) }
        }));
        return undefined;
      }
      return original(state, title, url);
    };
  };

  wrapHistoryMethod("pushState");
  wrapHistoryMethod("replaceState");
  const originalWindowOpen = window.open.bind(window);
  window.open = function guardedWindowOpen(url, ...args) {
    if (shouldBlock(url)) {
      document.dispatchEvent(new CustomEvent(BLOCKED_EVENT, {
        detail: { method: "window.open", url: String(url) }
      }));
      return null;
    }
    return originalWindowOpen(url, ...args);
  };
  // 通过 Navigation API 取消离开职位页的导航，避免依赖重载来恢复现场。
  // 适配依据：https://developer.chrome.com/docs/web-platform/navigation-api
  window.navigation?.addEventListener("navigate", (event) => {
    const destinationUrl = event.destination?.url;
    if (!shouldBlock(destinationUrl) || event.navigationType === "traverse" || !event.cancelable) return;
    event.preventDefault();
    document.dispatchEvent(new CustomEvent(BLOCKED_EVENT, {
      detail: { method: "navigation.preventDefault", url: String(destinationUrl) }
    }));
  });
  document.addEventListener(START_EVENT, (event) => {
    if (event.detail?.persistent === true) persistentGuard = true;
    // 保护上限需覆盖原生点击与后续确认窗口，避免点击尚未结束时放行聊天跳转。
    const durationMs = Math.max(1000, Math.min(45000, Number(event.detail?.durationMs) || 12000));
    guardUntil = Date.now() + durationMs;
  });
  document.addEventListener(STOP_EVENT, () => {
    guardUntil = 0;
    // 持久保护贯穿职位文档生命周期；STOP 仅结束单次操作保护。
  });
})();

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
  document.addEventListener(START_EVENT, (event) => {
    if (event.detail?.persistent === true) persistentGuard = true;
    const durationMs = Math.max(1000, Math.min(20000, Number(event.detail?.durationMs) || 12000));
    guardUntil = Date.now() + durationMs;
  });
  document.addEventListener(STOP_EVENT, () => {
    guardUntil = 0;
    // A protected jobs document keeps its navigation boundary for its entire
    // lifetime. STOP only ends a short operation-specific guard; otherwise a
    // delayed BOSS router task can take the owner tab to chat much later.
  });
})();

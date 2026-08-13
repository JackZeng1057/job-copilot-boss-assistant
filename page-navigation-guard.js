// Main-world route guard: keeps the automation owner tab on the BOSS jobs page.
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
  // The Navigation API fires for link, Location, History and browser-initiated
  // navigations. Cancelling here prevents the jobs document from unloading,
  // so recovery never needs to refresh the saved jobs URL.
  // Source: https://developer.chrome.com/docs/web-platform/navigation-api
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

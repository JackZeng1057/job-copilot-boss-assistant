const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", `file://${__dirname}/`), "utf8"));
assert.ok(manifest.permissions.includes("debugger"),
  "browser-native contact requires the explicit debugger permission");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");
const listenerStart = source.indexOf("chrome.runtime.onMessage.addListener");
const listenerEnd = source.indexOf("if (chrome.tabs?.onUpdated)", listenerStart);
const listener = source.slice(listenerStart, listenerEnd);
assert.match(listener, /message\?\.type === ["']dispatchTrustedContactClick["']/,
  "the service worker must expose one narrowly scoped native-contact message");

const start = source.indexOf("async function dispatchTrustedContactClick(senderTab, payload)");
const end = source.indexOf("async function openOrFocusManualChatTab", start);
assert.ok(start >= 0 && end > start, "the native contact executor must exist");

const attachStart = source.indexOf("function debuggerAttach(target)");
const attachEnd = source.indexOf("function debuggerSendCommand", attachStart);
assert.ok(attachStart >= 0 && attachEnd > attachStart, "the debugger attach wrapper must exist");
let requestedProtocolVersion = "";
const attachSandbox = {
  chrome: {
    debugger: {
      attach(_target, protocolVersion, callback) {
        requestedProtocolVersion = protocolVersion;
        callback();
      }
    }
  },
  consumeRuntimeLastError: () => null,
  Promise,
  Error
};
vm.runInNewContext(`${source.slice(attachStart, attachEnd)}\nthis.debuggerAttach = debuggerAttach;`, attachSandbox);

const calls = [];
let failRelease = false;
let failDetach = false;
let hangInput = false;
const sandbox = {
  // Shortened so the timeout path is exercised without a real 20s wait.
  NATIVE_CLICK_TIMEOUT_MS: 120,
  NATIVE_CLICK_RELEASE_TIMEOUT_MS: 60,
  setTimeout,
  clearTimeout,
  nativeContactTabIds: new Set(),
  isAutomationJobsUrl: (url) => /^https:\/\/www\.zhipin\.com\/web\/geek\/jobs/.test(url),
  isBossJobDetailUrl: (url) => /^https:\/\/www\.zhipin\.com\/job_detail\//.test(url),
  debuggerAttach: async (target) => calls.push(["attach", target.tabId]),
  debuggerSendCommand: async (_target, method, params) => {
    calls.push([method, params.type]);
    if (hangInput && params.type === "mousePressed") await new Promise(() => {});
    if (failRelease && params.type === "mouseReleased") throw new Error("release failed");
  },
  debuggerDetach: async (target) => {
    calls.push(["detach", target.tabId]);
    if (failDetach) throw new Error("detach failed");
  },
  URL,
  Number,
  String,
  Error,
  Math,
  Promise
};

vm.runInNewContext(`${source.slice(start, end)}\nthis.dispatchTrustedContactClick = dispatchTrustedContactClick;`, sandbox);

const senderTab = {
  id: 7,
  url: "https://www.zhipin.com/web/geek/jobs?query=ai",
  width: 1440,
  height: 900
};
const payload = {
  x: 900,
  y: 520,
  pageUrl: senderTab.url,
  jobKey: "job:abc",
  jobUrl: "https://www.zhipin.com/job_detail/abc.html"
};

(async () => {
  await attachSandbox.debuggerAttach({ tabId: 7 });
  assert.equal(requestedProtocolVersion, "1.3",
    "Chrome's extension debugger transport must request CDP protocol version 1.3");

  const result = await sandbox.dispatchTrustedContactClick(senderTab, payload);
  assert.equal(result.dispatched, true);
  assert.deepEqual(calls.map((entry) => entry[0]), [
    "attach",
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "detach"
  ]);
  assert.deepEqual(calls.slice(1, 4).map((entry) => entry[1]), [
    "mouseMoved", "mousePressed", "mouseReleased"
  ], "exactly one press/release sequence may be sent");
  assert.equal(sandbox.nativeContactTabIds.size, 0, "the per-tab lock must always be released");

  await assert.rejects(
    sandbox.dispatchTrustedContactClick({ ...senderTab, url: "https://example.com/" }, payload),
    /BOSS 职位页|jobs page/
  );
  await assert.rejects(
    sandbox.dispatchTrustedContactClick(senderTab, { ...payload, x: 9999 }),
    /坐标|coordinate/
  );
  await assert.rejects(
    sandbox.dispatchTrustedContactClick(senderTab, { ...payload, pageUrl: `${senderTab.url}&stale=1` }),
    /页面|stale/
  );

  // A blocked BOSS main thread once kept Input.dispatchMouseEvent pending for
  // 95 seconds. The dispatch must give up, release the held button and detach.
  calls.length = 0;
  hangInput = true;
  await assert.rejects(sandbox.dispatchTrustedContactClick(senderTab, payload), /原生点击超时/,
    "an unacknowledged input command must time out instead of hanging the contact flow");
  assert.deepEqual(calls.at(-1), ["detach", 7],
    "a timed-out click must still detach the debugger session");
  assert.deepEqual(calls.at(-2), ["Input.dispatchMouseEvent", "mouseReleased"],
    "a click that timed out while held down must release the mouse button before detaching");
  assert.equal(sandbox.nativeContactTabIds.size, 0,
    "the per-tab lock must be released after a timeout");
  hangInput = false;

  calls.length = 0;
  failRelease = true;
  await assert.rejects(sandbox.dispatchTrustedContactClick(senderTab, payload), /release failed/);
  assert.deepEqual(calls.at(-1), ["detach", 7], "debugger must detach after an input failure");
  assert.equal(sandbox.nativeContactTabIds.size, 0);

  calls.length = 0;
  failRelease = false;
  failDetach = true;
  await assert.rejects(sandbox.dispatchTrustedContactClick(senderTab, payload), /detach failed/);
  assert.equal(sandbox.nativeContactTabIds.size, 0,
    "the per-tab lock must be released even when Chrome reports a detach failure");

  console.log("Browser-native contact executor tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");

assert.match(source, /const nativeAutomationContactKeys = new Set\(\)/,
  "trusted automation clicks need a separate ownership marker from real manual clicks");

const manualStart = source.indexOf("function handleManualJobContactClick(event)");
const manualEnd = source.indexOf("function containTrustedManualContactNavigation", manualStart);
const manualHandler = source.slice(manualStart, manualEnd);
assert.match(manualHandler,
  /nativeAutomationContactKeys\.has\(job\.key\)[\s\S]*trustedManualContactEvents\.add\(event\)[\s\S]*return true/,
  "the trusted automation event must reuse navigation containment without starting a second contact controller");

const ownerStart = source.indexOf("async function communicateOnOwnerPage(job");
const ownerEnd = source.indexOf("async function performIsolatedCommunication", ownerStart);
const ownerContact = source.slice(ownerStart, ownerEnd);
assert.match(ownerContact, /dispatchNativeContactClick\(job, button\)/,
  "owner-page communication must use the browser-native click executor");
assert.doesNotMatch(ownerContact, /node\.click\(\)|button\.click\(\)|clickOnOwnerPage\(button\)/,
  "the new contact path must never fall back to an untrusted DOM click");

const dispatchStart = source.indexOf("async function dispatchNativeContactClick(job, button)");
const dispatchEnd = source.indexOf("async function performIsolatedCommunication", dispatchStart);
const dispatcher = source.slice(dispatchStart, dispatchEnd);
assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart, "the content-side click boundary must exist");
assert.match(dispatcher, /elementFromPoint/,
  "the click point must still be owned by the exact communication control");
assert.match(dispatcher, /temporarilyDisableJobCopilotPointerEvents/,
  "the extension's own floating UI must not obstruct its native contact click");
assert.match(dispatcher, /type:\s*["']dispatchTrustedContactClick["']/,
  "only validated coordinates may cross into the elevated service worker");
assert.match(dispatcher, /nativeAutomationContactKeys\.add[\s\S]*finally[\s\S]*nativeAutomationContactKeys\.delete/,
  "the automation ownership marker must be cleared on every outcome");

const runtimeStart = source.indexOf("async function dispatchNativeContactClick(job, button)");
const runtimeEnd = source.indexOf("async function performIsolatedCommunication", runtimeStart);
const panel = {
  style: {
    values: new Map([["pointer-events", "auto"]]),
    priorities: new Map(),
    getPropertyValue(key) { return this.values.get(key) || ""; },
    getPropertyPriority(key) { return this.priorities.get(key) || ""; },
    setProperty(key, value, priority = "") {
      this.values.set(key, value);
      this.priorities.set(key, priority);
    },
    removeProperty(key) {
      this.values.delete(key);
      this.priorities.delete(key);
    }
  }
};
const button = {
  isConnected: true,
  getBoundingClientRect: () => ({ left: 700, top: 300, width: 100, height: 40 }),
  contains: () => false
};
const externalOverlay = {};
let hitTarget = button;
const messages = [];
const runtimeSandbox = {
  document: {
    getElementById(id) { return id === "job-copilot-panel" ? panel : null; },
    elementFromPoint() {
      return panel.style.getPropertyValue("pointer-events") === "none" ? hitTarget : panel;
    }
  },
  window: { innerWidth: 1200, innerHeight: 800 },
  location: { href: "https://www.zhipin.com/web/geek/jobs?query=frontend" },
  nativeAutomationContactKeys: new Set(),
  isElementVisible: () => true,
  communicationButtonMatchesJob: () => true,
  sleep: async () => {},
  sendMessage: async (message) => {
    messages.push(message);
    return { ok: true, dispatched: true };
  },
  Error,
  Map,
  Set
};
vm.runInNewContext(
  `${source.slice(runtimeStart, runtimeEnd)}\nthis.dispatchNativeContactClick = dispatchNativeContactClick;`,
  runtimeSandbox
);

(async () => {
  const job = {
    key: "job:frontend",
    url: "https://www.zhipin.com/job_detail/frontend.html"
  };
  await runtimeSandbox.dispatchNativeContactClick(job, button);
  assert.equal(messages.length, 1,
    "a visible BOSS button underneath the Job Copilot panel must still receive the native click");
  assert.equal(panel.style.getPropertyValue("pointer-events"), "auto",
    "the panel's original pointer behavior must be restored after dispatch");
  assert.equal(runtimeSandbox.nativeAutomationContactKeys.size, 0,
    "the contact ownership marker must be cleared after dispatch");

  hitTarget = externalOverlay;
  await assert.rejects(
    runtimeSandbox.dispatchNativeContactClick(job, button),
    /BOSS 页面其他元素遮挡/,
    "a real host-page overlay must continue to block native automation"
  );
  assert.equal(messages.length, 1, "an obstructed host button must never be clicked");
  assert.equal(panel.style.getPropertyValue("pointer-events"), "auto");

  console.log("Content browser-native contact boundary tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

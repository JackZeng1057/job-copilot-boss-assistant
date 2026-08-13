const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = ["../content-job-scan.js", "../content-panel-layout.js", "../content.js"]
  .map((file) => fs.readFileSync(new URL(file, `file://${__dirname}/`), "utf8"))
  .join("\n");
assert.match(source, /document\.addEventListener\("click", handleManualJobContactClick, true\)/,
  "manual contact detection must run before BOSS SPA navigation handlers");

const handlerStart = source.indexOf("function handleManualJobContactClick(event)");
const contactStart = source.indexOf("function containTrustedManualContactNavigation", handlerStart);
const contactEnd = source.indexOf("function openManualChatCompanion", contactStart);
assert.ok(handlerStart >= 0 && contactStart > handlerStart && contactEnd > contactStart);
const handlerSource = source.slice(handlerStart, contactStart);
const contactSource = source.slice(contactStart, contactEnd);
const containEnd = source.indexOf("async function contactManuallyWithoutOwnerNavigation", contactStart);
const containmentSource = source.slice(contactStart, containEnd);

assert.match(handlerSource, /findJobForCommunicationButton\(button\)/,
  "the visible detail must resolve one exact queue job before removal");
assert.doesNotMatch(handlerSource,
  /progressFor\(job\)\.status === ["']contacting["'][\s\S]*dismissJob/,
  "contacting is never proof of communication success");
assert.doesNotMatch(contactSource, /communicateInIsolatedTab/,
  "a trusted manual click must not open a disposable job-detail tab");
assert.match(contactSource, /trustedManualContactEvents\.has\(event\)[\s\S]*event\.preventDefault\(\)/,
  "native anchor navigation must be cancelled only after BOSS receives the trusted click");
assert.match(contactSource, /observeManualCommunicationOnOwnerPage\(job\)/,
  "manual contact must observe the original trusted BOSS click instead of replaying it");
assert.doesNotMatch(contactSource, /node\.click\(\)|button\.click\(\)/,
  "manual contact must never replace a trusted user event with a synthetic click");
assert.match(contactSource, /result !== ["']confirmed["'][\s\S]*throw[\s\S]*dismissJob/,
  "the exact job may leave the queue only after positive confirmation");
const identityStart = source.indexOf("function communicationButtonMatchesJob(button, job)");
const identityEnd = source.indexOf("function findJobDetailScope", identityStart);
const identitySource = source.slice(identityStart, identityEnd);
assert.match(identitySource, /bossJobIdForCommunicationButton/,
  "manual contact should prefer the exact BOSS job id from the visible detail");
assert.doesNotMatch(identitySource, /companyMatched|return\s+titleMatched\s*\|\|/,
  "a shared company name must never select another queue job");

class FakeElement {
  constructor(label) { this.innerText = label; this.textContent = label; }
  closest(selector) {
    return ["a,button,[role='button']", "a[href]"].includes(selector) ? this : null;
  }
}

const job = { key: "job:manual", title: "人工沟通岗位", index: 4 };
const directCalls = [];
let mappedJob = job;
let latestStatus = "";
let prevented = 0;
let stopped = 0;
const sandbox = {
  Element: FakeElement,
  isJobsPage: () => true,
  isInsideJobCopilot: () => false,
  cleanText: (value) => String(value || "").trim(),
  findJobForCommunicationButton: () => mappedJob,
  manualContactInFlightKeys: new Set(),
  nativeAutomationContactKeys: new Set(),
  trustedManualContactEvents: new WeakSet(),
  contactManuallyWithoutOwnerNavigation(value) { directCalls.push({ value }); },
  openExistingConversationInCompanion() {},
  setStatus(value) { latestStatus = value; }
};

vm.runInNewContext(
  `${handlerSource}\n${containmentSource}\n` +
  `this.handleManualJobContactClick = handleManualJobContactClick;\n` +
  `this.containTrustedManualContactNavigation = containTrustedManualContactNavigation;`,
  sandbox
);
const manualButton = new FakeElement("立即沟通");
const event = {
  isTrusted: true,
  target: manualButton,
  get defaultPrevented() { return prevented > 0; },
  preventDefault() { prevented += 1; },
  stopImmediatePropagation() { stopped += 1; }
};

assert.equal(sandbox.handleManualJobContactClick(event), true);
assert.equal(prevented, 1,
  "the trusted click must cancel native navigation during capture before BOSS can route the jobs tab");
assert.equal(stopped, 0, "the real immediate-contact click must keep propagating");
assert.equal(directCalls.length, 1);
assert.equal(directCalls[0].value.key, job.key);
sandbox.containTrustedManualContactNavigation(event);
assert.equal(prevented, 1,
  "the document bubble cleanup must not be the first navigation boundary");
assert.equal(stopped, 0);

const modernEvent = {
  isTrusted: true,
  target: manualButton,
  defaultPrevented: false,
  preventDefault() { throw new Error("modern Chromium must leave the trusted click unchanged"); },
  stopImmediatePropagation() { throw new Error("trusted click propagation must not stop"); }
};
sandbox.window = { navigation: {} };
assert.equal(sandbox.handleManualJobContactClick(modernEvent), true);
assert.equal(directCalls.length, 2,
  "the Navigation API path must still hand the original trusted click to BOSS");

mappedJob = null;
assert.equal(sandbox.handleManualJobContactClick(event), true,
  "an unmapped communication control must still be contained on the jobs page");
assert.equal(prevented, 2);
assert.equal(stopped, 1);
assert.equal(directCalls.length, 2, "an ambiguous job must never remove or contact another queue item");
assert.match(latestStatus, /无法确认.*岗位|未识别.*岗位/);

console.log("Manual contact queue identity tests passed");

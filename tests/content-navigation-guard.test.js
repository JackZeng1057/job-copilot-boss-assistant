const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");

const selector = source.slice(
  source.indexOf("async function selectJobDetail"),
  source.indexOf("function findJobCardActivationTargets")
);
assert.match(selector, /clickWithoutOwnerNavigation\(target\)/,
  "job selection must suppress link navigation in the owner jobs tab");
assert.doesNotMatch(selector, /safeClick\(target\)/,
  "job selection must never use an unrestricted click on a detail link");

const activationTargets = source.slice(
  source.indexOf("function findJobCardActivationTargets"),
  source.indexOf("function detailMatchesJob")
);
assert.doesNotMatch(activationTargets, /a\[href\*=['\"]\/job_detail\//,
  "the owner tab must not use a job-detail link as a fallback activation target");
const helperStart = source.indexOf("function clickWithinDisposableTab(node)");
const helperEnd = source.indexOf("function isElementVisible(node)", helperStart);
const helperSource = source.slice(helperStart, helperEnd);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "disposable-tab click helper must exist");
assert.match(helperSource, /setAttribute\(["']target["'],\s*["']_self["']\)/,
  "link navigation must be contained in the inactive worker tab");
assert.match(helperSource, /setAttribute\(["']rel["'],\s*["']noopener noreferrer["']\)/,
  "the worker click must not expose an opener");
assert.equal((helperSource.match(/node\.click\(\)/g) || []).length, 1,
  "the worker helper must issue exactly one native click");
const originalContact = source.slice(
  source.indexOf("async function clickCommunicateForJob(job)"),
  source.indexOf("async function performIsolatedCommunication", source.indexOf("async function clickCommunicateForJob(job)"))
);
assert.match(originalContact, /findCommunicationButtonForJob\(job\)/,
  "the current job detail must provide the communication control");
assert.match(originalContact, /communicateInIsolatedTab/,
  "automatic communication must delegate navigation-capable work to a disposable tab");
assert.doesNotMatch(originalContact, /clickWithoutNavigation\(button\)|dispatchCommunicationRetryClick/,
  "the jobs tab must never click a communication control or retry a click");
const manualChatHandler = source.slice(
  source.indexOf("function installManualChatTabHandler"),
  source.indexOf("function isTrustedTopNavigationChatClick", source.indexOf("function installManualChatTabHandler"))
);
assert.match(manualChatHandler, /type:\s*["']openManualChatTab["']/,
  "manual chat navigation must be delegated to the background tab API");
assert.doesNotMatch(manualChatHandler, /window\.open/,
  "manual chat must never let the page choose or reuse the jobs browsing context");
assert.match(source, /function hardenManualChatLinks[\s\S]*target\s*=\s*["']_blank["']/,
  "top-level chat links need a new-tab fallback even when click interception is bypassed");
assert.match(source, /function hardenManualChatLinks[\s\S]*noopener noreferrer/,
  "fallback chat tabs must not receive a jobs-page opener");
assert.match(source, /function hardenManualChatLinks[\s\S]*setAttribute\(["']href["'],\s*`\$\{location\.pathname\}\$\{location\.search\}`\)/,
  "the BOSS chat URL must be removed from the jobs page before a click can navigate it");
assert.match(source, /function hardenManualChatLinks[\s\S]*pointerEvents\s*=\s*["']none["']/,
  "the original BOSS chat node must never receive pointer input");
assert.match(source, /function normalizeManualChatLabel[\s\S]*\[0-9０-９\]/,
  "unread counts must not disable top-message interception");
assert.match(source, /document\.documentElement\.appendChild\(overlay\)/,
  "the message overlay must use viewport coordinates outside transformed BOSS containers");
assert.match(source, /function positionManualChatOverlay[\s\S]*createElement\(["']a["']\)[\s\S]*web\/geek\/chat[\s\S]*target\s*=\s*["']_blank["']/,
  "an extension-owned native link must keep clicks outside the BOSS React route handler");
assert.match(source, /job-copilot-message-overlay[\s\S]*stopImmediatePropagation\(\)/,
  "the native overlay must stop BOSS's SPA click handler without preventing its own default action");
assert.match(source, /addEventListener\(["']pointerdown["'],\s*handleManualChatHitboxEvent,\s*true\)/,
  "the message hitbox must intercept pointer input before the BOSS route handler");
assert.doesNotMatch(source, /clickWithoutJavascriptUrl/);
console.log("Current-page content navigation regression test passed");

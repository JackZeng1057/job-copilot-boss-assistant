const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");

const selector = source.slice(
  source.indexOf("async function selectJobDetail"),
  source.indexOf("function findJobCardActivationTargets")
);
assert.match(selector, /await clickWithoutOwnerNavigation\(target, ownerJobsUrl\)/,
  "job selection must suppress link navigation in the owner jobs tab");
assert.match(selector, /restoreOwnerJobsRoute\(ownerJobsUrl\)/,
  "job selection must detect a delayed BOSS SPA route escape while waiting for the detail pane");
assert.match(selector, /OWNER_NAVIGATION_GUARD_START_EVENT[\s\S]*try\s*\{[\s\S]*finally[\s\S]*OWNER_NAVIGATION_GUARD_STOP_EVENT/,
  "job selection must keep the main-world SPA route lock active for the entire simulated card click");
assert.doesNotMatch(selector, /safeClick\(target\)/,
  "job selection must never use an unrestricted click on a detail link");
assert.match(source,
  /if \(JC_STATE\.pipeline\.ownerRouteEscaped\)[\s\S]*reason: "owner_route_escape"/,
  "the analysis loop must preserve the route-escape warning instead of overwriting it as a normal pause");

const activationTargets = source.slice(
  source.indexOf("function findJobCardActivationTargets"),
  source.indexOf("function detailMatchesJob")
);
assert.doesNotMatch(activationTargets, /a\[href\*=['\"]\/job_detail\//,
  "the owner tab must not use a job-detail link as a fallback activation target");
// safeClick is now the only helper that issues a DOM click, and it exists only
// for BOSS's own dialog controls (the "留在此页" button) — never for the
// communication button, which goes through the browser-native click path.
const safeClickStart = source.indexOf("function safeClick(node)");
const safeClickEnd = source.indexOf("function isElementVisible(node)", safeClickStart);
const safeClickSource = source.slice(safeClickStart, safeClickEnd);
assert.ok(safeClickStart >= 0 && safeClickEnd > safeClickStart, "dialog click helper must exist");
assert.match(safeClickSource, /preventJavascriptUrlDefaultOnce\(node\)/,
  "a javascript: control must not trigger its CSP-violating default action");
assert.equal((safeClickSource.match(/node\.click\(\)/g) || []).length, 1,
  "the dialog helper must issue exactly one native click");
const originalContact = source.slice(
  source.indexOf("async function clickCommunicateForJob(job)"),
  source.indexOf("function communicationBlockStatus", source.indexOf("async function clickCommunicateForJob(job)"))
);
assert.match(originalContact, /findCommunicationButtonForJob\(job\)/,
  "the current job detail must provide the communication control");
assert.match(originalContact, /communicateOnOwnerPage\(job/,
  "automatic communication must run on the visible owner jobs page");
assert.doesNotMatch(originalContact, /communicateInIsolatedTab/,
  "automatic communication must not create a separate detail tab");
assert.match(originalContact, /createStayOnCurrentPageWaiter/,
  "the jobs tab must wait for the native BOSS confirmation dialog");
assert.match(source, /nativeAutomationContactKeys\.has\(job\.key\)[\s\S]*trustedManualContactEvents\.add\(event\)/,
  "native communication clicks must reuse the trusted-event navigation boundary");
assert.doesNotMatch(originalContact, /communicateInHiddenFrame|communicateInIsolatedTab/,
  "the jobs tab must not delegate communication to a detail tab");
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
assert.match(source, /type:\s*["']protectJobsTab["']/,
  "every jobs-page runtime must register a persistent owner-tab navigation guard");
assert.match(source, /function registerJobsTabProtection\(\)[\s\S]*persistent:\s*true[\s\S]*protectJobsTab/,
  "the jobs document must arm the main-world route guard for its full lifetime");
assert.doesNotMatch(source, /clickWithoutJavascriptUrl/);
console.log("Current-page content navigation regression test passed");

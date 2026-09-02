const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "content.js"), "utf8");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
const guard = fs.readFileSync(path.join(root, "page-navigation-guard.js"), "utf8");

const ownerStart = source.indexOf("async function communicateOnOwnerPage(job");
const ownerEnd = source.indexOf("async function dispatchNativeContactClick", ownerStart);
const owner = source.slice(ownerStart, ownerEnd);
assert.ok(ownerStart >= 0 && ownerEnd > ownerStart, "owner-page communication must exist");

// The confirmation window must measure BOSS's response, not the click's own
// delivery: a 95s native click once consumed the whole 15s budget, so the job
// was recorded as "BOSS 未返回明确确认" without BOSS ever being asked in time.
const dispatchIndex = owner.indexOf("await dispatchNativeContactClick(job, button)");
const waiterIndex = owner.indexOf("createStayOnCurrentPageWaiter(");
assert.ok(dispatchIndex >= 0 && waiterIndex >= 0, "both the click and its waiter must exist");
assert.ok(waiterIndex > dispatchIndex,
  "the confirmation window must start after the click is dispatched, never before it");
assert.match(owner, /durationMs: NATIVE_CLICK_TIMEOUT_MS \+ CONTACT_CONFIRMATION_TIMEOUT_MS/,
  "the navigation guard must outlast the click itself, not just the confirmation window");
assert.match(owner, /recordContactDispatchDuration\(Date\.now\(\) - dispatchStartedAt\)/,
  "the click's own duration must be measured so a slow dispatch is visible in the log");
assert.match(owner, /waiter\?\.cancel\(\)/,
  "a click that threw before the waiter existed must not crash the cleanup");
assert.match(source, /dispatchMs=\$\{Number\(report\.dispatchMs \|\| 0\)\}/,
  "the timing log must report how long the native click took");

// chrome.debugger input commands resolve only on renderer acknowledgement.
assert.match(background, /const NATIVE_CLICK_TIMEOUT_MS = \d+/,
  "the service worker must bound a native click");
assert.match(background, /withTimeout\(debuggerAttach\(debuggee\), NATIVE_CLICK_TIMEOUT_MS/,
  "attaching the debugger must be bounded");
assert.match(background, /withTimeout\(dispatchClickSequence\(debuggee, x, y, pressState\), NATIVE_CLICK_TIMEOUT_MS/,
  "the click sequence must be bounded");
assert.match(background, /pressState\.pressed = true;\s*await debuggerSendCommand\(debuggee, "Input\.dispatchMouseEvent", \{\s*type: "mousePressed"/,
  "a press that times out may still land later, so it must count as held down before the await");
assert.match(background, /releaseStuckMouseButton\(debuggee, x, y, pressState\)[\s\S]*debuggerDetach\(debuggee\)/,
  "a held button must be released before the session is detached");

assert.match(guard, /Math\.min\(45000,/,
  "the guard ceiling must cover a bounded native click plus its confirmation window");

// A click the browser never delivered says nothing about the job.
const busyStart = source.indexOf("async function handleBusyPageContact(job, context)");
const busyEnd = source.indexOf("async function handleThrottledContact(job)", busyStart);
const busy = source.slice(busyStart, busyEnd);
assert.ok(busyStart >= 0 && busyEnd > busyStart, "an undelivered click must have its own outcome");
assert.match(source, /NATIVE_CLICK_TIMEOUT_PATTERN\.test\(String\(error\?\.message \|\| error\)\)[\s\S]{0,80}handleBusyPageContact\(job, context\)/,
  "a native-click timeout must be routed away from the generic contact failure");
assert.match(busy, /attempts > MAX_BUSY_PAGE_CONTACT_RETRIES/,
  "the retry must be capped so a permanently wedged page cannot loop forever");
assert.match(busy, /setJobProgress\(job, "qualified"[\s\S]*retryContactJobKey = job\.key/,
  "the first undelivered click must keep the job queued for a retry");
assert.match(busy, /setJobProgress\(job, "attention", detail\)[\s\S]*completeJob\(job\)/,
  "only after the retry may the job be handed over for manual review");
assert.match(source, /JC_STATE\.busyPageContactRetries\.delete\(job\.key\)/,
  "a successful contact must clear the job's retry counter");
assert.match(source, /for \(const key of JC_STATE\.busyPageContactRetries\.keys\(\)\)/,
  "the retry counters must be pruned with the rest of the per-job state");

console.log("Contact confirmation window regression tests passed");

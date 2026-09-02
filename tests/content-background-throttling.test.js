const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

// Chromium throttles a hidden tab's timers to once per second, then once per
// minute. Attempt-count loops must therefore notice when their ticks stop
// mapping to real seconds instead of blaming BOSS for the resulting silence.
assert.match(source, /async function contactSleep\(ms\)[\s\S]*elapsed >= Math\.max\(THROTTLED_TICK_MIN_MS, ms \* THROTTLED_TICK_RATIO\)[\s\S]*throttled = true/,
  "a tick far longer than requested must mark the attempt as throttled");

const selectStart = source.indexOf("async function selectJobDetail(job)");
const selectEnd = source.indexOf("function findJobCardActivationTargets", selectStart);
const selectBlock = source.slice(selectStart, selectEnd);
assert.ok(selectStart >= 0 && selectEnd > selectStart, "the detail selector must exist");
assert.match(selectBlock, /await contactSleep\(100\)/,
  "the detail-match retry loop must measure its own ticks");
assert.doesNotMatch(selectBlock, /await sleep\(/,
  "no untracked sleep may remain in the detail-match retry loop");
assert.match(selectBlock, /if \(contactTabThrottled\(\)\) return false;/,
  "a throttled detail-match loop must stop instead of spending a minute per attempt");

const dispatchStart = source.indexOf("async function dispatchNativeContactClick(job, button)");
const dispatchEnd = source.indexOf("function communicationBlockStatus", dispatchStart);
const dispatchBlock = source.slice(dispatchStart, dispatchEnd);
assert.match(dispatchBlock, /await contactSleep\(50\)/,
  "the native-click preflight must measure its own ticks");
assert.match(dispatchBlock, /throw new Error\(contactTabThrottled\(\) \? THROTTLED_CONTACT_ERROR : preflightError\)/,
  "a throttled preflight must report throttling rather than a fabricated overlay reason");

const runStart = source.indexOf("async function runCommunicateForJob(job, tracker)");
const runEnd = source.indexOf("async function communicateOnOwnerPage(", runStart);
const runBlock = source.slice(runStart, runEnd);
assert.match(runBlock, /return tracker\.throttled \? ["']tab_throttled["'] : ["']detail_mismatch["']/,
  "throttling must not be recorded as a job/detail mismatch");
assert.match(runBlock, /status === ["']manual_required["'] && tracker\.throttled \? ["']tab_throttled["'] : status/,
  "a throttled confirmation window must not be reported as BOSS staying silent");

// The job must survive a throttled attempt: it was never given a fair chance.
const throttledStart = source.indexOf("async function handleThrottledContact(job)");
const throttledEnd = source.indexOf("async function contactQualifiedJob(job, context)", throttledStart);
const throttledBlock = source.slice(throttledStart, throttledEnd);
assert.ok(throttledStart >= 0 && throttledEnd > throttledStart, "the throttled outcome must be handled");
assert.doesNotMatch(throttledBlock, /completeJob\(job\)|["']attention["']/,
  "a throttled attempt must never shelve the job for manual review");
assert.match(throttledBlock, /setJobProgress\(job, ["']qualified["']/,
  "the job must stay in the queue as still-qualified");
assert.match(throttledBlock, /JC_STATE\.retryContactJobKey = job\.key/,
  "the same job must be the next one retried");
assert.match(throttledBlock, /await waitForPageVisible\(THROTTLE_RECOVERY_TIMEOUT_MS\)/,
  "the retry must wait for the tab to come back instead of spinning while throttled");

assert.match(source, /function waitForPageVisible\(timeoutMs\)[\s\S]*addEventListener\("visibilitychange"/,
  "recovery must be event driven, since timers are exactly what throttling breaks");

// Next time this happens the log must be able to answer it on its own.
assert.match(source, /logAutomationEvent\("contact_attempt_timing"[\s\S]*selectMs[\s\S]*throttled[\s\S]*maxTickMs[\s\S]*visibility/,
  "every contact attempt must record its phase timings, throttle state and tab visibility");

console.log("Background throttling contact regression tests passed");

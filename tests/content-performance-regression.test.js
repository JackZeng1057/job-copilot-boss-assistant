const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", `file://${__dirname}/`), "utf8"));

assert.equal(manifest.version, "1.0.0", "the stable release must use version 1.0.0");
assert.match(source, /const POST_ANALYSIS_CONTACT_DELAY_MS = 3000;/,
  "qualified jobs should wait three seconds before communication");
assert.match(source, /const BETWEEN_JOBS_DELAY_MS = 5000;/,
  "jobs should retain a five-second anti-rate-limit pacing delay");

const waiter = source.slice(
  source.indexOf("function createStayOnCurrentPageWaiter"),
  source.indexOf("function hasSuccessfulContactEvidence")
);
assert.doesNotMatch(waiter, /setInterval\(probe,\s*25\)/,
  "contact confirmation must not poll the entire page every 25ms");
assert.match(waiter, /CONTACT_CONFIRMATION_FALLBACK_MS/,
  "contact confirmation must use a bounded low-frequency fallback");

const evidence = source.slice(
  source.indexOf("function hasSuccessfulContactEvidence"),
  source.indexOf("function findStayOnCurrentPageButton")
);
assert.doesNotMatch(evidence, /document\.body\?\.innerText|document\.body\.innerText/,
  "contact confirmation must not read the entire page text");
assert.match(evidence, /CONTACT_STATUS_SELECTOR/,
  "contact confirmation should inspect only targeted status containers");

const manualChatSetup = source.slice(
  source.indexOf("function installManualChatTabHandler"),
  source.indexOf("function handleManualChatHitboxEvent")
);
assert.doesNotMatch(manualChatSetup, /setInterval\(hardenManualChatLinks,\s*250\)/,
  "manual chat protection must not force layout four times per second");
assert.match(manualChatSetup, /scheduleManualChatLinkHardening/,
  "manual chat protection should coalesce mutation, resize, and scroll work");

assert.match(source, /const PAGE_SNAPSHOT_POLL_MS = 5000;/,
  "the safety snapshot poll should run at most once every five seconds");
assert.match(source, /const JOB_SNAPSHOT_STABILITY_ATTEMPTS = 2;/,
  "a stable list check should not perform up to five full snapshots");
assert.match(source, /function canReuseJobSnapshotForPipeline\(\)/,
  "pipeline startup should reuse an already current DOM snapshot");
const pipelineStarter = source.slice(
  source.indexOf("async function startAutoPipeline"),
  source.indexOf("async function registerAutomationSession")
);
assert.doesNotMatch(pipelineStarter, /window\.confirm\(/,
  "pipeline startup must not require a second confirmation click");
assert.match(source, /button\.textContent = "确认并开始自动投递";/,
  "the single start button must make the one-click confirmation explicit");
assert.match(pipelineStarter, /canReuseJobSnapshotForPipeline\(\)/,
  "pipeline startup must avoid an unconditional full rescan");
assert.doesNotMatch(pipelineStarter, /synchronizePageContext\(\{ force: true/,
  "pipeline startup must not always force a stable multi-pass scan");
const snapshotCapture = source.slice(
  source.indexOf("function captureJobSnapshot"),
  source.indexOf("function stableJobKey")
);
assert.doesNotMatch(snapshotCapture, /card\.innerText/,
  "job snapshots should not force layout by reading every card's innerText");
assert.match(snapshotCapture, /card\.textContent/,
  "job snapshots should use layout-free textContent reads");
assert.match(source, /function mutationAffectsJobList\(mutation\)/,
  "the page observer must ignore detail-pane mutations");

const renderer = source.slice(
  source.indexOf("function renderList()"),
  source.indexOf("function jobProgressInfo")
);
assert.ok(renderer.length > 0, "the renderer test boundary must resolve to live production code");
assert.doesNotMatch(renderer, /list\.innerHTML\s*=\s*["']{2}/,
  "status updates must not destroy and rebuild the entire result list");
assert.match(renderer, /installJobListEventDelegation/,
  "the result list should use one delegated click handler");

assert.match(source, /const MAX_DETACHED_JOBS = 50;/,
  "detached job history must be bounded");
assert.match(source, /function detachJobRecord\(job\)[\s\S]*card:\s*null/,
  "detached job records must release their DOM card references");
assert.match(source, /const MAX_COMPLETED_JOB_KEYS = 500;/,
  "completed job history must be bounded in memory");

console.log("Content performance regression tests passed");

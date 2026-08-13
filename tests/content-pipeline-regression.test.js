const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = ["../content-job-scan.js", "../content-panel-layout.js", "../content.js"]
  .map((file) => fs.readFileSync(new URL(file, `file://${__dirname}/`), "utf8"))
  .join("\n");

assert.match(source, /if \(JC_STATE\.pipeline\.controlActionInFlight\) return;/,
  "only an in-flight action may suppress a duplicate control click");
assert.doesNotMatch(source, /PIPELINE_CONTROL_COOLDOWN_MS|controlCooldownUntil/,
  "the pipeline control must not retain a timed transition lock");
assert.match(source, /const POST_ANALYSIS_CONTACT_DELAY_MS = 3000;/);
assert.match(source, /const BETWEEN_JOBS_DELAY_MS = 5000;/);

const batchStart = source.indexOf("async function advanceToNextBatch()");
const batchEnd = source.indexOf("function revealMoreJobs", batchStart);
const batchBlock = source.slice(batchStart, batchEnd);
assert.match(batchBlock, /phase\s*=\s*"batch_wait"/);
assert.match(batchBlock, /phase\s*=\s*"batch_loading"/);
assert.match(batchBlock, /batch_wait_started/);
assert.match(batchBlock, /batch_wait_completed/);
assert.doesNotMatch(batchBlock, /allPaused\s*=\s*true/,
  "batch countdown must not pause itself");

const startStart = source.indexOf("async function startAutoPipeline()");
const startEnd = source.indexOf("function canReuseJobSnapshotForPipeline", startStart);
const startBlock = source.slice(startStart, startEnd);
assert.match(startBlock, /completedJobKeys\.clear\(\)/,
  "a fresh run must not inherit completion markers and skip its first job");

assert.match(source, /if \(pageReplaced\) JC_STATE\.completedJobKeys\.clear\(\)/);
assert.match(source, /phase:\s*JC_STATE\.pipeline\.phase/);

const background = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");
assert.match(background, /"pauseReason",\s*"phase"/);

console.log("Pipeline pause and first-job regression tests passed");

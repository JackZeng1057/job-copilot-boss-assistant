const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const start = source.indexOf("async function advanceToNextBatch()");
const end = source.indexOf("function revealMoreJobs", start);
const batchBlock = source.slice(start, end);

assert.ok(start >= 0, "batch transition function must exist");
assert.match(source, /batchWaitRemainingMs:\s*0/,
  "pipeline state must retain a resumable batch-wait duration");
assert.match(source, /batchSize:\s*0/,
  "pipeline state must retain the current batch size for the panel");
assert.match(source, /batchWaitRemainingMs:\s*JC_STATE\.pipeline\.batchWaitRemainingMs/,
  "the remaining batch wait must be persisted with the owner session");
assert.match(source, /pipeline\.batchWaitRemainingMs\s*=\s*Math\.max\(0, Number\(session\.batchWaitRemainingMs\) \|\| 0\)/,
  "a restored owner session must recover its remaining batch wait");
assert.match(batchBlock, /const resumingBatchWait = JC_STATE\.pipeline\.waitingForNextBatch;[\s\S]*const waitDuration = resumingBatchWait[\s\S]*batchWaitRemainingMs/,
  "resuming a batch wait must use the saved remaining duration instead of a fresh local deadline");
assert.match(batchBlock, /JC_STATE\.pipeline\.batchWaitRemainingMs\s*=\s*Math\.max\(0, deadline - Date\.now\(\)\)/,
  "pausing a countdown must freeze the remaining duration");
assert.doesNotMatch(batchBlock, /JC_STATE\.pipeline\.allPaused\)[\s\S]{0,160}JC_STATE\.pipeline\.waitingForNextBatch\s*=\s*false/,
  "a paused countdown must remain marked as a resumable batch wait");
assert.match(source, /if \(JC_STATE\.pipeline\.waitingForNextBatch\) \{[\s\S]*advanceToNextBatch\(\)/,
  "resuming from the panel must restart the saved batch countdown");
assert.match(source, /当前列表总数 \$\{visible\} 个 · 本批 \$\{batchSize\} 个/,
  "the page label must show both list total and current batch size");

console.log("Batch wait resume and batch-count regression tests passed");

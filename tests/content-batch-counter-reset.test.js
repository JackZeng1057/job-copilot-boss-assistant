const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

assert.match(source, /function resetBatchProgress\(\) \{[\s\S]*batchNumber = 1;[\s\S]*batchKeys = \[\];[\s\S]*batchSize = 0;[\s\S]*batchWaitRemainingMs = 0;[\s\S]*waitingForNextBatch = false;[\s\S]*loadingNextBatch = false;[\s\S]*\n\}/,
  "a single helper must clear every batch counter at once");

const snapshotStart = source.indexOf("function applyJobSnapshot(");
const snapshotEnd = source.indexOf("function detachJobRecord(");
const snapshotBlock = source.slice(snapshotStart, snapshotEnd);
assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart, "applyJobSnapshot must exist");
assert.match(snapshotBlock, /jobProgress\.clear\(\);[\s\S]{0,300}resetBatchProgress\(\);/,
  "rebinding or replacing the job list must restart the batch counter at 1");

const restoreStart = source.indexOf("function restoreOwnedAutomationSession(");
const restoreEnd = source.indexOf("function renderRemoteAutomationState(");
const restoreBlock = source.slice(restoreStart, restoreEnd);
assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, "restoreOwnedAutomationSession must exist");
assert.match(restoreBlock, /if \(String\(session\.fingerprint \|\| ""\) === String\(JC_STATE\.page\.fingerprint \|\| ""\)\) \{[\s\S]*batchNumber = Math\.max\(1, Number\(session\.batchNumber\)[\s\S]*\} else \{\s*resetBatchProgress\(\);\s*\}/,
  "a restored session must only keep batch counters when it belongs to the current list");

console.log("Batch counter reset regression tests passed");

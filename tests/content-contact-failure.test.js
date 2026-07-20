const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const start = source.indexOf("async function contactQualifiedJob(job, context)");
const end = source.indexOf("async function waitForPacingDelay", start);
const handler = source.slice(start, end);

assert.ok(start >= 0 && end > start, "qualified-job contact handler must exist");
assert.match(handler, /try \{[\s\S]*clickCommunicateForJob\(job\)[\s\S]*catch \(error\)/,
  "communication errors must be handled at the job state boundary");
assert.match(handler, /setJobProgress\(job, ["']attention["'], detail\)/,
  "an ambiguous communication result must leave an explicit attention state");
const catchHandler = handler.slice(handler.indexOf("catch (error)"), handler.indexOf("if (JC_STATE.analysisRunId"));
assert.doesNotMatch(catchHandler, /pipeline\.allPaused = true/,
  "a job-level communication error must not pause later jobs");
assert.match(catchHandler, /return ["']continue["']/,
  "a job-level communication error must continue with the next job");
assert.match(handler, /result === ["']stay_missing["'][\s\S]*return ["']continue["']/,
  "an autonomously checked but ambiguous result must continue with the next job");
assert.match(handler, /blocked_rate:[\s\S]*blocked_limit:[\s\S]*blocked_security:/,
  "platform throttling, quota and security checks must be reported separately");
assert.match(handler, /blocked_rate:[\s\S]*pipeline\.allPaused = true/,
  "account-level platform blocks must still pause the pipeline");

console.log("Contact failure state regression test passed");

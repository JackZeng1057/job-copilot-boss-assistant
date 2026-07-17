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
assert.match(handler, /pipeline\.allPaused = true/,
  "an ambiguous communication result must pause later jobs");
assert.match(handler, /避免重复沟通/,
  "the UI must explain why automatic retry is disabled");
assert.match(handler, /blocked_rate:[\s\S]*blocked_limit:[\s\S]*blocked_security:/,
  "platform throttling, quota and security checks must be reported separately");

console.log("Contact failure state regression test passed");

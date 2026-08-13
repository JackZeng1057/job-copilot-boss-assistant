const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");

assert.match(source, /data-retry-contact-key=/,
  "qualified attention rows must expose a contact-only retry action");
assert.match(source, /只重新尝试沟通，不重复请求 AI/,
  "the UI must distinguish contact retry from AI reanalysis");

const start = source.indexOf("async function retryContactForJob(key)");
const end = source.indexOf("async function retryFailedJob", start);
assert.ok(start >= 0 && end > start, "the contact-only retry workflow must exist");
const retry = source.slice(start, end);
assert.match(retry, /completedJobKeys\.delete\(job\.key\)/,
  "contact retry must reopen a job previously marked complete");
assert.match(retry, /retryContactJobKey = job\.key/,
  "contact retry must take priority over untouched queue jobs");
assert.match(retry, /pipeline\.batchKeys = \[job\.key\]/,
  "contact retry must remain scoped to exactly one job");
assert.doesNotMatch(retry, /requestAiAnalysis|analyses\.delete|analysisPayloads\.delete/,
  "contact retry must not spend another AI request or discard the existing score");

assert.match(source, /retryContactOnlyRun[\s\S]*单岗位沟通重试已完成，自动投递保持暂停/,
  "a contact-only retry must not silently continue into the full queue");

console.log("Contact-only retry tests passed");

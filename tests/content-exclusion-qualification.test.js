const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const start = source.indexOf("function isQualifiedJob(job)");
const end = source.indexOf("function jobNeedsProcessing(job)", start);
assert.ok(start >= 0 && end > start, "qualified-job guard must exist");

const analyses = new Map();
const sandbox = {
  JC_STATE: {
    analyses,
    settings: { minScore: 60 }
  }
};
vm.runInNewContext(`${source.slice(start, end)}\nthis.isQualifiedJob = isQualifiedJob;`, sandbox);

const job = { key: "job:fixture" };

analyses.set(job.key, { score: 60, excluded: false });
assert.equal(sandbox.isQualifiedJob(job), true);

analyses.set(job.key, { score: 59, excluded: false });
assert.equal(sandbox.isQualifiedJob(job), false);

analyses.set(job.key, { score: 95, excluded: true });
assert.equal(sandbox.isQualifiedJob(job), false,
  "an explicitly excluded occupation must never be contacted even with a high model score");

assert.match(source, /已排除：/);
console.log("excluded-occupation qualification guard tests passed");

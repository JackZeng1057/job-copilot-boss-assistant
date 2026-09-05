// 验证命中排除条件的岗位即使达到分数线也不会沟通。
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = require("./helpers/extension-source").contentSource();
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

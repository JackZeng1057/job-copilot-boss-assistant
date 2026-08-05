const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const start = source.indexOf("function focusNextQualifiedJob()");
const end = source.indexOf("function focusJob(key)", start);
assert.ok(start >= 0 && end > start, "next-qualified locator must exist");

let focusedKey = null;
let status = "";
const analyses = new Map();
const sandbox = {
  JC_STATE: {
    jobs: [{ key: "job:pending", detached: false }],
    selectedKey: null,
    analyses,
    settings: { minScore: 60 }
  },
  focusJob(key) {
    focusedKey = key;
  },
  setStatus(value) {
    status = value;
  }
};

vm.runInNewContext(`${source.slice(start, end)}\nthis.focusNextQualifiedJob = focusNextQualifiedJob;`, sandbox);

sandbox.focusNextQualifiedJob();
assert.equal(focusedKey, null,
  "the next-qualified control must not focus a pending or unqualified job");
assert.match(status, /没有可定位的达标岗位/);

analyses.set("job:pending", { score: 60 });
sandbox.focusNextQualifiedJob();
assert.equal(focusedKey, "job:pending",
  "a job meeting the configured minimum score should be focused");

console.log("Next-qualified job locator tests passed");

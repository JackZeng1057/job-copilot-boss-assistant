const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
assert.match(source, /class="jc-dismiss-job"[\s\S]*data-dismiss-key=[\s\S]*aria-label="关闭检测：/,
  "each job row must render an accessible dismissal control");
assert.match(source, /closest\("\[data-focus-key\], \[data-retry-key\], \[data-dismiss-key\]"\)/,
  "the delegated list handler must recognize dismissal clicks");
assert.match(source, /jobs: snapshot\.jobs\.filter\(\(job\) => !JC_STATE\.dismissedJobKeys\.has\(job\.key\)\)/,
  "a later page rescan must not add a dismissed job back to the delivery list");
assert.match(source, /dismissedJobKeys: Array\.from\(JC_STATE\.dismissedJobKeys\)/,
  "dismissed jobs must be included in the resumable automation session");
const start = source.indexOf("function dismissJob(key)");
const end = source.indexOf("function mountSalaryVisualClone", start);
assert.ok(start >= 0 && end > start, "job dismissal handler must exist");

const pendingJob = { key: "job:pending", title: "待分析岗位", index: 0 };
const analyzingJob = { key: "job:analyzing", title: "分析中岗位", index: 1 };
const progress = new Map([
  [pendingJob.key, { status: "pending", detail: "" }],
  [analyzingJob.key, { status: "analyzing", detail: "" }]
]);
let rendered = 0;
let persisted = 0;
let workerStarts = 0;
let status = "";
const sandbox = {
  JC_STATE: {
    jobs: [pendingJob, analyzingJob],
    analyses: new Map([[analyzingJob.key, { score: 80 }]]),
    jobProgress: progress,
    dismissedJobKeys: new Set(),
    completedJobKeys: new Set(),
    selectedKey: analyzingJob.key,
    currentJobKey: analyzingJob.key,
    retryJobKey: pendingJob.key,
    analyzing: true,
    analysisRunId: 4,
    pipeline: {
      active: true,
      allPaused: false,
      batchKeys: [pendingJob.key, analyzingJob.key]
    }
  },
  progressFor(job) {
    return progress.get(job.key) || { status: "pending", detail: "" };
  },
  rememberCompletedJobKey(key) {
    sandbox.JC_STATE.completedJobKeys.add(key);
  },
  clearHighlights() {},
  renderList() {
    rendered += 1;
  },
  updateAutomationControls() {},
  schedulePersistAutomationSession() {
    persisted += 1;
  },
  setStatus(value) {
    status = value;
  },
  setTimeout(callback) {
    callback();
  },
  ensureAnalysisWorker() {
    workerStarts += 1;
  }
};

vm.runInNewContext(`${source.slice(start, end)}\nthis.dismissJob = dismissJob;`, sandbox);

assert.equal(sandbox.dismissJob(pendingJob.key), true);
assert.deepEqual(sandbox.JC_STATE.jobs.map((job) => job.key), [analyzingJob.key]);
assert.deepEqual(sandbox.JC_STATE.jobs.map((job) => job.index), [0],
  "remaining jobs must be renumbered after a dismissal");
assert.ok(sandbox.JC_STATE.dismissedJobKeys.has(pendingJob.key));
assert.ok(sandbox.JC_STATE.completedJobKeys.has(pendingJob.key));
assert.deepEqual(Array.from(sandbox.JC_STATE.pipeline.batchKeys), [analyzingJob.key]);
assert.equal(sandbox.JC_STATE.retryJobKey, "");

assert.equal(sandbox.dismissJob(analyzingJob.key), true);
assert.equal(sandbox.JC_STATE.analysisRunId, 5,
  "dismissing the in-flight job must invalidate its late AI result");
assert.equal(sandbox.JC_STATE.analyzing, false);
assert.equal(sandbox.JC_STATE.analyses.has(analyzingJob.key), false);
assert.equal(sandbox.JC_STATE.jobProgress.has(analyzingJob.key), false);
assert.equal(sandbox.JC_STATE.selectedKey, "");
assert.equal(sandbox.JC_STATE.currentJobKey, "");
assert.equal(workerStarts, 1, "the active pipeline should continue with the next eligible job");
assert.equal(rendered, 2);
assert.equal(persisted, 2);
assert.match(status, /已关闭检测/);

console.log("Job dismissal tests passed");

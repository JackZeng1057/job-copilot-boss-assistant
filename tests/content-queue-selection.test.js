const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Behavioural test for the queue's job-selection rules. content.js boots a
// panel at load time and needs a DOM, so instead of loading the whole file we
// lift the pure queue functions into a sandbox and actually call them.
const source = ["../content-job-scan.js", "../content-panel-layout.js", "../content.js"]
  .map((file) => fs.readFileSync(new URL(file, `file://${__dirname}/`), "utf8"))
  .join("\n");

function lift(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  // Walk braces from the signature to find the function's closing brace.
  // Start matching at the body's brace, not at a default parameter's `{}`.
  const bodyStart = source.indexOf(") {", start) + 2;
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${signature}`);
}

const lifted = [
  "function progressFor(job)",
  "function analysisProgressStatus(job)",
  "function isQualifiedJob(job)",
  "function jobNeedsProcessing(job)",
  "function takeNextJobForProcessing()",
  "function rememberCompletedJobKey(key)",
  "function rememberDismissedJobKey(key)",
  "function rememberBoundedJobKey(keys, key)",
  "function prepareCurrentBatch()"
].map(lift).join("\n\n");

function makeSandbox({ jobs, analyses = {}, progress = {}, completed = [], batchKeys = [], minScore = 60, mode = "auto" }) {
  const sandbox = {
    console,
    JOB_BATCH_SIZE: 15,
    MAX_COMPLETED_JOB_KEYS: 500,
    schedulePersistAutomationSession() {},
    JC_STATE: {
      jobs,
      analyses: new Map(Object.entries(analyses)),
      jobProgress: new Map(Object.entries(progress)),
      completedJobKeys: new Set(completed),
      retryJobKey: "",
      retryContactJobKey: "",
      settings: { minScore },
      pipeline: { mode, batchKeys: [...batchKeys] }
    }
  };
  vm.runInNewContext(
    `${lifted}\nthis.__q = { jobNeedsProcessing, takeNextJobForProcessing, prepareCurrentBatch, isQualifiedJob, rememberCompletedJobKey, rememberDismissedJobKey };`,
    sandbox
  );
  return sandbox;
}

const job = (key, extra = {}) => ({ key, title: key, index: 0, ...extra });

// --- untouched jobs are picked in list order -------------------------------
{
  const s = makeSandbox({ jobs: [job("a"), job("b"), job("c")] });
  assert.equal(s.__q.takeNextJobForProcessing().key, "a", "the first unprocessed job wins by default");
}

// --- a requested retry jumps the queue, and is consumed exactly once -------
{
  const s = makeSandbox({ jobs: [job("a"), job("b"), job("c")] });
  s.JC_STATE.retryJobKey = "c";
  assert.equal(s.__q.takeNextJobForProcessing().key, "c", "a retry request must outrank untouched jobs");
  assert.equal(s.JC_STATE.retryJobKey, "", "the retry key must be consumed so the retry runs once");
  assert.equal(s.__q.takeNextJobForProcessing().key, "a", "the queue returns to list order afterwards");
}

// --- a contact retry outranks a plain reanalysis retry ---------------------
{
  const s = makeSandbox({ jobs: [job("a"), job("b")] });
  s.JC_STATE.retryJobKey = "a";
  s.JC_STATE.retryContactJobKey = "b";
  assert.equal(s.__q.takeNextJobForProcessing().key, "b");
}

// --- a retry for a job that no longer needs work falls through -------------
{
  const s = makeSandbox({ jobs: [job("a"), job("b")], completed: ["b"] });
  s.JC_STATE.retryContactJobKey = "b";
  assert.equal(s.__q.takeNextJobForProcessing().key, "a",
    "a stale retry key must not stall the queue");
}

// --- completed jobs are never handed out again -----------------------------
{
  const s = makeSandbox({ jobs: [job("a"), job("b")], completed: ["a"] });
  assert.equal(s.__q.takeNextJobForProcessing().key, "b");
}

// --- an analyzed job below the pass mark is done, above it still needs contact
{
  const analyses = { a: { score: 40, excluded: false }, b: { score: 80, excluded: false } };
  const s = makeSandbox({ jobs: [job("a"), job("b")], analyses });
  assert.equal(s.__q.jobNeedsProcessing(s.JC_STATE.jobs[0]), false, "a rejected job needs no contact");
  assert.equal(s.__q.jobNeedsProcessing(s.JC_STATE.jobs[1]), true, "a qualified job still owes a contact attempt");
}

// --- an excluded job never qualifies, whatever the score --------------------
{
  const s = makeSandbox({ jobs: [job("a")], analyses: { a: { score: 95, excluded: true } } });
  assert.equal(s.__q.isQualifiedJob(s.JC_STATE.jobs[0]), false,
    "an excluded job must not pass regardless of score");
}

// --- the pass mark is read live, so a settings change re-sorts the queue ----
{
  const s = makeSandbox({ jobs: [job("a")], analyses: { a: { score: 65, excluded: false } }, minScore: 60 });
  assert.equal(s.__q.isQualifiedJob(s.JC_STATE.jobs[0]), true);
  s.JC_STATE.settings.minScore = 70;
  assert.equal(s.__q.isQualifiedJob(s.JC_STATE.jobs[0]), false,
    "raising the pass mark must immediately disqualify a borderline job");
}

// --- terminal contact outcomes are not retried in the same run -------------
for (const status of ["contacted", "unavailable", "detail_mismatch", "attention"]) {
  const s = makeSandbox({
    jobs: [job("a")],
    analyses: { a: { score: 80, excluded: false } },
    progress: { a: { status, detail: "" } }
  });
  assert.equal(s.__q.jobNeedsProcessing(s.JC_STATE.jobs[0]), false,
    `a job left in "${status}" must not be picked up again`);
}

// --- an in-progress job is not handed out twice ----------------------------
{
  const s = makeSandbox({ jobs: [job("a"), job("b")], progress: { a: { status: "analyzing", detail: "" } } });
  assert.equal(s.__q.takeNextJobForProcessing().key, "b",
    "a job already being analyzed must not be selected again");
}

// --- an active batch confines selection to its own keys --------------------
{
  const s = makeSandbox({ jobs: [job("a"), job("b"), job("c")], batchKeys: ["c"] });
  assert.equal(s.__q.takeNextJobForProcessing().key, "c",
    "selection must stay inside the current batch");
}

// --- batch preparation caps at JOB_BATCH_SIZE and skips detached jobs ------
{
  const jobs = Array.from({ length: 20 }, (_, i) => job(`j${i}`));
  jobs[0].detached = true;
  const s = makeSandbox({ jobs });
  const batch = s.__q.prepareCurrentBatch();
  assert.equal(batch.length, 15, "a batch must not exceed JOB_BATCH_SIZE");
  assert.ok(!batch.includes("j0"), "a detached job must not enter the batch");
}

// --- both key sets stay bounded, or the in-memory set drifts from the one the
// session persists and applyJobSnapshot pays an O(n) copy on every page sync ---
{
  const s = makeSandbox({ jobs: [job("a")] });
  s.JC_STATE.dismissedJobKeys = new Set();
  for (let i = 0; i < 700; i += 1) {
    s.__q.rememberCompletedJobKey(`c${i}`);
    s.__q.rememberDismissedJobKey(`d${i}`);
  }
  assert.equal(s.JC_STATE.completedJobKeys.size, 500, "completed keys must stay capped");
  assert.equal(s.JC_STATE.dismissedJobKeys.size, 500, "dismissed keys must stay capped too");
  assert.ok(!s.JC_STATE.dismissedJobKeys.has("d0"), "the oldest dismissed key must be evicted");
  assert.ok(s.JC_STATE.dismissedJobKeys.has("d699"), "the newest dismissed key must be kept");

  // Re-recording moves a key to the newest slot rather than duplicating it.
  s.__q.rememberDismissedJobKey("d250");
  assert.equal(s.JC_STATE.dismissedJobKeys.size, 500, "re-recording must not grow the set");
  assert.equal([...s.JC_STATE.dismissedJobKeys].at(-1), "d250", "a re-recorded key becomes newest");
}

console.log("Queue selection tests passed");

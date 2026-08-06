const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const rowStart = source.indexOf("function updateJobRow(item, job)");
const rowEnd = source.indexOf("function dismissJob", rowStart);
const rowSource = source.slice(rowStart, rowEnd);

assert.match(rowSource, /data-reanalyze-key[\s\S]*data-focus-key/,
  "every eligible row must render reanalysis to the left of locate");
assert.match(rowSource, /reanalysisInFlightKeys\.has\(job\.key\)/,
  "row rendering must expose an in-flight state without changing queue progress");
assert.match(source, /analysisPayloads\.set\(job\.key, payload\)[\s\S]*requestAiAnalysis\(job, payload\)/,
  "the main analysis must retain the exact collected-JD payload for safe replay");
assert.match(source, /requestAiAnalysis\(job, payload, \{[\s\S]*updateGlobalStatus:\s*false/,
  "parallel reanalysis must not overwrite the main queue status ticker");

const functionStart = source.indexOf("async function reanalyzeJobInParallel(key)");
const functionEnd = source.indexOf("function jobProgressInfo", functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart, "parallel reanalysis handler must exist");
const functionSource = source.slice(functionStart, functionEnd);

(async () => {
  const job = { key: "job:2", title: "并行重分析岗位", index: 1 };
  const originalAnalysis = { score: 48, decision: "manual_review", excluded: false };
  const nextAnalysis = { score: 72, decision: "recommend", excluded: false };
  const payload = { title: job.title, jd: "已采集完整 JD", jdComplete: true };
  const JC_STATE = {
    jobs: [job],
    analyses: new Map([[job.key, originalAnalysis]]),
    analysisPayloads: new Map([[job.key, payload]]),
    reanalysisInFlightKeys: new Set(),
    analyzing: true,
    analysisRunId: 9,
    pipeline: { active: true, allPaused: false, batchKeys: ["job:1", job.key] }
  };
  let renders = 0;
  let requests = 0;
  let requestOptions = null;
  const sandbox = {
    JC_STATE,
    requestAiAnalysis: async (_job, actualPayload, options) => {
      requests += 1;
      assert.equal(actualPayload, payload);
      requestOptions = options;
      return { ok: true, analysis: { ...nextAnalysis }, performance: { usage: {}, requestCount: 1 } };
    },
    applyAnalysisPerformance() {},
    analysisProgressStatus: () => "qualified",
    progressFor: () => ({ status: "not_qualified" }),
    setJobProgress() {},
    renderList() { renders += 1; },
    schedulePersistAutomationSession() {},
    setStatus() {},
    logAutomationEvent() {},
    friendlyAiError: String
  };
  vm.runInNewContext(`${functionSource}\nthis.reanalyzeJobInParallel = reanalyzeJobInParallel;`, sandbox);

  const first = sandbox.reanalyzeJobInParallel(job.key);
  const duplicate = await sandbox.reanalyzeJobInParallel(job.key);
  await first;

  assert.equal(duplicate.reason, "already_running");
  assert.equal(requests, 1, "the same job must never run duplicate reanalysis requests");
  assert.equal(requestOptions.updateGlobalStatus, false);
  assert.equal(JC_STATE.analyses.get(job.key).score, 72);
  assert.equal(JC_STATE.analyzing, true, "the main queue worker must remain active");
  assert.equal(JC_STATE.analysisRunId, 9, "parallel reanalysis must not invalidate the main queue run");
  assert.deepEqual(JC_STATE.pipeline.batchKeys, ["job:1", job.key]);
  assert.ok(renders >= 2);
  console.log("Parallel per-job reanalysis tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

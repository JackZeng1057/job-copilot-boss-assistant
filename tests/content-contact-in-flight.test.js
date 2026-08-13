const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Regression guard for the cross-context ordering contract: the service worker
// must confirm the job marker is stored before the native click can navigate.
const source = ["../content-job-scan.js", "../content-panel-layout.js", "../content.js"]
  .map((file) => fs.readFileSync(new URL(file, `file://${__dirname}/`), "utf8"))
  .join("\n");

function lift(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
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
  "async function persistAutomationSessionNow()",
  "async function markContactInFlight(key)",
  "function clearContactInFlight()",
  "function buildAutomationSessionPayload(overrides = {})"
].map(lift).join("\n\n");

let persistCalls = 0;
const sentMessages = [];
let releaseImmediatePersist = null;
const sandbox = {
  console,
  JOB_BATCH_SIZE: 15,
  MAX_COMPLETED_JOB_KEYS: 500,
  schedulePersistAutomationSession() { persistCalls += 1; },
  clearTimeout() {},
  sessionPersistTimer: null,
  sendMessage(message) {
    sentMessages.push(message);
    return new Promise((resolve) => {
      releaseImmediatePersist = () => resolve({ ok: true });
    });
  },
  document: { getElementById: () => null },
  location: { href: "https://www.zhipin.com/web/geek/jobs" },
  JC_STATE: {
    jobs: [{ key: "job:a", title: "A" }, { key: "job:b", title: "B" }],
    analyses: new Map(),
    jobProgress: new Map(),
    dismissedJobKeys: new Set(),
    completedJobKeys: new Set(),
    currentJobKey: "",
    sessionOwner: true,
    settings: { minScore: 60 },
    page: { url: "https://www.zhipin.com/web/geek/jobs", fingerprint: "fp" },
    pipeline: {
      active: true, allPaused: false, pauseReason: "", mode: "auto", phase: "analysis",
      contactInFlight: false, contextInvalidated: false, batchNumber: 1, batchKeys: [], batchSize: 0,
      batchWaitRemainingMs: 0, waitingForNextBatch: false, loadingNextBatch: false
    }
  }
};
vm.runInNewContext(
  `${lifted}\nthis.__api = { markContactInFlight, clearContactInFlight, buildAutomationSessionPayload };`,
  sandbox
);
const { markContactInFlight, clearContactInFlight, buildAutomationSessionPayload } = sandbox.__api;

(async () => {
  let payload = buildAutomationSessionPayload();
  assert.equal(payload.contactInFlight, false);
  assert.equal(payload.currentJobKey, "");

  let markerResolved = false;
  const marking = markContactInFlight("job:b").then(() => { markerResolved = true; });
  await Promise.resolve();
  payload = sentMessages.at(-1)?.patch;
  assert.equal(sentMessages.at(-1)?.type, "updateAutomationSession");
  assert.equal(payload.contactInFlight, true);
  assert.equal(payload.currentJobKey, "job:b");
  assert.equal(markerResolved, false,
    "the click gate must remain closed until the service worker confirms storage");
  releaseImmediatePersist();
  await marking;
  assert.equal(markerResolved, true);

  const contactStart = source.indexOf("async function runQualifiedJobContact(job, context)");
  const contactEnd = source.indexOf("async function waitForPacingDelay", contactStart);
  const contact = source.slice(contactStart, contactEnd);
  assert.match(contact, /await markContactInFlight\(job\.key\)[\s\S]*await clickCommunicateForJob\(job\)/,
    "the native click must happen only after the session marker is stored");

  persistCalls = 0;
  clearContactInFlight();
  payload = buildAutomationSessionPayload();
  assert.equal(payload.contactInFlight, false);
  assert.equal(payload.currentJobKey, "");
  assert.equal(persistCalls, 1);

  persistCalls = 0;
  clearContactInFlight();
  assert.equal(persistCalls, 0, "a redundant clear must be a no-op");

  const background = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");
  const allowed = background.slice(background.indexOf("const allowed = ["));
  for (const key of ["contactInFlight", "currentJobKey"]) {
    assert.ok(allowed.slice(0, allowed.indexOf("]")).includes(`"${key}"`),
      `sanitizeAutomationSession must keep ${key}`);
  }
  const normalizeStart = background.indexOf("function normalizeSessionContactMarker(session)");
  const normalizeEnd = background.indexOf("async function getJobsTabGuards", normalizeStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart,
    "the service worker must normalize the marker at its common save boundary");
  const markerSandbox = {};
  vm.runInNewContext(
    `${background.slice(normalizeStart, normalizeEnd)}\nthis.normalize = normalizeSessionContactMarker;`,
    markerSandbox
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(markerSandbox.normalize({ contactInFlight: false, currentJobKey: "job:stale" }))),
    { contactInFlight: false, currentJobKey: "" }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(markerSandbox.normalize({ contactInFlight: true, currentJobKey: "" }))),
    { contactInFlight: false, currentJobKey: "" }
  );

  console.log("Contact in-flight marker tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

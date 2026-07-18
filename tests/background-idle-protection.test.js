const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");

function createStorageArea(seed = {}) {
  const values = { ...seed };
  return {
    values,
    get(keys, callback) {
      if (typeof keys === "string") callback({ [keys]: values[keys] });
      else callback({ ...values });
    },
    set(patch, callback) {
      Object.assign(values, patch);
      callback?.();
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
      callback?.();
    }
  };
}

function createHarness() {
  const local = createStorageArea();
  const session = createStorageArea();
  const sentControls = [];
  let messageListener = null;
  let idleListener = null;
  let detectionInterval = null;
  const runtime = {
    lastError: null,
    onMessage: { addListener(listener) { messageListener = listener; } }
  };
  const tabs = {
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    update(tabId, changes, callback) { callback({ id: tabId, ...changes }); },
    sendMessage(tabId, message, callback) {
      sentControls.push({ tabId, ...message });
      callback({ ok: true });
    }
  };
  const idle = {
    setDetectionInterval(seconds) { detectionInterval = seconds; },
    queryState: async () => "active",
    onStateChanged: { addListener(listener) { idleListener = listener; } }
  };

  vm.runInNewContext(source, {
    chrome: { runtime, storage: { local, session }, tabs, idle },
    console,
    fetch: async () => { throw new Error("fetch should not run"); },
    setTimeout,
    clearTimeout,
    URL
  });

  const send = (message) => new Promise((resolve) => {
    assert.equal(messageListener(message, { tab: { id: 7 } }, resolve), true);
  });
  const changeIdleState = async (state) => {
    idleListener(state);
    await new Promise((resolve) => setTimeout(resolve, 15));
  };
  return { session, sentControls, send, changeIdleState, getDetectionInterval: () => detectionInterval };
}

(async () => {
  const harness = createHarness();
  assert.equal(harness.getDetectionInterval(), 60);
  await harness.send({
    type: "registerAutomationSession",
    session: {
      active: true,
      paused: false,
      mode: "auto",
      jobsUrl: "https://www.zhipin.com/web/geek/jobs"
    }
  });

  await harness.changeIdleState("idle");
  let saved = harness.session.values.jobCopilotAutomationSessionV1;
  assert.equal(saved.paused, false);
  assert.equal(Boolean(saved.autoPausedByIdle), false);
  assert.equal(harness.sentControls.length, 0);

  await harness.changeIdleState("active");
  saved = harness.session.values.jobCopilotAutomationSessionV1;
  assert.equal(saved.paused, false);
  assert.equal(Boolean(saved.autoPausedByIdle), false);
  assert.equal(harness.sentControls.length, 0);

  await harness.changeIdleState("locked");
  saved = harness.session.values.jobCopilotAutomationSessionV1;
  assert.equal(saved.paused, true);
  assert.equal(saved.autoPausedByIdle, true);
  assert.equal(harness.sentControls.at(-1).action, "pause");
  assert.equal(harness.sentControls.at(-1).reason, "machine_locked");

  await harness.changeIdleState("active");
  saved = harness.session.values.jobCopilotAutomationSessionV1;
  assert.equal(saved.paused, false);
  assert.equal(saved.autoPausedByIdle, false);
  assert.equal(harness.sentControls.at(-1).action, "resume");
  assert.equal(harness.sentControls.at(-1).reason, "machine_active");

  await harness.changeIdleState("locked");
  await harness.send({ type: "controlAutomationTab", action: "pause" });
  saved = harness.session.values.jobCopilotAutomationSessionV1;
  assert.equal(saved.autoPausedByIdle, false);
  const controlsBeforeActive = harness.sentControls.length;
  await harness.changeIdleState("active");
  assert.equal(harness.sentControls.length, controlsBeforeActive);

  console.log("Machine lock pause and resume tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

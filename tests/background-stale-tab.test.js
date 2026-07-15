const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");

function storageArea(seed = {}) {
  const values = { ...seed };
  return {
    values,
    get(key, callback) { callback({ [key]: values[key] }); },
    set(patch, callback) { Object.assign(values, patch); callback?.(); },
    remove(key, callback) { delete values[key]; callback?.(); }
  };
}

(async () => {
  const key = "jobCopilotAutomationSessionV1";
  const session = storageArea({
    [key]: { tabId: 159484187, active: true, jobsUrl: "https://www.zhipin.com/web/geek/jobs" }
  });
  const local = storageArea();
  let listener;
  let pendingError = null;
  const runtime = {
    onMessage: { addListener(value) { listener = value; } },
    get lastError() {
      const error = pendingError;
      pendingError = null;
      return error;
    }
  };
  const tabs = {
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    update(_tabId, _changes, callback) {
      pendingError = { message: "No tab with id: 159484187." };
      callback(undefined);
    },
    sendMessage(_tabId, _message, callback) { callback({ ok: true }); }
  };

  vm.runInNewContext(source, {
    chrome: { runtime, storage: { local, session }, tabs },
    console,
    fetch: async () => { throw new Error("fetch should not run"); },
    setTimeout,
    clearTimeout,
    URL
  });

  const response = await new Promise((resolve) => {
    assert.equal(listener({ type: "focusAutomationTab" }, {}, resolve), true);
  });
  assert.equal(response.ok, false);
  assert.equal(session.values[key], undefined);
  console.log("Stale automation tab regression test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

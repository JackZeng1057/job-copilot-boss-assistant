// 验证 session 存储不可用时的兼容行为和存储读取容错。
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = require("./helpers/extension-source").backgroundSource();

async function runScenario(storageErrorMessage) {
  let listener = null;
  let pendingError = null;
  let lastErrorReads = 0;
  const runtime = {
    onMessage: {
      addListener(value) {
        listener = value;
      }
    },
    get lastError() {
      lastErrorReads += 1;
      const error = pendingError;
      pendingError = null;
      return error;
    }
  };
  const storage = {
    get(_keys, callback) {
      pendingError = storageErrorMessage ? { message: storageErrorMessage } : null;
      callback(storageErrorMessage ? undefined : {
        apiKey: "must-not-leave-background",
        resumeDefault: "private resume text",
        resumeAltA: "private alternate resume",
        currentLocation: "generic location preference"
      });
    },
    set(_items, callback) {
      callback?.();
    },
    remove(_keys, callback) {
      callback?.();
    }
  };

  vm.runInNewContext(source, {
    chrome: { runtime, storage: { local: storage } },
    console,
    fetch: async () => { throw new Error("fetch should not run"); },
    setTimeout,
    clearTimeout
  });

  assert.equal(typeof listener, "function");
  const response = await new Promise((resolve, reject) => {
    const asyncResponse = listener({ type: "getSettings" }, {}, resolve);
    assert.equal(asyncResponse, true);
    setTimeout(() => reject(new Error("getSettings response timed out")), 100);
  });
  assert.equal(response.ok, true);
  assert.equal(response.settings.restrictTargetLocation, false);
  assert.equal(response.settings.experienceYears, "");
  assert.equal(response.settings.graduateStatus, "unspecified");
  assert.deepEqual(Array.from(response.settings.profile), ["default"]);
  assert.equal(response.settings.apiKey, undefined);
  assert.equal(response.settings.resumeDefault, undefined);
  assert.equal(response.settings.resumeAltA, undefined);
  assert.ok(lastErrorReads >= 1);
}

(async () => {
  await runScenario(null);
  await runScenario("No SW");
  console.log("Windows Edge storage fallback tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

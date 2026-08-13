const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");

function lift(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const bodyStart = source.indexOf("{", start);
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

let pendingError = null;
const sandbox = {
  chrome: {
    runtime: {
      get lastError() {
        const error = pendingError;
        pendingError = null;
        return error;
      }
    }
  }
};
vm.runInNewContext([
  lift("function consumeRuntimeLastError()"),
  lift("function storageSet(area, values)")
].join("\n\n") + "\nthis.storageSet = storageSet;", sandbox);

(async () => {
  const failingStorage = {
    set(_values, callback) {
      pendingError = { message: "storage quota exceeded" };
      callback();
    }
  };
  await assert.rejects(
    sandbox.storageSet(failingStorage, { marker: true }),
    /storage quota exceeded/,
    "a failed marker write must prevent the native contact click"
  );

  const successfulStorage = { set(_values, callback) { callback(); } };
  await assert.doesNotReject(sandbox.storageSet(successfulStorage, { marker: true }));
  console.log("Background storage write tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

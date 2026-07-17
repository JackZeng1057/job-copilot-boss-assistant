const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const start = source.indexOf("async function performIsolatedCommunication(expectedJob)");
const end = source.indexOf("function dispatchCommunicationRetryClick", start);
assert.ok(start >= 0 && end > start, "isolated communication orchestration must exist");

let waiterResults = [];
let blockStatus = "";
let firstClicks = 0;
let retryClicks = 0;
let sleeps = [];
const button = {
  scrollIntoView() {},
  focus() {}
};
const context = {
  findImmediateCommunicateButtons() { return [button]; },
  isElementVisible() { return true; },
  isolatedJobMatchesExpectation() { return true; },
  hasSuccessfulContactEvidence() { return false; },
  communicationBlockStatus() { return blockStatus; },
  clickWithoutNavigation() { firstClicks += 1; },
  dispatchCommunicationRetryClick() { retryClicks += 1; },
  createStayOnCurrentPageWaiter() {
    return {
      promise: Promise.resolve(waiterResults.shift()),
      cancel() {}
    };
  },
  sleep(ms) {
    sleeps.push(ms);
    return Promise.resolve();
  },
  document: {}
};
vm.runInNewContext(
  `${source.slice(start, end)}\nthis.performIsolatedCommunication = performIsolatedCommunication;`,
  context
);

(async () => {
  waiterResults = ["stay_missing", "stayed"];
  const recovered = await context.performIsolatedCommunication({ title: "测试岗位" });
  assert.equal(recovered, "stayed");
  assert.equal(firstClicks, 1, "the native click must run exactly once");
  assert.equal(retryClicks, 1, "an unconfirmed native click must get exactly one alternate retry");
  assert.deepEqual(sleeps, [1200], "the retry must wait briefly before the second click");

  waiterResults = ["stay_missing"];
  blockStatus = "blocked_rate";
  firstClicks = 0;
  retryClicks = 0;
  sleeps = [];
  const blocked = await context.performIsolatedCommunication({ title: "测试岗位" });
  assert.equal(blocked, "blocked_rate");
  assert.equal(firstClicks, 1);
  assert.equal(retryClicks, 0, "platform throttling must stop before a retry");
  assert.deepEqual(sleeps, []);

  console.log("Isolated contact retry behavior tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const contactStart = source.indexOf("async function performIsolatedCommunication(expectedJob)");
const waiterStart = source.indexOf("createStayOnCurrentPageWaiter(clickAttempt === 0 ? 18000 : 15000)", contactStart);
const communicateClick = source.indexOf("clickWithoutNavigation(currentButton)", contactStart);
const waiterAwait = source.indexOf("await stayWaiter.promise", contactStart);
assert.ok(contactStart < waiterStart && waiterStart < communicateClick && communicateClick < waiterAwait,
  "the disposable contact tab must observe the native confirmation before clicking");
const retryClick = source.indexOf("dispatchCommunicationRetryClick(currentButton)", communicateClick);
assert.ok(retryClick > communicateClick,
  "a still-unconfirmed immediate-communication button should receive one alternate retry");
assert.match(source.slice(contactStart, source.indexOf("function isolatedJobMatchesExpectation", contactStart)),
  /clickAttempt < 2[\s\S]*communicationBlockStatus\(\)[\s\S]*hasSuccessfulContactEvidence\(\)/,
  "retry must be bounded and stop for platform blocks or late success evidence");
const start = source.indexOf("function createStayOnCurrentPageWaiter(");
const end = source.indexOf("function findStayOnCurrentPageButton()", start);
assert.ok(start >= 0 && end > start, "stay confirmation waiter must exist");

let mutationCallback = null;
let availableButton = null;
let successControls = [];
let clickCount = 0;
const delayed = [];
class MutationObserver {
  constructor(callback) { mutationCallback = callback; }
  observe() {}
  disconnect() {}
}
const context = {
  MutationObserver,
  document: {
    body: { innerText: "" },
    documentElement: {},
    querySelectorAll() { return successControls; }
  },
  location: { href: "https://www.zhipin.com/web/geek/jobs" },
  window: {},
  isBossChatUrl() { return false; },
  findStayOnCurrentPageButton() { return availableButton; },
  isInsideJobCopilot() { return false; },
  isElementVisible() { return true; },
  cleanText(value) { return String(value || "").trim(); },
  safeClick() { clickCount += 1; },
  setInterval() { return 1; },
  clearInterval() {},
  setTimeout(callback, delay) {
    delayed.push({ callback, delay });
    return delayed.length;
  },
  clearTimeout() {}
};
vm.runInNewContext(`${source.slice(start, end)}\nthis.createStayOnCurrentPageWaiter = createStayOnCurrentPageWaiter;`, context);

(async () => {
  const waiter = context.createStayOnCurrentPageWaiter();
  availableButton = {};
  mutationCallback();
  assert.equal(clickCount, 1, "observer must click confirmation immediately after insertion");
  delayed.find((item) => item.delay === 300).callback();
  assert.equal(await waiter.promise, "stayed");

  availableButton = null;
  const changedControlWaiter = context.createStayOnCurrentPageWaiter();
  successControls = [{ innerText: "继续沟通" }];
  mutationCallback();
  assert.equal(await changedControlWaiter.promise, "stayed",
    "a changed communication control must confirm a successful send without a dialog");

  successControls = [{ innerText: "继续聊" }];
  const alternateControlWaiter = context.createStayOnCurrentPageWaiter();
  mutationCallback();
  assert.equal(await alternateControlWaiter.promise, "stayed",
    "alternate BOSS success wording must confirm a successful send");

  availableButton = null;
  successControls = [];
  context.document.body.innerText = "已与BOSS沟通";
  const pageEvidenceWaiter = context.createStayOnCurrentPageWaiter();
  mutationCallback();
  assert.equal(await pageEvidenceWaiter.promise, "stayed",
    "page-level success evidence must confirm a successful send");

  console.log("Stay-on-page confirmation regression test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

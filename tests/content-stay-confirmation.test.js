const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const contactStart = source.indexOf("async function performIsolatedCommunication(expectedJob)");
const waiterStart = source.indexOf("createStayOnCurrentPageWaiter(12000)", contactStart);
const communicateClick = source.indexOf("clickWithoutNavigation(button)", contactStart);
const waiterAwait = source.indexOf("await stayWaiter.promise", contactStart);
assert.ok(contactStart < waiterStart && waiterStart < communicateClick && communicateClick < waiterAwait,
  "the disposable contact tab must observe the native confirmation before clicking");
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

  console.log("Stay-on-page confirmation regression test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

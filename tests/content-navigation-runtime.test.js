const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(new URL("../content.js", `file://${__dirname}/`), "utf8");
const helperStart = source.indexOf("function isBossJobDetailUrl");
const helperEnd = source.indexOf("function detailMatchesJob", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart,
  "owner-tab detail route guard helpers must exist");

const sandbox = {
  location: { href: "https://www.zhipin.com/web/geek/jobs?query=frontend" },
  historyBackCount: 0,
  history: {
    back() {
      sandbox.historyBackCount += 1;
      sandbox.location.href = "https://www.zhipin.com/web/geek/jobs?query=frontend";
    }
  },
  URL
};
vm.runInNewContext(
  `${source.slice(helperStart, helperEnd)}\nthis.clickWithoutOwnerNavigation = clickWithoutOwnerNavigation;`,
  sandbox
);

(async () => {
  let prevented = false;
  const anchor = {
    addEventListener(_type, listener) {
      listener({ preventDefault() { prevented = true; } });
    }
  };
  const node = {
    closest() { return anchor; },
    click() {
      // Simulate a BOSS SPA listener that ignores preventDefault and changes
      // history directly after the extension's synthetic card click.
      sandbox.location.href = "https://www.zhipin.com/job_detail/abc123.html";
    }
  };

  const stayedOnJobsPage = await sandbox.clickWithoutOwnerNavigation(
    node,
    "https://www.zhipin.com/web/geek/jobs?query=frontend"
  );

  assert.equal(prevented, true, "native anchor navigation must still be cancelled");
  assert.equal(stayedOnJobsPage, false,
    "an SPA route escape must make job selection fail closed");
  assert.equal(sandbox.historyBackCount, 1,
    "an SPA job-detail escape must immediately use browser history to preserve list state");
  assert.match(sandbox.location.href, /\/web\/geek\/jobs/);

  console.log("Owner-tab SPA navigation runtime test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "/Users/zengzeng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const projectDir = "/Users/zengzeng/Desktop/job-copilot/extension";
const browserExecutable = "/Users/zengzeng/Library/Caches/ms-playwright/chromium-1232/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const demoUrl = "http://127.0.0.1:4173/marketing/pipeline-demo.html?slow=1";
const docsDir = path.join(projectDir, "docs/images");
const socialDir = path.join(projectDir, "marketing/screenshots");

await fs.mkdir(docsDir, { recursive: true });
await fs.mkdir(socialDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "light"
});
const page = await context.newPage();
await page.goto(demoUrl, { waitUntil: "networkidle" });
await page.screenshot({ path: path.join(docsDir, "job-list-hd.png") });

await page.locator("#job-copilot-launcher").click();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(docsDir, "job-panel-hd.png") });

await page.locator("#jc-pipeline-control").click();
await page.waitForTimeout(3600);
await page.screenshot({ path: path.join(docsDir, "progress-hd.png") });
await browser.close();

const profileDir = await fs.mkdtemp("/tmp/job-copilot-extension-profile-");
const extensionContext = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  executablePath: browserExecutable,
  viewport: { width: 336, height: 590 },
  deviceScaleFactor: 3,
  args: [
    "--no-sandbox",
    `--disable-extensions-except=${projectDir}`,
    `--load-extension=${projectDir}`
  ]
});

let [worker] = extensionContext.serviceWorkers();
if (!worker) worker = await extensionContext.waitForEvent("serviceworker");
const extensionId = new URL(worker.url()).host;
const popup = await extensionContext.newPage();
await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "load" });
await popup.screenshot({ path: path.join(docsDir, "configuration-hd.png") });

await popup.evaluate(() => window.scrollTo(0, 560));
await popup.waitForTimeout(100);
await popup.screenshot({ path: path.join(docsDir, "preferences-hd.png") });

await popup.evaluate(() => window.scrollTo(0, 1120));
await popup.waitForTimeout(100);
await popup.screenshot({ path: path.join(docsDir, "resume-import-hd.png") });
await extensionContext.close();

const copies = [
  ["configuration-hd.png", "01-configuration-real-ui.png"],
  ["job-panel-hd.png", "02-job-panel-real-ui.png"],
  ["progress-hd.png", "03-progress-real-ui.png"],
  ["preferences-hd.png", "04-preferences-real-ui.png"],
  ["resume-import-hd.png", "05-resume-real-ui.png"]
];
for (const [source, target] of copies) {
  await fs.copyFile(path.join(docsDir, source), path.join(socialDir, target));
}

console.log(JSON.stringify({ extensionId, docsDir, socialDir, files: copies.map(([, target]) => target) }, null, 2));

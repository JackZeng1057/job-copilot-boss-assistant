import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "/Users/zengzeng/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const projectDir = "/Users/zengzeng/Desktop/job-copilot/extension";
const browserExecutable = "/Users/zengzeng/Library/Caches/ms-playwright/chromium-1232/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const rawDir = path.join(projectDir, "marketing/video/raw");
const outputPath = path.join(rawDir, "job-copilot-real-demo.webm");
await fs.mkdir(rawDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});
const context = await browser.newContext({
  viewport: { width: 720, height: 1280 },
  screen: { width: 720, height: 1280 },
  deviceScaleFactor: 1.5,
  colorScheme: "light",
  recordVideo: {
    dir: rawDir,
    size: { width: 720, height: 1280 }
  }
});
const page = await context.newPage();
const video = page.video();

await page.goto("http://127.0.0.1:4173/marketing/pipeline-demo.html?slow=1", { waitUntil: "networkidle" });
await page.mouse.move(680, 110);
await page.waitForTimeout(1800);

await page.locator("#job-copilot-launcher").click();
await page.waitForTimeout(1800);

await page.locator("#jc-pipeline-control").click();
await page.waitForTimeout(3600);

await page.locator("#jc-pipeline-control").click();
await page.waitForTimeout(1800);

await page.locator("#jc-pipeline-control").click();
await page.waitForTimeout(2600);

await page.locator("#fixture-page-b").click();
await page.waitForTimeout(1800);

await page.locator("#jc-rescan").click();
await page.waitForTimeout(1800);

await page.locator("#jc-pipeline-control").click();
await page.waitForTimeout(3600);

await context.close();
await video.saveAs(outputPath);
await browser.close();

console.log(outputPath);

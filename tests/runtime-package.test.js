// 在临时目录验证所有安装资源齐全，且不包含测试或开发文件。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { stageExtension } = require("../scripts/stage-extension");
const { root, runtimeFiles } = require("../scripts/runtime-files");

test("installation stage includes every runtime module and excludes development files", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "job-copilot-package-"));
  try {
    const files = stageExtension(temporary);
    assert.deepEqual(files, runtimeFiles());
    for (const file of files) {
      assert.equal(fs.readFileSync(path.join(temporary, file), "utf8"),
        fs.readFileSync(path.join(root, file), "utf8"));
    }
    for (const file of ["popup-resume.js", "background-ai-chat.js", "content-state.js", "vendor/pdfjs/pdf.worker.min.mjs"]) {
      assert.ok(fs.existsSync(path.join(temporary, file)), file);
    }
    for (const directory of ["tests", "docs", "scripts", ".github", ".git"]) {
      assert.equal(fs.existsSync(path.join(temporary, directory)), false);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

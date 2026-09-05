// 从 manifest 与后台入口读取测试源码，避免测试维护另一份模块加载清单。
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const readSource = (file) => fs.readFileSync(path.join(root, file), "utf8");

function contentFiles() {
  const manifest = JSON.parse(readSource("manifest.json"));
  return manifest.content_scripts
    .filter((entry) => entry.world !== "MAIN")
    .flatMap((entry) => entry.js || []);
}

function contentSource() {
  return contentFiles().map(readSource).join("\n");
}

// 仅供旧的源码断言和 VM 单元测试展开经典 worker 依赖。
// runtime-loading.test.js 另按真实 importScripts 语义逐个执行文件。
function backgroundSource() {
  return readSource("background.js").replace(/importScripts\(([\s\S]*?)\);/, (_, args) => {
    const files = JSON.parse(`[${args}]`);
    return files.map(readSource).join("\n");
  });
}

module.exports = { root, readSource, contentFiles, contentSource, backgroundSource };

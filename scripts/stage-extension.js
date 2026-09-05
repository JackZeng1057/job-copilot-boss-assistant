// 仅整理安装所需文件，不发布、不修改版本号。
const fs = require("node:fs");
const path = require("node:path");
const { root, runtimeFiles } = require("./runtime-files");

function stageExtension(destination) {
  const files = runtimeFiles();
  fs.mkdirSync(destination, { recursive: true });
  for (const file of files) {
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  fs.cpSync(path.join(root, "vendor"), path.join(destination, "vendor"), { recursive: true });
  if (fs.existsSync(path.join(root, "icons"))) {
    fs.cpSync(path.join(root, "icons"), path.join(destination, "icons"), { recursive: true });
  }
  return files;
}

if (require.main === module) {
  const destination = path.join(root, "dist/extension");
  // 此目录专用于生成安装文件，清理旧产物，避免已删除的模块混入新版本。
  fs.rmSync(destination, { recursive: true, force: true });
  const files = stageExtension(destination);
  console.log(`已整理 ${files.length} 个第一方资源及 vendor 目录：${destination}`);
}

module.exports = { stageExtension };

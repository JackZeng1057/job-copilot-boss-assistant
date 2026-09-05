// 使用本机 Node 检查全部第一方脚本，无需安装 lint 或构建依赖。
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { root, runtimeFiles } = require("./runtime-files");

const scripts = runtimeFiles().filter((file) => file.endsWith(".js"));
for (const file of scripts) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`资源引用及 ${scripts.length} 个运行脚本语法检查通过`);

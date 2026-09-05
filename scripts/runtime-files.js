// 从运行入口收集第一方资源；打包和检查共用此清单，避免拆分模块后漏装文件。
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

function runtimeFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const pending = ["manifest.json", "LICENSE", manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((entry) => [...(entry.js || []), ...(entry.css || [])])];
  const files = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    if (path.isAbsolute(file) || file.startsWith("..")) throw new Error(`无效资源路径：${file}`);
    const fullPath = path.join(root, file);
    if (!fs.statSync(fullPath).isFile()) throw new Error(`缺少运行资源：${file}`);
    files.add(file);
    // PDF.js 与 CMap 作为完整第三方目录复制，不对供应商代码作依赖分析。
    if (file.startsWith("vendor/") || !/\.(?:js|html)$/.test(file)) continue;
    const source = fs.readFileSync(fullPath, "utf8");
    const references = [];
    if (file.endsWith(".html")) {
      for (const match of source.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)) {
        references.push(match[1]);
      }
    } else {
      for (const match of source.matchAll(/\bimportScripts\(([\s\S]*?)\);/g)) {
        references.push(...JSON.parse(`[${match[1]}]`));
      }
      for (const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*|new URL\(\s*)["'](\.[^"']+)["']/g)) {
        references.push(match[1]);
      }
    }
    for (const reference of references) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), reference));
      if (!dependency.startsWith("vendor/")) pending.push(dependency);
    }
  }
  return [...files].sort();
}

module.exports = { root, runtimeFiles };

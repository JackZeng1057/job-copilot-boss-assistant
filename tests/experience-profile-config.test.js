const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync(new URL("../popup.html", `file://${__dirname}/`), "utf8");
const popup = fs.readFileSync(new URL("../popup.js", `file://${__dirname}/`), "utf8");
const background = fs.readFileSync(new URL("../background.js", `file://${__dirname}/`), "utf8");

assert.match(html, /id=["']experienceYears["'][^>]*type=["']number["'][^>]*min=["']0["']/,
  "settings must offer an optional non-negative experience-years field");
assert.match(html, /id=["']graduateStatus["'][\s\S]*value=["']unspecified["'][\s\S]*value=["']graduate["'][\s\S]*value=["']experienced["']/,
  "fresh-graduate status must be tri-state so existing users remain unspecified");

assert.match(popup, /experienceYears:\s*document\.getElementById\(["']experienceYears["']\)/);
assert.match(popup, /graduateStatus:\s*document\.getElementById\(["']graduateStatus["']\)/);
assert.match(popup, /experienceYears:\s*["']["']/,
  "legacy settings must default to no explicit experience claim");
assert.match(popup, /graduateStatus:\s*["']unspecified["']/,
  "legacy settings must not be classified as graduate or experienced automatically");
assert.match(popup, /experienceYears:\s*normalizeExperienceYears\(fields\.experienceYears\.value\)/,
  "experience years must be normalized before storage");
assert.match(popup, /graduateStatus:\s*normalizeGraduateStatus\(fields\.graduateStatus\.value\)/,
  "graduate status must be normalized before storage");

assert.match(background, /experienceYears:\s*["']["']/);
assert.match(background, /graduateStatus:\s*["']unspecified["']/);
assert.match(background, /【前台求职配置：个人经验与应届状态】/,
  "all providers must receive the same candidate experience context");
assert.match(background, /经验年限与应届身份[^\n]*0-6/,
  "experience and graduate status must have a small, explicit scoring weight");
assert.match(background, /经验年限与应届身份[^\n]*(?:不能|不得)[^\n]*(?:单独|直接)[^\n]*(?:淘汰|skip|excluded)/,
  "the low-weight profile factor must not become an automatic rejection rule");

console.log("Experience profile configuration tests passed");

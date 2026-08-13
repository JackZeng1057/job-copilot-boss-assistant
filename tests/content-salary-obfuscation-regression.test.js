const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = ["../content-job-scan.js", "../content-panel-layout.js", "../content.js"]
  .map((file) => fs.readFileSync(new URL(file, `file://${__dirname}/`), "utf8"))
  .join("\n");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const context = {};
vm.runInNewContext([
  "const frameworkSalaryCache = new WeakMap();",
  extractFunction("cleanText"),
  extractFunction("normalizeDisplaySalary"),
  extractFunction("findSalaryLine"),
  extractFunction("cleanTitleBase"),
  extractFunction("buildDisplayTitle"),
  extractFunction("salaryForAi"),
  extractFunction("findReadableSalaryInFrameworkState"),
  extractFunction("escapeHtml"),
  extractFunction("escapeAttr"),
  extractFunction("renderTitleHtml")
].join("\n"), context);

assert.equal(
  context.buildDisplayTitle("电商运营助理专员", "≡.≡≡K", "电商运营助理专员 ≡.≡≡K"),
  "电商运营助理专员",
  "encrypted salary glyphs must not be appended to the title"
);
assert.equal(
  context.buildDisplayTitle("电商运营助理专员", "██-██K", "电商运营助理专员 ██-██K"),
  "电商运营助理专员",
  "known block-style encrypted salaries must remain hidden"
);
assert.equal(
  context.cleanTitleBase("电商运营助理专员 ▤-▥K"),
  "电商运营助理专员",
  "encrypted salary glyphs embedded in the title node must be removed"
);
assert.equal(
  context.cleanTitleBase("电商运营助理专员 \uE123.\uE456K"),
  "电商运营助理专员",
  "private-use salary glyphs embedded in the title node must be removed"
);
assert.equal(
  context.cleanTitleBase("AI 全栈开发工程师（前端/App 方向） \uE123.\uE456薪"),
  "AI 全栈开发工程师（前端/App 方向）",
  "an encrypted compensation suffix must not leave a stray salary character in the title"
);
assert.equal(
  context.salaryForAi("██-██K"),
  "页面加密薪资：██-██K",
  "encrypted salary text must still reach AI instead of being silently omitted"
);
assert.equal(
  context.findReadableSalaryInFrameworkState({
    __vueParentComponent: {
      props: { job: { salaryDesc: "35-55K", title: "前端开发工程师" } }
    }
  }),
  "35-55K",
  "plain salary data in the card component state must be recovered for display and AI"
);
assert.match(
  context.renderTitleHtml({
    jobName: "电商运营助理专员",
    salary: "██-██K",
    salaryNode: {},
    text: ""
  }),
  /data-jc-salary-slot/,
  "encrypted salary rendering must reserve a slot for an exact DOM clone"
);
assert.match(source, /function mountSalaryVisualClone\(item, job\)/,
  "encrypted salaries must be mounted from an exact sanitized source clone");
assert.match(source, /cloneNode\(true\)/,
  "the source salary subtree must retain its real nested font structure");
assert.equal(
  context.buildDisplayTitle("电商运营助理专员", "12-18K", "电商运营助理专员 12-18K"),
  "电商运营助理专员 12-18K",
  "readable numeric salaries should still be displayed"
);
const readableSalaryHtml = context.renderTitleHtml({
  jobName: "前端开发工程师",
  salary: "15-30K·15薪",
  salaryFontFamily: "boss-obfuscated-font",
  text: ""
});
assert.match(readableSalaryHtml, /class="jc-salary-text"/,
  "decoded salary text must use the panel title typography class");
assert.doesNotMatch(readableSalaryHtml, /boss-obfuscated-font|font-family/,
  "decoded salaries must never inherit the BOSS salary font");
const cssSource = fs.readFileSync(new URL("../content.css", `file://${__dirname}/`), "utf8");
assert.match(cssSource, /\.jc-salary-source,\s*\n\.jc-salary-source \*[\s\S]*font-size:\s*12px\s*!important/,
  "fallback salary glyphs must use the same 12px size as the plugin job title");
assert.match(cssSource, /\.jc-salary-text[\s\S]*font-size:\s*12px\s*!important/,
  "decoded salary text must use the same 12px size as the plugin job title");

console.log("Content salary obfuscation regression tests passed");

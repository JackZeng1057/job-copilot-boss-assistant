// Job-card scraping: turns BOSS's DOM into the plain job records the rest of
// the content script works with. Nothing here reads or writes JC_STATE, so it
// can be read and changed on its own when BOSS changes its markup.

const KNOWN_JOB_CITIES = [
  "北京", "上海", "广州", "深圳", "杭州", "南京", "苏州", "成都", "重庆", "武汉", "西安", "天津",
  "长沙", "郑州", "青岛", "厦门", "合肥", "佛山", "东莞", "宁波", "无锡", "珠海", "福州"
];

const JOB_CARD_SELECTORS = [
  ".job-card-wrapper", ".job-list-box li", "li[class*='job-card']", "div[class*='job-card']"
];

const JOB_CARD_SELECTOR = JOB_CARD_SELECTORS.join(",");

const frameworkSalaryCache = new WeakMap();

function extractJobCity(text) {
  return KNOWN_JOB_CITIES.find((locationName) => String(text || "").includes(locationName)) || "";
}

function isLocationMetadata(text) {
  const value = cleanText(text);
  if (!value) return false;
  const hasKnownCity = KNOWN_JOB_CITIES.some((city) => value.includes(city));
  const looksLikeAddress = /(?:省|市|区|县|镇|街道|园区)(?:[·・\s]|$)/.test(value)
    || /^[\u4e00-\u9fa5]{2,12}(?:·[\u4e00-\u9fa5]{2,12}){1,3}$/.test(value);
  const hasRequirementSignal = /经验|学历|本科|大专|应届|不限|在校|实习|全职|兼职|技能|职责|要求/.test(value);
  return (hasKnownCity || looksLikeAddress) && !hasRequirementSignal;
}

function captureJobSnapshot() {
  const jobs = findCards().map((card, index) => {
    // innerText forces style/layout for every card. textContent is sufficient
    // for extraction and keeps repeated list snapshots off the rendering path.
    const text = cleanText(card.textContent || "");
    const salaryInfo = extractSalaryInfo(card, text);
    const jobName = extractJobName(card, text);
    const title = buildDisplayTitle(jobName, salaryInfo.text, text);
    const job = {
      index,
      card,
      text,
      title,
      jobName,
      company: extractCompany(card, text),
      city: extractJobCity(text),
      salary: salaryInfo.text,
      salaryFontFamily: salaryInfo.fontFamily,
      salaryVisualHtml: salaryInfo.visualHtml,
      salaryNode: salaryInfo.node,
      requirements: extractRequirements(text),
      url: extractUrl(card)
    };
    job.key = stableJobKey(job);
    return job;
  }).filter((job) => job.text.length > 10);
  return {
    jobs,
    fingerprint: fingerprintJobs(jobs),
    url: location.href.split("#")[0]
  };
}

function stableJobKey(job) {
  const idMatch = String(job.url || "").match(/\/job_detail\/([^/?#]+)/i);
  if (idMatch?.[1]) return `job:${idMatch[1]}`;
  const signature = [
    cleanText(job.jobName).toLowerCase(),
    cleanText(job.company).toLowerCase(),
    cleanText(job.city),
    cleanText(job.requirements).toLowerCase()
  ].join("|");
  return `card:${hashText(signature)}`;
}

function fingerprintJobs(jobs) {
  return hashText(jobs.map((job) => job.key).join("|"));
}

function hashText(text) {
  let hash = 2166136261;
  for (const char of String(text || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function findCards() {
  for (const selector of JOB_CARD_SELECTORS) {
    const cards = Array.from(document.querySelectorAll(selector));
    if (cards.length > 0) return cards;
  }
  return [];
}

function extractJobName(card, text) {
  // querySelector with a comma returns DOM order, not selector priority. A
  // broad job-title container may wrap both name and salary, so select the
  // narrow name node first.
  const selectors = [".job-name", "[class*='job-name']", ".job-title", "[class*='job-title']"];
  const node = selectors.map((selector) => card.querySelector(selector)).find(Boolean);
  const raw = cleanText(node?.textContent || "") || firstUsefulLine(card, text);
  return cleanTitleBase(raw).slice(0, 42) || "未知岗位";
}

function buildDisplayTitle(jobName, salary, cardText) {
  const displaySalary = normalizeDisplaySalary(salary) || normalizeDisplaySalary(findSalaryLine(cardText));
  return [jobName, displaySalary].filter(Boolean).join(" ").slice(0, 72);
}

function extractCompany(card, text) {
  const node = card.querySelector(".company-name, [class*='company']");
  return cleanText(node?.textContent || "").slice(0, 40) || "";
}

function extractSalaryInfo(card, text) {
  const node = findSalaryNode(card);
  const raw = cleanText(node?.textContent || node?.innerText || "");
  const sourceText = raw || text;
  const readable = findReadableSalaryMetadata(node)
    || normalizeDisplaySalary(sourceText)
    || findReadableSalaryInFrameworkState(card);
  if (readable) return { text: readable, fontFamily: "", visualHtml: "", node };
  if (node && /[Kk薪千]|[\u2200-\u22FF\u2500-\u259F\u25A0-\u25FF\uE000-\uF8FF]{2,}/.test(sourceText)) {
    return {
      text: sourceText,
      fontFamily: "",
      visualHtml: serializeSalaryVisual(node),
      node
    };
  }
  return { text: "", fontFamily: "", visualHtml: "", node: null };
}

function findReadableSalaryMetadata(node) {
  if (!node) return "";
  const nodes = [node, ...Array.from(node.querySelectorAll("*"))].slice(0, 40);
  for (const current of nodes) {
    for (const name of ["aria-label", "title", "data-salary", "data-text", "data-value", "data-original-title"]) {
      const readable = normalizeDisplaySalary(current.getAttribute?.(name) || "");
      if (readable) return readable;
    }
  }
  return "";
}

function findReadableSalaryInFrameworkState(card) {
  if (!card || (typeof card !== "object" && typeof card !== "function")) return "";
  const signature = String(card.textContent || "").slice(0, 180);
  const cached = frameworkSalaryCache.get(card);
  if (cached?.signature === signature) return cached.salary;
  let propertyNames = [];
  try {
    propertyNames = Object.getOwnPropertyNames(card);
  } catch {
    return "";
  }
  const roots = propertyNames
    .filter((name) => /^__(?:vue|react)/i.test(name))
    .map((name) => {
      try {
        return Object.getOwnPropertyDescriptor(card, name)?.value;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const queue = roots.map((value) => ({ value, depth: 0 }));
  const seen = new WeakSet();
  let inspected = 0;
  while (queue.length && inspected < 400) {
    const current = queue.shift();
    const value = current.value;
    if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) continue;
    seen.add(value);
    inspected += 1;
    let descriptors;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      continue;
    }
    const entries = Object.entries(descriptors).filter(([, descriptor]) => "value" in descriptor);
    entries.sort(([left], [right]) => {
      const salaryKey = (name) => /salary|pay|wage|薪|compensation/i.test(name) ? 0 : 1;
      return salaryKey(left) - salaryKey(right);
    });
    for (const [name, descriptor] of entries) {
      const nested = descriptor.value;
      if (typeof nested === "string" && nested.length <= 120
          && /salary|pay|wage|薪|compensation/i.test(name)) {
        const readable = normalizeDisplaySalary(nested);
        if (readable) {
          frameworkSalaryCache.set(card, { signature, salary: readable });
          return readable;
        }
      } else if (current.depth < 4 && nested
          && (typeof nested === "object" || typeof nested === "function")) {
        queue.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  frameworkSalaryCache.set(card, { signature, salary: "" });
  return "";
}

function serializeSalaryVisual(node) {
  if (!node) return "";
  const serializeChildren = (parent, depth = 0) => {
    if (depth > 6) return escapeHtml(parent.textContent || "");
    return Array.from(parent.childNodes).map((child) => {
      if (child.nodeType === Node.TEXT_NODE) return escapeHtml(child.textContent || "");
      if (!(child instanceof Element)) return "";
      const classes = Array.from(child.classList || [])
        .filter((name) => /^[A-Za-z0-9_-]{1,80}$/.test(name))
        .slice(0, 8)
        .join(" ");
      const classAttr = classes ? ` class="${classes}"` : "";
      return `<span${classAttr}>${serializeChildren(child, depth + 1)}</span>`;
    }).join("");
  };
  const rootClasses = Array.from(node.classList || [])
    .filter((name) => /^[A-Za-z0-9_-]{1,80}$/.test(name))
    .slice(0, 8)
    .join(" ");
  const classAttr = rootClasses ? ` ${rootClasses}` : "";
  return `<span class="jc-salary-source${classAttr}">${serializeChildren(node)}</span>`;
}

function normalizeDisplaySalary(text) {
  const value = cleanText(text || "");
  if (!value) return "";
  const salary = value.match(/\d+\s*[-~—]\s*\d+\s*[Kk](?:\s*[·,，、|｜/\\-]?\s*\d+\s*薪)?/);
  if (salary) return cleanText(salary[0].replace(/\s+/g, ""));
  return "";
}

function findSalaryLine(text) {
  const lines = String(text || "").split(/\n+|\s{2,}/).map((line) => cleanText(line));
  return lines.find((line) => /\d+\s*[-~—]\s*\d+\s*[Kk]|[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{1,}\s*[-~—]\s*[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{1,}\s*[Kk]/.test(line)) || "";
}

function findSalaryNode(card) {
  const selectors = [".salary", ".job-salary", "[class*='salary']", "[class*='Salary']", "[class*='red']"];
  for (const selector of selectors) {
    const node = card.querySelector(selector);
    if (node && /[Kk千薪█▉▊▋▌▍▎▏■\uE000-\uF8FF]/.test(node.textContent || "")) return node;
  }
  const nodes = Array.from(card.querySelectorAll("span,em,b,p,div"));
  return nodes.find((node) => /[█▉▊▋▌▍▎▏■\uE000-\uF8FF]{2,}|[Kk]|千|薪/.test(cleanText(node.textContent || ""))) || null;
}

function salaryForAi(text) {
  const value = cleanText(text || "");
  const normal = normalizeDisplaySalary(value);
  if (normal) return normal;
  return value ? `页面加密薪资：${value}` : "";
}

function cleanTitleBase(text) {
  return cleanText(String(text || "")
    .replace(/[\u2200-\u22FF\u2500-\u259F\u25A0-\u25FF\uE000-\uF8FF]{1,}\s*[.·\-~—]?\s*[\u2200-\u22FF\u2500-\u259F\u25A0-\u25FF\uE000-\uF8FF]{1,}\s*[Kk]?(?:\s*薪)?/g, "")
    .replace(/[\u2200-\u22FF\u2500-\u259F\u25A0-\u25FF\uE000-\uF8FF]{1,}\s*薪/g, "")
    .replace(/[\u2200-\u22FF\u2500-\u259F\u25A0-\u25FF\uE000-\uF8FF]{1,}/g, "")
    .replace(/\s+(?=[^\s]*[^\p{L}\p{N}])\S+[Kk]\s*$/gu, "")
    .replace(/\s+(?=[^\s]*[^\p{L}\p{N}])\S*薪\s*$/gu, "")
    .replace(/\d+\s*[-~—]\s*\d+\s*[Kk]/g, "")
    .replace(/\d+\s*薪/g, "")
    .replace(/[-~—]\s*[Kk]\b/g, "")
    .replace(/[·,，、|｜/\\-]+\s*$/g, "")
    .replace(/\s+[·,，、|｜/\\-]+/g, " "));
}

function extractRequirements(text) {
  const candidates = String(text || "").split(/\s{2,}| · | 丨 |\|/).map((item) => cleanText(item));
  const requirementParts = [];
  for (const item of candidates) {
    if (!item || requirementParts.includes(item)) continue;
    if (/^\d+\s*[-~—]\s*\d+\s*[Kk]$/.test(item)) continue;
    if (isLocationMetadata(item)) continue;
    if (/经验|学历|本科|大专|应届|不限|在校|实习|Java|后端|前端|测试|运维|Python|SQL|全职|兼职/.test(item)) {
      requirementParts.push(item.slice(0, 24));
    }
    if (requirementParts.length >= 3) break;
  }
  return requirementParts.join(" · ");
}

function extractUrl(card) {
  const link = card.querySelector("a[href]");
  if (!link) return "";
  const href = link.getAttribute("href") || "";
  if (!href || /^javascript:/i.test(href)) return "";
  return new URL(href, location.href).href;
}

function stripObfuscatedSalary(text) {
  return cleanText(String(text || "")
    .replace(/[█▉▊▋▌▍▎▏■]{2,}\s*[-~—]\s*[█▉▊▋▌▍▎▏■]{2,}\s*[Kk]?/g, "")
    .replace(/\d+\s*[-~—]\s*\d+\s*[Kk]/g, "")
    .replace(/[█▉▊▋▌▍▎▏■]{2,}\s*薪?/g, "")
    .replace(/薪资已隐藏/g, ""));
}

function buildJobTextForAi(job) {
  return stripObfuscatedSalary(job.text)
    .replace(/[█▉▊▋▌▍▎▏■]+/g, "")
    .slice(0, 3000);
}

function firstUsefulLine(card, fallbackText) {
  const lines = String(card.innerText || "").split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const line = lines.find((item) => !/沟通|收藏|薪|发布|经验|学历/.test(item) && !isLocationMetadata(item))
    || lines[0]
    || fallbackText;
  return line || "";
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function escapeAttr(text) {
  return String(text || "").replace(/[;"<>]/g, "");
}

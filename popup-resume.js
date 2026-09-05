// 简历文件解析；TXT、Markdown、DOCX 不加载 PDF.js，PDF 在用户导入时按需加载。
const PLAIN_TEXT_RESUME_EXTENSIONS = [".txt", ".md", ".markdown", ".text"];
const WORDPROCESSING_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export async function readResumeFile(file) {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return extractPdfText(await file.arrayBuffer());
  }
  if (name.endsWith(".docx")) {
    return extractDocxText(await file.arrayBuffer());
  }
  // accept 只过滤文件选择器；仍需校验格式，避免将二进制乱码当作简历正文。
  const isPlainText = file.type.startsWith("text/")
    || PLAIN_TEXT_RESUME_EXTENSIONS.some((extension) => name.endsWith(extension));
  if (!isPlainText) {
    throw new Error(`${describeResumeFormat(name)}暂不支持，请另存为 PDF、Word (.docx) 或纯文本后再导入`);
  }
  const text = await file.text();
  assertDecodedAsText(text, name);
  return text;
}

function describeResumeFormat(lowerCaseName) {
  const known = {
    ".doc": "旧版 Word 文档（.doc）", ".pages": "Pages 文档", ".rtf": "RTF 文档",
    ".html": "网页文件", ".htm": "网页文件", ".zip": "压缩包", ".wps": "WPS 文档"
  };
  const match = Object.keys(known).find((extension) => lowerCaseName.endsWith(extension));
  return match ? known[match] : "该文件格式";
}

// 识别伪装成文本扩展名的二进制内容，避免乱码进入分析提示词。
function assertDecodedAsText(text, name) {
  const sample = text.slice(0, 4000);
  if (!sample) return;
  const undecodable = (sample.match(/[\uFFFD\u0000]/g) || []).length;
  if (undecodable / sample.length > 0.02) {
    throw new Error(`${name} 不是纯文本文件，读取到的是乱码；请另存为 PDF、Word (.docx) 或纯文本后再导入`);
  }
}

// DOCX 正文位于 ZIP 的 word/document.xml，使用浏览器原生解压，无需新增依赖。
async function extractDocxText(buffer) {
  const xml = await readZipEntryAsText(new Uint8Array(buffer), "word/document.xml");
  if (!xml) throw new Error("这个 .docx 缺少正文（word/document.xml），可能已损坏");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("无法解析这个 .docx 的正文 XML，请另存为 PDF 或纯文本后再导入");
  }
  const paragraphs = Array.from(doc.getElementsByTagNameNS(WORDPROCESSING_NS, "p"))
    .map((paragraph) => docxParagraphText(paragraph).trim());
  return paragraphs.filter(Boolean).join("\n");
}

function docxParagraphText(paragraph) {
  let text = "";
  // 按文档顺序读取文本、制表符与换行，保留段落内部顺序。
  const walker = paragraph.ownerDocument.createTreeWalker(paragraph, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    if (node.namespaceURI !== WORDPROCESSING_NS) continue;
    if (node.localName === "t") text += node.textContent;
    else if (node.localName === "tab") text += "\t";
    else if (node.localName === "br" || node.localName === "cr") text += "\n";
  }
  return text;
}

async function readZipEntryAsText(bytes, entryName) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directoryOffset = findZipCentralDirectory(view);
  if (directoryOffset < 0) throw new Error("这个文件不是有效的 .docx（未找到 zip 目录）");

  for (let cursor = directoryOffset; cursor + 46 <= view.byteLength;) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name === entryName) {
      return inflateZipEntry(bytes, view, view.getUint32(cursor + 42, true),
        view.getUint16(cursor + 10, true), view.getUint32(cursor + 20, true));
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return "";
}

function findZipCentralDirectory(view) {
  // ZIP 目录结束记录位于末尾，注释最长 65535 字节，因此在该范围内反向查找。
  const limit = Math.max(0, view.byteLength - 0xffff - 22);
  for (let cursor = view.byteLength - 22; cursor >= limit; cursor -= 1) {
    if (view.getUint32(cursor, true) === 0x06054b50) return view.getUint32(cursor + 16, true);
  }
  return -1;
}

async function inflateZipEntry(bytes, view, localHeaderOffset, method, compressedSize) {
  if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
    throw new Error("这个 .docx 的内部结构异常，请另存后重试");
  }
  const dataStart = localHeaderOffset + 30
    + view.getUint16(localHeaderOffset + 26, true)
    + view.getUint16(localHeaderOffset + 28, true);
  const data = bytes.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return new TextDecoder().decode(data);
  if (method !== 8) throw new Error(`这个 .docx 使用了不支持的压缩方式（${method}）`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

async function extractPdfText(buffer) {
  const pdfjsLib = await import("./vendor/pdfjs/pdf.min.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).toString();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    cMapUrl: new URL("./vendor/pdfjs/cmaps/", import.meta.url).toString(),
    cMapPacked: true,
    useWorkerFetch: true
  });
  let pdf;
  try {
    pdf = await loadingTask.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/[^\S\r\n]+/g, " ")
        .trim();
      if (pageText) pages.push(pageText);
    }
    return pages.join("\n\n").trim();
  } finally {
    await loadingTask.destroy();
  }
}

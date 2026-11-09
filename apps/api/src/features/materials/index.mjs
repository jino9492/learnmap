import { open } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createHash } from "node:crypto";
import { AiError, validateMaterial } from "../../ai/index.ts";
import { extractPdfPages as defaultPdfExtractor } from "./pdf.mjs";

const MAX_BYTES = 20 * 1024 * 1024;
const CHUNK_SIZE = 12000;

function sourcesFromPages(pages) {
  if (!Array.isArray(pages)) throw new AiError("INPUT", "Text extraction returned invalid pages.");
  const sources = [];
  for (const [index, page] of pages.entries()) {
    if (typeof page !== "string") throw new AiError("INPUT", "Text extraction returned an invalid page.");
    const text = page.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
    if (!text) continue;
    for (let offset = 0; offset < text.length; offset += CHUNK_SIZE) {
      const chunk = text.slice(offset, offset + CHUNK_SIZE);
      if (!chunk.trim()) continue;
      sources.push({
        location: text.length > CHUNK_SIZE ? `page:${index + 1}:part:${offset / CHUNK_SIZE + 1}` : `page:${index + 1}`,
        text: chunk,
      });
    }
  }
  if (!sources.length) throw new AiError("INPUT", "No readable text was found. Image-only documents require OCR.");
  return sources;
}

export async function loadMaterial(path, { extractPdfPages = defaultPdfExtractor } = {}) {
  const extension = extname(path).toLowerCase();
  if (![".pdf", ".txt", ".md", ".json"].includes(extension)) {
    throw new AiError("INPUT", "Unsupported file type. Supported entry points: PDF, UTF-8 TXT, Markdown, or legacy material JSON. PPT/PPTX extraction is not connected yet.");
  }
  let file;
  let bytes;
  try {
    file = await open(path, "r");
    const info = await file.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) {
      throw new AiError("INPUT", "Input must be a nonempty file no larger than 20 MiB.");
    }
    bytes = await file.readFile();
    if (bytes.length > MAX_BYTES) throw new AiError("INPUT", "Input file exceeds 20 MiB.");
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError("INPUT", "Could not read the input file.");
  } finally { await file?.close(); }

  if (extension === ".json") {
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch { throw new AiError("INPUT", "The legacy material JSON is invalid."); }
    return validateMaterial(value);
  }

  let pages;
  if (extension === ".pdf") {
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new AiError("INPUT", "File does not have a PDF header.");
    try { pages = await extractPdfPages(new Uint8Array(bytes)); }
    catch (error) {
      if (error instanceof AiError) throw error;
      throw new AiError("INPUT", "Could not extract PDF text. Check whether the PDF is damaged or password-protected.");
    }
  } else {
    try { pages = [new TextDecoder("utf-8", { fatal: true }).decode(bytes)]; }
    catch { throw new AiError("INPUT", "Text documents must use UTF-8 encoding."); }
  }

  return validateMaterial({
    id: createHash("sha256").update(bytes).digest("hex"),
    title: basename(path).slice(0, 12000),
    sources: sourcesFromPages(pages),
  });
}

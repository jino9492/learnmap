import { fileURLToPath } from "node:url";
import { AiError } from "../../ai/core/errors.ts";
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recognizePdfImages } from './ocr.mjs';

export async function extractPdfPages(bytes, { recognizeImages = recognizePdfImages } = {}) {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const packageUrl = import.meta.resolve("pdfjs-dist/package.json");
  const task = getDocument({
    data: bytes,
    cMapUrl: fileURLToPath(new URL("./cmaps/", packageUrl)).replaceAll("\\", "/"),
    cMapPacked: true,
    standardFontDataUrl: fileURLToPath(new URL("./standard_fonts/", packageUrl)).replaceAll("\\", "/"),
    isEvalSupported: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  let directory;
  try {
    const document = await task.promise;
    const pages = [];
    const images = [];
    const imagePages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .filter((item) => "str" in item)
          .map((item) => item.str + (item.hasEOL ? "\n" : " "))
          .join("").trim();
        pages.push(text);
        // A few selectable bullets/captions must not hide an image-based body.
        if ((text.match(/[\p{L}\p{N}]/gu) ?? []).length < 100) {
          const operators = await page.getOperatorList();
          const visual = operators.fnArray.some((op) => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(op))
            || operators.fnArray.filter((op) => op === OPS.constructPath).length > 20;
          if (visual) {
            directory ??= await mkdtemp(join(tmpdir(), 'learnmap-ocr-'));
            const initial = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: Math.min(2, 2400 / Math.max(initial.width, initial.height)) });
            const canvas = document.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
            try {
              await page.render({ canvasContext: canvas.context, viewport }).promise;
              const path = join(directory, `page-${number}.png`);
              await writeFile(path, canvas.canvas.toBuffer('image/png'));
              images.push(path);
              imagePages.push(number - 1);
            } finally { document.canvasFactory.destroy(canvas); }
          }
        }
      } finally { page.cleanup(); }
    }
    if (images.length) {
      const recognized = await recognizeImages(images, directory);
      if (!Array.isArray(recognized) || recognized.length !== images.length || recognized.some((text) => typeof text !== 'string')) {
        throw new AiError('OCR_REQUIRED', 'OCR 결과가 올바르지 않습니다. 텍스트를 포함한 PDF로 다시 시도해 주세요.');
      }
      for (const [index, text] of recognized.entries()) {
        const number = imagePages[index];
        // OCR reads the whole rendered page, including the selectable captions.
        if (text.trim()) pages[number] = text.trim();
      }
      if (imagePages.filter((index) => (pages[index].match(/[\p{L}\p{N}]/gu) ?? []).length >= 20).length < imagePages.length / 2) {
        throw new AiError('OCR_REQUIRED', 'PDF에서 충분한 본문을 인식하지 못했습니다. OCR 언어와 문서 화질을 확인해 주세요.');
      }
    }
    return pages;
  } catch (error) {
    if (error instanceof AiError) throw error;
    if (error instanceof Error && error.name === "PasswordException") {
      throw new AiError("INPUT", "Password-protected PDFs are not supported. Provide an unlocked copy.");
    }
    throw new AiError("INPUT", "Could not extract PDF text. The file may be damaged or use an unsupported PDF structure.");
  } finally {
    await task.destroy();
    // Only remove the directory created by mkdtemp above.
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

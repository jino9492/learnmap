import { fileURLToPath } from "node:url";
import { AiError } from "../../ai/core/errors.ts";

export async function extractPdfPages(bytes) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
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
  try {
    const document = await task.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .filter((item) => "str" in item)
          .map((item) => item.str + (item.hasEOL ? "\n" : " "))
          .join("").trim();
        pages.push(text);
      } finally { page.cleanup(); }
    }
    return pages;
  } catch (error) {
    if (error instanceof AiError) throw error;
    if (error instanceof Error && error.name === "PasswordException") {
      throw new AiError("INPUT", "Password-protected PDFs are not supported. Provide an unlocked copy.");
    }
    throw new AiError("INPUT", "Could not extract PDF text. The file may be damaged or use an unsupported PDF structure.");
  } finally { await task.destroy(); }
}

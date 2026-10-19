export const PDF_MAX_PAGES = 3;

export type OcrResult = { text: string; confidence: number };
/** Returns null when OCR is not possible without a network call that the caller disallowed. */
export type OcrRunner = (bytes: Uint8Array, opts: { allowNetwork: boolean }) => Promise<OcrResult | null>;

export type PdfResult = { text: string; title?: string; pages: number };
export type PdfReader = (bytes: Uint8Array) => Promise<PdfResult>;

/**
 * tesseract.js OCR. Language data comes from TESSDATA_PATH when set (fully local);
 * otherwise it is downloaded once from the tesseract.js CDN, which counts as a network call.
 */
export const tesseractOcr: OcrRunner = async (bytes, { allowNetwork }) => {
  const langPath = process.env.TESSDATA_PATH;
  if (!langPath && !allowNetwork) return null;
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    ...(langPath ? { langPath, gzip: false } : {}),
    cachePath: process.env.TESSDATA_CACHE ?? ".cache/tessdata",
  });
  try {
    const { data } = await worker.recognize(Buffer.from(bytes));
    return { text: data.text ?? "", confidence: Math.max(0, Math.min(1, (data.confidence ?? 0) / 100)) };
  } finally {
    await worker.terminate();
  }
};

/** pdfjs-dist text layer of the first PDF_MAX_PAGES pages. Runs locally, no network. */
export const pdfjsReader: PdfReader = async (bytes) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= Math.min(PDF_MAX_PAGES, doc.numPages); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        } else if (item.str && !item.str.endsWith(" ")) {
          line += " ";
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join("\n"));
      page.cleanup();
    }
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as { Title?: unknown };
    return {
      text: pages.join("\n\n"),
      title: typeof info.Title === "string" ? info.Title : undefined,
      pages: doc.numPages,
    };
  } finally {
    await task.destroy();
  }
};

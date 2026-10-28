// Copied from the PDF Auto-Summariser (src/lib/pdf.ts). Kept as a copy rather
// than a shared package; port fixes across by hand.
//
// PDF text extraction. We try three strategies in order:
//
//   1. Zotero.Fulltext.getItemContent — fast path if already indexed.
//   2. Zotero.PDFWorker direct extraction — same engine the reader uses.
//   3. The cache file Zotero writes after extracting (.zotero-ft-cache).
//
// Zotero 9 made the Fulltext APIs sensitive to whether you pass an item
// object versus an ID; pass the object to be safe.

function log(msg: string): void {
  Zotero.debug(`[Reading Partner] ${msg}`);
}

export async function getPdfText(
  attachmentItem: any,
  maxChars: number,
  _waitSeconds: number
): Promise<string> {
  // Strategy 1: existing index.
  let text = await tryReadIndex(attachmentItem);
  if (text) {
    log(`extracted via index (${text.length} chars)`);
    return trimForModel(text, maxChars);
  }

  // Strategy 2: direct PDFWorker extraction. This is what Zotero uses for
  // its own full-text indexing, so it should work whenever the file is on
  // disk and readable.
  log("index empty; trying direct PDFWorker extraction");
  text = await tryDirectExtract(attachmentItem);
  if (text) {
    log(`extracted via PDFWorker (${text.length} chars)`);
    return trimForModel(text, maxChars);
  }

  // Strategy 3: try reading the cache file directly. Zotero writes
  // .zotero-ft-cache alongside the PDF after extracting it.
  log("PDFWorker returned no usable text; trying cache file");
  text = await tryReadCacheFile(attachmentItem);
  if (text) {
    log(`extracted via cache file (${text.length} chars)`);
    return trimForModel(text, maxChars);
  }

  // Strategy 4: trigger indexing and check the cache file again after a
  // moment. Zotero.Fulltext.indexItems creates the cache file as a side
  // effect even if our earlier check failed.
  log("cache file empty; forcing reindex and retrying");
  try {
    await Zotero.Fulltext.indexItems([attachmentItem.id], { complete: true });
  } catch (e: any) {
    // Older Zotero builds use a positional boolean instead of an options
    // object. Try that too.
    try {
      await Zotero.Fulltext.indexItems([attachmentItem.id], true);
    } catch (e2: any) {
      log(`indexItems failed both shapes: ${e?.message}, ${e2?.message}`);
    }
  }
  await sleep(2000);

  text = await tryReadCacheFile(attachmentItem);
  if (text) {
    log(`extracted via cache file after reindex (${text.length} chars)`);
    return trimForModel(text, maxChars);
  }

  text = await tryReadIndex(attachmentItem);
  if (text) {
    log(`extracted via index after reindex (${text.length} chars)`);
    return trimForModel(text, maxChars);
  }

  throw new Error(
    "Could not extract text from PDF. The file may be image-only " +
      "(scanned without OCR), corrupted, or not on local disk."
  );
}

async function tryReadIndex(attachmentItem: any): Promise<string> {
  try {
    // Zotero 9 prefers being passed the item object, not the ID.
    const content = await Zotero.Fulltext.getItemContent(attachmentItem);
    if (typeof content === "string" && content.length > 0) return content;
    return "";
  } catch (e: any) {
    // Don't log every miss as an error — it's expected when not yet indexed.
    return "";
  }
}

async function tryDirectExtract(attachmentItem: any): Promise<string> {
  try {
    const worker = (Zotero as any).PDFWorker;
    if (!worker || typeof worker.getFullText !== "function") {
      log("Zotero.PDFWorker.getFullText not available");
      return "";
    }

    let result: any;
    try {
      result = await worker.getFullText(attachmentItem.id, -1);
    } catch {
      try {
        result = await worker.getFullText(attachmentItem.id, 100000);
      } catch (e2: any) {
        log(`getFullText threw: ${e2?.message || e2}`);
        return "";
      }
    }

    return normalisePDFWorkerResult(result);
  } catch (e: any) {
    log(`tryDirectExtract error: ${e?.message || e}`);
    return "";
  }
}

// Zotero ships at least three shapes across versions:
//   { text: string, ... }
//   { extractedText: string, ... }
//   { text: string, extractedPages: [{text, ...}], totalPages: number }
//   { pages: [string | {text}] }
// And `text` itself may be a string, an array of strings, or empty.
function normalisePDFWorkerResult(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;

  // Direct top-level text. Common in Zotero 7.
  if (typeof result.text === "string" && result.text.length > 0) {
    return result.text;
  }
  if (Array.isArray(result.text)) {
    return result.text.join("\n\n");
  }

  // Older alternate name.
  if (typeof result.extractedText === "string" && result.extractedText.length > 0) {
    return result.extractedText;
  }

  // Zotero 9 shape: extractedPages is the array of page objects.
  if (Array.isArray(result.extractedPages)) {
    const joined = result.extractedPages
      .map((p: any) => {
        if (typeof p === "string") return p;
        return p?.text || p?.content || "";
      })
      .filter(Boolean)
      .join("\n\n");
    if (joined) return joined;
  }

  // Generic "pages" array fallback.
  if (Array.isArray(result.pages)) {
    const joined = result.pages
      .map((p: any) => (typeof p === "string" ? p : p?.text || ""))
      .filter(Boolean)
      .join("\n\n");
    if (joined) return joined;
  }

  log(
    `PDFWorker result unparseable. Keys: ${JSON.stringify(Object.keys(result))}. ` +
      `text type: ${typeof result.text}. ` +
      `extractedPages: ${Array.isArray(result.extractedPages) ? result.extractedPages.length : "n/a"}`
  );
  return "";
}

// Read .zotero-ft-cache directly. Zotero writes this file after indexing.
// On the user's machine the sync log showed:
//   "Getting full-text content from cache file for item 1/TMFCRTWL"
//   "Getting contents of /Users/.../Zotero/storage/TMFCRTWL/.zotero-ft-cache"
// So this path exists and is reliable once indexing has run at least once.
async function tryReadCacheFile(attachmentItem: any): Promise<string> {
  try {
    const filePath = await attachmentItem.getFilePathAsync();
    if (!filePath) {
      log("attachment has no local file path");
      return "";
    }

    // The cache file sits next to the PDF as .zotero-ft-cache.
    // Build that path by replacing the filename.
    const PathUtils = (globalThis as any).PathUtils;
    const IOUtils = (globalThis as any).IOUtils;
    if (!PathUtils || !IOUtils) {
      log("PathUtils/IOUtils not available");
      return "";
    }

    const dir = PathUtils.parent(filePath);
    if (!dir) return "";
    const cachePath = PathUtils.join(dir, ".zotero-ft-cache");

    const exists = await IOUtils.exists(cachePath);
    if (!exists) {
      log(`cache file not found at ${cachePath}`);
      return "";
    }

    const text = await IOUtils.readUTF8(cachePath);
    return typeof text === "string" ? text : "";
  } catch (e: any) {
    log(`tryReadCacheFile error: ${e?.message || e}`);
    return "";
  }
}

// Take the first portion plus a tail. Most academic papers front-load the
// abstract/intro and back-load the conclusion; the middle is methods detail
// and citations that contribute less to a summary.
export function trimForModel(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = maxChars - headChars - 100;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  return `${head}\n\n[... middle of document elided ...]\n\n${tail}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

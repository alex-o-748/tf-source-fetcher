'use strict';

// PDF.js 5 uses Math.sumPrecise in a handful of code paths. It is available
// in newer Node releases, but Toolforge may run this service on Node 20 where
// it is absent. PDF.js catches some of those failures and logs a warning, but
// that still leaves the operation half-finished and its resources live. Keep
// the runtime compatibility local to the dependency instead of requiring a
// larger heap or accepting the repeated warning.
if (typeof Math.sumPrecise !== 'function') {
  Math.sumPrecise = function sumPrecise(values) {
    // Neumaier compensated summation. PDF.js only needs finite numeric arrays,
    // but reject non-numbers like the native proposal does rather than hiding
    // bad input from the library.
    let sum = 0;
    let correction = 0;
    for (const value of values) {
      if (typeof value !== 'number') throw new TypeError('Math.sumPrecise values must be numbers');
      const next = sum + value;
      correction +=
        Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
      sum = next;
    }
    return sum + correction;
  };
}

const { extractText: extractPdfText, getDocumentProxy } = require('unpdf');
const { MAX_CONTENT_CHARS } = require('./config');

function truncate(text) {
  if (text.length <= MAX_CONTENT_CHARS) {
    return { content: text, truncated: false };
  }
  return { content: text.slice(0, MAX_CONTENT_CHARS), truncated: true };
}

class InvalidPageError extends Error {
  constructor(totalPages) {
    super(`Invalid page number. PDF has ${totalPages} pages.`);
    this.totalPages = totalPages;
  }
}

// Extracts text from a PDF buffer. When `pageParam` (1-based) is given, only
// that page is extracted; otherwise the whole document is extracted and
// truncated per MAX_CONTENT_CHARS (large PDFs fetched without a page param
// rely on the `truncated` flag, per the client's own "large PDF without page"
// warning behavior).
const destructionTasks = new WeakMap();

function destroyPdf(pdf) {
  if (!pdf) return;
  if (destructionTasks.has(pdf)) return destructionTasks.get(pdf);
  const task = (async () => {
    try {
      // cleanup() releases page operator lists, fonts, decoded images and other
      // per-page caches immediately. destroy() below also cleans up, but doing
      // this explicitly makes the intent clear and supports PDF.js versions
      // where destruction delegates less aggressively.
      await pdf.cleanup?.();
    } finally {
      // unpdf returns a PDFDocumentProxy created by a loading task. Destroying
      // that task also terminates its worker/transport and releases the source
      // Uint8Array. Fall back to the public proxy API for compatible mocks and
      // alternate PDF.js builds.
      if (pdf.loadingTask?.destroy) await pdf.loadingTask.destroy();
      else await pdf.destroy?.();
    }
  })();
  destructionTasks.set(pdf, task);
  return task;
}

async function extractPdf(buf, pageParam, { signal } = {}) {
  let pdf;
  let abortCleanup;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf));

    // PDF parsing happens after the response body has downloaded, so aborting
    // fetch alone cannot stop it. On request timeout/client disconnect,
    // destroy the loading task to interrupt outstanding page/font/operator
    // work. The finally block remains the single guaranteed cleanup path.
    if (signal) {
      const abort = () => void destroyPdf(pdf).catch(() => {});
      signal.addEventListener('abort', abort, { once: true });
      abortCleanup = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }

    const totalPages = pdf.numPages;

    let pages;
    let page = null;
    if (pageParam !== undefined && pageParam !== null) {
      const pageNum = parseInt(pageParam, 10);
      if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > totalPages) {
        throw new InvalidPageError(totalPages);
      }
      pages = [pageNum];
      page = pageNum;
    }

    const { text } = await extractPdfText(pdf, { mergePages: true, pages });
    const normalized = text.replace(/\s+/g, ' ').trim();
    const { content, truncated } = truncate(normalized);

    return { content, truncated, totalPages, page };
  } finally {
    abortCleanup?.();
    await destroyPdf(pdf);
  }
}

module.exports = { extractPdf, InvalidPageError, destroyPdf };

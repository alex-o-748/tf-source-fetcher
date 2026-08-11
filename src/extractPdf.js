'use strict';

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
async function extractPdf(buf, pageParam) {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
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
}

module.exports = { extractPdf, InvalidPageError };

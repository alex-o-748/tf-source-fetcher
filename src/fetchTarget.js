'use strict';

const { extractHtml } = require('./extractHtml');
const { extractPdf, InvalidPageError } = require('./extractPdf');
const {
  USER_AGENT,
  FETCH_TIMEOUT_MS,
  MAX_HTML_BYTES,
  MAX_PDF_BYTES,
  MIN_CONTENT_CHARS,
} = require('./config');

const NO_CONTENT_ERROR = 'Source content was empty or too short to verify';

function emptyResultBase(status, fetchedAt) {
  return {
    content: null,
    error: null,
    status,
    pdf: false,
    totalPages: null,
    page: null,
    truncated: false,
    fetchedAt,
  };
}

// Reads a response body while enforcing a byte cap, so a huge/streaming
// response can't exhaust memory before we get a chance to reject it.
async function readBodyWithLimit(response, maxBytes) {
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      const err = new Error('Response too large');
      err.code = 'TOO_LARGE';
      throw err;
    }
    return buf;
  }

  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      const err = new Error('Response too large');
      err.code = 'TOO_LARGE';
      throw err;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function isPdf(targetUrl, contentType) {
  if (contentType && contentType.includes('application/pdf')) return true;
  try {
    return new URL(targetUrl).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return targetUrl.toLowerCase().endsWith('.pdf');
  }
}

// Performs the upstream fetch + extraction for one target URL. Does not
// touch the cache or the per-host rate limiter — the caller (server.js)
// handles those, since robots.txt / rate-limit checks must happen before
// this runs and the result needs to be cache-keyed by the caller.
//
// Returns one of:
//   { networkError: true, error }                    — upstream unreachable
//   { invalidPage: true, error, status, totalPages }  — bad `page` for a PDF
//   { content, error, status, pdf, totalPages, page, truncated, fetchedAt }
async function fetchAndExtract(targetUrl, pageParam) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/pdf,*/*',
      },
    });
  } catch (e) {
    clearTimeout(timer);
    const reason =
      e.name === 'AbortError' ? 'Request to source timed out' : e.message || 'Network error';
    return { networkError: true, error: reason };
  }

  const fetchedAt = new Date().toISOString();
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const pdf = isPdf(targetUrl, contentType);

  if (!response.ok) {
    clearTimeout(timer);
    try {
      await response.body?.cancel();
    } catch {
      // ignore — we only needed the status
    }
    return {
      ...emptyResultBase(response.status, fetchedAt),
      error: `Source returned HTTP ${response.status}`,
    };
  }

  let buf;
  try {
    buf = await readBodyWithLimit(response, pdf ? MAX_PDF_BYTES : MAX_HTML_BYTES);
  } catch (e) {
    clearTimeout(timer);
    if (e.code === 'TOO_LARGE') {
      return {
        ...emptyResultBase(response.status, fetchedAt),
        error: `Source content exceeds the ${pdf ? 'PDF' : 'HTML'} size limit`,
      };
    }
    return { networkError: true, error: e.message || 'Failed reading response body' };
  }
  clearTimeout(timer);

  if (pdf) {
    let extracted;
    try {
      extracted = await extractPdf(buf, pageParam);
    } catch (e) {
      if (e instanceof InvalidPageError) {
        return {
          invalidPage: true,
          error: e.message,
          status: response.status,
          totalPages: e.totalPages,
          fetchedAt,
        };
      }
      // Corrupt/unparseable PDF: we got a response, just nothing usable.
      return { ...emptyResultBase(response.status, fetchedAt), error: NO_CONTENT_ERROR };
    }

    if (extracted.content.length < MIN_CONTENT_CHARS) {
      return { ...emptyResultBase(response.status, fetchedAt), error: NO_CONTENT_ERROR };
    }

    return {
      content: extracted.content,
      error: null,
      status: response.status,
      pdf: true,
      totalPages: extracted.totalPages,
      page: extracted.page,
      truncated: extracted.truncated,
      fetchedAt,
    };
  }

  const html = buf.toString('utf8');
  const extracted = extractHtml(html, targetUrl);

  if (extracted.content.length < MIN_CONTENT_CHARS) {
    return { ...emptyResultBase(response.status, fetchedAt), error: NO_CONTENT_ERROR };
  }

  return {
    content: extracted.content,
    error: null,
    status: response.status,
    pdf: false,
    totalPages: null,
    page: null,
    truncated: extracted.truncated,
    fetchedAt,
  };
}

module.exports = { fetchAndExtract, isPdf };

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

// Why a fetch failed, for the counters — never for the `error` string.
//
// Four different failures all landed in one `networkError` counter, and
// Node's fetch makes that worse: undici reports nearly everything as
// `TypeError: fetch failed` and puts the real reason in `err.cause.code`. So
// a run reporting "18% network errors" could be a dead host, an expired
// certificate, a slow publisher, or a bug in this process, and the metrics
// could not tell them apart.
//
// THE RETURNED `error` STRING IS DELIBERATELY UNCHANGED. The client
// (citation-checker-script's core/worker.js) decides whether to retry by
// matching it: `/^(?:fetch failed|terminated)$/` means the fetcher never
// reached the publisher and is worth retrying, while "Request to source timed
// out" is deliberately NOT retried because it will time out again. Replacing
// "fetch failed" with "getaddrinfo ENOTFOUND example.com" would silently turn
// every retryable transport failure into a permanent SOURCE UNAVAILABLE row.
// Categorise for us; keep the wording for them.
const NET_CATEGORIES = {
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  ECONNREFUSED: 'refused',
  ECONNRESET: 'reset',
  EPIPE: 'reset',
  UND_ERR_SOCKET: 'reset',
  ETIMEDOUT: 'timeout',
  UND_ERR_CONNECT_TIMEOUT: 'timeout',
  UND_ERR_HEADERS_TIMEOUT: 'timeout',
  UND_ERR_BODY_TIMEOUT: 'timeout',
  EPROTO: 'tls',
  CERT_HAS_EXPIRED: 'tls',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls',
  SELF_SIGNED_CERT_IN_CHAIN: 'tls',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls',
  HPE_INVALID_CONSTANT: 'protocol',
  HPE_INVALID_HEADER_TOKEN: 'protocol',
  UND_ERR_INVALID_ARG: 'protocol',
  ERR_INVALID_URL: 'url',
  ERR_UNESCAPED_CHARACTERS: 'url',
};

function networkErrorCode(e) {
  return e?.cause?.code || e?.code || null;
}

// Returns { category, code }. `code` is the raw one, reported so a category
// that comes back mostly `other` can be widened from evidence rather than
// guesswork.
function classifyNetworkError(e, fallback = 'other') {
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return { category: 'timeout', code: e.name };
  }
  const code = networkErrorCode(e);
  if (code && NET_CATEGORIES[code]) return { category: NET_CATEGORIES[code], code };

  const text = `${e?.message || ''} ${e?.cause?.message || ''}`;
  if (/certificate|SSL|TLS/i.test(text)) return { category: 'tls', code };
  if (/socket hang up|aborted/i.test(text)) return { category: 'reset', code };

  return { category: fallback, code };
}


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
//
// Every shape that got as far as reading a body also carries `bytes`, the
// size of that body — reported to src/metrics.js and nothing else.
async function fetchAndExtract(targetUrl, pageParam, { signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let bytes = 0;

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
    signal?.removeEventListener('abort', abort);
    const reason =
      e.name === 'AbortError' ? 'Request to source timed out' : e.message || 'Network error';
    const { category, code } = classifyNetworkError(e);
    return { networkError: true, error: reason, netCategory: category, netCode: code };
  }

  const fetchedAt = new Date().toISOString();
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const pdf = isPdf(targetUrl, contentType);

  if (!response.ok) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
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
    // Reported to src/metrics.js. Heap growth that tracks bytes read rather
    // than requests served is a different bug from one that tracks either.
    bytes = buf.byteLength;
  } catch (e) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (e.code === 'TOO_LARGE') {
      return {
        ...emptyResultBase(response.status, fetchedAt),
        error: `Source content exceeds the ${pdf ? 'PDF' : 'HTML'} size limit`,
      };
    }
    // Defaults to `body` rather than `other`: getting this far means the
    // connection was established and the headers were fine, so a failure here
    // is a download that died part-way, not a host we never reached.
    const { category, code } = classifyNetworkError(e, 'body');
    return {
      networkError: true,
      error: e.message || 'Failed reading response body',
      netCategory: category,
      netCode: code,
    };
  }
  try {
    if (pdf) {
      let extracted;
      try {
        extracted = await extractPdf(buf, pageParam, { signal: controller.signal });
      } catch (e) {
        if (e instanceof InvalidPageError) {
          return {
            invalidPage: true,
            error: e.message,
            status: response.status,
            totalPages: e.totalPages,
            fetchedAt,
            bytes,
          };
        }
        // Corrupt/unparseable PDF: we got a response, just nothing usable.
        return { ...emptyResultBase(response.status, fetchedAt), error: NO_CONTENT_ERROR, bytes };
      }

      if (extracted.content.length < MIN_CONTENT_CHARS) {
        return { ...emptyResultBase(response.status, fetchedAt), error: NO_CONTENT_ERROR, bytes };
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
        bytes,
      };
    }

    const html = buf.toString('utf8');
    const extracted = extractHtml(html, targetUrl);

    // bodyChars, not content.length: content carries a Title/Published/By
    // header, and a login wall with a long headline and byline would otherwise
    // clear this floor on metadata alone and be reported as usable content.
    if (extracted.bodyChars < MIN_CONTENT_CHARS) {
      return {
        ...emptyResultBase(response.status, fetchedAt),
        error: NO_CONTENT_ERROR,
        bytes,
      };
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
      bytes,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = { fetchAndExtract, isPdf, classifyNetworkError };

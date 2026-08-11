'use strict';

// Descriptive UA with a contact URL, per Wikimedia's bot-etiquette expectations
// (mirrors the style of LIFTWING_USER_AGENT in the reference public-ai-proxy Worker).
const USER_AGENT =
  'source-fetcher/1.0 (+https://github.com/alex-o-748/tf-source-fetcher; ' +
  'fetches citation sources for Wikipedia citation verification; running on Wikimedia Toolforge)';

module.exports = {
  PORT: process.env.PORT || 8080,

  USER_AGENT,

  // Text extraction is capped to match the tuning already established by the
  // reference Cloudflare Worker (public-ai-proxy's extractText / PDF path both
  // use `.substring(0, 100000)`).
  MAX_CONTENT_CHARS: 100000,

  // The client (core/worker.js) discards content.length <= 100 as unverifiable.
  MIN_CONTENT_CHARS: 101,

  // Network fetch of the upstream page/PDF, including reading the body.
  FETCH_TIMEOUT_MS: Number(process.env.FETCH_TIMEOUT_MS) || 20000,

  // robots.txt lookups should be quick; a slow/hanging robots.txt shouldn't
  // block the actual fetch for long.
  ROBOTS_TIMEOUT_MS: Number(process.env.ROBOTS_TIMEOUT_MS) || 5000,
  ROBOTS_CACHE_TTL_MS: Number(process.env.ROBOTS_CACHE_TTL_MS) || 60 * 60 * 1000,

  // Response body size guards. Toolforge gives this tool a heavier memory
  // budget than the other two tools specifically for PDF parsing / large
  // buffers, so these are a bit more generous than the Worker's 10 MB PDF cap.
  MAX_HTML_BYTES: Number(process.env.MAX_HTML_BYTES) || 20 * 1024 * 1024,
  MAX_PDF_BYTES: Number(process.env.MAX_PDF_BYTES) || 25 * 1024 * 1024,

  // Per-host politeness: minimum gap between two outbound requests to the
  // same host, and how long a request may queue waiting for its turn before
  // we give up and tell the caller to retry later.
  HOST_MIN_INTERVAL_MS: Number(process.env.HOST_MIN_INTERVAL_MS) || 1000,
  HOST_MAX_QUEUE_WAIT_MS: Number(process.env.HOST_MAX_QUEUE_WAIT_MS) || 8000,
  // How long to back a host off after it returns a 429 to us.
  HOST_BACKOFF_MS: Number(process.env.HOST_BACKOFF_MS) || 30000,

  // Cache (Redis). Toolforge's shared Redis instance is documented as
  // reachable at tools-redis:6379 from any tool's containers; namespaced by
  // key prefix below so tools sharing the instance don't collide.
  REDIS_URL: process.env.REDIS_URL || 'redis://tools-redis:6379',
  CACHE_KEY_PREFIX: 'source-fetcher:',
  CACHE_TTL_OK_SECONDS: Number(process.env.CACHE_TTL_OK_SECONDS) || 24 * 60 * 60,
  CACHE_TTL_ERROR_SECONDS: Number(process.env.CACHE_TTL_ERROR_SECONDS) || 60 * 60,
  // Disable caching entirely (e.g. for local dev without Redis) by setting
  // DISABLE_CACHE=1.
  CACHE_DISABLED: process.env.DISABLE_CACHE === '1',
};

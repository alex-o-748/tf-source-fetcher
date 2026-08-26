'use strict';

// Descriptive UA with a contact URL, per Wikimedia's bot-etiquette expectations
// (mirrors the style of LIFTWING_USER_AGENT in the reference public-ai-proxy Worker).
const USER_AGENT =
  'source-fetcher/1.0 (+https://github.com/alex-o-748/tf-source-fetcher; ' +
  'fetches citation sources for Wikipedia citation verification; running on Wikimedia Toolforge)';

// `Number(process.env.X) || fallback` silently rewrites a deliberate 0 (e.g.
// HOST_MIN_INTERVAL_MS=0 in a probe run) into the default, so read numbers
// through this instead.
function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

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
  FETCH_TIMEOUT_MS: numEnv('FETCH_TIMEOUT_MS', 20000),

  // robots.txt lookups should be quick; a slow/hanging robots.txt shouldn't
  // block the actual fetch for long.
  ROBOTS_TIMEOUT_MS: numEnv('ROBOTS_TIMEOUT_MS', 5000),
  ROBOTS_CACHE_TTL_MS: numEnv('ROBOTS_CACHE_TTL_MS', 60 * 60 * 1000),

  // Response body size guards. Toolforge gives this tool a heavier memory
  // budget than the other two tools specifically for PDF parsing / large
  // buffers, so these are a bit more generous than the Worker's 10 MB PDF cap.
  MAX_HTML_BYTES: numEnv('MAX_HTML_BYTES', 20 * 1024 * 1024),
  MAX_PDF_BYTES: numEnv('MAX_PDF_BYTES', 25 * 1024 * 1024),

  // --- Concurrency and per-host politeness ---------------------------------
  //
  // These are the constraints that make it safe for a caller to fetch many
  // citations at once. They are enforced here rather than trusted to the
  // caller because every caller — the userscript, the batch job, a probe —
  // funnels through this one service, and only this service sees the whole
  // picture of what is currently in flight against a given publisher.

  // Simultaneous in-flight upstream requests to a single host. 1 keeps the
  // strictly-one-at-a-time behavior this service shipped with; a host slot is
  // held for the whole request, so a slow publisher throttles itself.
  HOST_MAX_CONCURRENCY: numEnv('HOST_MAX_CONCURRENCY', 1),
  // Minimum gap between two outbound request *starts* to the same host.
  HOST_MIN_INTERVAL_MS: numEnv('HOST_MIN_INTERVAL_MS', 1000),
  // How long a request may queue waiting for its host's turn before we give
  // up and tell the caller to retry later.
  HOST_MAX_QUEUE_WAIT_MS: numEnv('HOST_MAX_QUEUE_WAIT_MS', 8000),
  // Hard cap on queued waiters per host, so a caller hammering one publisher
  // can't grow this process's memory without bound.
  HOST_MAX_QUEUE_DEPTH: numEnv('HOST_MAX_QUEUE_DEPTH', 64),
  // How long to back a host off after it returns a 429 to us, and the ceiling
  // we'll honor from a host's own `Retry-After` header.
  HOST_BACKOFF_MS: numEnv('HOST_BACKOFF_MS', 30000),
  HOST_BACKOFF_MAX_MS: numEnv('HOST_BACKOFF_MAX_MS', 10 * 60 * 1000),

  // Process-wide ceiling on simultaneous upstream fetches, across all hosts.
  // This is the number that bounds how much outbound traffic Wikimedia IP
  // space emits on our behalf at any instant, so it is deliberately well
  // below what the process could technically sustain.
  MAX_CONCURRENT_FETCHES: numEnv('MAX_CONCURRENT_FETCHES', 16),
  // How long a request may wait for a global slot before we shed it.
  CAPACITY_MAX_QUEUE_WAIT_MS: numEnv('CAPACITY_MAX_QUEUE_WAIT_MS', 15000),

  // Cache (Redis). Toolforge's shared Redis instance is documented as
  // reachable at tools-redis:6379 from any tool's containers; namespaced by
  // key prefix below so tools sharing the instance don't collide.
  REDIS_URL: process.env.REDIS_URL || 'redis://tools-redis:6379',
  CACHE_KEY_PREFIX: 'source-fetcher:',
  CACHE_TTL_OK_SECONDS: numEnv('CACHE_TTL_OK_SECONDS', 24 * 60 * 60),
  CACHE_TTL_ERROR_SECONDS: numEnv('CACHE_TTL_ERROR_SECONDS', 60 * 60),
  // Disable caching entirely (e.g. for local dev without Redis) by setting
  // DISABLE_CACHE=1.
  CACHE_DISABLED: process.env.DISABLE_CACHE === '1',
};

'use strict';

const http = require('http');

const config = require('./src/config');
const cache = require('./src/cache');
const { isAllowedByRobots } = require('./src/robots');
const { HostRateLimiter, RateLimitedError } = require('./src/rateLimiter');
const { Semaphore, CapacityError } = require('./src/semaphore');
const { SingleFlight } = require('./src/singleFlight');
const { fetchAndExtract } = require('./src/fetchTarget');

const hostLimiter = new HostRateLimiter();
const capacity = new Semaphore(config.MAX_CONCURRENT_FETCHES, config.CAPACITY_MAX_QUEUE_WAIT_MS);
const inFlight = new SingleFlight();

const startedAt = Date.now();
const stats = {
  requests_total: 0,
  cache_hits_total: 0,
  upstream_fetches_total: 0,
  robots_blocks_total: 0,
  network_errors_total: 0,
};

// The response contract. Every response is built from this, so a field added
// here can never be missing from one code path — including responses
// rehydrated from a cache entry written by an older build.
function contract(overrides) {
  return {
    content: null,
    error: null,
    status: null,
    pdf: false,
    totalPages: null,
    page: null,
    truncated: false,
    fetched_at: null,
    cached: false,
    coalesced: false,
    // Who decided this response, when it wasn't the publisher. `null` means
    // `status` came from the target host itself (or no fetch happened for a
    // network reason). See "Distinguishing refused from dead" in the README:
    // a 429 with `refused_by: null` is the publisher telling us to slow down
    // and says something real about that source, while a 429 with
    // `refused_by: "rate-limiter"` or `"capacity"` was us and says nothing
    // about the source at all.
    refused_by: null,
    // Seconds to wait before retrying this URL, when we can estimate it.
    retry_after: null,
    ...overrides,
  };
}

function sendJson(res, httpStatus, body) {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // Wildcard CORS: this endpoint has no credentials, and is called both
    // from the en.wikipedia.org userscript and server-to-server by a batch
    // job (which sends no Origin header at all), so a fixed allowlist isn't
    // needed — matches the reference Worker's `/fetch` route.
    'Access-Control-Allow-Origin': '*',
  };
  if (body && typeof body.retry_after === 'number') {
    headers['Retry-After'] = String(body.retry_after);
  }
  res.writeHead(httpStatus, headers);
  res.end(payload);
}

// The outer HTTP status mirrors the JSON body's `status` field whenever we
// have one (whether it came from upstream or is our own considered verdict,
// e.g. a robots.txt block or our own rate limiting) — `null` only when we
// never got a response from anywhere.
function outerStatusFor(jsonStatus) {
  return jsonStatus === null || jsonStatus === undefined ? 502 : jsonStatus;
}

function isSuccessStatus(status) {
  return typeof status === 'number' && status >= 200 && status < 300;
}

function hostOf(targetUrl) {
  try {
    return new URL(targetUrl).host;
  } catch {
    return targetUrl;
  }
}

function retryAfterSeconds(ms) {
  return Math.max(1, Math.ceil((ms || 0) / 1000));
}

// A 429 is the one upstream status whose useful lifetime is stated by the
// response itself. Caching it for the generic error TTL would keep serving
// "slow down" for an hour after the publisher's window reopened, and would
// contradict the `retry_after` sitting in the same body; so it is cached for
// exactly as long as we're telling the caller to wait, and no longer.
function cacheTtlFor(body) {
  if (isSuccessStatus(body.status)) return cache.CACHE_TTL_OK_SECONDS;
  if (body.status === 429) {
    const asked = body.retry_after || cache.CACHE_TTL_ERROR_SECONDS;
    return Math.min(asked, cache.CACHE_TTL_ERROR_SECONDS);
  }
  return cache.CACHE_TTL_ERROR_SECONDS;
}

// Does the actual work for one uncached (url, page) pair, and returns
// `{ httpStatus, body }`. Exactly one of these runs per key at a time — see
// SingleFlight — so everything inside it, including the host slot it holds
// and the upstream request it makes, happens once no matter how many callers
// asked for this URL at the same moment.
async function performFetch(targetUrl, pageParamRaw, cacheKeyPage, cacheable) {
  const host = hostOf(targetUrl);

  // Politeness gate 1: our own per-host pacing, concurrency cap, and backoff,
  // before we ever touch the network for this request. The slot is held until
  // this request finishes, not just until it starts, so a slow publisher is
  // never asked for a second page while it's still answering the first.
  let releaseHost;
  try {
    releaseHost = await hostLimiter.acquire(host);
  } catch (e) {
    if (!(e instanceof RateLimitedError)) throw e;
    return {
      httpStatus: 429,
      body: contract({
        status: 429,
        error: e.message,
        refused_by: 'rate-limiter',
        retry_after: retryAfterSeconds(e.retryAfterMs),
      }),
    };
  }

  try {
    // Politeness gate 2: the process-wide ceiling on simultaneous outbound
    // requests. Acquired after the host slot rather than before it, so a
    // request idling in a host queue isn't also holding global capacity —
    // but before robots.txt, because a robots.txt lookup is outbound traffic
    // from Wikimedia IP space too. Leaving it outside would mean a burst
    // across a thousand distinct hosts fired a thousand robots.txt requests
    // while the ceiling dutifully held content fetches to sixteen.
    let releaseCapacity;
    try {
      releaseCapacity = await capacity.acquire();
    } catch (e) {
      if (!(e instanceof CapacityError)) throw e;
      return {
        httpStatus: 429,
        body: contract({
          status: 429,
          error: e.message,
          refused_by: 'capacity',
          retry_after: retryAfterSeconds(e.retryAfterMs),
        }),
      };
    }

    let result;
    try {
      // Politeness gate 3: robots.txt. Inside the host slot, so a burst of
      // requests for one new host doesn't become a burst of robots.txt
      // fetches for it either; and cached per host, so this is a first-touch
      // cost rather than a per-request one.
      const allowed = await isAllowedByRobots(targetUrl).catch(() => true);
      if (!allowed) {
        stats.robots_blocks_total += 1;
        const body = contract({
          status: 403,
          error: 'Blocked by robots.txt',
          refused_by: 'robots',
        });
        if (cacheable) {
          await cache.set(targetUrl, cacheKeyPage, body, cache.CACHE_TTL_ERROR_SECONDS);
        }
        return { httpStatus: 403, body };
      }

      stats.upstream_fetches_total += 1;
      result = await fetchAndExtract(targetUrl, pageParamRaw);
    } finally {
      releaseCapacity();
    }

    if (result.networkError) {
      // Never reached upstream at all — status stays null per contract, and
      // this is transient by nature so it's never cached.
      stats.network_errors_total += 1;
      return { httpStatus: 502, body: contract({ error: result.error }) };
    }

    const cooldownMs = hostLimiter.reportStatus(host, result.status, result.retryAfter);

    if (result.invalidPage) {
      // A bad `page` for this caller's request, not a fact about the source —
      // never cached, and reported at the transport level as a 400 while the
      // body keeps the upstream's real status.
      return {
        httpStatus: 400,
        body: contract({
          status: result.status,
          error: result.error,
          totalPages: result.totalPages,
          fetched_at: result.fetchedAt,
        }),
      };
    }

    const body = contract({
      content: result.content,
      error: result.error,
      status: result.status,
      pdf: result.pdf,
      totalPages: result.totalPages,
      page: result.page,
      truncated: result.truncated,
      fetched_at: result.fetchedAt,
      // A 429 that reaches here came from the publisher, so refused_by stays
      // null and the caller should treat it as a real signal about the source.
      // The wait we report is the cooldown we just put that host into, which
      // already accounts for its own Retry-After: retrying any sooner would
      // only earn a `refused_by: "rate-limiter"` reply from us anyway.
      retry_after: cooldownMs > 0 ? retryAfterSeconds(cooldownMs) : null,
    });

    if (cacheable) {
      await cache.set(targetUrl, cacheKeyPage, body, cacheTtlFor(body));
    }

    return { httpStatus: outerStatusFor(result.status), body };
  } finally {
    releaseHost();
  }
}

async function handleFetch(targetUrl, pageParamRaw, res) {
  const pageNum = pageParamRaw !== null ? parseInt(pageParamRaw, 10) : null;
  const pageIsValidInt = pageParamRaw === null || Number.isInteger(pageNum);
  const cacheKeyPage = Number.isInteger(pageNum) ? pageNum : null;

  const cached = await cache.get(targetUrl, cacheKeyPage);
  if (cached) {
    stats.cache_hits_total += 1;
    const body = contract({ ...cached, cached: true, coalesced: false });
    sendJson(res, outerStatusFor(body.status), body);
    return;
  }

  // Concurrent callers asking for the same URL share one execution rather
  // than each making their own upstream request.
  const key = cache.keyFor(targetUrl, cacheKeyPage);
  const { value, coalesced } = await inFlight.run(key, () =>
    performFetch(targetUrl, pageParamRaw, cacheKeyPage, pageIsValidInt)
  );

  sendJson(res, value.httpStatus, { ...value.body, coalesced });
}

function handleStats(res) {
  sendJson(res, 200, {
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    ...stats,
    coalesced_total: inFlight.coalescedTotal,
    coalescing_now: inFlight.size,
    capacity: capacity.snapshot(),
    hosts: hostLimiter.snapshot(),
    cache_connected: cache.isReady(),
    limits: {
      host_max_concurrency: config.HOST_MAX_CONCURRENCY,
      host_min_interval_ms: config.HOST_MIN_INTERVAL_MS,
      host_max_queue_wait_ms: config.HOST_MAX_QUEUE_WAIT_MS,
      max_concurrent_fetches: config.MAX_CONCURRENT_FETCHES,
    },
  });
}

function handleOptions(req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Content-Type',
  });
  res.end();
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendJson(res, 400, { content: null, error: 'Malformed request URL', status: 400 });
    return;
  }

  if (req.method === 'OPTIONS') {
    handleOptions(req, res);
    return;
  }

  if (url.pathname === '/stats' && req.method === 'GET') {
    handleStats(res);
    return;
  }

  if (url.pathname !== '/') {
    sendJson(res, 404, { content: null, error: 'Not found', status: 404 });
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Access-Control-Allow-Origin': '*', Allow: 'GET, OPTIONS' });
    res.end('Method not allowed');
    return;
  }

  const targetUrl = url.searchParams.get('fetch');
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    sendJson(res, 400, {
      content: null,
      error: 'Missing or invalid "fetch" query parameter (must be an http(s) URL)',
      status: 400,
    });
    return;
  }

  const pageParamRaw = url.searchParams.get('page');
  stats.requests_total += 1;

  handleFetch(targetUrl, pageParamRaw, res).catch((err) => {
    console.error('[server] unhandled error handling', targetUrl, err);
    sendJson(res, 500, contract({ status: 500, error: 'Internal error' }));
  });
});

async function main() {
  await cache.connect();
  server.listen(config.PORT, () => {
    console.log(
      `source-fetcher listening on port ${config.PORT} ` +
        `(max ${config.MAX_CONCURRENT_FETCHES} concurrent fetches, ` +
        `${config.HOST_MAX_CONCURRENCY} per host)`
    );
  });
}

main();

module.exports = server;

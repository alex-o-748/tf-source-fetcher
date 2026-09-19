'use strict';

const http = require('http');

const config = require('./src/config');
const cache = require('./src/cache');
const { isAllowedByRobots, robotsCacheSize } = require('./src/robots');
const { HostRateLimiter, RateLimitedError } = require('./src/rateLimiter');
const { fetchAndExtract } = require('./src/fetchTarget');
const metrics = require('./src/metrics');

const hostLimiter = new HostRateLimiter();

// Diagnostic scaffolding — see the header of src/metrics.js. These are the
// two structures in this process that grow once per distinct origin and are
// never evicted, which is the leading hypothesis for the heap growth that
// outlived the parse-budget fix.
metrics.setGauges(() => ({
  robots: robotsCacheSize(),
  limiter: hostLimiter.size(),
}));

function emptyContract(status, fetchedAt) {
  return {
    content: null,
    error: null,
    status,
    pdf: false,
    totalPages: null,
    page: null,
    truncated: false,
    fetched_at: fetchedAt,
  };
}

function sendJson(res, httpStatus, body) {
  const payload = JSON.stringify(body);
  res.writeHead(httpStatus, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // Wildcard CORS: this endpoint has no credentials, and is called both
    // from the en.wikipedia.org userscript and server-to-server by a batch
    // job (which sends no Origin header at all), so a fixed allowlist isn't
    // needed — matches the reference Worker's `/fetch` route.
    'Access-Control-Allow-Origin': '*',
  });
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

async function handleFetch(targetUrl, pageParamRaw, req, res) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Source processing timed out (deadline exceeded)', 'AbortError')),
    config.PROCESSING_DEADLINE_MS
  );
  const cancelForDisconnect = () => {
    if (!res.writableEnded) {
      controller.abort(new DOMException('Client disconnected', 'AbortError'));
    }
  };
  req.once('aborted', cancelForDisconnect);
  res.once('close', cancelForDisconnect);

  try {
    const pageNum = pageParamRaw !== null ? parseInt(pageParamRaw, 10) : null;
    const pageIsValidInt = pageParamRaw === null || Number.isInteger(pageNum);
    const cacheKeyPage = Number.isInteger(pageNum) ? pageNum : null;

    const cached = await cache.get(targetUrl, cacheKeyPage);
    if (cached) {
      metrics.record({ cached: true, ok: isSuccessStatus(cached.status) && !!cached.content });
      sendJson(res, outerStatusFor(cached.status), { ...cached, cached: true });
      return;
    }

    let host;
    try {
      host = new URL(targetUrl).host;
    } catch {
      host = targetUrl;
    }

    // These gates are independent, so wait for them concurrently. Across
    // requests Node already overlaps network I/O; this also avoids adding a
    // cold robots lookup to time already spent in the per-host queue.
    let allowed;
    try {
      [, allowed] = await Promise.all([
        hostLimiter.acquire(host, controller.signal),
        isAllowedByRobots(targetUrl, controller.signal).catch((error) => {
          if (controller.signal.aborted) throw error;
          return true;
        }),
      ]);
    } catch (e) {
      if (!(e instanceof RateLimitedError)) throw e;
      metrics.record({ rateLimited: true });
      sendJson(res, 429, { ...emptyContract(429, null), error: e.message, cached: false });
      return;
    }

    if (!allowed) {
      const body = { ...emptyContract(403, null), error: 'Blocked by robots.txt', cached: false };
      if (pageIsValidInt) {
        await cache.set(targetUrl, cacheKeyPage, { ...body, cached: undefined }, cache.CACHE_TTL_ERROR_SECONDS);
      }
      metrics.record({ robotsBlocked: true });
      sendJson(res, 403, body);
      return;
    }

    const result = await fetchAndExtract(targetUrl, pageParamRaw, controller.signal);

    if (result.networkError) {
      if (controller.signal.aborted) throw controller.signal.reason;
      // Never reached upstream at all — status stays null per contract, and
      // this is transient by nature so it's never cached.
      metrics.record({ networkError: true });
      sendJson(res, 502, { ...emptyContract(null, null), error: result.error, cached: false });
      return;
    }

    if (result.invalidPage) {
      metrics.record({ invalidPage: true, pdf: true, bytes: result.bytes });
      sendJson(res, 400, {
        ...emptyContract(result.status, result.fetchedAt),
        error: result.error,
        totalPages: result.totalPages,
        cached: false,
      });
      return;
    }

    hostLimiter.reportStatus(host, result.status);

    const body = {
      content: result.content,
      error: result.error,
      status: result.status,
      pdf: result.pdf,
      totalPages: result.totalPages,
      page: result.page,
      truncated: result.truncated,
      fetched_at: result.fetchedAt,
    };

    if (pageIsValidInt) {
      const ttl = isSuccessStatus(result.status)
        ? cache.CACHE_TTL_OK_SECONDS
        : cache.CACHE_TTL_ERROR_SECONDS;
      await cache.set(targetUrl, cacheKeyPage, body, ttl);
    }

    metrics.record({
      ok: !!result.content,
      httpError: !isSuccessStatus(result.status),
      noContent: isSuccessStatus(result.status) && !result.content,
      pdf: !!result.pdf,
      truncated: !!result.truncated,
      bytes: result.bytes,
    });

    sendJson(res, outerStatusFor(result.status), { ...body, cached: false });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    if (!res.writableEnded && !res.destroyed) {
      metrics.record({ networkError: true });
      sendJson(res, 504, {
        ...emptyContract(null, null),
        error: 'Source processing timed out (deadline exceeded)',
        cached: false,
      });
    }
  } finally {
    clearTimeout(timer);
    req.removeListener('aborted', cancelForDisconnect);
    res.removeListener('close', cancelForDisconnect);
  }
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

  // Diagnostic scaffolding — see the header of src/metrics.js. Counters and
  // process memory only; no URLs, no fetched content, nothing a caller told
  // us. Remove with the rest of the instrumentation once the leak is found.
  if (url.pathname === '/metrics') {
    sendJson(res, 200, metrics.snapshot());
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

  handleFetch(targetUrl, pageParamRaw, req, res)
    .catch((err) => {
      console.error('[server] unhandled error handling', targetUrl, err);
      metrics.record({ networkError: true });
      sendJson(res, 500, {
        content: null,
        error: 'Internal error',
        status: 500,
        pdf: false,
        totalPages: null,
        page: null,
        truncated: false,
        fetched_at: null,
        cached: false,
      });
    })
    // One place, so every exit path above is counted exactly once and the
    // periodic line can't be skipped by whichever branch returned.
    .finally(() => metrics.maybeLog());
});

async function main() {
  await cache.connect();
  server.listen(config.PORT, () => {
    console.log(`source-fetcher listening on port ${config.PORT}`);
  });
}

main();

module.exports = server;

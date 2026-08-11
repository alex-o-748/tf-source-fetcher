'use strict';

const http = require('http');

const config = require('./src/config');
const cache = require('./src/cache');
const { isAllowedByRobots } = require('./src/robots');
const { HostRateLimiter, RateLimitedError } = require('./src/rateLimiter');
const { fetchAndExtract } = require('./src/fetchTarget');

const hostLimiter = new HostRateLimiter();

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

async function handleFetch(targetUrl, pageParamRaw, res) {
  const pageNum = pageParamRaw !== null ? parseInt(pageParamRaw, 10) : null;
  const pageIsValidInt = pageParamRaw === null || Number.isInteger(pageNum);
  const cacheKeyPage = Number.isInteger(pageNum) ? pageNum : null;

  const cached = await cache.get(targetUrl, cacheKeyPage);
  if (cached) {
    sendJson(res, outerStatusFor(cached.status), { ...cached, cached: true });
    return;
  }

  let host;
  try {
    host = new URL(targetUrl).host;
  } catch {
    host = targetUrl;
  }

  // Politeness gate 1: our own per-host pacing/backoff, before we ever touch
  // the network for this request.
  try {
    await hostLimiter.acquire(host);
  } catch (e) {
    if (!(e instanceof RateLimitedError)) throw e;
    sendJson(res, 429, { ...emptyContract(429, null), error: e.message, cached: false });
    return;
  }

  // Politeness gate 2: robots.txt.
  const allowed = await isAllowedByRobots(targetUrl).catch(() => true);
  if (!allowed) {
    const body = { ...emptyContract(403, null), error: 'Blocked by robots.txt', cached: false };
    if (pageIsValidInt) {
      await cache.set(targetUrl, cacheKeyPage, { ...body, cached: undefined }, cache.CACHE_TTL_ERROR_SECONDS);
    }
    sendJson(res, 403, body);
    return;
  }

  const result = await fetchAndExtract(targetUrl, pageParamRaw);

  if (result.networkError) {
    // Never reached upstream at all — status stays null per contract, and
    // this is transient by nature so it's never cached.
    sendJson(res, 502, { ...emptyContract(null, null), error: result.error, cached: false });
    return;
  }

  if (result.invalidPage) {
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

  sendJson(res, outerStatusFor(result.status), { ...body, cached: false });
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

  handleFetch(targetUrl, pageParamRaw, res).catch((err) => {
    console.error('[server] unhandled error handling', targetUrl, err);
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
  });
});

async function main() {
  await cache.connect();
  server.listen(config.PORT, () => {
    console.log(`source-fetcher listening on port ${config.PORT}`);
  });
}

main();

module.exports = server;

'use strict';

// End-to-end smoke test against a local fixture "publisher" server, standing
// in for real internet URLs since this dev sandbox has no general egress.
// Exercises the full pipeline: robots.txt, per-host rate limiting, HTML and
// PDF extraction, the refused/dead/no-content status contract, and caching.

const test = require('node:test');
const assert = require('node:assert/strict');

const FIXTURES_PORT = 18291;
const SERVER_PORT = 18292;

process.env.FIXTURES_PORT = String(FIXTURES_PORT);
process.env.PORT = String(SERVER_PORT);
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6399';
process.env.FETCH_TIMEOUT_MS = '1500';
process.env.HOST_MIN_INTERVAL_MS = '150';
process.env.HOST_MAX_QUEUE_WAIT_MS = '3000';
process.env.HOST_BACKOFF_MS = '2000';
process.env.ROBOTS_TIMEOUT_MS = '2000';
process.env.HOST_MAX_CONCURRENCY = '2';
process.env.MAX_CONCURRENT_FETCHES = '4';
process.env.CAPACITY_MAX_QUEUE_WAIT_MS = '3000';

const fixturesServer = require('./fixtures-server');
const sourceFetcherServer = require('../server');
const cache = require('../src/cache');

const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const FIXTURES_BASE = `http://127.0.0.1:${FIXTURES_PORT}`;

async function waitForReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.status === 400) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('source-fetcher server did not become ready in time');
}

async function callFetch(targetUrl, page) {
  const u = new URL('/', BASE);
  u.searchParams.set('fetch', targetUrl);
  if (page !== undefined) u.searchParams.set('page', String(page));
  const res = await fetch(u);
  const body = await res.json();
  return { httpStatus: res.status, body, headers: res.headers };
}

// A URL nothing has fetched before, so it can't be answered from Redis left
// over from an earlier run of the suite.
let nonce = 0;
function freshUrl(base, path) {
  nonce += 1;
  return `${base}${path}${path.includes('?') ? '&' : '?'}n=${Date.now()}-${nonce}`;
}

// Extra fixture instances listen on their own ports, which makes them
// distinct *hosts* to the per-host limiter — necessary for any test that
// leaves a host throttled or backed off, so it can't bleed into the others.
const extraFixtures = [];
async function startFixture() {
  const server = fixturesServer.createFixtureServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  extraFixtures.push(server);
  server.base = `http://127.0.0.1:${server.address().port}`;
  return server;
}

test.before(async () => {
  await waitForReady();
});

test.after(async () => {
  fixturesServer.closeAllConnections?.();
  sourceFetcherServer.closeAllConnections?.();
  for (const server of extraFixtures) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  await new Promise((resolve) => fixturesServer.close(resolve));
  await new Promise((resolve) => sourceFetcherServer.close(resolve));
  await cache.disconnect();
});

test('CORS preflight succeeds', async () => {
  const res = await fetch(`${BASE}/?fetch=x`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://en.wikipedia.org' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('live HTML article: extracted, status 200, not cached on first hit', async () => {
  const { httpStatus, body } = await callFetch(`${FIXTURES_BASE}/article`);
  assert.equal(httpStatus, 200);
  assert.equal(body.status, 200);
  assert.equal(body.error, null);
  assert.ok(body.content && body.content.length > 100);
  assert.equal(body.pdf, false);
  assert.equal(body.cached, false);
  assert.ok(body.fetched_at);
});

test('same URL is served from cache on subsequent hits', async () => {
  // The previous test already fetched and cached this URL.
  const first = await callFetch(`${FIXTURES_BASE}/article`);
  assert.equal(first.body.cached, true, 'expected a cache hit left over from the previous test');
  const second = await callFetch(`${FIXTURES_BASE}/article`);
  assert.equal(second.body.cached, true);
  assert.equal(second.body.content, first.body.content);
});

test('too-short content: no-content error, content null', async () => {
  const { httpStatus, body } = await callFetch(`${FIXTURES_BASE}/short`);
  assert.equal(httpStatus, 200);
  assert.equal(body.status, 200);
  assert.equal(body.content, null);
  assert.equal(body.error, 'Source content was empty or too short to verify');
});

test('upstream 403 is passed through as a real status ("refused")', async () => {
  const { httpStatus, body } = await callFetch(`${FIXTURES_BASE}/forbidden`);
  assert.equal(body.status, 403);
  assert.equal(httpStatus, 403);
  assert.equal(body.content, null);
  assert.ok(body.error);
});

test('upstream 404 is passed through distinctly from 403', async () => {
  const { body } = await callFetch(`${FIXTURES_BASE}/notfound`);
  assert.equal(body.status, 404);
});

test('unreachable host: status null in body, 502 at transport level ("dead")', async () => {
  const { httpStatus, body } = await callFetch('http://127.0.0.1:1/nope');
  assert.equal(body.status, null);
  assert.equal(httpStatus, 502);
  assert.equal(body.content, null);
  assert.ok(body.error);
});

test('slow/hanging host times out as a network error, not a hang', async () => {
  const { body } = await callFetch(`${FIXTURES_BASE}/slow`);
  assert.equal(body.status, null);
  assert.ok(/timed out/i.test(body.error));
});

test('robots.txt disallowed path is blocked as a 403', async () => {
  const { httpStatus, body } = await callFetch(`${FIXTURES_BASE}/blocked`);
  assert.equal(body.status, 403);
  assert.equal(httpStatus, 403);
  assert.equal(body.error, 'Blocked by robots.txt');
});

test('PDF extraction: full document', async () => {
  const { body } = await callFetch(`${FIXTURES_BASE}/doc.pdf`);
  assert.equal(body.status, 200);
  assert.equal(body.pdf, true);
  assert.equal(body.totalPages, 10);
  assert.equal(body.page, null);
  assert.ok(body.content.length > 100);
});

test('PDF extraction: single page via page param', async () => {
  const { body } = await callFetch(`${FIXTURES_BASE}/doc.pdf`, 3);
  assert.equal(body.pdf, true);
  assert.equal(body.page, 3);
  assert.equal(body.totalPages, 10);
});

test('PDF extraction: out-of-range page is a 400 with totalPages', async () => {
  const { httpStatus, body } = await callFetch(`${FIXTURES_BASE}/doc.pdf`, 999);
  assert.equal(httpStatus, 400);
  assert.equal(body.totalPages, 10);
  assert.ok(/Invalid page number/.test(body.error));
});

test('missing fetch param is a 400', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 400);
});

// --- Concurrency ----------------------------------------------------------

test('a successful response reports that nothing refused it', async () => {
  const { body } = await callFetch(freshUrl(FIXTURES_BASE, '/article'));
  assert.equal(body.refused_by, null);
  assert.equal(body.retry_after, null);
  assert.equal(body.coalesced, false);
});

test('concurrent requests for the same URL hit the publisher once', async () => {
  const fixture = await startFixture();
  const target = freshUrl(fixture.base, '/hold?ms=200');

  const responses = await Promise.all(Array.from({ length: 6 }, () => callFetch(target)));

  assert.equal(
    fixture.hitsFor('/hold').length,
    1,
    'six callers asking for one URL must produce one upstream request'
  );
  for (const { body } of responses) {
    assert.equal(body.status, 200);
    assert.ok(body.content.length > 100);
  }
  assert.equal(responses.filter((r) => r.body.coalesced).length, 5);
  assert.equal(responses.filter((r) => !r.body.coalesced).length, 1);
});

test('concurrent requests to one host stay within the per-host cap', async () => {
  const fixture = await startFixture();
  const targets = Array.from({ length: 6 }, (_, i) =>
    freshUrl(fixture.base, `/hold?ms=120&i=${i}`)
  );

  const responses = await Promise.all(targets.map((t) => callFetch(t)));

  for (const { body } of responses) {
    assert.equal(body.status, 200, `unexpected ${body.status}: ${body.error}`);
  }
  // HOST_MAX_CONCURRENCY is 2 for this suite. The publisher itself is the
  // witness: it must never have seen more than two of our requests at once.
  assert.ok(
    fixture.stats.maxInFlight <= 2,
    `publisher saw ${fixture.stats.maxInFlight} concurrent requests, cap is 2`
  );
});

test('our own throttling is labelled as ours, with a retry hint', async () => {
  const fixture = await startFixture();
  // Far more than this host's queue budget can absorb, so some callers are
  // certain to be turned away by us rather than by the publisher.
  const targets = Array.from({ length: 60 }, (_, i) =>
    freshUrl(fixture.base, `/hold?ms=400&i=${i}`)
  );
  const responses = await Promise.all(targets.map((t) => callFetch(t)));

  const refused = responses.filter((r) => r.httpStatus === 429);
  assert.ok(refused.length > 0, 'expected this to overwhelm the per-host budget');

  for (const { body, headers } of refused) {
    assert.equal(
      body.refused_by,
      'rate-limiter',
      'a 429 we generated must never look like the publisher refusing us'
    );
    assert.equal(typeof body.retry_after, 'number');
    assert.ok(body.retry_after >= 1);
    assert.equal(headers.get('retry-after'), String(body.retry_after));
    assert.equal(body.fetched_at, null, 'we never contacted the host for these');
  }
  assert.ok(
    fixture.stats.maxInFlight <= 2,
    `publisher saw ${fixture.stats.maxInFlight} concurrent requests under load, cap is 2`
  );
});

test("an upstream 429 is reported as the publisher's, and backs that host off", async () => {
  const fixture = await startFixture();

  const first = await callFetch(freshUrl(fixture.base, '/ratelimited'));
  assert.equal(first.httpStatus, 429);
  assert.equal(first.body.status, 429);
  assert.equal(first.body.refused_by, null, 'this 429 came from the publisher');
  assert.ok(first.body.fetched_at, 'we did contact the host');
  assert.equal(typeof first.body.retry_after, 'number');

  // The host is now in cooldown, so the next request never reaches it.
  const second = await callFetch(freshUrl(fixture.base, '/article'));
  assert.equal(second.httpStatus, 429);
  assert.equal(second.body.refused_by, 'rate-limiter');
  assert.equal(second.body.fetched_at, null);
  assert.equal(fixture.hitsFor('/article').length, 0);

  // HOST_BACKOFF_MS is 2000 in this suite.
  await new Promise((r) => setTimeout(r, 2200));
  const third = await callFetch(freshUrl(fixture.base, '/article'));
  assert.equal(third.body.status, 200);
});

test("a host's own Retry-After is honoured over our default backoff", async () => {
  const fixture = await startFixture();
  const { body } = await callFetch(freshUrl(fixture.base, '/ratelimited?retryAfter=90'));
  assert.equal(body.status, 429);
  assert.equal(body.refused_by, null);
  assert.ok(body.retry_after >= 90, `expected >= 90s, got ${body.retry_after}`);
});

test('robots.txt blocks are attributed to robots, not to a publisher status', async () => {
  const { body } = await callFetch(freshUrl(FIXTURES_BASE, '/blocked'));
  assert.equal(body.status, 403);
  assert.equal(body.refused_by, 'robots');
});

test('the global ceiling binds across hosts, where per-host caps cannot', async () => {
  // Ten distinct publishers, one request each: every per-host cap is
  // satisfied, so only the process-wide ceiling can hold this down. This is
  // the case per-host limits alone would miss entirely — a sweep touching a
  // thousand different sites at once.
  const fixtures = await Promise.all(Array.from({ length: 10 }, () => startFixture()));
  const totalInFlight = () => fixtures.reduce((n, f) => n + f.stats.inFlight, 0);

  let observedPeak = 0;
  const sampler = setInterval(() => {
    const now = totalInFlight();
    if (now > observedPeak) observedPeak = now;
  }, 5);

  try {
    const responses = await Promise.all(
      fixtures.map((f) => callFetch(freshUrl(f.base, '/hold?ms=250')))
    );
    for (const { body } of responses) {
      assert.equal(body.status, 200, `unexpected ${body.status}: ${body.error}`);
    }
  } finally {
    clearInterval(sampler);
  }

  // MAX_CONCURRENT_FETCHES is 4 for this suite.
  assert.ok(observedPeak > 0, 'sampler saw nothing; the test proved nothing');
  assert.ok(
    observedPeak <= 4,
    `${observedPeak} requests were in flight across publishers at once, ceiling is 4`
  );
});

test('/stats reports the live concurrency picture', async () => {
  const res = await fetch(`${BASE}/stats`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.limits.host_max_concurrency, 2);
  assert.equal(body.limits.max_concurrent_fetches, 4);
  assert.ok(body.capacity.peak_active <= 4, 'global cap must never have been exceeded');
  assert.ok(body.capacity.peak_active >= 2, 'the multi-host test should have loaded it');
  assert.ok(body.coalesced_total >= 5, 'the coalescing test should be visible here');
  assert.equal(body.capacity.active, 0);
  assert.ok(body.upstream_fetches_total > 0);
});

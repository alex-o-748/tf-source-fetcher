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
  return { httpStatus: res.status, body };
}

test.before(async () => {
  await waitForReady();
});

test.after(async () => {
  fixturesServer.closeAllConnections?.();
  sourceFetcherServer.closeAllConnections?.();
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

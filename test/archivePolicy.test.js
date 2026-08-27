'use strict';

// Unit tests for the archive-specific pieces added alongside fetch
// concurrency: recognizing a pinned Wayback snapshot (src/archiveSnapshot.js)
// and the cache-TTL policy built on it (src/cachePolicy.js). No network, no
// Redis — these are pure functions.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isImmutableSnapshotUrl } = require('../src/archiveSnapshot');
const { cacheTtlSecondsFor } = require('../src/cachePolicy');
const config = require('../src/config');

test('a fully-timestamped id_ snapshot URL is recognized as immutable', () => {
  assert.equal(
    isImmutableSnapshotUrl('https://web.archive.org/web/20240101120000id_/https://example.com/doc'),
    true
  );
});

test('a fully-timestamped snapshot URL without id_ is also recognized', () => {
  assert.equal(
    isImmutableSnapshotUrl('https://web.archive.org/web/20250515222512/https://example.com/page'),
    true
  );
});

test('an ambiguous "closest capture" URL (short timestamp) is not treated as pinned', () => {
  assert.equal(isImmutableSnapshotUrl('https://web.archive.org/web/2025/https://x.com'), false);
});

test('a non-archive host is never treated as immutable, even with a similar path', () => {
  assert.equal(
    isImmutableSnapshotUrl('https://not-archive.example/web/20240101120000id_/https://x.com'),
    false
  );
});

test('an unparseable URL is treated as not immutable rather than throwing', () => {
  assert.equal(isImmutableSnapshotUrl('not a url'), false);
});

test('a successful pinned-snapshot fetch gets the long immutable TTL', () => {
  const ttl = cacheTtlSecondsFor(
    'https://web.archive.org/web/20240101120000id_/https://example.com/doc',
    { status: 200 }
  );
  assert.equal(ttl, config.CACHE_TTL_IMMUTABLE_SECONDS);
  assert.ok(ttl > config.CACHE_TTL_OK_SECONDS, 'immutable TTL should exceed the ordinary OK TTL');
});

test('a successful ordinary fetch still gets the normal OK TTL, archive host or not', () => {
  assert.equal(
    cacheTtlSecondsFor('https://example.com/article', { status: 200 }),
    config.CACHE_TTL_OK_SECONDS
  );
  // Wayback's own landing/search pages aren't pinned snapshots.
  assert.equal(
    cacheTtlSecondsFor('https://web.archive.org/', { status: 200 }),
    config.CACHE_TTL_OK_SECONDS
  );
});

test('a failed fetch to a pinned snapshot URL still uses the ordinary error TTL', () => {
  // Immutability is a property of successful content, not of a fetch error —
  // a transient Wayback outage shouldn't be remembered for 30 days.
  const ttl = cacheTtlSecondsFor(
    'https://web.archive.org/web/20240101120000id_/https://example.com/doc',
    { status: 503 }
  );
  assert.equal(ttl, config.CACHE_TTL_ERROR_SECONDS);
});

test('a 429 is capped at its own retry_after, not the full error TTL', () => {
  const ttl = cacheTtlSecondsFor('https://example.com/x', { status: 429, retry_after: 30 });
  assert.equal(ttl, 30);
});

test('a 429 with no retry_after falls back to the generic error TTL', () => {
  const ttl = cacheTtlSecondsFor('https://example.com/x', { status: 429, retry_after: null });
  assert.equal(ttl, config.CACHE_TTL_ERROR_SECONDS);
});

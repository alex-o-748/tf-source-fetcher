'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const robots = require('../src/robots');
const metrics = require('../src/metrics');
const { ROBOTS_CACHE_MAX, ROBOTS_CACHE_MAX_BYTES } = require('../src/config');

// `fetch` is resolved from the global at call time, so stubbing it here is
// enough to keep these tests off the network.
const realFetch = globalThis.fetch;

function stubFetch(bodyFor) {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    const body = bodyFor(url);
    return {
      ok: true,
      text: async () => body,
    };
  };
  return () => calls;
}

test.beforeEach(() => {
  robots.resetForTest();
  metrics.resetForTest();
});

test.after(() => {
  globalThis.fetch = realFetch;
});

test('caches one robots.txt per origin and reuses it', async () => {
  const calls = stubFetch(() => 'User-agent: *\nDisallow: /private\n');

  assert.equal(await robots.isAllowedByRobots('https://a.example/article'), true);
  assert.equal(await robots.isAllowedByRobots('https://a.example/private/x'), false);
  assert.equal(calls(), 1, 'second lookup on the same origin should not refetch');
  assert.equal(robots.robotsCacheStats().entries, 1);
});

test('counts robots.txt bytes, which used to be invisible', async () => {
  const body = `User-agent: *\n${'Disallow: /x\n'.repeat(1000)}`;
  stubFetch(() => body);

  await robots.isAllowedByRobots('https://a.example/article');
  await robots.isAllowedByRobots('https://b.example/article');

  const { robots: r } = metrics.snapshot();
  assert.equal(r.fetches, 2);
  assert.equal(r.bytes, Buffer.byteLength(body) * 2);
  assert.equal(r.maxBytes, Buffer.byteLength(body));
  // The whole point of the separate counter: these bytes are NOT in the
  // target-body total that a reading of `[mem]` compares retention against.
  assert.equal(metrics.snapshot().bytesFetched, 0);
});

test('a failed robots.txt fetch is counted but contributes no bytes', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  assert.equal(await robots.isAllowedByRobots('https://dead.example/article'), true);
  const { robots: r } = metrics.snapshot();
  assert.equal(r.fetches, 1);
  assert.equal(r.bytes, 0);
});

// The bound. This is the structure that grew once per distinct origin for the
// life of the process, in a workload that sees ~one new origin per request.

test('caps the number of cached origins', async () => {
  stubFetch(() => 'User-agent: *\nAllow: /\n');

  for (let i = 0; i < ROBOTS_CACHE_MAX + 50; i += 1) {
    await robots.isAllowedByRobots(`https://host-${i}.example/article`);
  }

  const stats = robots.robotsCacheStats();
  assert.ok(
    stats.entries <= ROBOTS_CACHE_MAX,
    `expected at most ${ROBOTS_CACHE_MAX} cached origins, got ${stats.entries}`
  );
  assert.ok(stats.evictions >= 50, 'evictions should be reported, not silent');
});

test('caps total cached bytes when the files are large', async () => {
  // Fat enough that the byte ceiling binds long before the count one — the
  // case a count-only cap would miss, since 500 hundred-KB files and 500
  // hundred-byte files are the same number of entries.
  const body = `User-agent: *\n${'Disallow: /some/fairly/long/path/segment\n'.repeat(13000)}`;
  const origins = Math.ceil(ROBOTS_CACHE_MAX_BYTES / Buffer.byteLength(body)) + 4;
  assert.ok(origins < ROBOTS_CACHE_MAX, 'the count ceiling must not be what binds here');
  stubFetch(() => body);

  for (let i = 0; i < origins; i += 1) {
    await robots.isAllowedByRobots(`https://fat-${i}.example/article`);
  }

  const stats = robots.robotsCacheStats();
  assert.ok(
    stats.bytes <= ROBOTS_CACHE_MAX_BYTES,
    `expected at most ${ROBOTS_CACHE_MAX_BYTES} bytes held, got ${stats.bytes}`
  );
  assert.ok(
    stats.entries < origins,
    'the byte ceiling must evict even though the count ceiling was never reached'
  );
});

test('evicts least-recently-used, not most-recently-added', async () => {
  stubFetch(() => 'User-agent: *\nAllow: /\n');

  await robots.isAllowedByRobots('https://keep.example/article');
  for (let i = 0; i < ROBOTS_CACHE_MAX; i += 1) {
    await robots.isAllowedByRobots(`https://filler-${i}.example/article`);
    // Keep touching the one origin that a real sweep would keep coming back to.
    await robots.isAllowedByRobots('https://keep.example/article');
  }

  const calls = stubFetch(() => 'User-agent: *\nAllow: /\n');
  await robots.isAllowedByRobots('https://keep.example/article');
  assert.equal(calls(), 0, 'the repeatedly used origin should still be cached');
});

test('the byte total tracks what is held, not what was ever fetched', async () => {
  stubFetch(() => 'User-agent: *\nAllow: /\n');
  const one = Buffer.byteLength('User-agent: *\nAllow: /\n');

  for (let i = 0; i < 10; i += 1) {
    await robots.isAllowedByRobots(`https://h-${i}.example/article`);
  }

  assert.equal(robots.robotsCacheStats().bytes, one * 10);
  assert.equal(robots.robotsCacheStats().entries, 10);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { HostRateLimiter, RateLimitedError } = require('../src/rateLimiter');
const { HOST_STATE_MAX, HOST_MIN_INTERVAL_MS } = require('../src/config');

// The behaviour these bounds must not break.

test('paces repeat requests to the same host', async () => {
  const limiter = new HostRateLimiter();
  const started = Date.now();
  await limiter.acquire('example.org');
  await limiter.acquire('example.org');
  assert.ok(
    Date.now() - started >= HOST_MIN_INTERVAL_MS - 50,
    'second acquire for the same host should have waited out the interval'
  );
});

test('backs a host off after a 429 and lets it through once the backoff expires', async () => {
  const limiter = new HostRateLimiter();
  limiter.reportStatus('slow.example', 429);
  await assert.rejects(() => limiter.acquire('slow.example'), RateLimitedError);

  // Expire it by hand rather than sleeping 30s.
  limiter.backoffUntil.set('slow.example', Date.now() - 1);
  await limiter.acquire('slow.example');
  assert.equal(
    limiter.backoffUntil.has('slow.example'),
    false,
    'an expired backoff should be deleted when it is read, not left behind'
  );
});

// The bound itself. Before this, both Maps grew once per distinct host for the
// life of the process — in a sweep, close to once per request.

test('sweeps host state that has expired instead of keeping it forever', async () => {
  const limiter = new HostRateLimiter();

  // More hosts than the ceiling, each seen exactly once and never again, which
  // is the sweep's access pattern.
  for (let i = 0; i < HOST_STATE_MAX + 500; i += 1) {
    // Reservations are made in the past so they are already expired, standing
    // in for hosts whose 1s slot elapsed while the run moved on.
    limiter.nextAvailableAt.set(`host-${i}.example`, Date.now() - 60_000);
  }
  assert.ok(limiter.size() > HOST_STATE_MAX, 'precondition: over the ceiling');

  await limiter.acquire('trigger.example');

  assert.ok(
    limiter.size() <= HOST_STATE_MAX,
    `expected the sweep to bring the map back under ${HOST_STATE_MAX}, got ${limiter.size()}`
  );
});

test('holds the ceiling even when every entry is still live', async () => {
  const limiter = new HostRateLimiter();
  const future = Date.now() + 60_000;
  for (let i = 0; i < HOST_STATE_MAX + 500; i += 1) {
    limiter.nextAvailableAt.set(`live-${i}.example`, future + i);
  }

  await limiter.acquire('trigger.example');

  assert.ok(
    limiter.nextAvailableAt.size <= HOST_STATE_MAX,
    'a map of entirely live entries must still be capped, not allowed to grow'
  );
  // The entries closest to expiring are the ones dropped, so the longest
  // backoffs — the hosts that most recently asked us to slow down — survive.
  assert.equal(
    limiter.nextAvailableAt.has(`live-${HOST_STATE_MAX + 499}.example`),
    true,
    'the furthest-out reservation should be the last thing evicted'
  );
});

test('expired backoffs are swept too', async () => {
  const limiter = new HostRateLimiter();
  for (let i = 0; i < HOST_STATE_MAX + 500; i += 1) {
    limiter.backoffUntil.set(`cold-${i}.example`, Date.now() - 1);
  }
  limiter.reportStatus('fresh.example', 429);

  assert.ok(limiter.backoffUntil.size <= HOST_STATE_MAX);
  assert.equal(
    limiter.backoffUntil.has('fresh.example'),
    true,
    'the live backoff must survive a sweep of expired ones'
  );
});

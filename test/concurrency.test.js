'use strict';

// Unit tests for the concurrency primitives. These assert the invariants the
// whole design rests on — a publisher never sees more than N of our requests
// at once, a duplicate URL is fetched once, an unservable request is refused
// quickly instead of hanging — directly, rather than inferring them from
// end-to-end timing.

const test = require('node:test');
const assert = require('node:assert/strict');

const { HostRateLimiter, RateLimitedError, parseRetryAfter } = require('../src/rateLimiter');
const { Semaphore, CapacityError } = require('../src/semaphore');
const { SingleFlight } = require('../src/singleFlight');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function limiter(overrides) {
  return new HostRateLimiter({
    maxConcurrency: 1,
    minIntervalMs: 0,
    maxQueueWaitMs: 1000,
    maxQueueDepth: 64,
    backoffMs: 100,
    backoffMaxMs: 10000,
    ...overrides,
  });
}

test('host limiter never exceeds its per-host concurrency cap', async () => {
  const rl = limiter({ maxConcurrency: 2, minIntervalMs: 0, maxQueueWaitMs: 5000 });
  let active = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 12 }, async () => {
      const release = await rl.acquire('example.org');
      active += 1;
      if (active > peak) peak = active;
      await sleep(20);
      active -= 1;
      release();
    })
  );

  assert.equal(peak, 2, `expected at most 2 concurrent, saw ${peak}`);
  assert.equal(rl.snapshot().host_slots_active, 0);
});

test('a host slot is held for the whole request, not just its start', async () => {
  // With maxConcurrency 1 and no pacing interval, the second acquire must
  // wait for the first release — this is the difference between pacing and
  // real backpressure, and it is what stops us queueing work onto a host
  // that has not answered us yet.
  const rl = limiter({ maxConcurrency: 1, minIntervalMs: 0, maxQueueWaitMs: 5000 });
  const order = [];

  const first = await rl.acquire('example.org');
  const second = rl.acquire('example.org').then((release) => {
    order.push('second');
    release();
  });

  await sleep(50);
  order.push('first-released');
  first();
  await second;

  assert.deepEqual(order, ['first-released', 'second']);
});

test('host limiter paces successive starts by the minimum interval', async () => {
  const rl = limiter({ maxConcurrency: 4, minIntervalMs: 60, maxQueueWaitMs: 5000 });
  const starts = [];

  await Promise.all(
    Array.from({ length: 4 }, async () => {
      const release = await rl.acquire('example.org');
      starts.push(Date.now());
      release();
    })
  );

  starts.sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1];
    assert.ok(gap >= 55, `gap ${i} was ${gap}ms, expected >= ~60ms`);
  }
});

test('different hosts do not block each other', async () => {
  const rl = limiter({ maxConcurrency: 1, minIntervalMs: 500, maxQueueWaitMs: 100 });
  const started = Date.now();
  const releases = await Promise.all([
    rl.acquire('a.example'),
    rl.acquire('b.example'),
    rl.acquire('c.example'),
  ]);
  assert.ok(Date.now() - started < 200, 'per-host pacing must not serialize distinct hosts');
  releases.forEach((r) => r());
});

test('a request that cannot get a slot in time is refused, not hung', async () => {
  const rl = limiter({ maxConcurrency: 1, minIntervalMs: 0, maxQueueWaitMs: 120 });
  const held = await rl.acquire('example.org');

  const started = Date.now();
  await assert.rejects(
    () => rl.acquire('example.org'),
    (err) => {
      assert.ok(err instanceof RateLimitedError);
      assert.ok(err.retryAfterMs >= 0);
      return true;
    }
  );
  const waited = Date.now() - started;
  assert.ok(waited >= 100 && waited < 1000, `waited ${waited}ms, expected ~120ms`);

  held();
});

test('an obviously hopeless request is refused immediately, without queueing', async () => {
  const rl = limiter({ maxConcurrency: 1, minIntervalMs: 1000, maxQueueWaitMs: 500 });
  const held = await rl.acquire('example.org');

  const started = Date.now();
  await assert.rejects(() => rl.acquire('example.org'), RateLimitedError);
  assert.ok(Date.now() - started < 100, 'should be refused up front, not after the full budget');

  held();
});

test('queue depth is bounded', async () => {
  const rl = limiter({ maxConcurrency: 1, minIntervalMs: 0, maxQueueWaitMs: 60000, maxQueueDepth: 3 });
  const held = await rl.acquire('example.org');

  const queued = [];
  for (let i = 0; i < 3; i++) {
    const p = rl.acquire('example.org');
    p.catch(() => {});
    queued.push(p);
  }
  await assert.rejects(() => rl.acquire('example.org'), RateLimitedError);

  held();
  for (const p of queued) (await p)();
});

test('an upstream 429 backs the host off, and only that host', async () => {
  const rl = limiter({ backoffMs: 200 });
  rl.reportStatus('slow.example', 429);

  await assert.rejects(
    () => rl.acquire('slow.example'),
    (err) => err instanceof RateLimitedError && err.retryAfterMs > 0
  );
  (await rl.acquire('other.example'))();

  await sleep(250);
  (await rl.acquire('slow.example'))();
});

test('a host asking for a longer Retry-After than our default is obeyed', async () => {
  const rl = limiter({ backoffMs: 100, backoffMaxMs: 60000 });
  rl.reportStatus('slow.example', 429, '30');
  await assert.rejects(
    () => rl.acquire('slow.example'),
    (err) => {
      assert.ok(err.retryAfterMs > 25000, `expected ~30s, got ${err.retryAfterMs}ms`);
      return true;
    }
  );
});

test('an absurd Retry-After is clamped to the configured ceiling', async () => {
  const rl = limiter({ backoffMs: 100, backoffMaxMs: 5000 });
  // reportStatus reports back the cooldown it actually applied, so the
  // caller can't promise a retry window the limiter won't honour.
  const applied = rl.reportStatus('slow.example', 429, '86400');
  assert.equal(applied, 5000);
  await assert.rejects(
    () => rl.acquire('slow.example'),
    (err) => {
      assert.ok(err.retryAfterMs <= 5000, `expected clamp to 5s, got ${err.retryAfterMs}ms`);
      return true;
    }
  );
  assert.equal(rl.reportStatus('fine.example', 200), 0);
});

test('a backed-off host is not tracked forever if it is never fetched again', async () => {
  const rl = limiter({ backoffMs: 30 });
  for (let i = 0; i < 50; i++) rl.reportStatus(`host-${i}.example`, 429);
  assert.equal(rl.snapshot().hosts_tracked, 50);

  await sleep(200);
  assert.equal(rl.snapshot().hosts_tracked, 0, 'expired backoff entries must be dropped');
});

test('eviction never drops a host that still owes a pacing gap', async () => {
  // Eviction runs on every release, so it has to distinguish "idle and
  // finished" from "idle but still inside its minimum interval" — dropping
  // the latter would silently reset pacing and let the next request go out
  // immediately, which is the whole thing the interval exists to prevent.
  const rl = limiter({ minIntervalMs: 300, maxQueueWaitMs: 5000 });
  (await rl.acquire('paced.example'))();
  assert.equal(rl.snapshot().hosts_tracked, 1);

  const started = Date.now();
  (await rl.acquire('paced.example'))();
  assert.ok(Date.now() - started >= 250, 'second request must still wait out the interval');
});

test('parseRetryAfter handles seconds, HTTP-dates, and junk', () => {
  assert.equal(parseRetryAfter('120'), 120000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
  const future = new Date(Date.now() + 60000).toUTCString();
  const ms = parseRetryAfter(future);
  assert.ok(ms > 50000 && ms <= 61000, `got ${ms}ms`);
});

test('idle host state is evicted so a long sweep does not leak', async () => {
  const rl = limiter({ minIntervalMs: 0, backoffMs: 0 });
  for (let i = 0; i < 200; i++) {
    (await rl.acquire(`host-${i}.example`))();
  }
  assert.equal(rl.snapshot().hosts_tracked, 0);
});

test('semaphore caps global concurrency and sheds when saturated', async () => {
  const sem = new Semaphore(3, 80);
  let active = 0;
  let peak = 0;

  const work = Array.from({ length: 6 }, async () => {
    const release = await sem.acquire();
    active += 1;
    if (active > peak) peak = active;
    await sleep(40);
    active -= 1;
    release();
  });

  await Promise.all(work);
  assert.equal(peak, 3);
  assert.equal(sem.snapshot().active, 0);

  // Saturate it and confirm the seventh caller is shed rather than parked.
  const held = await Promise.all([sem.acquire(), sem.acquire(), sem.acquire()]);
  await assert.rejects(() => sem.acquire(), CapacityError);
  held.forEach((r) => r());
});

test('semaphore release is idempotent', async () => {
  const sem = new Semaphore(1, 50);
  const release = await sem.acquire();
  release();
  release();
  assert.equal(sem.snapshot().active, 0);
  (await sem.acquire())();
});

test('single-flight collapses concurrent duplicates onto one execution', async () => {
  const sf = new SingleFlight();
  let runs = 0;

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      sf.run('same-key', async () => {
        runs += 1;
        await sleep(30);
        return 'answer';
      })
    )
  );

  assert.equal(runs, 1, 'the duplicate callers must not each hit the publisher');
  assert.deepEqual(
    results.map((r) => r.value),
    Array(5).fill('answer')
  );
  assert.equal(results.filter((r) => r.coalesced).length, 4);
  assert.equal(sf.size, 0, 'the in-flight entry must be cleared when it settles');
});

test('single-flight keeps distinct keys independent and clears after failure', async () => {
  const sf = new SingleFlight();
  let runs = 0;
  await Promise.all([sf.run('a', async () => runs++), sf.run('b', async () => runs++)]);
  assert.equal(runs, 2);

  await assert.rejects(() =>
    sf.run('c', async () => {
      throw new Error('boom');
    })
  );
  assert.equal(sf.size, 0);
  // A failure must not poison the key for the next caller.
  const { value } = await sf.run('c', async () => 'ok');
  assert.equal(value, 'ok');
});

test('single-flight propagates one failure to every joiner', async () => {
  const sf = new SingleFlight();
  let runs = 0;
  const attempt = () =>
    sf.run('k', async () => {
      runs += 1;
      await sleep(20);
      throw new Error('upstream down');
    });

  const settled = await Promise.allSettled([attempt(), attempt(), attempt()]);
  assert.equal(runs, 1);
  assert.equal(settled.filter((s) => s.status === 'rejected').length, 3);
});

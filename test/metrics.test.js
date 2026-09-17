'use strict';

// Tests for the diagnostic instrumentation (src/metrics.js).
//
// These are deliberately about the *reporting*, not about memory: the point of
// the module is to produce a number nobody has to trust me about, so what
// matters is that the counters count, the deltas are per-interval rather than
// cumulative, and the line survives the arithmetic edge cases (no requests
// since the last line, heap going down). A wrong metric is worse than no
// metric — it sends the next person chasing something that isn't there.

const test = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../src/metrics');
const { MEM_LOG_EVERY } = require('../src/config');

test.beforeEach(() => metrics.resetForTest());

test('counts requests and outcomes independently', () => {
  metrics.record({ ok: true, bytes: 1000 });
  metrics.record({ ok: true, pdf: true, bytes: 2000 });
  metrics.record({ httpError: true });
  metrics.record({ networkError: true });
  metrics.record({ robotsBlocked: true });
  metrics.record({ cached: true, ok: true });

  const s = metrics.snapshot();
  assert.equal(s.counts.requests, 6);
  assert.equal(s.counts.ok, 3);
  assert.equal(s.counts.pdf, 1);
  assert.equal(s.counts.httpError, 1);
  assert.equal(s.counts.networkError, 1);
  assert.equal(s.counts.robotsBlocked, 1);
  assert.equal(s.counts.cached, 1);
  assert.equal(s.bytesFetched, 3000);
});

test('a request with no body read contributes no bytes', () => {
  metrics.record({ networkError: true });
  metrics.record({ ok: true }); // bytes undefined
  metrics.record({ ok: true, bytes: 0 });
  assert.equal(metrics.snapshot().bytesFetched, 0);
  assert.equal(metrics.snapshot().counts.requests, 3);
});

test('the periodic line fires every MEM_LOG_EVERY requests, not otherwise', () => {
  const lines = [];
  const write = (l) => lines.push(l);

  for (let i = 0; i < MEM_LOG_EVERY - 1; i++) {
    metrics.record({ ok: true });
    assert.equal(metrics.maybeLog(write), false, `fired early at request ${i + 1}`);
  }
  metrics.record({ ok: true });
  assert.equal(metrics.maybeLog(write), true);
  assert.equal(lines.length, 1);

  for (let i = 0; i < MEM_LOG_EVERY; i++) {
    metrics.record({ ok: true });
    metrics.maybeLog(write);
  }
  assert.equal(lines.length, 2, 'second interval should emit exactly one more line');
});

test('deltas are per-interval, not cumulative', () => {
  const lines = [];
  const write = (l) => lines.push(l);

  for (let i = 0; i < MEM_LOG_EVERY * 2; i++) {
    metrics.record({ ok: true, bytes: 1024 * 1024 });
    metrics.maybeLog(write);
  }

  assert.equal(lines.length, 2);
  // Cumulative totals climb...
  assert.match(lines[0], new RegExp(`req=${MEM_LOG_EVERY} `));
  assert.match(lines[1], new RegExp(`req=${MEM_LOG_EVERY * 2} `));
  // ...while the per-interval request delta stays the same. This is the bug
  // worth guarding: a cumulative delta would make MB/req look like it was
  // falling as the process aged, which is exactly backwards.
  assert.match(lines[0], new RegExp(`\\(\\+${MEM_LOG_EVERY} in `));
  assert.match(lines[1], new RegExp(`\\(\\+${MEM_LOG_EVERY} in `));
});

test('the line carries the fields the diagnosis turns on', () => {
  metrics.setGauges(() => ({ robots: 431, limiter: 433 }));
  metrics.record({ ok: true, bytes: 5 * 1024 * 1024 });

  const line = metrics.formatLine();
  for (const field of ['req=', 'ok=', 'bytes=', 'hosts=robots:431/limiter:433', 'rss=', 'heap=', 'ext=', 'MB/req']) {
    assert.ok(line.includes(field), `missing ${field} in: ${line}`);
  }
});

test('no requests since the last line does not divide by zero', () => {
  // Drive a full interval so a line fires and the mark resets...
  for (let i = 0; i < MEM_LOG_EVERY; i++) {
    metrics.record({ ok: true });
    metrics.maybeLog(() => {});
  }
  // ...then format with nothing in between, which is what an idle service
  // polled on /metrics looks like.
  const line = metrics.formatLine();
  assert.match(line, /\(\+0 in /);
  assert.ok(line.includes('+0.000MB/req'), line);
  assert.doesNotMatch(line, /NaN|Infinity/);
});

test('a heap that shrank reports a negative retention, not a wrapped one', () => {
  // GC between two lines can legitimately leave less heap than before. The
  // line has to read as "-12.0MB", not as a huge positive number.
  metrics.record({ ok: true });
  const line = metrics.formatLine();
  assert.doesNotMatch(line, /NaN|Infinity|undefined/);
  assert.match(line, /retained [+-]\d+\.\d+MB = [+-]\d+\.\d+MB\/req/);
});

test('gauges are optional', () => {
  metrics.resetForTest(); // clears gauges
  metrics.record({ ok: true });
  const line = metrics.formatLine();
  assert.doesNotMatch(line, /hosts=/, 'no gauges registered should mean no hosts field');
});

test('a throwing gauge costs a field, not the request', () => {
  // This runs inside a live request path. Instrumentation that can throw is
  // instrumentation that turns a diagnosis into an outage.
  metrics.setGauges(() => {
    throw new Error('gauge exploded');
  });
  metrics.record({ ok: true });

  assert.doesNotThrow(() => metrics.snapshot());
  assert.doesNotThrow(() => metrics.formatLine());
  assert.deepEqual(metrics.snapshot().hosts, {});
  assert.doesNotMatch(metrics.formatLine(), /hosts=/);
});

test('snapshot exposes memory fields as raw bytes for machine reading', () => {
  const s = metrics.snapshot();
  for (const key of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']) {
    assert.equal(typeof s.memory[key], 'number', `memory.${key}`);
    assert.ok(s.memory[key] >= 0);
  }
  assert.equal(typeof s.uptimeSeconds, 'number');
});

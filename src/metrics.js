'use strict';

const { MEM_LOG_EVERY } = require('./config');

// Process counters and a periodic memory line.
//
// This exists to answer one question that guesswork could not: the pod fills a
// 1 GB heap in ~22 minutes and dies (`FATAL ERROR: Ineffective mark-compacts
// near heap limit`), *after* the per-page parse budget and the shared-Window
// parser landed. So something retains memory per request, and at the sweep's
// rate that is on the order of a megabyte each — about 100x more than the
// jsdom Window churn that was fixed.
//
// Local reproduction never saw it, and the reason is a gap in the harness,
// not in the theory: every local run hit ONE plain-HTTP origin. Production
// hits thousands of distinct HTTPS origins, roughly one new origin per
// request for a citation sweep. Two known per-origin structures grew without
// bound (`robots.js`'s parser cache and `rateLimiter.js`'s two Maps — both
// now capped, see below), and undici keeps a connection pool and TLS state
// per origin underneath `fetch`.
//
// So the line below reports, per interval: how much heap was retained, how
// many requests caused it, how many bytes were fetched, and how many origins
// each per-origin structure is now holding. Growth tracking `req` points at
// something per-request; growth tracking `hosts` points at the per-origin
// structures; growth tracking `bytes` points at what we read rather than how
// often. Those are different bugs with different fixes, and this is what
// tells them apart.
//
// `rtxt` was added after the first production reading was misread. That
// reading — 151 MB retained over 50 requests against "only 8.4 MB
// downloaded" — treated the small byte count as ruling out what we read, and
// concluded the growth had to be in parsing. But `bytes` counts the target
// body only; a sweep also fetches one robots.txt per new origin, parses it,
// and (before the cap) kept it forever. Those bytes were in neither number.
// `rtxt` is fetch count / total / largest single file, and the `hosts` gauge
// carries what the cache is holding now. If robots.txt is the retention, the
// cap turns the curve flat and `rEvict` climbs; if the heap still grows with
// `hosts` parked at its ceiling, it is undici's per-origin state or something
// per-request, and this line says which.
//
// Deliberately cheap: integer counters, no per-request allocation, no new
// unbounded structure of its own. The host gauges read the size of Maps that
// already exist rather than keeping a Set here — adding a structure that
// grows per origin, while hunting a leak that grows per origin, would be a
// good way to measure our own instrumentation.
//
// This is diagnostic scaffolding, not a feature. Once the leak is found and
// fixed, deleting this file, its test, its config entry and the calls in
// server.js should leave no trace.

const counts = {
  requests: 0,
  cached: 0,
  ok: 0,
  httpError: 0,
  networkError: 0,
  robotsBlocked: 0,
  rateLimited: 0,
  invalidPage: 0,
  noContent: 0,
  pdf: 0,
  truncated: 0,
};

let bytesFetched = 0;

// robots.txt is fetched by src/robots.js, not src/fetchTarget.js, so it never
// reached `bytesFetched` — and in a sweep there is close to one of them per
// request, each one parsed and then *kept*. That made "151 MB retained while
// only 8.4 MB was downloaded" a comparison against the wrong number: the
// downloads the reading was meant to exonerate were not all being counted.
// Tracked separately rather than folded into `bytesFetched`, because which of
// the two is growing is the whole question.
let robotsFetches = 0;
let robotsBytes = 0;
let robotsMaxBytes = 0;

let gauges = () => ({});

// Baseline for the per-interval deltas, reset each time a line is emitted.
let mark = { requests: 0, bytesFetched: 0, heapUsed: 0, at: Date.now() };

function mb(bytes) {
  return bytes / 1024 / 1024;
}

// server.js registers a reader for the sizes of the per-origin structures it
// owns, so this module doesn't have to reach into them (and can't keep them
// alive by holding a reference to something it shouldn't).
function setGauges(fn) {
  gauges = typeof fn === 'function' ? fn : () => ({});
}

// One request's outcome. Every field is optional; callers pass what applies.
function record(event = {}) {
  counts.requests += 1;
  for (const key of [
    'cached',
    'ok',
    'httpError',
    'networkError',
    'robotsBlocked',
    'rateLimited',
    'invalidPage',
    'noContent',
    'pdf',
    'truncated',
  ]) {
    if (event[key]) counts[key] += 1;
  }
  if (typeof event.bytes === 'number' && event.bytes > 0) {
    bytesFetched += event.bytes;
  }
}

// One robots.txt read. `bytes` is 0 for a miss, a failure or a timeout — all
// of which still cost a request, which is why the count is separate from the
// total rather than inferred from it.
function recordRobotsFetch(bytes = 0) {
  robotsFetches += 1;
  if (typeof bytes === 'number' && bytes > 0) {
    robotsBytes += bytes;
    if (bytes > robotsMaxBytes) robotsMaxBytes = bytes;
  }
}

function snapshot() {
  const m = process.memoryUsage();
  return {
    uptimeSeconds: Math.round(process.uptime()),
    counts: { ...counts },
    bytesFetched,
    robots: { fetches: robotsFetches, bytes: robotsBytes, maxBytes: robotsMaxBytes },
    memory: {
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
    },
    // Never let a gauge take the service down. This module is scaffolding
    // bolted onto a live request path; a throwing gauge must cost us a field
    // in a log line, not a 500 on somebody's fetch.
    hosts: readGauges(),
  };
}

function readGauges() {
  try {
    const g = gauges();
    return g && typeof g === 'object' ? g : {};
  } catch {
    return {};
  }
}

// The line the diagnosis actually turns on. The trailing per-request figure is
// the headline: heap retained since the previous line, divided by the requests
// that happened in between.
function formatLine() {
  const s = snapshot();
  const dReq = s.counts.requests - mark.requests;
  const dHeap = s.memory.heapUsed - mark.heapUsed;
  const dBytes = s.bytesFetched - mark.bytesFetched;
  const dSeconds = Math.max(1, Math.round((Date.now() - mark.at) / 1000));

  const hosts = Object.entries(s.hosts)
    .map(([k, v]) => `${k}:${v}`)
    .join('/');

  const perReq = dReq > 0 ? mb(dHeap) / dReq : 0;

  return (
    `[mem] req=${s.counts.requests} (+${dReq} in ${dSeconds}s) ` +
    `ok=${s.counts.ok} http=${s.counts.httpError} net=${s.counts.networkError} ` +
    `robots=${s.counts.robotsBlocked} rl=${s.counts.rateLimited} ` +
    `cached=${s.counts.cached} nocontent=${s.counts.noContent} pdf=${s.counts.pdf} ` +
    `bytes=${mb(s.bytesFetched).toFixed(1)}MB (+${mb(dBytes).toFixed(1)}MB) ` +
    // `rtxt`, not `robots` — the existing `robots=` field is the count of
    // requests blocked by robots.txt, which is a different number entirely.
    `rtxt=${s.robots.fetches}/${mb(s.robots.bytes).toFixed(1)}MB` +
    `(max ${Math.round(s.robots.maxBytes / 1024)}KB) ` +
    (hosts ? `hosts=${hosts} ` : '') +
    `rss=${mb(s.memory.rss).toFixed(1)}MB heap=${mb(s.memory.heapUsed).toFixed(1)}/` +
    `${mb(s.memory.heapTotal).toFixed(1)}MB ext=${mb(s.memory.external).toFixed(1)}MB ` +
    `ab=${mb(s.memory.arrayBuffers).toFixed(1)}MB ` +
    `| retained ${mb(dHeap) >= 0 ? '+' : ''}${mb(dHeap).toFixed(1)}MB ` +
    `= ${perReq >= 0 ? '+' : ''}${perReq.toFixed(3)}MB/req`
  );
}

function resetMark() {
  const s = snapshot();
  mark = {
    requests: s.counts.requests,
    bytesFetched: s.bytesFetched,
    heapUsed: s.memory.heapUsed,
    at: Date.now(),
  };
}

// Called once per request. Emits a line every MEM_LOG_EVERY requests; 0 or
// less turns the periodic line off without disabling /metrics.
function maybeLog(write = (line) => console.log(line)) {
  if (MEM_LOG_EVERY <= 0) return false;
  if (counts.requests === 0 || counts.requests % MEM_LOG_EVERY !== 0) return false;
  write(formatLine());
  resetMark();
  return true;
}

// Test-only: start from a clean slate.
function resetForTest() {
  for (const key of Object.keys(counts)) counts[key] = 0;
  bytesFetched = 0;
  robotsFetches = 0;
  robotsBytes = 0;
  robotsMaxBytes = 0;
  gauges = () => ({});
  resetMark();
}

resetMark();

module.exports = {
  record,
  recordRobotsFetch,
  snapshot,
  formatLine,
  maybeLog,
  setGauges,
  resetForTest,
};

#!/usr/bin/env node
'use strict';

// Throughput/safety probe for fetch-stage concurrency — the thing the
// 2026-08-25 design doc says didn't exist yet ("no equivalent of
// probe-concurrency.js for fetch"). Unlike that doc's verify-side probe,
// this one is not measuring what a shared backend can sustain: fetch means
// firing at hundreds of different third-party sites we don't control, so a
// probe that found "concurrency 64 works great" by hammering a few real
// domains would teach exactly the wrong lesson (design doc, "Fetch
// concurrency: what's actually blocking it", point 2).
//
// So this probe never touches the real internet. It stands up many local
// fixture "publisher" servers (each on its own loopback port, so each is a
// distinct host to the per-host limiter — real TCP, not in-process calls)
// with a deliberate mix of behavior: normal pages, slow pages, hosts that
// 429 us, and a robots.txt-disallowed path on every host. It then drives
// the actual service (server.js, unmodified) at increasing caller
// concurrency and checks, from the publisher side, that the per-host and
// global caps configured in src/config.js actually held — not just that
// throughput went up.
//
// This answers "is the mechanism safe" (do the caps hold under load, are
// our own refusals correctly labelled, does backoff work). It does NOT
// answer "is concurrency N safe against real publishers" — that needs the
// WMCS decision and real (or at least representative) targets. Don't read
// a clean run here as clearance to raise HOST_MAX_CONCURRENCY against real
// sites.
//
// Usage:
//   node scripts/probe-fetch-concurrency.js
//   node scripts/probe-fetch-concurrency.js --levels 1,8,32,128 --requests 300
//   HOST_MAX_CONCURRENCY=2 MAX_CONCURRENT_FETCHES=32 node scripts/probe-fetch-concurrency.js
//
// All of server.js's own env vars (see README's Configuration table) apply
// normally, since this runs the real service. DISABLE_CACHE defaults to 1
// here so the probe needs no Redis; set REDIS_URL yourself to include
// caching in the numbers.

const { parseArgs } = require('node:util');

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    hosts: { type: 'string', default: '24' },
    'urls-per-host': { type: 'string', default: '6' },
    requests: { type: 'string', default: '240' },
    levels: { type: 'string', default: '1,4,16,64,256' },
    skew: { type: 'string', default: '0' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`usage: node scripts/probe-fetch-concurrency.js [options]

Fires --requests calls at each caller concurrency level in --levels, spread
across --hosts local fixture publishers, and reports throughput plus whether
the per-host/global concurrency caps actually held (checked from the
publisher side, not inferred). Never touches the real internet.

Options:
  --hosts <n>          Distinct local fixture hosts (default 24)
  --urls-per-host <n>  Distinct target URLs per host (default 6)
  --requests <n>       Requests fired at each concurrency level (default 240)
  --levels <list>      Comma-separated caller concurrency levels (default 1,4,16,64,256)
  --skew <pct>         Send this % of requests to ONE host, modelling a corpus
                       where a single hostname (web.archive.org) carries a
                       large share of citations. Reports that host's outcomes
                       separately from the long tail. Try --skew 24, the real
                       share measured in benchmark/dataset.json. (default 0)
  --help, -h           Show this help and exit.
`);
  process.exit(0);
}

const NUM_HOSTS = Number(values.hosts);
const URLS_PER_HOST = Number(values['urls-per-host']);
const REQUESTS_PER_LEVEL = Number(values.requests);
const LEVELS = values.levels.split(',').map(Number);
const SKEW_PCT = Number(values.skew);

if (process.env.REDIS_URL === undefined) process.env.DISABLE_CACHE = '1';
process.env.PORT = process.env.PORT || '0';

const config = require('../src/config');
const { createFixtureServer } = require('../test/fixtures-server');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startFixtures(count) {
  const fixtures = [];
  for (let i = 0; i < count; i++) {
    const server = createFixtureServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    server.base = `http://127.0.0.1:${server.address().port}`;
    fixtures.push(server);
  }
  return fixtures;
}

// Deliberate mix, decided once so every level sees the same population:
// most hosts serve ordinary (if variably slow) pages; roughly one in six
// always 429s us, to exercise real publisher-side backoff; every host also
// has one robots.txt-disallowed path (fixtures-server.js disallows
// `/blocked` for all instances).
function buildTargetPool(fixtures) {
  const targets = [];
  fixtures.forEach((fixture, hostIdx) => {
    for (let i = 0; i < URLS_PER_HOST; i++) {
      const holdMs = 50 + Math.floor(Math.random() * 400);
      targets.push(`${fixture.base}/hold?ms=${holdMs}&i=${i}`);
    }
    if (hostIdx % 6 === 0) {
      targets.push(`${fixture.base}/ratelimited`);
    }
    if (hostIdx % 8 === 0) {
      targets.push(`${fixture.base}/blocked`);
    }
  });
  // A handful of exact duplicates, so a level with enough concurrency to
  // make them genuinely simultaneous exercises request coalescing too.
  for (let i = 0; i < Math.min(5, targets.length); i++) {
    targets.push(targets[Math.floor(Math.random() * targets.length)]);
  }
  return targets;
}

// Per-host limiting is a good model of "one publisher's tolerance" only while
// hosts are roughly interchangeable. A corpus where one hostname carries a
// large share of citations breaks that assumption: that host's requests all
// compete for a single slot while the long tail runs fully parallel, so the
// concentrated host starves on our *own* refusals while everything else
// sails through. Real Wikipedia corpora look exactly like this because of
// web.archive.org, so the probe has to be able to produce that shape.
function buildSkewedPool(targets, hotHostBase) {
  if (!SKEW_PCT) return { pool: targets, isHot: () => false };
  const hot = targets.filter((t) => t.startsWith(hotHostBase));
  const cold = targets.filter((t) => !t.startsWith(hotHostBase));
  return {
    pool: targets,
    hotBase: hotHostBase,
    isHot: (url) => url.startsWith(hotHostBase),
    hot,
    cold,
  };
}

async function runLevel(concurrency, totalRequests, targets, baseUrl, levelNonce, skew) {
  let nextIdx = 0;
  const results = new Array(totalRequests);

  // With --skew, pick the target by share rather than round-robin, so the hot
  // host really does receive SKEW_PCT of the load.
  function pickTarget(i) {
    if (!skew || !skew.hotBase || skew.hot.length === 0 || skew.cold.length === 0) {
      return targets[i % targets.length];
    }
    return i % 100 < SKEW_PCT
      ? skew.hot[i % skew.hot.length]
      : skew.cold[i % skew.cold.length];
  }

  async function worker() {
    for (;;) {
      const i = nextIdx++;
      if (i >= totalRequests) return;
      // Built via URL/searchParams rather than string concatenation, so this
      // is correct whether or not the target already has a query string
      // (naive `+ '&lv=' + n` mangles a bare-path target like /ratelimited
      // into an unrecognized path, which is a bug this probe hit once).
      const targetUrl = new URL(pickTarget(i));
      targetUrl.searchParams.set('lv', String(levelNonce));
      const target = targetUrl.toString();
      const hot = skew ? skew.isHot(targetUrl.origin + '/') : false;
      const start = Date.now();
      try {
        const u = new URL('/', baseUrl);
        u.searchParams.set('fetch', target);
        const res = await fetch(u);
        const body = await res.json();
        results[i] = { ms: Date.now() - start, httpStatus: res.status, body, hot };
      } catch (e) {
        results[i] = {
          ms: Date.now() - start,
          httpStatus: 0,
          hot,
          body: { status: null, error: String(e), refused_by: null, coalesced: false },
        };
      }
    }
  }

  const wallStart = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { wallMs: Date.now() - wallStart, results };
}

function summarize(results) {
  const statusCounts = new Map();
  const refusedByCounts = new Map();
  let coalesced = 0;
  let latencySum = 0;
  let latencyMax = 0;

  for (const r of results) {
    const key = r.httpStatus === 0 ? 'transport-error' : String(r.httpStatus);
    statusCounts.set(key, (statusCounts.get(key) || 0) + 1);
    const refusedBy = r.body.refused_by === null || r.body.refused_by === undefined
      ? 'none (real or n/a)'
      : r.body.refused_by;
    refusedByCounts.set(refusedBy, (refusedByCounts.get(refusedBy) || 0) + 1);
    if (r.body.coalesced) coalesced += 1;
    latencySum += r.ms;
    if (r.ms > latencyMax) latencyMax = r.ms;
  }

  return {
    statusCounts,
    refusedByCounts,
    coalesced,
    avgMs: Math.round(latencySum / results.length),
    maxMs: latencyMax,
  };
}

function fmtCounts(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

async function main() {
  console.log(
    `Starting ${NUM_HOSTS} local fixture publishers (${URLS_PER_HOST} URLs each) ` +
      `and the real service (host cap ${config.HOST_MAX_CONCURRENCY}, ` +
      `min interval ${config.HOST_MIN_INTERVAL_MS}ms, global cap ${config.MAX_CONCURRENT_FETCHES})...`
  );

  const fixtures = await startFixtures(NUM_HOSTS);
  const targets = buildTargetPool(fixtures);
  // The first fixture stands in for the one concentrated host.
  const skew = SKEW_PCT ? buildSkewedPool(targets, `${fixtures[0].base}/`) : null;
  if (skew) {
    console.log(
      `Skew: ${SKEW_PCT}% of requests directed at a single host ` +
        `(${fixtures[0].base}), the rest spread across the other ${NUM_HOSTS - 1}.`
    );
  }

  const sourceFetcherServer = require('../server');
  const baseUrl = await new Promise((resolve) => {
    const check = setInterval(async () => {
      try {
        const port = sourceFetcherServer.address()?.port;
        if (!port) return;
        const res = await fetch(`http://127.0.0.1:${port}/stats`);
        if (res.ok) {
          clearInterval(check);
          resolve(`http://127.0.0.1:${port}`);
        }
      } catch {
        // not up yet
      }
    }, 50);
  });
  console.log(`Service ready at ${baseUrl}. Target pool: ${targets.length} URLs.\n`);

  const rows = [];

  for (const level of LEVELS) {
    for (const fixture of fixtures) fixture.reset();

    const { wallMs, results } = await runLevel(
      level,
      REQUESTS_PER_LEVEL,
      targets,
      baseUrl,
      level,
      skew
    );
    const summary = summarize(results);

    const perHostPeak = Math.max(...fixtures.map((f) => f.stats.maxInFlight));
    const hostCapHeld = perHostPeak <= config.HOST_MAX_CONCURRENCY;

    const stats = await (await fetch(`${baseUrl}/stats`)).json();
    const globalCapHeld = stats.capacity.peak_active <= config.MAX_CONCURRENT_FETCHES;

    const throughput = (REQUESTS_PER_LEVEL / (wallMs / 1000)).toFixed(2);

    console.log(`── concurrency ${level} ${'─'.repeat(Math.max(0, 50 - String(level).length))}`);
    console.log(`  wall: ${wallMs}ms   throughput: ${throughput} req/s   avg: ${summary.avgMs}ms   max: ${summary.maxMs}ms`);
    console.log(`  status:     ${fmtCounts(summary.statusCounts)}`);
    console.log(`  refused_by: ${fmtCounts(summary.refusedByCounts)}`);
    console.log(`  coalesced:  ${summary.coalesced}`);

    if (skew) {
      const split = (hot) => {
        const s = results.filter((r) => r.hot === hot);
        const starved = s.filter((r) => r.body.refused_by === 'rate-limiter').length;
        const ok = s.filter((r) => r.body.status === 200).length;
        const pct = s.length ? Math.round((100 * starved) / s.length) : 0;
        return { n: s.length, ok, starved, pct };
      };
      const hot = split(true);
      const tail = split(false);
      console.log(
        `  concentrated host: ${hot.n} reqs, ${hot.ok} ok, ` +
          `${hot.starved} refused by us (${hot.pct}% starved)`
      );
      console.log(
        `  long tail:         ${tail.n} reqs, ${tail.ok} ok, ` +
          `${tail.starved} refused by us (${tail.pct}% starved)`
      );
      if (hot.pct - tail.pct >= 25) {
        console.log(
          `  ^^ the concentrated host is being starved relative to the tail: ` +
            `per-host limiting is penalising it for being popular, not for misbehaving.`
        );
      }
    }
    console.log(
      `  per-host peak seen by publishers: ${perHostPeak} (cap ${config.HOST_MAX_CONCURRENCY}) ` +
        `${hostCapHeld ? 'OK' : '*** VIOLATED ***'}`
    );
    console.log(
      `  global peak seen by service:      ${stats.capacity.peak_active} (cap ${config.MAX_CONCURRENT_FETCHES}) ` +
        `${globalCapHeld ? 'OK' : '*** VIOLATED ***'}`
    );
    console.log(
      `  service totals so far: ${stats.upstream_fetches_total} upstream fetches, ` +
        `${stats.hosts.refused_total} host-refused, ${stats.capacity.shed_total} capacity-shed, ` +
        `${stats.hosts.backoff_total} backoffs, ${stats.coalesced_total} coalesced\n`
    );

    rows.push({ level, throughput: Number(throughput), hostCapHeld, globalCapHeld });

    // Let in-flight cooldowns/queues from this level settle before the next
    // one starts, so one level's backoff state doesn't read as the next
    // level's failure.
    await sleep(200);
  }

  console.log('Summary:');
  console.table(rows);

  const anyViolation = rows.some((r) => !r.hostCapHeld || !r.globalCapHeld);
  if (anyViolation) {
    console.error('\nA concurrency cap was violated at some level — see *** VIOLATED *** above.');
  } else {
    console.log('\nAll configured caps held at every level tested.');
  }

  for (const fixture of fixtures) {
    fixture.closeAllConnections?.();
    await new Promise((resolve) => fixture.close(resolve));
  }
  sourceFetcherServer.closeAllConnections?.();
  await new Promise((resolve) => sourceFetcherServer.close(resolve));
  const cache = require('../src/cache');
  await cache.disconnect();

  process.exit(anyViolation ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

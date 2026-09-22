'use strict';

const robotsParser = require('robots-parser');
const metrics = require('./metrics');
const {
  USER_AGENT,
  ROBOTS_TIMEOUT_MS,
  ROBOTS_CACHE_TTL_MS,
  ROBOTS_CACHE_MAX,
  ROBOTS_CACHE_MAX_BYTES,
} = require('./config');

// origin -> { parserPromise, expiresAt, bytes }
//
// Bounded two ways, because this is the structure most likely to be the
// per-origin retention the `[mem]` line was added to find. See the README's
// memory section. Map iteration order is insertion order, and `touch()` below
// re-inserts on every hit, so the head of the Map is the least recently used
// entry and eviction is a walk from the front.
const cache = new Map();

// Sum of `bytes` over live entries, maintained incrementally rather than
// recomputed: eviction runs on the request path.
let cachedBytes = 0;
let evictions = 0;

async function fetchRobotsTxt(origin) {
  const robotsUrl = `${origin}/robots.txt`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROBOTS_TIMEOUT_MS);
  try {
    const resp = await fetch(robotsUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!resp.ok) {
      // No robots.txt (404) or the host errored on it — default-allow, same
      // as every well-behaved crawler does for a missing robots.txt.
      metrics.recordRobotsFetch(0);
      return { parser: robotsParser(robotsUrl, ''), bytes: 0 };
    }
    const text = await resp.text();
    const bytes = Buffer.byteLength(text);
    // Counted separately from the target body in src/fetchTarget.js, and the
    // reason that separation matters: a sweep fetches one of these per new
    // origin, so "we only downloaded 8 MB" can be true of the bodies and
    // badly wrong about what this process actually read and kept.
    metrics.recordRobotsFetch(bytes);
    return { parser: robotsParser(robotsUrl, text), bytes };
  } catch {
    // Unreachable/timeout fetching robots.txt itself — don't let that block
    // the actual fetch; default-allow.
    metrics.recordRobotsFetch(0);
    return { parser: robotsParser(robotsUrl, ''), bytes: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function drop(origin) {
  const entry = cache.get(origin);
  if (!entry) return;
  cache.delete(origin);
  cachedBytes -= entry.bytes;
}

// Evicts until both ceilings hold: expired entries first (they are already
// dead — dropping one costs nothing but a refetch that was going to happen
// anyway), then least-recently-used.
//
// `bytes` is only known once the fetch resolves, so an in-flight entry counts
// as 0 and the byte budget can be exceeded briefly by whatever is in flight.
// Bounding that too would mean blocking on a size we cannot know yet.
function evict() {
  const now = Date.now();
  for (const [origin, entry] of cache) {
    if (cache.size <= ROBOTS_CACHE_MAX && cachedBytes <= ROBOTS_CACHE_MAX_BYTES) return;
    if (entry.expiresAt > now) continue;
    drop(origin);
    evictions += 1;
  }
  for (const origin of cache.keys()) {
    if (cache.size <= ROBOTS_CACHE_MAX && cachedBytes <= ROBOTS_CACHE_MAX_BYTES) return;
    drop(origin);
    evictions += 1;
  }
}

// Moves an entry to the back of the Map, so insertion order is LRU order.
function touch(origin, entry) {
  cache.delete(origin);
  cache.set(origin, entry);
}

// Returns true if `targetUrl` may be fetched per its host's robots.txt.
// Results are cached per host for ROBOTS_CACHE_TTL_MS.
async function isAllowedByRobots(targetUrl) {
  const parsed = new URL(targetUrl);
  const origin = parsed.origin;

  let entry = cache.get(origin);
  if (entry && entry.expiresAt > Date.now()) {
    touch(origin, entry);
  } else {
    if (entry) drop(origin);
    entry = { parserPromise: null, expiresAt: Date.now() + ROBOTS_CACHE_TTL_MS, bytes: 0 };
    entry.parserPromise = fetchRobotsTxt(origin).then((result) => {
      // The entry may have been evicted while this was in flight; only adjust
      // the byte total if it is still the one in the Map, or the total drifts
      // permanently away from what is actually held.
      if (cache.get(origin) === entry) {
        entry.bytes = result.bytes;
        cachedBytes += result.bytes;
        evict();
      }
      return result.parser;
    });
    cache.set(origin, entry);
    evict();
  }

  const parser = await entry.parserPromise;
  const allowed = parser.isAllowed(targetUrl, USER_AGENT);
  // robots-parser returns undefined when a rule can't be determined; treat
  // that as allowed rather than blocking on ambiguity.
  return allowed !== false;
}

// How many origins this cache is holding. Read by src/metrics.js, because a
// heap that grows in step with this number points here rather than at anything
// per-request. It used to grow without bound; it is now capped by
// ROBOTS_CACHE_MAX / ROBOTS_CACHE_MAX_BYTES, so if the heap keeps climbing
// while this sits at its ceiling, the growth is somewhere else.
function robotsCacheSize() {
  return cache.size;
}

// Bytes of robots.txt source currently held, and how many entries have been
// evicted since start. Evictions climbing means the ceiling is binding — which
// is the thing to know before concluding this cache was innocent.
function robotsCacheStats() {
  return { entries: cache.size, bytes: cachedBytes, evictions };
}

// Test-only: start from a clean slate.
function resetForTest() {
  cache.clear();
  cachedBytes = 0;
  evictions = 0;
}

module.exports = { isAllowedByRobots, robotsCacheSize, robotsCacheStats, resetForTest };

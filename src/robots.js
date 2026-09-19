'use strict';

const robotsParser = require('robots-parser');
const { USER_AGENT, ROBOTS_TIMEOUT_MS, ROBOTS_CACHE_TTL_MS } = require('./config');

// host -> { parser, expiresAt }
const cache = new Map();

function waitForSharedLookup(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      }
    );
  });
}

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
      return robotsParser(robotsUrl, '');
    }
    const text = await resp.text();
    return robotsParser(robotsUrl, text);
  } catch {
    // Unreachable/timeout fetching robots.txt itself — don't let that block
    // the actual fetch; default-allow.
    return robotsParser(robotsUrl, '');
  } finally {
    clearTimeout(timer);
  }
}

// Returns true if `targetUrl` may be fetched per its host's robots.txt.
// Results are cached per host for ROBOTS_CACHE_TTL_MS.
async function isAllowedByRobots(targetUrl, signal) {
  const parsed = new URL(targetUrl);
  const origin = parsed.origin;

  let entry = cache.get(origin);
  if (!entry || entry.expiresAt <= Date.now()) {
    const parserPromise = fetchRobotsTxt(origin);
    entry = { parserPromise, expiresAt: Date.now() + ROBOTS_CACHE_TTL_MS };
    cache.set(origin, entry);
  }

  // The lookup is shared by all concurrent requests for this origin. Abort
  // this caller's wait without cancelling (and poisoning) the shared lookup.
  const parser = await waitForSharedLookup(entry.parserPromise, signal);
  const allowed = parser.isAllowed(targetUrl, USER_AGENT);
  // robots-parser returns undefined when a rule can't be determined; treat
  // that as allowed rather than blocking on ambiguity.
  return allowed !== false;
}

// How many origins this cache is holding. Entries are never evicted — an
// expired one is overwritten, not deleted — so this only ever grows, once per
// distinct origin seen. Read by src/metrics.js, because a heap that grows in
// step with this number points here rather than at anything per-request.
function robotsCacheSize() {
  return cache.size;
}

module.exports = { isAllowedByRobots, robotsCacheSize };

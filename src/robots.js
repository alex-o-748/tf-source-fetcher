'use strict';

const robotsParser = require('robots-parser');
const { USER_AGENT, ROBOTS_TIMEOUT_MS, ROBOTS_CACHE_TTL_MS } = require('./config');

// host -> { parser, expiresAt }
const cache = new Map();

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
async function isAllowedByRobots(targetUrl) {
  const parsed = new URL(targetUrl);
  const origin = parsed.origin;

  let entry = cache.get(origin);
  if (!entry || entry.expiresAt <= Date.now()) {
    const parserPromise = fetchRobotsTxt(origin);
    entry = { parserPromise, expiresAt: Date.now() + ROBOTS_CACHE_TTL_MS };
    cache.set(origin, entry);
  }

  const parser = await entry.parserPromise;
  const allowed = parser.isAllowed(targetUrl, USER_AGENT);
  // robots-parser returns undefined when a rule can't be determined; treat
  // that as allowed rather than blocking on ambiguity.
  return allowed !== false;
}

module.exports = { isAllowedByRobots };

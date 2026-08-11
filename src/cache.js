'use strict';

const Redis = require('ioredis');
const {
  REDIS_URL,
  CACHE_KEY_PREFIX,
  CACHE_TTL_OK_SECONDS,
  CACHE_TTL_ERROR_SECONDS,
  CACHE_DISABLED,
} = require('./config');

let client = null;
let ready = false;

// Connects once at startup. If Redis is unreachable, the service still comes
// up — it just runs without a cache rather than failing to boot or hanging
// requests on offline-queued commands.
async function connect() {
  if (CACHE_DISABLED) {
    console.log('[cache] disabled via DISABLE_CACHE=1');
    return;
  }
  client = new Redis(REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  client.on('error', (err) => {
    if (ready) {
      console.warn('[cache] redis error, caching temporarily degraded:', err.message);
    }
  });
  try {
    await client.connect();
    ready = true;
    console.log(`[cache] connected to Redis at ${REDIS_URL}`);
  } catch (err) {
    console.warn(
      `[cache] could not connect to Redis at ${REDIS_URL} (${err.message}); running without a cache`
    );
    ready = false;
  }
}

// Cache key: normalized URL (fragment stripped, host lowercased) plus the
// optional page number, so distinct PDF pages of the same URL don't collide.
function normalizeKey(targetUrl, page) {
  let normalized;
  try {
    const u = new URL(targetUrl);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    normalized = u.toString();
  } catch {
    normalized = targetUrl;
  }
  return `${CACHE_KEY_PREFIX}${normalized}${page ? `#page=${page}` : ''}`;
}

async function get(targetUrl, page) {
  if (!ready) return null;
  try {
    const raw = await client.get(normalizeKey(targetUrl, page));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('[cache] get failed:', err.message);
    return null;
  }
}

async function set(targetUrl, page, value, ttlSeconds) {
  if (!ready) return;
  try {
    await client.set(normalizeKey(targetUrl, page), JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    console.warn('[cache] set failed:', err.message);
  }
}

async function disconnect() {
  if (client) {
    await client.quit().catch(() => client.disconnect());
  }
  ready = false;
}

module.exports = {
  connect,
  disconnect,
  get,
  set,
  isReady: () => ready,
  CACHE_TTL_OK_SECONDS,
  CACHE_TTL_ERROR_SECONDS,
};

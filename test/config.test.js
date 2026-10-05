'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Each test file runs in its own process, so config is read fresh here.
delete process.env.REDIS_URL;
delete process.env.CACHE_KEY_PREFIX;
const config = require('../src/config');

test('the default Redis is the address Help:Toolforge/Redis gives', () => {
  // `tools-redis:6379`, the old default, is not on that page, and an
  // unreachable Redis means a silently cache-less service.
  assert.equal(config.REDIS_URL, 'redis://redis.svc.tools.eqiad1.wikimedia.cloud:6379');
});

test('the cache key prefix keeps its old default when unset', () => {
  assert.equal(config.CACHE_KEY_PREFIX, 'source-fetcher:');
});

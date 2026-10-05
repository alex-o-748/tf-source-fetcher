'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { networkErrorCode, isCacheableNetworkError } = require('../src/networkError');

// Shapes copied from what Node 22's fetch actually throws (probed against a
// local server and an unresolvable host): the top-level message is always
// "fetch failed" or "terminated", and the code is one level down.
function fetchFailed(cause) {
  return new TypeError('fetch failed', { cause });
}
function withCode(message, code) {
  return Object.assign(new Error(message), { code });
}

test('networkErrorCode reads the code off the cause, not the top-level error', () => {
  assert.equal(networkErrorCode(fetchFailed(withCode('getaddrinfo ENOTFOUND x.invalid', 'ENOTFOUND'))), 'ENOTFOUND');
  assert.equal(networkErrorCode(fetchFailed(withCode('connect ECONNREFUSED 127.0.0.1:9', 'ECONNREFUSED'))), 'ECONNREFUSED');
  assert.equal(networkErrorCode(fetchFailed(withCode('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'))), 'DEPTH_ZERO_SELF_SIGNED_CERT');
});

test('networkErrorCode handles a mid-body reset ("terminated")', () => {
  const e = new TypeError('terminated', { cause: withCode('other side closed', 'UND_ERR_SOCKET') });
  assert.equal(networkErrorCode(e), 'UND_ERR_SOCKET');
});

test('networkErrorCode falls back to the first member of an AggregateError', () => {
  const agg = new AggregateError([withCode('a', 'ETIMEDOUT'), withCode('b', 'ENETUNREACH')], 'connect failed');
  assert.equal(networkErrorCode(fetchFailed(agg)), 'ETIMEDOUT');
});

test('networkErrorCode is null when nothing carries a code', () => {
  assert.equal(networkErrorCode(fetchFailed(new Error('bad port'))), null);
  assert.equal(networkErrorCode(new Error('plain')), null);
  assert.equal(networkErrorCode(null), null);
});

test('DNS and certificate failures are cacheable — they describe the publisher', () => {
  for (const code of [
    'ENOTFOUND',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'EPROTO',
  ]) {
    assert.equal(isCacheableNetworkError(code), true, code);
  }
});

test('failures that a restart or an egress blip could cause are not cacheable', () => {
  for (const code of [
    'ECONNREFUSED',
    'UND_ERR_CONNECT_TIMEOUT',
    'ETIMEDOUT',
    'ECONNRESET',
    'UND_ERR_SOCKET',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    null,
    undefined,
    '',
  ]) {
    assert.equal(isCacheableNetworkError(code), false, String(code));
  }
});

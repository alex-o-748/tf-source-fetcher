'use strict';

// Attributing the `networkError` counter.
//
// After the retention fix (README, cause 4) the fetch failure rate fell from
// 57% to 18%. The remainder is worth attributing rather than dismissing, and
// one counter could not: a host that does not resolve, a certificate we
// reject, a publisher too slow for the 20 s timeout and an unhandled
// exception in this process all landed in the same number. Node's fetch makes
// it worse by reporting nearly everything as `TypeError: fetch failed` with
// the real reason hidden in `err.cause.code`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyNetworkError } = require('../src/fetchTarget');
const metrics = require('../src/metrics');

// How undici actually surfaces a failure: the message is useless, the cause
// carries the code.
function undiciError(code, message = 'fetch failed') {
  const err = new TypeError(message);
  err.cause = Object.assign(new Error(message), { code });
  return err;
}

test('classifies the failures a sweep actually meets', () => {
  const cases = [
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ECONNREFUSED', 'refused'],
    ['ECONNRESET', 'reset'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['HPE_INVALID_CONSTANT', 'protocol'],
  ];
  for (const [code, expected] of cases) {
    const { category } = classifyNetworkError(undiciError(code));
    assert.equal(category, expected, `${code} should classify as ${expected}`);
  }
});

test('our own fetch timeout is a timeout, not an unknown', () => {
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  assert.equal(classifyNetworkError(abort).category, 'timeout');
});

test('falls back to the message when there is no code', () => {
  assert.equal(
    classifyNetworkError(new Error('unable to verify the first certificate')).category,
    'tls'
  );
  assert.equal(classifyNetworkError(new Error('socket hang up')).category, 'reset');
});

test('an unrecognized failure keeps its raw code for later', () => {
  const { category, code } = classifyNetworkError(undiciError('UND_ERR_SOMETHING_NEW'));
  assert.equal(category, 'other');
  assert.equal(code, 'UND_ERR_SOMETHING_NEW', 'the code must survive, or the bucket is a dead end');
});

test('a body-read failure defaults to `body`, not `other`', () => {
  // Getting that far means the connection and headers were fine, so this is a
  // download that died part-way rather than a host we never reached.
  assert.equal(classifyNetworkError(new Error('terminated'), 'body').category, 'body');
});

test('counts by category and keeps unknown codes bounded', () => {
  metrics.resetForTest();

  metrics.record({ networkError: true, netCategory: 'dns', netCode: 'ENOTFOUND' });
  metrics.record({ networkError: true, netCategory: 'dns', netCode: 'ENOTFOUND' });
  metrics.record({ networkError: true, netCategory: 'timeout' });
  metrics.record({ networkError: true, netCategory: 'internal' });

  const s = metrics.snapshot();
  assert.equal(s.netCategories.dns, 2);
  assert.equal(s.netCategories.timeout, 1);
  assert.equal(s.netCategories.internal, 1);
  // The headline `net=` and the breakdown must always agree — a category that
  // silently drops a failure would read as "fewer errors", the worst way to be
  // wrong about this.
  const summed = Object.values(s.netCategories).reduce((a, b) => a + b, 0);
  assert.equal(s.counts.networkError, 4);
  assert.equal(summed, s.counts.networkError, 'every counted failure must land in a category');

  // A category this module does not know must not create a key.
  metrics.record({ networkError: true, netCategory: 'invented', netCode: 'X1' });
  assert.equal(metrics.snapshot().netCategories.other, 1);
  assert.ok(!('invented' in metrics.snapshot().netCategories));

  for (let i = 0; i < 100; i += 1) {
    metrics.record({ networkError: true, netCategory: 'other', netCode: `CODE_${i}` });
  }
  assert.ok(
    metrics.snapshot().unknownNetCodes.length <= 20,
    'the unknown-code set must be capped — it is fed by remote behaviour'
  );
});

test('the [mem] line shows the breakdown only when something failed', () => {
  metrics.resetForTest();
  metrics.record({ ok: true });
  assert.doesNotMatch(metrics.formatLine(), /net\[/, 'a clean run should not print ten zeroes');

  metrics.record({ networkError: true, netCategory: 'tls' });
  assert.match(metrics.formatLine(), /net\[tls:1\]/);
});

// The constraint that makes all of the above safe to ship.
test('the returned error wording is unchanged, because the client parses it', () => {
  // citation-checker-script's core/worker.js decides whether to retry with
  // /^(?:fetch failed|terminated)$/ — its own transport failure, worth another
  // go — and deliberately does NOT retry "Request to source timed out".
  // Classifying must not change those strings: replacing "fetch failed" with
  // "getaddrinfo ENOTFOUND example.com" would turn every retryable transport
  // failure into a permanent SOURCE UNAVAILABLE row.
  const PROXY_TRANSPORT_FAILURE = /^(?:fetch failed|terminated)$|^Source fetch timed out/i;

  const undici = undiciError('ENOTFOUND');
  const reason = undici.name === 'AbortError' ? 'Request to source timed out' : undici.message;
  assert.equal(reason, 'fetch failed');
  assert.ok(PROXY_TRANSPORT_FAILURE.test(reason), 'the client must still see this as retryable');

  const abort = new Error('whatever');
  abort.name = 'AbortError';
  const timeoutReason =
    abort.name === 'AbortError' ? 'Request to source timed out' : abort.message;
  assert.equal(
    PROXY_TRANSPORT_FAILURE.test(timeoutReason),
    false,
    'a source timeout must stay non-retryable'
  );
});

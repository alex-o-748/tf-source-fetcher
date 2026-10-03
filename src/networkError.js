'use strict';

// Node's fetch (undici) throws the same top-level message, "fetch failed", for
// every connection-level failure: a domain that no longer exists, a refused
// connection, an expired certificate, a reset. The reason is only on the
// error's `cause`. It used to be dropped here, so a caller could not tell a
// dead domain from a one-off blip, and retried both alike — four attempts and
// ~7s of backoff per dead link, for a failure that reproduces every time.
//
// This module recovers the code so the response can carry it as `errorCode`.

// Walks the cause chain for the first Node/undici error code. Happy-eyeballs
// connects (several addresses per host) can fail with an AggregateError; Node
// usually copies the first member's code onto it, and `errors[0]` covers the
// case where it does not.
function networkErrorCode(error) {
  let e = error;
  for (let depth = 0; e && depth < 5; depth += 1) {
    if (typeof e.code === 'string' && e.code) return e.code;
    const first = Array.isArray(e.errors) ? e.errors.find((x) => typeof x?.code === 'string') : null;
    if (first) return first.code;
    e = e.cause;
  }
  return null;
}

// Failures that say something about the publisher's own configuration rather
// than about the network between us — no DNS record, a certificate that does
// not validate, a TLS handshake that cannot succeed. They reproduce on every
// attempt, so they are cached like an upstream 404.
//
// Deliberately absent: ECONNREFUSED and connect timeouts. Those are also
// usually the publisher's, but a server mid-restart or a brief egress problem
// on our side looks identical, and caching it would turn a few seconds of
// outage into an hour of failures. The client (citation-checker-script's
// core/worker.js) declines to *retry* a slightly wider set than this caches;
// the two lists disagreeing is harmless in either direction — a retry of a
// cached failure is a cache hit, and an uncached one is just refetched.
const CACHEABLE_CODES = new Set([
  'ENOTFOUND',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'EPROTO',
]);
const TLS_CODE = /CERT|^ERR_TLS_|^ERR_SSL_/;

function isCacheableNetworkError(code) {
  if (typeof code !== 'string' || !code) return false;
  return CACHEABLE_CODES.has(code) || TLS_CODE.test(code);
}

module.exports = { networkErrorCode, isCacheableNetworkError };

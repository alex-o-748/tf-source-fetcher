'use strict';

const config = require('./config');
const { isImmutableSnapshotUrl } = require('./archiveSnapshot');

function isSuccessStatus(status) {
  return typeof status === 'number' && status >= 200 && status < 300;
}

// How long to cache one response, given the target URL it came from and the
// response body server.js is about to send. A pure function so the
// archive-immutability and 429-retry-window rules can be tested directly,
// without spinning up the whole service.
function cacheTtlSecondsFor(targetUrl, body) {
  if (isSuccessStatus(body.status)) {
    if (isImmutableSnapshotUrl(targetUrl)) return config.CACHE_TTL_IMMUTABLE_SECONDS;
    return config.CACHE_TTL_OK_SECONDS;
  }
  if (body.status === 429) {
    // Cached only for its own retry window, capped at the generic error TTL
    // — caching it for the full error TTL would keep serving "slow down"
    // after the publisher's window reopened, contradicting the retry_after
    // sitting in the same body.
    const asked = body.retry_after || config.CACHE_TTL_ERROR_SECONDS;
    return Math.min(asked, config.CACHE_TTL_ERROR_SECONDS);
  }
  return config.CACHE_TTL_ERROR_SECONDS;
}

module.exports = { cacheTtlSecondsFor };

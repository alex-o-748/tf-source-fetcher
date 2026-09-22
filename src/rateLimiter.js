'use strict';

const {
  HOST_MIN_INTERVAL_MS,
  HOST_MAX_QUEUE_WAIT_MS,
  HOST_BACKOFF_MS,
  HOST_STATE_MAX,
} = require('./config');

class RateLimitedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Both Maps hold `host -> timestamp`, and an entry whose timestamp has passed
// is indistinguishable from an absent one: a reservation in the past imposes no
// wait, an expired backoff blocks nothing. So dropping them is not an eviction
// policy with a cost — it is deleting state that has stopped meaning anything.
//
// That is what makes these Maps bounded in practice by the *working* set (hosts
// seen in the last second or backed off in the last 30) rather than by every
// host the process has ever seen, which is what they used to grow to. A sweep
// hits close to one new origin per request, so "every host ever seen" was on
// the order of the request count.
//
// Only runs once a Map is over HOST_STATE_MAX, because the sweep is O(size) and
// the common case is a handful of entries. If a sweep cannot get under the
// ceiling, the entries closest to expiring are dropped: losing one costs at
// most one under-paced request to that host, and the alternative is unbounded
// growth. Reaching that branch at all means something is wrong upstream of
// here — it is a backstop, not a mechanism.
function prune(map, now = Date.now()) {
  if (map.size <= HOST_STATE_MAX) return;

  for (const [host, at] of map) {
    if (at <= now) map.delete(host);
  }
  if (map.size <= HOST_STATE_MAX) return;

  const byExpiry = [...map.entries()].sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < byExpiry.length && map.size > HOST_STATE_MAX; i += 1) {
    map.delete(byExpiry[i][0]);
  }
}

// Best-effort, in-process per-host politeness control: a minimum gap between
// two outbound requests to the same host, plus a cooldown once a host has
// told us to slow down (429). This is per-process state (fine for a single
// Toolforge webservice replica); it does not coordinate across replicas.
class HostRateLimiter {
  constructor() {
    this.nextAvailableAt = new Map(); // host -> timestamp a slot is free
    this.backoffUntil = new Map(); // host -> timestamp backoff ends
  }

  // Reports an upstream response's status for a host so future requests can
  // back off after a 429.
  reportStatus(host, status) {
    if (status === 429) {
      this.backoffUntil.set(host, Date.now() + HOST_BACKOFF_MS);
      prune(this.backoffUntil);
    }
  }

  // Resolves once it's this host's turn, or throws RateLimitedError if the
  // wait would exceed the configured budget.
  async acquire(host) {
    const now = Date.now();

    const backoff = this.backoffUntil.get(host);
    if (backoff && backoff > now) {
      throw new RateLimitedError(
        `Backing off ${host} after a recent rate-limit response; retry in ${Math.ceil((backoff - now) / 1000)}s`
      );
    }
    // An expired backoff never blocks anything again, so reading one is the
    // cheapest possible moment to delete it.
    if (backoff) this.backoffUntil.delete(host);

    const nextFree = this.nextAvailableAt.get(host) || 0;
    const wait = Math.max(0, nextFree - now);

    if (wait > HOST_MAX_QUEUE_WAIT_MS) {
      throw new RateLimitedError(`Too many concurrent requests to ${host}; try again shortly`);
    }

    // Reserve the next slot immediately so concurrent callers queue in order
    // rather than all waking up at once and racing for the same gap.
    this.nextAvailableAt.set(host, Math.max(nextFree, now) + HOST_MIN_INTERVAL_MS);
    prune(this.nextAvailableAt, now);

    if (wait > 0) {
      await sleep(wait);
    }
  }

  // How many distinct hosts these Maps are holding. Read by src/metrics.js —
  // see robotsCacheSize(). Expired entries are swept (see prune), so this
  // tracks the working set and should sit in the tens; a number that climbs
  // with the request count means the sweep is not doing its job.
  size() {
    return Math.max(this.nextAvailableAt.size, this.backoffUntil.size);
  }
}

module.exports = { HostRateLimiter, RateLimitedError };

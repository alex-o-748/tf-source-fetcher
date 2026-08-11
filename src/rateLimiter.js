'use strict';

const {
  HOST_MIN_INTERVAL_MS,
  HOST_MAX_QUEUE_WAIT_MS,
  HOST_BACKOFF_MS,
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

    const nextFree = this.nextAvailableAt.get(host) || 0;
    const wait = Math.max(0, nextFree - now);

    if (wait > HOST_MAX_QUEUE_WAIT_MS) {
      throw new RateLimitedError(`Too many concurrent requests to ${host}; try again shortly`);
    }

    // Reserve the next slot immediately so concurrent callers queue in order
    // rather than all waking up at once and racing for the same gap.
    this.nextAvailableAt.set(host, Math.max(nextFree, now) + HOST_MIN_INTERVAL_MS);

    if (wait > 0) {
      await sleep(wait);
    }
  }
}

module.exports = { HostRateLimiter, RateLimitedError };

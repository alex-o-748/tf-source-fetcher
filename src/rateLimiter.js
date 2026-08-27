'use strict';

const config = require('./config');

class RateLimitedError extends Error {
  // `retryAfterMs` is our own estimate of when this URL is worth trying
  // again. It is surfaced to the caller so a self-inflicted throttle can be
  // retried promptly instead of being mistaken for a publisher refusing us.
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'RateLimitedError';
    this.retryAfterMs = Math.max(0, Math.round(retryAfterMs || 0));
  }
}

// Parses a `Retry-After` header, which may be either a number of seconds or
// an HTTP-date. Returns milliseconds, or null if it isn't usable.
function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(headerValue);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

// Per-host politeness control, and the point where concurrency against a
// single publisher is actually bounded.
//
// Three constraints, per host:
//   * at most `maxConcurrency` requests in flight at once — a slot is held
//     for the whole request, so a slow host applies backpressure by itself
//     rather than us firing at a fixed rate into a queue it can't drain;
//   * at least `minIntervalMs` between two request *starts*;
//   * a cooldown after the host has told us to slow down (429).
//
// `maxConcurrency` and `minIntervalMs` are the generic defaults; a specific
// host can get its own values via `overrides` (hostname -> partial
// {maxConcurrency, minIntervalMs}), which defaults to config.HOST_OVERRIDES.
// This exists because "one hostname" and "one publisher's tolerance" is only
// a good match for the long tail — a host that concentrates an unusual share
// of all traffic (web.archive.org, in this project's case: every dead-link
// fallback funnels through it) needs its own budget, or it gets starved by
// our *own* refusals in exact proportion to how popular it is, which is
// backwards.
//
// Callers that can't be admitted within `maxQueueWaitMs` are refused with a
// RateLimitedError rather than queued forever, so a caller running at high
// concurrency gets a fast, explicit "that was us, not the publisher" instead
// of a hang.
//
// This is per-process state: correct for a single Toolforge webservice
// replica, and it does not coordinate across replicas if this is ever scaled
// beyond one.
class HostRateLimiter {
  constructor(options = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? config.HOST_MAX_CONCURRENCY);
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? config.HOST_MIN_INTERVAL_MS);
    this.maxQueueWaitMs = Math.max(0, options.maxQueueWaitMs ?? config.HOST_MAX_QUEUE_WAIT_MS);
    this.maxQueueDepth = Math.max(0, options.maxQueueDepth ?? config.HOST_MAX_QUEUE_DEPTH);
    this.backoffMs = Math.max(0, options.backoffMs ?? config.HOST_BACKOFF_MS);
    this.backoffMaxMs = Math.max(0, options.backoffMaxMs ?? config.HOST_BACKOFF_MAX_MS);
    this.overrides = options.overrides ?? config.HOST_OVERRIDES ?? {};

    this.hosts = new Map(); // host -> state
    this.refusedTotal = 0;
    this.backoffTotal = 0;
  }

  // Resolves the effective per-host limits once, at first use, so that
  // changing this.overrides later (nothing does today, but nothing should
  // have to know that) can't retroactively change a host already in flight.
  //
  // Includes maxQueueWaitMs/maxQueueDepth, not just maxConcurrency/
  // minIntervalMs: minIntervalMs paces admissions *out of* the queue at one
  // per interval no matter how high maxConcurrency is (by design — it
  // prevents a backlog of queued waiters from bursting all at once when a
  // slot frees up), so raising maxConcurrency alone barely helps a host that
  // is seeing a disproportionate share of traffic relative to everyone
  // else — it still gets refused by our own queue-wait budget just as
  // readily. A host known to carry that kind of share should be given more
  // patience to queue, not just a wider door.
  _limitsFor(host) {
    const override = this.overrides[host];
    return {
      maxConcurrency: Math.max(1, override?.maxConcurrency ?? this.maxConcurrency),
      minIntervalMs: Math.max(0, override?.minIntervalMs ?? this.minIntervalMs),
      maxQueueWaitMs: Math.max(0, override?.maxQueueWaitMs ?? this.maxQueueWaitMs),
      maxQueueDepth: Math.max(0, override?.maxQueueDepth ?? this.maxQueueDepth),
    };
  }

  _state(host) {
    let state = this.hosts.get(host);
    if (!state) {
      const { maxConcurrency, minIntervalMs, maxQueueWaitMs, maxQueueDepth } = this._limitsFor(host);
      state = {
        active: 0,
        nextStartAt: 0,
        backoffUntil: 0,
        queue: [],
        timer: null,
        evictTimer: null,
        maxConcurrency,
        minIntervalMs,
        maxQueueWaitMs,
        maxQueueDepth,
      };
      this.hosts.set(host, state);
    }
    return state;
  }

  // A long-lived process fetching a 1000-article sweep sees tens of thousands
  // of distinct hosts, so idle entries are dropped rather than accumulated.
  _maybeEvict(host, state) {
    // A stale eviction timer can outlive its entry — if the host has since
    // been re-tracked, this must not delete the live replacement.
    if (this.hosts.get(host) !== state) return;
    if (state.active > 0 || state.queue.length > 0 || state.timer) return;
    const now = Date.now();
    if (state.nextStartAt > now || state.backoffUntil > now) return;
    if (state.evictTimer) clearTimeout(state.evictTimer);
    this.hosts.delete(host);
  }

  _pump(host, state) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    while (state.queue.length > 0 && state.active < state.maxConcurrency) {
      const now = Date.now();
      if (state.nextStartAt > now) {
        state.timer = setTimeout(() => {
          state.timer = null;
          this._pump(host, state);
        }, state.nextStartAt - now);
        return;
      }
      const waiter = state.queue.shift();
      state.active += 1;
      state.nextStartAt = now + state.minIntervalMs;
      waiter.admit();
    }

    this._maybeEvict(host, state);
  }

  _release(host, state) {
    state.active = Math.max(0, state.active - 1);
    this._pump(host, state);
  }

  // Records an upstream response for a host so future requests back off after
  // a 429. `retryAfterHeader` is the host's own `Retry-After`, honored (up to
  // `backoffMaxMs`) when it asks for longer than our default cooldown.
  //
  // Returns the cooldown actually applied, in ms, so the caller can report a
  // `retry_after` that matches when we'll really try this host again rather
  // than a number we won't honor. 0 when nothing was applied.
  reportStatus(host, status, retryAfterHeader) {
    if (status !== 429) return 0;
    const asked = parseRetryAfter(retryAfterHeader);
    const cooldown = Math.min(
      this.backoffMaxMs,
      Math.max(this.backoffMs, asked === null ? 0 : asked)
    );
    const state = this._state(host);
    state.backoffUntil = Date.now() + cooldown;
    this.backoffTotal += 1;

    // A host we back off and then never fetch again would otherwise sit in
    // the map for the life of the process — and a sweep of many hosts that
    // rate-limit us is exactly when that adds up. This timer is unref'd
    // because losing it costs nothing: it only drops a dead entry.
    if (state.evictTimer) clearTimeout(state.evictTimer);
    state.evictTimer = setTimeout(() => {
      state.evictTimer = null;
      this._maybeEvict(host, state);
    }, cooldown + 1);
    state.evictTimer.unref?.();

    return cooldown;
  }

  // Resolves with a `release()` once it is this host's turn. Throws
  // RateLimitedError if we won't get a turn within the queue-wait budget.
  // The returned release() must be called exactly once, in a finally.
  async acquire(host) {
    const state = this._state(host);
    const now = Date.now();

    if (state.backoffUntil > now) {
      const retryAfterMs = state.backoffUntil - now;
      this.refusedTotal += 1;
      throw new RateLimitedError(
        `Backing off ${host} after a recent rate-limit response; ` +
          `retry in ${Math.ceil(retryAfterMs / 1000)}s`,
        retryAfterMs
      );
    }

    // Fast path: nobody ahead of us, a slot free, and the pacing gap elapsed.
    if (state.queue.length === 0 && state.active < state.maxConcurrency && state.nextStartAt <= now) {
      state.active += 1;
      state.nextStartAt = now + state.minIntervalMs;
      return this._releaseFn(host, state);
    }

    // Cheap up-front estimate, so an obviously hopeless request is refused
    // immediately instead of occupying a queue slot for the full budget. It
    // deliberately ignores how long currently-active requests will run — the
    // hard timeout below is what actually guarantees the bound.
    const estimatedWaitMs =
      Math.max(0, state.nextStartAt - now) + state.queue.length * state.minIntervalMs;
    if (estimatedWaitMs > state.maxQueueWaitMs || state.queue.length >= state.maxQueueDepth) {
      this.refusedTotal += 1;
      throw new RateLimitedError(
        `Too many concurrent requests queued for ${host}; try again shortly`,
        estimatedWaitMs || state.minIntervalMs
      );
    }

    return new Promise((resolve, reject) => {
      const waiter = { admit: null, timer: null };

      waiter.timer = setTimeout(() => {
        const i = state.queue.indexOf(waiter);
        if (i >= 0) state.queue.splice(i, 1);
        this.refusedTotal += 1;
        this._maybeEvict(host, state);
        reject(
          new RateLimitedError(
            `Waited ${state.maxQueueWaitMs}ms for a slot on ${host} without getting one; ` +
              'try again shortly',
            state.minIntervalMs
          )
        );
      }, state.maxQueueWaitMs);

      waiter.admit = () => {
        clearTimeout(waiter.timer);
        resolve(this._releaseFn(host, state));
      };

      state.queue.push(waiter);
      this._pump(host, state);
    });
  }

  _releaseFn(host, state) {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this._release(host, state);
    };
  }

  // Point-in-time view, for /stats and for sizing a probe run.
  snapshot() {
    let active = 0;
    let queued = 0;
    let backingOff = 0;
    const now = Date.now();
    for (const state of this.hosts.values()) {
      active += state.active;
      queued += state.queue.length;
      if (state.backoffUntil > now) backingOff += 1;
    }
    return {
      hosts_tracked: this.hosts.size,
      host_slots_active: active,
      host_slots_queued: queued,
      hosts_backing_off: backingOff,
      refused_total: this.refusedTotal,
      backoff_total: this.backoffTotal,
      overrides: this.overrides,
    };
  }
}

module.exports = { HostRateLimiter, RateLimitedError, parseRetryAfter };

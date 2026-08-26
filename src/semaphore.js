'use strict';

class CapacityError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'CapacityError';
    this.retryAfterMs = Math.max(0, Math.round(retryAfterMs || 0));
  }
}

// A counting semaphore with a bounded wait, used as the process-wide ceiling
// on simultaneous upstream fetches.
//
// The per-host limiter already bounds what any one publisher sees; this
// bounds what *everyone* sees at once, which is the number that matters for
// how much outbound traffic Wikimedia IP space emits on our behalf — and for
// this process's memory, since each in-flight fetch can be buffering up to
// MAX_PDF_BYTES.
//
// Waiting is bounded rather than unlimited: a caller that can't be served
// within the budget is shed with a CapacityError, which the server reports as
// a self-inflicted throttle. Shedding beats queueing here, because a caller
// blocked for a minute on our queue has already given up.
class Semaphore {
  constructor(limit, maxWaitMs) {
    this.limit = Math.max(1, limit);
    this.maxWaitMs = Math.max(0, maxWaitMs);
    this.active = 0;
    this.queue = [];
    this.shedTotal = 0;
    this.peakActive = 0;
  }

  get waiting() {
    return this.queue.length;
  }

  _admit() {
    this.active += 1;
    if (this.active > this.peakActive) this.peakActive = this.active;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next.admit();
    };
  }

  async acquire() {
    if (this.active < this.limit) return this._admit();

    return new Promise((resolve, reject) => {
      const waiter = { admit: null, timer: null };

      waiter.timer = setTimeout(() => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        this.shedTotal += 1;
        reject(
          new CapacityError(
            `source-fetcher is at capacity (${this.limit} concurrent fetches); try again shortly`,
            this.maxWaitMs
          )
        );
      }, this.maxWaitMs);

      waiter.admit = () => {
        clearTimeout(waiter.timer);
        resolve(this._admit());
      };

      this.queue.push(waiter);
    });
  }

  snapshot() {
    return {
      limit: this.limit,
      active: this.active,
      waiting: this.queue.length,
      peak_active: this.peakActive,
      shed_total: this.shedTotal,
    };
  }
}

module.exports = { Semaphore, CapacityError };

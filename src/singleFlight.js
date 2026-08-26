'use strict';

// Collapses concurrent requests for the same key onto one execution.
//
// Without this, the Redis cache only deduplicates work that is *already
// finished*. A caller fetching many articles at once routinely asks for the
// same URL several times within the same second — the same source cited by
// several articles, or a page re-requested after a client-side timeout — and
// every one of those would miss the cache and hit the publisher separately.
// That is the worst possible thing to do to a third-party site while also
// being pure wasted work, so concurrent duplicates share one upstream fetch
// and one answer.
class SingleFlight {
  constructor() {
    this.inFlight = new Map(); // key -> Promise
    this.coalescedTotal = 0;
  }

  get size() {
    return this.inFlight.size;
  }

  // Returns { value, coalesced }. `coalesced` is true for callers that joined
  // an execution someone else had already started. Rejections propagate to
  // every joiner, which is correct: they would all have failed the same way.
  async run(key, fn) {
    const existing = this.inFlight.get(key);
    if (existing) {
      this.coalescedTotal += 1;
      return { value: await existing, coalesced: true };
    }

    const promise = (async () => fn())();
    this.inFlight.set(key, promise);
    try {
      return { value: await promise, coalesced: false };
    } finally {
      this.inFlight.delete(key);
    }
  }
}

module.exports = { SingleFlight };

# source-fetcher

A small Node HTTP service, deployed on Wikimedia Toolforge, that retrieves the
web page (or PDF) a Wikipedia citation points to, extracts readable text from
it, and returns that text to a caller. It exists so that the
`citation-checker-script` Wikipedia userscript can fetch arbitrary
third-party URLs without hitting CORS, and so a batch job can do the same
server-to-server.

This replaces the URL-fetching part of the [`public-ai-proxy`](https://github.com/alex-o-748/public-ai-proxy)
Cloudflare Worker. The Worker's *other* job — proxying LLM calls — is handled
separately by `llm-router`. This service does fetching and extraction only;
it does not proxy chat completions and does not implement `/log` (see
[Out of scope](#out-of-scope) below).

## ⚠️ Deployment status: built, not live

Unattended fetching of third-party publisher URLs from Wikimedia
infrastructure has **not yet been cleared with WMCS** (Wikimedia Cloud
Services). This service is built, deployable, and smoke-testable, but:

- The userscript's default `workerBase` still points at the Cloudflare Worker.
- No batch job should be pointed at this service's production path.

Do not wire this in as the live path until the WMCS egress question is
resolved. If you're unsure whether that's happened, ask before flipping the
switch.

The concurrency limits described under
[Politeness and concurrency](#politeness-and-concurrency) are what make a
concurrent caller safe *once* it's cleared to run; they are not that
clearance. Unattended, production-volume fetching from Toolforge is still the
part gated on WMCS.

## API contract

```
GET /?fetch=<url-encoded target URL>&page=<optional 1-based page number>
GET /stats
```

`page` only applies to paginated PDFs; most callers won't send it.
`/stats` reports live concurrency and throttling counters — see
["Sizing a real run"](#sizing-a-real-run).

### Response — success

```json
{
  "content": "<extracted plain text>",
  "error": null,
  "status": 200,
  "pdf": false,
  "totalPages": null,
  "page": null,
  "truncated": false,
  "fetched_at": "2026-08-11T06:00:00.000Z",
  "cached": false,
  "coalesced": false,
  "refused_by": null,
  "retry_after": null
}
```

- **`status`** is the *upstream* site's HTTP status, not this service's own
  response status (see "Distinguishing refused from dead" below) — this is
  the single most important field.
- **`content`** is only ever present when it's at least 101 characters;
  shorter content is reported as the "no usable content" error below instead.
- **`truncated`** is `true` whenever extracted text was cut off (currently at
  100,000 characters, matching the reference Worker's tuning). The client
  additionally treats any response with `content.length >= 12000` as
  truncated on its own, regardless of this flag.
- **`pdf` / `totalPages` / `page`** — set for PDFs; `page` is only non-null
  when the caller passed a `page` param and it was honored.
- **`fetched_at`** — ISO timestamp of the actual upstream fetch. Used by the
  batch job to compute when a stored finding should be re-crawled. `null`
  when no upstream fetch actually happened (robots.txt block, our own rate
  limiting, or the host being unreachable).
- **`cached`** — whether this response was served from the Redis cache
  instead of freshly fetched.
- **`refused_by`** — who decided this response, when it wasn't the publisher:
  `null` (the `status` came from the target host itself), `"robots"`,
  `"rate-limiter"` (our own per-host pacing/backoff), or `"capacity"` (our own
  process-wide concurrency ceiling). See
  ["Whose 429 is it?"](#whose-429-is-it) below — this is the field that keeps
  a self-inflicted throttle from being recorded as a fact about a source.
- **`retry_after`** — seconds to wait before retrying this URL, or `null` when
  we have no estimate. Also sent as a `Retry-After` header. For a publisher's
  own 429 this is the cooldown we've actually put that host into (which already
  honours the host's own `Retry-After`), so retrying sooner would only earn a
  refusal from us.
- **`coalesced`** — `true` when this caller joined an in-flight fetch that
  another concurrent caller had already started, instead of causing its own
  upstream request. Purely informational; the body is identical either way.

### Response — no usable content

```json
{ "content": null, "error": "Source content was empty or too short to verify", "status": 200 }
```

The fetch succeeded but there was nothing worth sending — an empty page, a
JS-only shell, or extracted text under 101 characters.

### Response — failure

```json
{ "content": null, "error": "<short human-readable reason>", "status": 403 }
```

### Distinguishing "refused" from "dead"

This is the behavior most worth getting right, because callers (the
userscript today; a batch job storing results in a database soon) treat
403/429 specifically as "retry later, record nothing" — folding different
failures into one generic error would silently misrecord a publisher block as
a fact about the article:

| Situation | `status` | `refused_by` | Notes |
|---|---|---|---|
| Upstream returned a real HTTP status (403, 404, 429, ...) | that status | `null` | passed through unchanged |
| Upstream unreachable (DNS failure, connection refused, timeout) | `null` | `null` | this service's own HTTP status is `502`; `status: null` in the body means "we never got a response at all" |
| Fetched fine, extracted nothing (login/cookie wall, JS-only render) | the upstream's real status (usually `200`) | `null` | uses the no-usable-content error above, not a generic failure |
| Blocked by the target host's `robots.txt` | `403` | `"robots"` | we never contacted the host |
| Throttled by our own per-host pacing or backoff | `429` | `"rate-limiter"` | we never contacted the host this time; retry after `retry_after` |
| Shed by our own process-wide concurrency ceiling | `429` | `"capacity"` | we never contacted the host this time; retry after `retry_after` |

The service's own outer HTTP status mirrors the JSON body's `status` field
whenever that field is a number (including robots.txt blocks and our own
rate-limit responses), and is `502` when it's `null`. The client's own
parsing reads `data.status` first and only falls back to the transport-level
status if that field is missing, so either way is safe to depend on.

### Whose 429 is it?

`status` alone can't answer this, and the difference matters as soon as a
caller fetches concurrently. A 429 from the publisher is a fact about that
source — back off hard, and treat the citation as unresolved. A 429 from
*us* says nothing about the source at all; it means we declined to send the
request, and the same URL will very likely succeed a moment later.

Folding the two together would misrecord our own throttling as publisher
hostility, and would get steadily worse the more concurrency a caller uses —
so read `refused_by`, not just `status`:

```js
if (data.status === 429) {
  if (data.refused_by === null) {
    // The publisher told us to slow down. Real signal; back off hard.
  } else {
    // That was source-fetcher, not the publisher. Nothing learned about the
    // source; retry this URL after data.retry_after seconds.
  }
}
```

Only `refused_by: null` responses carry a `fetched_at`, which is the other
way to tell the two apart: if we never contacted the host, there is no fetch
timestamp to record.

## Behavior carried over from the reference Worker

- HTML extraction primarily uses [`@mozilla/readability`](https://github.com/mozilla/readability)
  (a real article-extraction pass — Node has no Cloudflare Workers runtime
  constraints, so this is a meaningful upgrade over the Worker's regex tag
  stripping) and falls back to the Worker's original strip-and-collapse
  regex approach when Readability can't find an article (JS-only shells,
  non-article pages).
- PDF extraction uses [`unpdf`](https://github.com/unjs/unpdf), the same
  library the Worker uses, including per-page extraction when `page` is
  given.
- The 100,000-character truncation cutoff matches the Worker's
  `.substring(0, 100000)` exactly.

## Politeness and concurrency

Fetches from Toolforge originate from Wikimedia IP space, which raises the
stakes on being a good citizen:

- Descriptive `User-Agent` with a contact URL (see `src/config.js`).
- `robots.txt` is fetched and respected per host, cached for an hour, and
  fetched once per host even under a burst of concurrent requests.
- Per-host pacing, a per-host concurrency cap, and a cooldown after a host
  returns 429, so we don't hammer a host that's asked us to slow down.
- A process-wide ceiling on simultaneous upstream fetches.
- Concurrent requests for the same URL share one upstream fetch.
- Rate-limit responses are surfaced to the caller as a real 429 rather than
  retried silently, and are labelled with `refused_by` so the caller can tell
  ours from the publisher's.

### Callers may fetch concurrently; the limits live here

Callers are expected to issue many fetches at once — that's the point of the
service — and the constraints that keep that safe are enforced here rather
than trusted to the caller. This is deliberate: the userscript, the batch job
and any probe all funnel through this one process, and only this process sees
what is currently in flight against a given publisher. A caller can't know
that, and two callers certainly can't agree on it.

Concretely, a request passes three gates before any packet leaves for the
target host, in this order:

1. **Per-host slot** (`HOST_MAX_CONCURRENCY`, default 1, plus
   `HOST_MIN_INTERVAL_MS` between request *starts*). A slot is held for the
   whole request, not just its start, so a slow publisher throttles itself:
   we never queue a second page onto a host that hasn't answered the first.
   A host that has recently 429'd us is in cooldown and skipped entirely.
   Requests that can't get a slot within `HOST_MAX_QUEUE_WAIT_MS` are refused
   with `refused_by: "rate-limiter"` rather than parked indefinitely.
2. **Global capacity** (`MAX_CONCURRENT_FETCHES`, default 16). This is the
   number that bounds how much outbound traffic Wikimedia IP space emits on
   our behalf at any instant, and it also bounds this process's memory, since
   each in-flight fetch can be buffering up to `MAX_PDF_BYTES`. It is
   acquired *after* the host slot, so a request idling in a host queue isn't
   also holding global capacity — but *before* the robots.txt lookup, because
   that lookup is outbound traffic too: leaving it outside the ceiling would
   let a burst across a thousand distinct hosts fire a thousand `robots.txt`
   requests while the ceiling dutifully held content fetches to sixteen.
   Callers shed here get `refused_by: "capacity"`.
3. **robots.txt**, checked inside both slots, so a burst of requests for one
   new host doesn't become a burst of `robots.txt` fetches for it either.
   Cached per host for an hour, so this is a first-touch cost.

Separately, concurrent requests for the same URL are **coalesced** onto a
single execution. Redis only deduplicates work that has already finished; a
caller sweeping many articles routinely asks for the same source several
times within the same second (cited by several articles, or re-requested
after a client-side timeout), and without coalescing every one of those would
miss the cache and hit the publisher separately. Joiners get
`coalesced: true` and an otherwise identical body.

The defaults are conservative on purpose. `HOST_MAX_CONCURRENCY: 1` with a
1s interval is the same one-at-a-time behavior this service shipped with,
only stricter (it now also waits for the previous request to *finish*).
Raising it is a decision about a specific publisher's tolerance, not a
throughput knob — and the parent project's design notes are explicit that
concentrating editors' fetches onto Wikimedia IP space is a reputational
exposure for the Foundation, not just a technical one.

### Sizing a real run

`GET /stats` reports the live picture — in-flight and queued host slots,
hosts currently backing off, global capacity use and its high-water mark,
how many requests were coalesced, and how many we refused ourselves:

```sh
curl -s https://<tool>.toolforge.org/stats | jq
```

This is what to watch while sizing caller-side concurrency: if
`capacity.shed_total` or `hosts.refused_total` is climbing, the caller is
asking for more than this service is willing to send, and the extra
concurrency is producing 429s rather than throughput. `capacity.peak_active`
against `limits.max_concurrent_fetches` says whether the global ceiling is
the binding constraint or whether per-host pacing is.

Per-host pacing/backoff, capacity and coalescing are all in-process state —
fine for a single Toolforge webservice replica, but none of it coordinates
across replicas if this is ever scaled beyond one. Two replicas means two of
every limit above.

## Caching

Responses are cached in Redis, keyed on the normalized target URL plus the
optional page number. This makes repeated fetches of the same source (across
articles, or across benchmark runs) free after the first hit, and reproducible
for benchmark comparisons.

- Successful upstream responses (`2xx`) cache for 24h (`CACHE_TTL_OK_SECONDS`).
- Other real upstream statuses (403, 404, robots.txt blocks, ...) cache for
  1h (`CACHE_TTL_ERROR_SECONDS`) — treated as a "fact about the world" worth
  remembering, but for less long, since a paywall or a rate limit can lift.
- An upstream **429** is the exception: it's cached only for as long as the
  `retry_after` in that same body, capped at `CACHE_TTL_ERROR_SECONDS`.
  Caching it for the full hour would keep serving "slow down" long after the
  publisher's window reopened, and would contradict the retry hint sitting
  next to it.
- Unreachable-host results (`status: null`) and our own refusals
  (`refused_by: "rate-limiter"` / `"capacity"`) are never cached — they're
  transient by nature, and the second kind isn't a fact about the source at
  all.
- If Redis is unreachable at startup, the service still starts; it just runs
  without a cache (logged once, not a hard failure).

## Out of scope

- **Google Books skip** — handled client-side (`isGoogleBooksUrl` in the
  userscript); this service never receives those URLs.
- **Wayback/Internet Archive fallback orchestration** — also client-side.
  When a live fetch fails, the client itself queries archive.org and, if a
  snapshot exists, calls this service again with a
  `web.archive.org/web/<timestamp>id_/<original-url>` URL — just another URL
  to fetch, no special-casing needed here.
- **LLM routing of any kind** — that's `llm-router`, a separate Toolforge tool.
- **`/log`** — the Worker's telemetry endpoint (writes verification results
  to Postgres) is left on the Cloudflare Worker for now; it isn't fetching,
  and is likely to be superseded by a proper findings database later.

## Configuration

All via environment variables (Toolforge envvars, never committed files):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | *(set by Toolforge)* | listen port |
| `REDIS_URL` | `redis://tools-redis:6379` | Toolforge's shared Redis instance |
| `DISABLE_CACHE` | unset | set to `1` to run without a cache |
| `FETCH_TIMEOUT_MS` | `20000` | upstream fetch timeout (connect + body read) |
| `MAX_HTML_BYTES` | `20971520` (20 MB) | HTML response size guard |
| `MAX_PDF_BYTES` | `26214400` (25 MB) | PDF response size guard |
| `HOST_MAX_CONCURRENCY` | `1` | simultaneous in-flight requests to one host |
| `HOST_MIN_INTERVAL_MS` | `1000` | minimum gap between request starts to the same host |
| `HOST_MAX_QUEUE_WAIT_MS` | `8000` | how long a request may queue for a host slot before we give up and return 429 |
| `HOST_MAX_QUEUE_DEPTH` | `64` | hard cap on queued waiters per host |
| `HOST_BACKOFF_MS` | `30000` | cooldown for a host after it returns 429 |
| `HOST_BACKOFF_MAX_MS` | `600000` | ceiling on a `Retry-After` we'll honour from a host |
| `MAX_CONCURRENT_FETCHES` | `16` | process-wide ceiling on simultaneous upstream fetches |
| `CAPACITY_MAX_QUEUE_WAIT_MS` | `15000` | how long a request may wait for a global slot before we shed it |
| `ROBOTS_TIMEOUT_MS` | `5000` | timeout for fetching `robots.txt` |
| `ROBOTS_CACHE_TTL_MS` | `3600000` | how long a host's `robots.txt` is cached |
| `CACHE_TTL_OK_SECONDS` | `86400` | cache TTL for successful upstream responses |
| `CACHE_TTL_ERROR_SECONDS` | `3600` | cache TTL for real (non-null) error statuses |

## Development

```sh
npm install
npm start          # reads PORT (defaults to 8080), REDIS_URL, etc.
npm test           # runs test/e2e.test.js against a local fixture server
```

`test/e2e.test.js` spins up a local fixture "publisher" server
(`test/fixtures-server.js`) and exercises the full pipeline against it —
HTML extraction, PDF extraction (against a bundled sample PDF), the
refused/dead/no-content status contract, robots.txt blocking, rate limiting,
CORS preflight, caching, and the concurrency behavior above. The fixture
server records what it was asked for and how much arrived at once, so
"we made exactly one request" and "the publisher never saw more than N at
once" are asserted from the publisher's side rather than inferred from
timing. It needs a Redis reachable at `REDIS_URL` (defaults to
`redis://127.0.0.1:6399` for the test run) since it also exercises the cache.

`test/concurrency.test.js` unit-tests the primitives those limits are built
from (`src/rateLimiter.js`, `src/semaphore.js`, `src/singleFlight.js`) and
needs no Redis and no network.

This sandbox's own network egress is restricted to an allowlist that doesn't
include arbitrary publisher URLs, so the automated tests use the local
fixture server rather than real internet URLs. Before flipping any live
traffic onto this service, smoke-test it manually against a few real URLs
(a live HTML page, a PDF, and a URL that's known to 403) from an environment
with normal internet access, or from Toolforge itself post-deploy.

## Toolforge deployment

```sh
ssh <shell-user>@login.toolforge.org
become source-fetcher
toolforge build start https://github.com/alex-o-748/tf-source-fetcher
toolforge build show                      # wait for success
toolforge webservice buildservice start
```

Runtime: Node 20+ via Toolforge's buildpack-based build service. `Procfile`
declares `web: node server.js`; the platform assigns `PORT`.

After deploying, smoke-test `GET /?fetch=<url>` against a live HTML page, a
PDF, and a URL that 403s, and confirm CORS preflight succeeds from an
`en.wikipedia.org` origin — then leave it there, reachable but not yet wired
into the userscript or batch job, until WMCS has cleared egress (see
[Deployment status](#-deployment-status-built-not-live) above).

## License

MIT — see [LICENSE](LICENSE).

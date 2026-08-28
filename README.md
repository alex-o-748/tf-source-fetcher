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

## ✅ Deployment status: live

Unattended fetching of third-party publisher URLs from Wikimedia
infrastructure has been cleared with WMCS (Wikimedia Cloud Services), and
the Internet Archive has confirmed the request volume this service expects
(up to ~100,000 requests) is fine on their end — they didn't specify a
rate beyond "watch for `429`s," which this service already does per-host
(see [Politeness](#politeness)). This service is ready for production
traffic.

## API contract

```
GET /?fetch=<url-encoded target URL>&page=<optional 1-based page number>
```

`page` only applies to paginated PDFs; most callers won't send it.

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
  "cached": false
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

| Situation | `status` | Notes |
|---|---|---|
| Upstream returned a real HTTP status (403, 404, 429, ...) | that status | passed through unchanged |
| Upstream unreachable (DNS failure, connection refused, timeout) | `null` | this service's own HTTP status is `502`; `status: null` in the body means "we never got a response at all" |
| Fetched fine, extracted nothing (login/cookie wall, JS-only render) | the upstream's real status (usually `200`) | uses the no-usable-content error above, not a generic failure |
| Blocked by the target host's `robots.txt` | `403` | we never contacted the host |
| Throttled by our own per-host rate limiter | `429` | we never contacted the host this time; try again shortly |

The service's own outer HTTP status mirrors the JSON body's `status` field
whenever that field is a number (including robots.txt blocks and our own
rate-limit responses), and is `502` when it's `null`. The client's own
parsing reads `data.status` first and only falls back to the transport-level
status if that field is missing, so either way is safe to depend on.

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

## Politeness

Fetches from Toolforge originate from Wikimedia IP space, which raises the
stakes on being a good citizen:

- Descriptive `User-Agent` with a contact URL (see `src/config.js`).
- `robots.txt` is fetched and respected per host, cached for an hour.
- Per-host pacing (minimum gap between requests to the same host) with a
  cooldown after a host returns 429, so we don't hammer a host that's asked
  us to slow down.
- Rate-limit responses are surfaced to the caller as a real 429 rather than
  retried silently.

Per-host pacing/backoff is in-process state — fine for a single Toolforge
webservice replica, but it doesn't coordinate across replicas if this is ever
scaled beyond one.

## Caching

Responses are cached in Redis, keyed on the normalized target URL plus the
optional page number. This makes repeated fetches of the same source (across
articles, or across benchmark runs) free after the first hit, and reproducible
for benchmark comparisons.

- Successful upstream responses (`2xx`) cache for 24h (`CACHE_TTL_OK_SECONDS`).
- Other real upstream statuses (403, 404, robots.txt blocks, ...) cache for
  1h (`CACHE_TTL_ERROR_SECONDS`) — treated as a "fact about the world" worth
  remembering, but for less long, since a paywall or a rate limit can lift.
- Unreachable-host results (`status: null`) and our own rate-limit refusals
  are never cached — they're transient by nature.
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
| `HOST_MIN_INTERVAL_MS` | `1000` | minimum gap between requests to the same host |
| `HOST_MAX_QUEUE_WAIT_MS` | `8000` | how long a request may queue before we give up and return 429 |
| `HOST_BACKOFF_MS` | `30000` | cooldown for a host after it returns 429 |
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
CORS preflight, and caching. It needs a Redis reachable at `REDIS_URL`
(defaults to `redis://127.0.0.1:6399` for the test run) since it also
exercises the cache.

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
`en.wikipedia.org` origin — then it's clear to wire into the userscript
(pointing `workerBase` at this service instead of the Cloudflare Worker)
and the batch job (see [Deployment status](#-deployment-status-live)
above).

## License

MIT — see [LICENSE](LICENSE).

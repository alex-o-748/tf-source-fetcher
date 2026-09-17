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
- **`content`** is only ever present when the extracted *body* is at least 101
  characters; shorter content is reported as the "no usable content" error
  below instead. On the Readability path the body is preceded by a short
  metadata header (see [Publication metadata](#publication-metadata)); that
  header does not count toward the 101-character floor.
- **`truncated`** is `true` whenever we did not return the whole source. Two
  causes: the extracted text was cut at 100,000 characters (matching the
  reference Worker's tuning), or the page itself was too large to extract from
  in full and was cut at `MAX_PARSE_BYTES` before extraction (see
  [Memory](#memory-what-killed-this-service-and-what-bounds-it-now)). Either
  way the meaning for a caller is the same — evidence may lie past the cut —
  which is why they share a flag. The client additionally treats any response
  with `content.length >= 12000` as truncated on its own, regardless of this
  flag.
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
  non-article pages) or returns implausibly little of one. Unlike the Worker,
  this path prefixes the text with the headline, byline and publication date —
  see [Publication metadata](#publication-metadata) for why that is load-bearing.
- PDF extraction uses [`unpdf`](https://github.com/unjs/unpdf), the same
  library the Worker uses, including per-page extraction when `page` is
  given.
- The 100,000-character truncation cutoff matches the Worker's
  `.substring(0, 100000)` exactly.

## Memory: what killed this service, and what bounds it now

Read this before touching `src/parseDocument.js`, before raising
`MAX_PARSE_BYTES`, and before reintroducing `new JSDOM()` anywhere in the
request path.

**The symptom.** The web pod was crash-looping: 27 restarts in 2 days, exit
139, `FATAL ERROR: Ineffective mark-compacts near heap limit` at 254 MB, with
hundreds of `Could not parse CSS stylesheet` lines ahead of each trace. During
each restart the front proxy has no backend and answers 502, so a batch sweep
saw its fetch failure rate climb from 13% to 60% over a few hours. That looks
exactly like a degrading upstream, or like us overloading something, and is
neither — it is one process crossing more and more restart windows. The tells:
identical URLs that returned 200 earlier returning 502 later, many unrelated
domains failing at once, and a `RESTARTS` count climbing in `kubectl get pods`.

Two separate things were wrong. The second is the one that actually killed it.

### 1. Churn: a jsdom Window per page

`new JSDOM(html, { url })` builds a Window/browsing context per page — CSSOM,
timers, navigator — and each one is ~1.8 MB of garbage that only a full
mark-compact with idle time retires.

It is **not** a permanent leak. A tight synchronous loop appears to leak
1.76 MB/page and never plateau, but that is a measurement artifact: two
`global.gc()` calls are not enough to retire a backlog of detached V8 contexts.
Given ~20 GC rounds with idle time between them, V8 reclaims nearly all of it
(16 KB/page residual), and the service under request load — which has idle time
by construction — measured flat with the old code too. So this alone does not
crash anything.

What it does is put 1.8 MB of pressure per request on a heap that (2) was
already driving to its ceiling. `src/parseDocument.js` builds exactly one
Window for the life of the process and parses every page into a fresh,
window-less `Document` with that Window's `DOMParser` — the same Document type
a browser hands Readability. Measured 0.006 MB/page retained against 1.76, and
~2x faster per page. Extraction output is byte-identical across article,
JS-shell, malformed, fallback and metadata-header cases.

`JSDOM.fragment()` — the fix citation-checker-script's batch pipeline used for
the same jsdom cost — is not available here: it returns a `DocumentFragment`,
and Readability requires a real `Document`. Recycling the shared Window
periodically is worse than not, measured: building a replacement costs more
than the residual it reclaims (10.7 vs 5.1 KB/page).

### 2. Peak: extraction costs ~130 MB of heap per MB of markup

This is the crash. Peak heap while extracting **one** page, `heapUsed` sampled
every 2 ms, dense markup (the bad case):

| HTML | Peak | | HTML | Peak |
|---|---|---|---|---|
| 128 KB | +33 MB | | 1 MB | +140 MB |
| 256 KB | +46 MB | | 2 MB | +269 MB |
| 512 KB | +70 MB | | 5 MB | process dies |

`MAX_HTML_BYTES` is 20 MB, so a single large page could demand ~2.6 GB against
a ~256 MB Node heap. No accumulation required, nothing that more uptime or more
GC improves, and nothing specific to jsdom — the regex fallback peaked at
+262 MB on a 20 MB page, because each `.replace()` in the chain allocates
another copy of the string.

Reproduced end-to-end against the real server at `--max-old-space-size=256`,
serving pages the download cap allows:

```
              before the fix              after the fix
0.5 MB page   200, heap 113 MB            200, heap 108 MB
  1 MB page   200, heap 177 MB            200, heap 106 MB
  2 MB page   200, heap 172 MB            200, heap 118 MB
  4 MB page   FATAL heap OOM, pod gone    200, heap 112 MB
  8 MB page   —                           200, heap 108 MB
```

Every one of those pages still returns the full 100,000 characters of content.

So `prepareMarkup()` bounds what either extraction path is allowed to see:
scripts, stylesheets and comments are dropped first — pure weight for a text
extractor, and on a modern news page the inline JSON state blob is often most
of the bytes — and whatever is still over `MAX_PARSE_BYTES` (512 KB) is cut at
a tag boundary. Because the strip runs before the cut, a page that is mostly
script keeps its whole article.

**Raising `MAX_PARSE_BYTES` costs ~130 MB of peak heap per MB.** Do not raise
it without giving the webservice proportionally more memory, and re-run
`test/parseDocument.test.js` after you do.

It costs real articles nothing: output is capped at `MAX_CONTENT_CHARS`
(100,000) anyway, and 128 KB of article-dense markup already yields more text
than that. When a page *is* cut for size, the response says so —
`truncated: true`, the same flag the 100,000-character cut sets, because
"we did not read all of this source" is a fact the citation verifier acts on.

### What is still unbounded

`MAX_PDF_BYTES` is 25 MB and the PDF path (`unpdf`) has no equivalent parse
budget. It has not been measured, and it is the obvious next place to look if
the pod dies again on a URL ending in `.pdf`.

`src/robots.js` and `src/rateLimiter.js` keep per-host `Map`s that are never
evicted. Bounded by how many distinct hosts a process sees, and small per
entry — not a crash risk at this scale, but not free either.

## Publication metadata

`article.textContent` — all this service used to return — is the article
**body**. Readability computes the headline, byline and publication date
separately and removes them from that body: `_grabArticle` drops any node
whose class/id matches `/byline|author|dateline|writtenby|p-author/i`, or
which carries `rel="author"`, and parks the text in `article.byline`. On most
news CMSes the publication date sits in that same element.

The consequence was not cosmetic. A claim like *"the impressions appeared in
August 2026"* is unverifiable against a source whose date has been stripped,
and the verifier reports that as **the citation failing** rather than as the
fetcher failing — so a fetcher-side omission surfaced to editors as a false
"not supported" verdict. The reference Cloudflare Worker never had this
problem, because crude tag-stripping keeps everything; the failure was
specific to this service, and therefore to the batch pipeline that uses it.

So on the Readability path the extracted text is now prefixed with whatever
of these is available, followed by a blank line:

```
Title: Here’s what people who have used the iPhone Ultra like most
Published: 2026-08-23T07:41:00-07:00
By: Chance Miller | Aug 23 2026 - 7:41 am PT
Site: 9to5Mac

<article body>
```

- It goes at the **front** so the date outlives `MAX_CONTENT_CHARS`
  truncation. In the Worker's output the date sits wherever it fell on the
  page and is lost whenever the cut lands above it.
- The byline is captured from the DOM **before** `parse()` runs, and widened
  to the byline node's parent when that parent is also short. Markup like
  `<div class="meta"><a rel="author">Name</a> | Aug 23 2026</div>` otherwise
  loses the date entirely — Readability matches the inner `<a>`, records only
  `Name`, and removes the whole container. The surrounding text is kept
  verbatim rather than having a date pattern-matched out of it, since this
  service follows citations to sources in any language.
- `article.publishedTime` covers JSON-LD `datePublished`,
  `article:published_time` and `parsely-pub-date`. A few more publication-date
  tags (`itemprop="datePublished"`, `DC.date.issued`, …) and `<time datetime>`
  inside a byline-ish container or a `<header>` are read as a fallback.
- **Modification dates are deliberately not used.** Presenting a "last
  updated" stamp as the publication date trades a missing fact for a wrong
  one, which is worse for a verdict than silence. An unqualified
  `time[datetime]` search is avoided for the same reason — it returns dates
  the article is *about*.
- The header is **not** added on the regex fallback path, which already keeps
  whatever byline and date the page displayed.

### Under-selection guard

The fallback to regex extraction previously fired only when Readability
returned *nothing*. A parse that returns a sliver of the wrong container —
`aria-hidden="true"` wrappers are the realistic trigger, since collapsed
accordions and "read more" panels carry it in the served HTML and are
expanded by script this service never runs — cleared the 101-character floor
and shipped as the source, which is worse than the crude extraction it
replaced because it is confidently and silently wrong.

Readability output under 500 characters is now compared against the regex
extraction, and the regex result is preferred if it is at least 5× longer.
The thresholds are deliberately far apart: Readability returns far less text
than `regexExtract` on *every* page — that is the point of it — so the guard
has to trigger on "a fragment instead of an article", never on "smaller".

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
| `MAX_HTML_BYTES` | `20971520` (20 MB) | HTML **download** size guard |
| `MAX_PDF_BYTES` | `26214400` (25 MB) | PDF download size guard |
| `MAX_PARSE_BYTES` | `524288` (512 KB) | how much markup we extract text from, after scripts/styles/comments are dropped. A **memory** limit — costs ~130 MB of peak heap per MB. [Read this first](#memory-what-killed-this-service-and-what-bounds-it-now) |
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

`test/extractHtml.test.js` covers text extraction directly — the byline/date
shapes above, the metadata header, the under-selection guard, and truncation.
It needs no network and no Redis, so `npm run test:unit` runs anywhere.

`test/parseDocument.test.js` covers HTML parsing and the two memory bugs behind
the crash loop (see [Memory](#memory-what-killed-this-service-and-what-bounds-it-now)):
the size bound on what reaches a parser, the one-Window-per-process property,
and two measuring tests — peak heap for a single oversized page, and heap
retained per page. `node --test` doesn't run with `--expose-gc`, so those two
ask V8 for a GC directly and skip themselves if they can't get one. They take a
few seconds — they parse an 8 MB page and then 150 normal ones — which is why
this is the one unit test file that isn't instant.

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

`scripts/inspect-url.js` is that smoke test, for one URL at a time:

```sh
node scripts/inspect-url.js https://example.com/some-article
```

It prints the extraction path taken, every date-ish `<meta>` tag on the page,
what Readability reports for title/byline/publishedTime/siteName, and the
header this service would return — which is what answers "would the
publication date survive on *this* page?".

### Don't use Firefox Reader View to check this

**Firefox Reader View is Readability**, which makes it look like a free way to
see what this service gets. It is not, in either direction — use the script.

Reader View renders the domain, title, byline, reading time and body. It has
no publication-date element at all, so a date is only ever visible because it
rode along in the byline or the body. Which of those happens is decided by
markup you cannot see:

| Markup | Reader View byline | Date in body | Date visible |
|---|---|---|---|
| A — the container itself carries `class="author-byline"` | `Chance Miller \| Aug 23 2026` | no | yes, in the credits |
| B — outer `class="meta"`, inner `<a rel="author">` (9to5Mac) | `Chance Miller` | no | **no** |
| C — as B, plus `<meta name="author">` | `Chance Miller` | no | **no** |
| D — as A, plus `<meta name="author">` | `Chance Miller` | yes | yes, in the body |
| E — date written as prose (Reuters' `Sept 9 (Reuters) -` dateline) | `null` | yes | yes, in the body |
| F — date only in `<meta>` | `null` | no | **no** |

Two rules drive the whole table. First, `_isValidByline` matches the *first*
node with `rel="author"`, `itemprop=author` or a byline-ish class, under 100
chars — so whether the date rides along depends on whether that node is the
container holding name *and* date (A) or an inner link holding just the name
(B). Second, `_grabArticle` only strips a byline node when it has no byline
from metadata:

```js
if (!this._articleByline && !this._metadata.byline && this._isValidByline(node, matchString))
```

which is why adding `<meta name="author">` makes the visible byline *survive
in the body* (D vs A). A tag about the author decides whether the date is
deleted.

The trap for anyone checking by eye is row **A**: Reader View shows the date,
but the pre-fix service still lost it, because the date was in
`article.byline` and only `textContent` was returned. A date on screen never
meant the fetcher had it. `scripts/inspect-url.js` reports `byline` and
`publishedTime` separately, which is the distinction Reader View collapses.

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

### When callers report a rash of 502s

Check whether the pod is alive before you believe anything about upstreams:

```sh
become source-fetcher
kubectl get pods                                  # RESTARTS and AGE
kubectl describe pod <pod> | grep -A6 "Last State"
kubectl logs <pod> --previous --tail=50           # the trace from the crash
```

A climbing `RESTARTS` count means the 502s are this service being down, not the
sources refusing us — every request in flight during a restart gets one. Note
the caller sees the same 502 either way, so a client-side failure *rate* can't
distinguish them; the restart count can. `Exit Code: 139` with a
`FATAL ERROR: Ineffective mark-compacts near heap limit` in the previous logs
is the heap ceiling, and the ceiling is set by the webservice's memory
allocation (Node sizes its old space from what the container gives it) —
`toolforge webservice restart --mem 2Gi` raises it, which buys headroom but
fixes nothing on its own. See
[Memory](#memory-what-killed-this-service-and-what-bounds-it-now) for the two
causes that did this once already, and for what is still unbounded.

After deploying, smoke-test `GET /?fetch=<url>` against a live HTML page, a
PDF, and a URL that 403s, and confirm CORS preflight succeeds from an
`en.wikipedia.org` origin — then it's clear to wire into the userscript
(pointing `workerBase` at this service instead of the Cloudflare Worker)
and the batch job (see [Deployment status](#-deployment-status-live)
above).

## License

MIT — see [LICENSE](LICENSE).

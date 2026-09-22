'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');
const { MAX_PARSE_BYTES } = require('./config');

// Turning fetched HTML into a DOM, within a memory budget.
//
// This file exists because the Toolforge pod was crash-looping: 27 restarts in
// 2 days, exit 139, `FATAL ERROR: Ineffective mark-compacts near heap limit`
// at 254 MB. Every request in flight during a restart gets a 502, which is why
// a batch sweep saw its fetch failure rate climb from 13% to 60% over a few
// hours — not a degrading upstream and not us overloading anyone, just one
// process crossing more and more restart windows.
//
// Two separate things were wrong. Both are handled here.
//
// 1. PEAK: turning HTML into a DOM costs ~130 MB of heap per MB of markup.
//
//    Measured, peak heap while extracting one page (dense markup, so this is
//    the bad case; `heapUsed` sampled every 2 ms):
//
//      128 KB html -> +33 MB     1 MB html -> +140 MB
//      256 KB html -> +46 MB     2 MB html -> +269 MB
//      512 KB html -> +70 MB     5 MB html -> process dies
//
//    MAX_HTML_BYTES is 20 MB, so a single large page could demand ~2.6 GB and
//    kill a pod with a ~256 MB heap outright — no accumulation required, and
//    nothing about it gets better with more uptime. That is the crash. The
//    regex fallback is no escape either: it peaked at +262 MB on a 20 MB page,
//    because each `.replace()` in the chain allocates another copy.
//
//    So `prepareMarkup()` bounds what either path is allowed to see. Scripts,
//    stylesheets and comments go first — they are pure weight for a text
//    extractor, and on a modern news page the inline JSON state blob is often
//    most of the bytes — and whatever is still over MAX_PARSE_BYTES is cut at
//    a tag boundary. Output is capped at MAX_CONTENT_CHARS (100,000) anyway,
//    and 128 KB of article-dense markup already yields more text than that, so
//    this costs real articles nothing.
//
// 2. CHURN: `new JSDOM(html, { url })` builds a Window/browsing context per
//    page — CSSOM, timers, navigator — and each one is ~1.8 MB of garbage that
//    only a full mark-compact with idle time retires. It is not a permanent
//    leak (with enough GC rounds V8 does reclaim it), but it is 1.8 MB of
//    pressure per request on a heap that was already being driven to its
//    ceiling by (1). `parseDocument()` builds exactly one Window for the life
//    of the process and parses every page into a fresh, window-less Document
//    with its DOMParser — the same Document type a browser hands Readability.
//    It is ~2x faster per page.
//
//    That change also introduced a much larger leak of its own, because a
//    document parsed by the shared parser stays reachable from the Window that
//    owns it, and that Window never goes away. The "0.006 MB/page retained"
//    this comment used to claim was measured against a 3 KB synthetic fixture;
//    against real pages it is 10.83 MB/page. See releaseDocument() below,
//    which is what makes the shared parser safe rather than merely fast.
//
// `JSDOM.fragment()` — the fix citation-checker-script's batch pipeline used
// for the same jsdom cost — is not available here: it returns a
// DocumentFragment, and Readability requires a real Document.

// Everything a text extractor never reads. Readability judges visibility from
// the `style` attribute, `hidden` and `aria-hidden` only, never from a
// stylesheet, and removes scripts itself — so dropping these changes no
// output, it only stops us paying to parse them. Dropping stylesheets also
// ends the `Could not parse CSS stylesheet` / `[csstree-match] BREAK after
// 15000 iterations` floods that filled the pod logs and buried the OOM traces.
const DROPPABLE = [
  /<!--[\s\S]*?-->/g,
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style>/gi,
];

// How much raw HTML we are willing to run the strip over. Bounds the
// intermediate strings `.replace()` allocates, and is generous enough that a
// page which is mostly script still has its whole article left after the
// strip.
const PRE_STRIP_BYTES = MAX_PARSE_BYTES * 4;

// Cuts at the last tag boundary before `limit` so the parser is never handed
// half an opening tag (jsdom would recover, but it would recover by inventing
// an attribute out of the article's first words). Falls back to a hard cut if
// there is no `<` anywhere near the limit.
function clampAtTagBoundary(html, limit) {
  if (html.length <= limit) return html;
  const cut = html.lastIndexOf('<', limit);
  return html.slice(0, cut > limit - 4096 ? cut : limit);
}

// Returns { markup, clamped } — the markup both extraction paths should use,
// and whether anything was cut for size. `clamped` is true only when page
// content was dropped, not when scripts or stylesheets were: callers surface
// it as `truncated`, and "we did not read all of this source" is a fact the
// citation verifier acts on.
function prepareMarkup(html) {
  const preStrip = clampAtTagBoundary(html, PRE_STRIP_BYTES);
  let stripped = preStrip;
  for (const re of DROPPABLE) stripped = stripped.replace(re, '');
  const markup = clampAtTagBoundary(stripped, MAX_PARSE_BYTES);
  return {
    markup,
    clamped: preStrip.length < html.length || markup.length < stripped.length,
  };
}

let sharedParser = null;
let windowsCreated = 0;

// The document the shared parser produced last, held only so the next parse
// can empty it. See releaseDocument().
let lastDocument = null;

function parser() {
  if (sharedParser) return sharedParser;

  // A VirtualConsole with no listeners drops jsdom's page-level complaints.
  // They describe defects in somebody else's HTML, we degrade gracefully on
  // all of them, and at this service's request volume they are noise in the
  // logs we need for our own failures.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    virtualConsole,
  });
  sharedParser = new dom.window.DOMParser();
  windowsCreated += 1;
  return sharedParser;
}

// A DOMParser document's URL is the parser window's, not the page's, so
// `doc.baseURI` would be "about:blank" and relative URLs would resolve against
// nothing. A <base> restores it. Skipped when the page declares its own, which
// by the HTML spec wins anyway.
function applyBaseUrl(doc, url) {
  if (!url || !doc.head || doc.querySelector('base[href]')) return;
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    return; // not an absolute URL; leave baseURI alone rather than set garbage
  }
  const base = doc.createElement('base');
  base.setAttribute('href', url);
  doc.head.insertBefore(base, doc.head.firstChild);
}

// Empties a document produced by parseDocument, so the nodes it holds can be
// collected while the shared parser stays alive.
//
// THIS IS NOT OPTIONAL TIDYING. A document parsed by the shared DOMParser
// stays reachable from the Window that owns the parser, and that Window lives
// for the life of the process — so without this, every page ever parsed is
// retained. Measured over real-shaped pages (~160 KB), retained heap per page:
//
//   shared parser, as it was                     10.83 MB   <- the leak
//   shared parser + releaseDocument()             0.00 MB
//   a fresh JSDOM per page (what it replaced)     0.60 MB
//
// The shared-Window change was introduced to save the 1.8 MB/page a per-page
// Window costs in garbage. It does save that. It also made *retention* 18x
// worse, and retention is the thing that kills a pod.
//
// It went unnoticed for two reasons. The measurement that blessed it used a
// 3 KB synthetic fixture whose document is small enough that retaining every
// one is invisible. And in the real pipeline Readability strips the document
// it is given down to the article, so a page that reaches Readability leaves
// only a husk behind — 0.04 MB/page instead of 10.83. Only pages that skip or
// fail Readability (JS shells, non-article pages, malformed markup, anything
// taking the regex fallback) retain in full, which is why production showed a
// mixed 2-3 MB per successful extraction rather than a clean 10.8.
//
// Safe to call as soon as the caller has read what it needs: everything
// extractHtml takes out of a document is a string by then.
function releaseDocument(doc) {
  if (!doc) return;
  try {
    doc.replaceChildren();
  } catch {
    // A document type that does not support it is not worth failing a request
    // over; the next parse releases it anyway.
  }
  if (lastDocument === doc) lastDocument = null;
}

// Returns a Document for `markup` (which should have been through
// prepareMarkup), resolving relative URLs against `url`.
//
// The document has no browsing context — `doc.defaultView` is null — which is
// the point: that is the object that made every page cost 1.8 MB. Anything
// needing `window` (getComputedStyle, layout, scripts) will not work on it,
// and nothing here needs them.
//
// Releasing the previous document here, rather than leaving it to callers, is
// what bounds this structurally: a caller that forgets to release costs one
// retained document, not one per page. Callers should still release when they
// are done, so the memory goes back between requests instead of at the next
// one.
function parseDocument(markup, url) {
  if (lastDocument) releaseDocument(lastDocument);
  const doc = parser().parseFromString(markup, 'text/html');
  applyBaseUrl(doc, url);
  lastDocument = doc;
  return doc;
}

// Test-only: how many jsdom Windows this process has built. The invariant
// worth pinning is that it stays at 1 no matter how many pages are parsed.
function windowsCreatedForTest() {
  return windowsCreated;
}

module.exports = {
  prepareMarkup,
  parseDocument,
  releaseDocument,
  windowsCreatedForTest,
};

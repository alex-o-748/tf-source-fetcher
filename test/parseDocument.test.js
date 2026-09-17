'use strict';

// Guards the fix for the crash loop described at the top of
// src/parseDocument.js. The Toolforge pod was dying with
// `FATAL ERROR: Ineffective mark-compacts near heap limit` at 254 MB, 27 times
// in 2 days, and every request in flight during a restart got a 502 — which a
// caller can only see as "the fetcher is failing more and more".
//
// Two causes, two sets of tests here:
//
//   PEAK  — extraction costs ~130 MB of heap per MB of markup, and the
//           download cap allows 20 MB. One big page was fatal on its own.
//           prepareMarkup() bounds what either extraction path sees.
//   CHURN — a jsdom Window per page is ~1.8 MB of garbage that only a full
//           mark-compact retires. parseDocument() builds one Window, ever.

const test = require('node:test');
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const vm = require('node:vm');

const {
  prepareMarkup,
  parseDocument,
  windowsCreatedForTest,
} = require('../src/parseDocument');
const { extractHtml } = require('../src/extractHtml');
const { MAX_PARSE_BYTES, MAX_CONTENT_CHARS } = require('../src/config');

// A news-article-shaped page with the stylesheet junk that filled the crash
// logs. `n` varies the content so nothing can be served from a cache.
function newsPage(n) {
  const css = Array.from(
    { length: 40 },
    (_, i) => `
    .c${i} { color: #${((i * 7919) % 0xffffff).toString(16).padStart(6, '0')}; display: flex; }
    @supports (display: grid) { .g${i} { grid-template-areas: "a b" "c d"; } }
    .x${i}:is(.a, .b) > :where(.c, .d) ~ .e { margin: calc(1px + 2%); }
    @media (min-width: ${300 + i}px) { .m${i} { color: rgb(1 2 3 / 50%); } }`
  ).join('\n');

  const paras = Array.from(
    { length: 60 },
    (_, i) =>
      `<p>Paragraph ${i} of article ${n}. ` +
      'The council approved the measure after a lengthy debate that stretched '.repeat(4) +
      'past midnight, with several members abstaining.</p>'
  ).join('\n');

  return (
    `<!DOCTYPE html><html lang="en"><head>` +
    `<title>Council approves measure ${n} — Example Times</title>` +
    `<meta name="date" content="2026-08-23">` +
    `<style>${css}</style><style>.broken { color: ; } @unknown { foo }</style>` +
    `</head><body><header><nav><a href="/">Home</a></nav></header><article>` +
    `<h1>Council approves measure ${n}</h1>` +
    `<div class="meta"><a rel="author">A. Reporter</a> | Aug 23 2026</div>` +
    `${paras}</article><footer>Copyright</footer></body></html>`
  );
}

const URL_N = (n) => `https://example.com/news/${n}`;

// --- PEAK: nothing unbounded reaches an extraction path -------------------

test('markup handed to the parser is bounded by MAX_PARSE_BYTES', () => {
  const unit = '<p>The council approved the measure after a lengthy debate.</p>';
  const huge = `<!DOCTYPE html><html><head><title>Big</title></head><body>${unit.repeat(
    Math.ceil((8 * 1024 * 1024) / unit.length)
  )}</body></html>`;

  const { markup, clamped } = prepareMarkup(huge);
  assert.ok(
    markup.length <= MAX_PARSE_BYTES,
    `${markup.length} bytes reached the parser; budget is ${MAX_PARSE_BYTES}. ` +
      'Extraction costs ~130 MB of heap per MB — this is the fatal OOM.'
  );
  assert.equal(clamped, true);
});

test('an oversized page is reported as truncated, not silently cut', () => {
  // Markup-heavy and text-light on purpose: the extracted body stays well
  // under MAX_CONTENT_CHARS, so `truncated` can only be true because the page
  // was cut for size. A text-dense page would trip the 100,000-character cut
  // and pass this test for the wrong reason.
  const article = Array.from(
    { length: 30 },
    (_, i) => `<p>Paragraph ${i}: the council approved the measure after a lengthy debate.</p>`
  ).join('');
  const filler = '<div class="layout-wrapper-column-inner"><span></span></div>';
  const huge =
    `<!DOCTYPE html><html><head><title>Big</title></head><body><article><h1>Big</h1>${article}` +
    filler.repeat(Math.ceil((4 * 1024 * 1024) / filler.length)) +
    `</article></body></html>`;

  const { truncated, bodyChars } = extractHtml(huge, 'https://example.com/big');
  assert.ok(bodyChars > 0, 'a clamped page must still extract what it did see');
  assert.ok(
    bodyChars < MAX_CONTENT_CHARS,
    'fixture is text-dense enough to trip the content cut; it no longer tests clamping'
  );
  // Downstream, a truncated source is judged differently from a complete one:
  // evidence may simply be past the cut. Reporting it is the whole contract.
  assert.equal(truncated, true);
});

test('clamping cuts at a tag boundary, never mid-tag', () => {
  const unit = '<p class="story-body-text">Council approved the measure.</p>';
  const huge = `<html><body>${unit.repeat(Math.ceil(MAX_PARSE_BYTES * 2 / unit.length))}</body></html>`;
  const { markup } = prepareMarkup(huge);
  // A cut inside `<p class="...` would have jsdom recover by inventing an
  // attribute from the article's own words.
  assert.ok(!/<[^>]*$/.test(markup), 'markup ends inside an unclosed tag');
});

test('a normal-sized page is passed through whole and not marked truncated', () => {
  const { markup, clamped } = prepareMarkup(newsPage(1));
  assert.equal(clamped, false);
  assert.match(markup, /Paragraph 59 of article 1/);
  assert.equal(extractHtml(newsPage(1), URL_N(1)).truncated, false);
});

test('scripts, stylesheets and comments are dropped, and that is not truncation', () => {
  const html =
    '<!DOCTYPE html><html><head><title>T</title>' +
    `<script>var state = {${'"k":1,'.repeat(5000)}"k":1};</script>` +
    '<style>.a { color: red }</style></head>' +
    '<body><!-- a comment --><article><p>Body text.</p></article></body></html>';

  const { markup, clamped } = prepareMarkup(html);
  assert.equal(clamped, false, 'dropping weight the extractor never reads is not a cut');
  assert.doesNotMatch(markup, /"k":1/);
  assert.doesNotMatch(markup, /color: red/);
  assert.doesNotMatch(markup, /a comment/);
  assert.match(markup, /Body text\./);
});

test('a page that is mostly script keeps its whole article', () => {
  // The real shape this protects: a news page whose bytes are dominated by an
  // inline JSON state blob. Stripping happens before the size cut, so the
  // article survives a page far larger than MAX_PARSE_BYTES.
  const blob = `<script>window.__DATA__ = "${'x'.repeat(MAX_PARSE_BYTES)}";</script>`;
  const article = Array.from(
    { length: 40 },
    (_, i) => `<p>Paragraph ${i}: the council approved the measure after debate.</p>`
  ).join('');
  const html = `<!DOCTYPE html><html><head><title>T</title>${blob}</head><body><article><h1>T</h1>${article}</article></body></html>`;

  const { markup, clamped } = prepareMarkup(html);
  assert.equal(clamped, false);
  assert.match(markup, /Paragraph 39/);
});

// --- CHURN: one Window per process, not one per page ----------------------

test('parsed documents have no browsing context', () => {
  const doc = parseDocument(prepareMarkup(newsPage(1)).markup, URL_N(1));

  // `new JSDOM(html).window.document` fails this: its defaultView is the
  // Window, and that Window is the 1.8 MB per page.
  assert.equal(doc.defaultView, null, 'a per-page Window is exactly the churn');

  // ...and it is still a usable Document, not a fragment.
  assert.equal(doc.nodeType, 9);
  assert.equal(doc.querySelectorAll('p').length, 60);
});

test('every page shares one Window for the life of the process', () => {
  for (let i = 0; i < 25; i++) parseDocument(prepareMarkup(newsPage(i)).markup, URL_N(i));
  assert.equal(
    windowsCreatedForTest(),
    1,
    'one Window per process is the property that keeps memory flat'
  );
});

// --- document identity ----------------------------------------------------

test('relative URLs still resolve against the page URL', () => {
  const doc = parseDocument(
    '<html><head></head><body><a href="/x">x</a></body></html>',
    'https://example.com/a/b'
  );
  assert.equal(doc.baseURI, 'https://example.com/a/b');
  assert.equal(doc.querySelector('a').href, 'https://example.com/x');
});

test("a page's own <base> wins over the fetch URL, per the HTML spec", () => {
  const doc = parseDocument(
    '<html><head><base href="https://cdn.example.org/"></head><body></body></html>',
    'https://example.com/a/b'
  );
  assert.equal(doc.baseURI, 'https://cdn.example.org/');
});

test('a non-absolute page URL leaves baseURI alone instead of setting garbage', () => {
  const doc = parseDocument('<html><head></head><body><p>hi</p></body></html>', 'not a url');
  assert.equal(doc.querySelector('base'), null);
});

// --- the budget is not so tight that it costs real articles ---------------

test('the parse budget still yields more text than the output cap', () => {
  // The justification for MAX_PARSE_BYTES: output is capped at
  // MAX_CONTENT_CHARS anyway, so a budget that reliably produces more text
  // than that costs a real article nothing.
  const unit = '<p>The council approved the measure after a lengthy overnight debate.</p>';
  const dense = `<!DOCTYPE html><html><head><title>T</title></head><body><article>${unit.repeat(
    Math.ceil(MAX_PARSE_BYTES / unit.length)
  )}</article></body></html>`;

  assert.ok(
    extractHtml(dense, 'https://example.com/dense').bodyChars >= MAX_CONTENT_CHARS,
    'the parse budget yields less text than we are willing to return'
  );
});

// --- behavioural: heap ----------------------------------------------------

// node --test doesn't run with --expose-gc, so ask V8 for one directly.
function getGc() {
  if (typeof global.gc === 'function') return global.gc;
  try {
    v8.setFlagsFromString('--expose_gc');
    const gc = vm.runInNewContext('gc');
    v8.setFlagsFromString('--no-expose_gc');
    return typeof gc === 'function' ? gc : null;
  } catch {
    return null;
  }
}

const gc = getGc();

// Peak, sampled while one page is extracted. This is the number that killed
// the pod: it is per-request, so no amount of GC or idle time helps. 512 KB of
// dense markup measured ~70 MB; 150 is a ceiling that fails loudly if the
// budget is raised without re-measuring, without tripping on noise.
test(
  'one page cannot blow the heap on its own',
  { skip: gc ? false : 'could not obtain a GC; run with --expose-gc to measure' },
  () => {
    const unit = '<p class="x">The council approved the measure after a debate.</p>';
    // 8 MB — well inside what MAX_HTML_BYTES lets through the door.
    const huge = `<!DOCTYPE html><html><head><title>Big</title></head><body><article>${unit.repeat(
      Math.ceil((8 * 1024 * 1024) / unit.length)
    )}</article></body></html>`;

    gc();
    gc();
    const base = process.memoryUsage().heapUsed / 1024 / 1024;
    let peak = base;
    const sampler = setInterval(() => {
      const h = process.memoryUsage().heapUsed / 1024 / 1024;
      if (h > peak) peak = h;
    }, 2);

    try {
      extractHtml(huge, 'https://example.com/big');
    } finally {
      clearInterval(sampler);
    }
    const h = process.memoryUsage().heapUsed / 1024 / 1024;
    if (h > peak) peak = h;

    assert.ok(
      peak - base < 150,
      `one 8 MB page peaked at +${(peak - base).toFixed(0)} MB. ` +
        'Unbounded, that page costs ~1 GB and kills a pod with a 256 MB heap.'
    );
  }
);

// Retained-per-page is the second bug: smaller, but it is what made a long
// sweep steadily worse rather than merely occasionally fatal.
const MAX_MB_PER_PAGE = 0.4;
const PAGES = 150;

test(
  'extraction does not retain memory per page',
  { skip: gc ? false : 'could not obtain a GC; run with --expose-gc to measure' },
  () => {
    const heapMB = () => {
      gc();
      gc();
      return process.memoryUsage().heapUsed / 1024 / 1024;
    };

    // Warm up: first-parse allocations (the shared Window, Readability's regex
    // caches, V8 code objects) are one-off and must not be attributed to the
    // per-page cost.
    for (let i = 0; i < 10; i++) extractHtml(newsPage(i), URL_N(i));

    const before = heapMB();
    for (let i = 0; i < PAGES; i++) extractHtml(newsPage(i), URL_N(i));
    const after = heapMB();

    const perPage = (after - before) / PAGES;
    assert.ok(
      perPage < MAX_MB_PER_PAGE,
      `retained ${perPage.toFixed(3)} MB/page over ${PAGES} pages ` +
        `(${before.toFixed(1)} -> ${after.toFixed(1)} MB); budget is ${MAX_MB_PER_PAGE} MB/page. ` +
        'A per-page jsdom Window is the usual cause — see src/parseDocument.js.'
    );
  }
);

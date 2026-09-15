'use strict';

// Unit tests for HTML text extraction. No network, no Redis — unlike
// test/e2e.test.js these run anywhere.
//
// The bug these were written for: Readability removes byline elements from
// the article body (Readability.js `_grabArticle` drops any node whose
// class/id matches /byline|author|dateline|writtenby|p-author/i, or which
// carries rel="author", and parks the text in `article.byline`). On most
// news CMSes the publication date sits in that same element, so extracting
// only `article.textContent` silently dropped the date — and a claim like
// "the impressions appeared in August 2026" then came back NOT SUPPORTED,
// with the model reasoning at length about a date it had never been shown.
//
// The reference Cloudflare Worker's regex extraction never had this problem
// (it keeps everything, including nav and comments), so the failure only
// appeared on the Toolforge path used by the batch pipeline.

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractHtml } = require('../src/extractHtml');
const { MAX_CONTENT_CHARS } = require('../src/config');

const URL = 'https://9to5mac.com/2026/08/23/iphone-ultra-impressions/';
const HEADLINE = 'Here’s what people who have used the iPhone Ultra like most';

// Enough substantive prose for Readability to score this container as the
// article rather than as chrome around it.
function bodyProse(n = 10) {
  return Array.from(
    { length: n },
    (_, i) =>
      `<p>Body paragraph ${i}: people who have used the foldable iPhone Ultra praised how ` +
      `well it fits in a pocket, the durability of the hinge, and the iPad-like app layouts ` +
      `that take advantage of the inner display.</p>`
  ).join('');
}

function page({ head = '', header = '', body = bodyProse() } = {}) {
  return (
    `<!doctype html><html><head><title>${HEADLINE}</title>${head}</head><body>` +
    `<article><h1>${HEADLINE}</h1>${header}${body}</article></body></html>`
  );
}

// --- the reported bug: publication dates removed with the byline -----------

const BYLINE_SHAPES = {
  'author and date in one .author-byline':
    '<div class="author-byline">Chance Miller | Aug 23 2026 - 7:41 am PT</div>',
  '.byline wrapping a <time>':
    '<div class="byline">By Chance Miller, <time datetime="2026-08-23">Aug 23 2026</time></div>',
  '.dateline with the date alone':
    '<div class="dateline">Aug 23 2026 - 7:41 am PT</div>',
  'rel="author" link with the date as sibling text':
    '<div class="meta"><a rel="author" href="/a/">Chance Miller</a> | Aug 23 2026</div>',
};

for (const [name, header] of Object.entries(BYLINE_SHAPES)) {
  test(`publication date survives extraction: ${name}`, () => {
    const { content } = extractHtml(page({ header }), URL);
    assert.match(
      content,
      /Aug 23 2026|2026-08-23/,
      `date was stripped from:\n${content.slice(0, 300)}`
    );
  });
}

test('date in a <meta> Readability does not read is recovered', () => {
  // Readability's _getArticleMetadata covers JSON-LD datePublished,
  // article:published_time and parsely-pub-date. itemprop="datePublished"
  // is not among them, so without findPublishedTime this page has no date
  // anywhere in the output.
  const html = page({
    head: '<meta itemprop="datePublished" content="2026-08-23T07:41:00-07:00">',
  });
  assert.match(extractHtml(html, URL).content, /Published: 2026-08-23T07:41:00-07:00/);
});

test('the headline is restored to the extracted text', () => {
  // article.textContent starts at the first body paragraph; Readability
  // removes the <h1> as a duplicate of the document title and exposes it
  // only as article.title, which used to be discarded.
  assert.match(extractHtml(page(), URL).content, /iPhone Ultra like most/);
});

// --- what must NOT be presented as a publication date ----------------------

test('a modification date is not reported as the publication date', () => {
  // Labelling "last updated" as "published" would swap a missing fact for a
  // wrong one, which is worse for a verdict than saying nothing.
  const html = page({
    head:
      '<meta property="og:updated_time" content="2027-01-15T00:00:00Z">' +
      '<meta itemprop="dateModified" content="2027-01-15T00:00:00Z">',
  });
  assert.doesNotMatch(extractHtml(html, URL).content, /Published:.*2027/);
});

test('a <time> in body prose is not mistaken for the publication date', () => {
  // An unqualified time[datetime] search would return a date the article is
  // *about* and label it as when the article was published.
  const html = page({
    body: `<p>The treaty was signed on <time datetime="1919-06-28">28 June 1919</time>.</p>${bodyProse()}`,
  });
  assert.doesNotMatch(extractHtml(html, URL).content, /Published:.*1919/);
});

// --- the metadata header must not manufacture usable content --------------

test('bodyChars measures the body only, never the header', () => {
  // fetchTarget compares bodyChars against MIN_CONTENT_CHARS to decide
  // whether a page yielded usable content. If that count included the
  // header, a cookie wall with a long headline and byline would clear the
  // floor on metadata alone and be reported as a successful fetch.
  const { content, bodyChars } = extractHtml(
    page({ header: '<div class="author-byline">Chance Miller | Aug 23 2026 - 7:41 am PT</div>' }),
    URL
  );

  const headerLength = content.indexOf('\n\n') + 2;
  assert.ok(headerLength > 2, 'this page should have produced a metadata header');
  assert.equal(content.length - bodyChars, headerLength);
});

// --- fallback behavior -----------------------------------------------------

test('a page Readability cannot parse still falls back to regex extraction', () => {
  // Unconditional fallback, unchanged from before the header was added: a
  // short non-article page yields whatever the regex gets, even when that is
  // well under the under-selection guard's threshold.
  const html =
    '<!doctype html><html><body><div>' +
    'Record 4412. Status: active. Registered 14 March 2011 under the county register, ' +
    'with no further detail held on file for this entry at the present time.' +
    '</div></body></html>';

  const { content, bodyChars } = extractHtml(html, URL);
  assert.match(content, /Record 4412/);
  assert.ok(bodyChars > 0);
});

test('under-selection falls back rather than shipping a fragment', () => {
  // The old fallback only fired when Readability returned *nothing*. A parse
  // that returns a sliver of the wrong container cleared MIN_CONTENT_CHARS
  // and shipped as the source — worse than the crude extraction it replaced,
  // because it is confidently and silently wrong.
  //
  // aria-hidden is the realistic trigger: Readability's _isProbablyVisible
  // skips those subtrees, and collapsed accordions, tabbed panels and
  // "read more" wrappers carry aria-hidden="true" in the served HTML,
  // expanded by script we never run. Here it leaves Readability with one
  // 82-character intro against 5kB of real content.
  const intro = '<p>This page collects the committee findings for the 2026 review period.</p>';
  const realContent = Array.from(
    { length: 30 },
    (_, i) =>
      `<p>Finding ${i}: the committee recorded a value of ${1000 + i} for this indicator ` +
      `during the review period, with supporting commentary from the rapporteur.</p>`
  ).join('');

  const { content, bodyChars } = extractHtml(
    `<!doctype html><html><head><title>Committee findings</title></head><body>` +
      `<div>${intro}</div><div aria-hidden="true">${realContent}</div></body></html>`,
    URL
  );

  assert.match(content, /Finding 29/, 'the real content must be present, not just the intro');
  assert.ok(bodyChars > 4000, `fell back to a fragment instead: ${bodyChars} chars`);
});

test('the guard does not fire on a normal article', () => {
  // Readability legitimately returns far less text than regexExtract on
  // every page — that is the point of it, and the reason the truncation cap
  // bites less often. A guard that treats "smaller" as "broken" would undo
  // the entire benefit, so this pins that an ordinary article still comes
  // back through the Readability path. Only that path emits a header, which
  // makes the header the signal that no fallback happened.
  const nav = '<nav>Home | iPhone | Mac | iPad | Watch | Vision | Guides | Store</nav>';
  const html =
    `<!doctype html><html><head><title>${HEADLINE}</title></head><body>${nav}` +
    `<article><h1>${HEADLINE}</h1>` +
    `<div class="author-byline">Chance Miller | Aug 23 2026 - 7:41 am PT</div>` +
    `${bodyProse(12)}</article></body></html>`;

  const { content } = extractHtml(html, URL);
  assert.ok(content.startsWith('Title:'), 'should have taken the Readability path');
  assert.match(content, /Body paragraph 11/, 'article body must survive');
  assert.doesNotMatch(content, /Watch \| Vision/, 'site nav must not be in the output');
});

// --- truncation ------------------------------------------------------------

test('the header survives truncation of an over-long page', () => {
  // The header is prepended precisely so that the date outlives the cap —
  // in the Worker's output the date sits wherever it fell on the page and
  // is lost whenever the cut lands above it.
  const huge = `<p>${'Long article prose about the foldable iPhone Ultra. '.repeat(4000)}</p>`;
  const html = page({
    header: '<div class="author-byline">Chance Miller | Aug 23 2026 - 7:41 am PT</div>',
    body: huge,
  });

  const { content, truncated } = extractHtml(html, URL);
  assert.equal(truncated, true);
  assert.equal(content.length, MAX_CONTENT_CHARS);
  assert.match(content.slice(0, 400), /Aug 23 2026/);
});

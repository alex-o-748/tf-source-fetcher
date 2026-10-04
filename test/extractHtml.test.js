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

// --- Drupal's "Submitted by … on …" byline ---------------------------------
//
// Reported on sunshinestatenews.com (Drupal): the Cloudflare Worker returned
// "Submitted by Kevin Derby on August 24, 2010 - 10:41pm", this service
// returned only a Title line and the body, and a claim dated August 24, 2010
// came back NOT SUPPORTED. Drupal marks its byline `class="submitted"` (D7) or
// `node__submitted` (D8+), a name in neither Readability's byline pattern nor
// ours, and puts the machine-readable date in RDFa on a <span>, which
// Readability's metadata pass — <meta> elements only — never looks at.

function drupalPage(submitted) {
  return (
    `<!doctype html><html><head><title>${HEADLINE} | Site</title></head><body>` +
    `<div id="skip-link"><a href="#main-content">Skip to main content</a></div>` +
    `<div id="node-1" class="node node-blog node-full clearfix">` +
    `<h1 class="title">${HEADLINE}</h1>${submitted}` +
    `<div class="content"><div class="field field-name-body">${bodyProse()}</div></div>` +
    `</div></body></html>`
  );
}

test('Drupal 7 byline: date kept from the visible text and from RDFa', () => {
  const html = drupalPage(
    '<div class="submitted"><span property="dc:date dc:created" ' +
      'content="2010-08-24T22:41:00-04:00" datatype="xsd:dateTime" rel="sioc:has_creator">' +
      'Submitted by <span class="username" typeof="sioc:UserAccount" property="foaf:name">' +
      'Kevin Derby</span> on August 24, 2010 - 10:41pm</span></div>'
  );
  const { content } = extractHtml(html, URL);
  assert.match(content, /Published: 2010-08-24T22:41:00-04:00/);
  assert.match(content, /By: Submitted by Kevin Derby on August 24, 2010 - 10:41pm/);
});

test('Drupal 8+ byline: node__submitted with schema.org RDFa', () => {
  const html = drupalPage(
    '<div class="node__submitted">Submitted by <span class="field--name-uid">' +
      '<span property="schema:name">Kevin Derby</span></span> on ' +
      '<span class="field--name-created" property="schema:dateCreated" ' +
      'content="2010-08-24T22:41:00-04:00">Tue, 08/24/2010 - 22:41</span></div>'
  );
  const { content } = extractHtml(html, URL);
  assert.match(content, /Published: 2010-08-24T22:41:00-04:00/);
  assert.match(content, /By: Submitted by Kevin Derby on Tue, 08\/24\/2010/);
});

test('an RDFa modification date is not reported as the publication date', () => {
  const html = drupalPage(
    '<span property="dc:modified" content="2027-01-15T00:00:00Z"></span>' +
      '<span property="schema:dateModified" content="2027-01-15T00:00:00Z"></span>'
  );
  assert.doesNotMatch(extractHtml(html, URL).content, /Published:.*2027/);
});

test('the headline is in the extracted text', () => {
  // Readability's article text drops the <h1> as a duplicate of the document
  // title; the crude page text keeps both.
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

test('a page Readability cannot parse still yields its text', () => {
  // A short non-article page: no header, but the crude text is all there.
  const html =
    '<!doctype html><html><body><div>' +
    'Record 4412. Status: active. Registered 14 March 2011 under the county register, ' +
    'with no further detail held on file for this entry at the present time.' +
    '</div></body></html>';

  const { content, bodyChars } = extractHtml(html, URL);
  assert.match(content, /Record 4412/);
  assert.ok(bodyChars > 0);
});

test('content a reader view would skip is still returned', () => {
  // The case that motivated extracting the crude page text: aria-hidden is
  // what collapsed accordions, tabbed panels and "read more" wrappers carry in
  // the served HTML, expanded by script we never run. Readability's
  // _isProbablyVisible skips those subtrees, which here would leave one
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
  assert.ok(bodyChars > 4000, `returned a fragment instead: ${bodyChars} chars`);
});

test('a byline outside the article container is kept, whatever its class', () => {
  // The reported failure, generalized. A date shown on the page beside the
  // article — in an element whose class no selector list anticipated — used
  // to be dropped with the rest of the chrome, and a claim dated to it came
  // back NOT SUPPORTED. The crude text keeps everything visible.
  const html =
    `<!doctype html><html><head><title>${HEADLINE}</title></head><body>` +
    `<div class="node"><h1>${HEADLINE}</h1>` +
    `<div class="post-meta-xyz">Posted on 24 August 2010 - 10:41pm</div>` +
    `<div class="content">${bodyProse()}</div></div></body></html>`;

  assert.match(extractHtml(html, URL).content, /24 August 2010/);
});

test('an ordinary article returns the page text after the metadata header', () => {
  const nav = '<nav>Home | iPhone | Mac | iPad | Watch | Vision | Guides | Store</nav>';
  const html =
    `<!doctype html><html><head><title>${HEADLINE}</title>` +
    `<meta property="article:published_time" content="2026-08-23T07:41:00-07:00"></head>` +
    `<body>${nav}<article><h1>${HEADLINE}</h1>` +
    `<div class="author-byline">Chance Miller | Aug 23 2026 - 7:41 am PT</div>` +
    `${bodyProse(12)}</article></body></html>`;

  const { content } = extractHtml(html, URL);
  assert.ok(content.startsWith('Published: 2026-08-23T07:41:00-07:00\n'), content.slice(0, 200));
  assert.match(content, /\n\nHere’s what people/, 'body starts with the page title after the header');
  assert.match(content, /Body paragraph 11/, 'article body must survive');
  assert.doesNotMatch(content, /Watch \| Vision/, '<nav> is still stripped');
});

test('a date that exists only in metadata reaches the output', () => {
  // The other half of the comparison: the crude text cannot see a date that
  // is never displayed. The header is what carries it.
  const html = page({
    head: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","datePublished":"2024-03-06T22:51:03.000Z"}</script>',
  });
  assert.match(extractHtml(html, URL).content, /^Published: 2024-03-06T22:51:03.000Z/);
});

test('HTML entities are decoded, once', () => {
  const html = page({
    body: `<p>Hampshire men&#x27;s coach &mdash; the club&#8217;s &quot;Hawks&quot; &amp; more; ` +
      `literal &amp;#39; stays.</p>${bodyProse()}`,
  });
  const { content } = extractHtml(html, URL);
  assert.match(content, /Hampshire men's coach — the club’s "Hawks" & more; literal &#39; stays\./);
});

test('HTML comments do not leak into the text', () => {
  // Seen in the wild as "Sorry, you need to enable JavaScript ... -->": a
  // comment containing markup is cut at its first ">" by the tag stripper.
  const html = page({
    body: `<!-- <div>Sorry, you need to enable JavaScript</div> -->${bodyProse()}`,
  });
  assert.doesNotMatch(extractHtml(html, URL).content, /enable JavaScript|-->/);
});

test('an over-long page spends the budget on the article, not the chrome', () => {
  // Over MAX_CONTENT_CHARS the cut would land wherever it lands. A page whose
  // chrome alone exceeds the cap would otherwise return no article at all.
  const chrome = `<div class="sidebar">${'Related: another headline here. '.repeat(4000)}</div>`;
  const html =
    `<!doctype html><html><head><title>${HEADLINE}</title></head><body>${chrome}` +
    `<article><h1>${HEADLINE}</h1>${bodyProse(12)}</article></body></html>`;

  const { content } = extractHtml(html, URL);
  assert.match(content, /Body paragraph 11/);
  assert.doesNotMatch(content, /Related: another headline/);
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

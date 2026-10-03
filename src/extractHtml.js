'use strict';

const { Readability, isProbablyReaderable } = require('@mozilla/readability');
const { prepareMarkup, parseDocument, releaseDocument } = require('./parseDocument');
const { MAX_CONTENT_CHARS } = require('./config');

// The page's crude text is what we return, except when it is over
// MAX_CONTENT_CHARS: then the cut would land wherever it lands, possibly
// above the article, and Readability's article selection is used instead so
// the budget goes on the article rather than on menus and comment threads.
// Below this length its output is more likely a mis-selected fragment than an
// article, and the crude text (cut at the cap) is kept instead.
const MIN_READABILITY_CHARS = 500;

// Class/id fragments that mark an element as publication metadata. The first
// five mirror Readability's own REGEXPS.byline (Readability.js), because that
// is exactly the set of nodes it strips out of the article body; the rest
// cover date-only containers it leaves in place but which we still want to
// recognize when hunting for a <time> element.
const DATE_CONTEXT_RE =
  /byline|author|dateline|writtenby|p-author|post-date|entry-date|published|pubdate|timestamp|submitted/i;

// Elements that hold publication metadata on a typical news CMS — the same
// nodes Readability strips from the article body. Matched in document order,
// so an author-bio box at the foot of the article loses to the byline at the
// top.
//
// `submitted` is Drupal's byline — "Submitted by <name> on <date>", in
// `div.submitted` (D7) or `div.node__submitted` (D8+). Readability's byline
// pattern doesn't know the name, so it is neither stripped as a byline nor
// reliably kept: the div sits beside the body field, outside the container
// Readability selects, and was being dropped with the rest of the chrome.
const BYLINE_SELECTOR = [
  '[rel~="author" i]',
  '[itemprop~="author" i]',
  '[class*="byline" i]',
  '[class*="author" i]',
  '[class*="dateline" i]',
  '[class*="post-date" i]',
  '[class*="entry-date" i]',
  '[class*="published" i]',
  '[class*="timestamp" i]',
  '[class*="submitted" i]',
  '[id*="byline" i]',
  '[id*="author" i]',
].join(',');

// Readability's own ceiling for what counts as a byline (_isValidByline
// rejects anything >= 100 chars), matched here so we consider the same nodes
// it does...
const MAX_BYLINE_CHARS = 100;

// ...and a looser ceiling for that node's parent, which is often the element
// actually holding the date (see captureBylineText).
const MAX_BYLINE_PARENT_CHARS = 200;

// Publication-date <meta> tags that Readability's _getArticleMetadata does NOT
// read. It already covers JSON-LD datePublished, article:published_time and
// parsely-pub-date, so those are deliberately absent here.
//
// Modification dates (og:updated_time, dateModified) are deliberately absent
// too: presenting a "last updated" stamp as the publication date would trade
// a missing fact for a wrong one, which is worse for a verdict than silence.
const PUBLISHED_META_SELECTORS = [
  'meta[itemprop="datePublished" i]',
  'meta[name="date" i]',
  'meta[name="pubdate" i]',
  'meta[name="publishdate" i]',
  'meta[name="article.published" i]',
  'meta[name="DC.date.issued" i]',
  'meta[name="dcterms.issued" i]',
].join(',');

// The same facts expressed as RDFa or microdata on *any* element, not just
// <meta>. Readability's metadata pass reads <meta> tags only, so these are
// invisible to it — and they are how Drupal publishes its dates, e.g.
//
//   <span property="dc:date dc:created" content="2010-08-24T22:41:00-04:00">
//
// Drupal records creation, not publication, but for a CMS node the two are
// the same moment. Modification properties (dc:modified, schema:dateModified)
// are absent for the reason given above.
const PUBLISHED_ATTR_SELECTORS = [
  '[property~="dc:date" i][content]',
  '[property~="dc:created" i][content]',
  '[property~="dc:issued" i][content]',
  '[property~="dcterms:created" i][content]',
  '[property~="dcterms:issued" i][content]',
  '[property~="schema:datePublished" i][content]',
  '[property~="schema:dateCreated" i][content]',
  '[itemprop~="datePublished" i][content]',
  '[itemprop~="datePublished" i][datetime]',
].join(',');

// Named entities worth decoding. Numeric references (&#8217; &#x27;) are
// decoded generically; these are the named ones common in real pages. An
// entity not listed here is left as written rather than guessed at.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  sbquo: '\u201A', bdquo: '\u201E', laquo: '\u00AB', raquo: '\u00BB',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', middot: '\u00B7',
  bull: '\u2022', copy: '\u00A9', reg: '\u00AE', trade: '\u2122',
  deg: '\u00B0', eacute: '\u00E9', shy: '',
};

// One pass, so `&amp;#39;` decodes to the literal text `&#39;` — as written on
// the page — rather than being decoded twice into an apostrophe.
function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X'
        ? parseInt(ref.slice(2), 16)
        : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = Object.hasOwn(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref] : undefined;
    return named === undefined ? match : named;
  });
}

// The page's visible text, nearly whole — the reference Worker's approach.
// This is the primary extraction, not a fallback: it keeps the bylines,
// datelines, captions and info panels that an article extractor discards as
// chrome, and those are where a claim's date or headline figure often lives.
// The model reading the result copes with the leftover navigation far better
// than with a missing fact. See "Extraction" in the README for the benchmark
// comparison this rests on.
function regexExtract(html) {
  return decodeEntities(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text) {
  if (text.length <= MAX_CONTENT_CHARS) {
    return { content: text, truncated: false };
  }
  return { content: text.slice(0, MAX_CONTENT_CHARS), truncated: true };
}

// Reads the byline element's full text *before* Readability runs, because
// `article.byline` is often only part of it. Where the markup is
//
//   <div class="meta"><a rel="author">Chance Miller</a> | Aug 23 2026</div>
//
// Readability matches the inner <a>, records "Chance Miller", and removes
// the whole container — so the date is in neither the body nor the byline.
// The parent carries it, hence the widen-to-parent step.
//
// This captures the surrounding text verbatim rather than pattern-matching a
// date out of it. A date regex would have to be taught every format this
// service will meet — the userscript already runs on fr, es and de Wikipedia
// and follows citations to sources in those languages — and would silently
// return nothing on the ones it had not been taught.
function captureBylineText(doc) {
  for (const node of doc.querySelectorAll(BYLINE_SELECTOR)) {
    const text = node.textContent.trim().replace(/\s+/g, ' ');
    if (!text || text.length >= MAX_BYLINE_CHARS) continue;

    const parent = node.parentElement;
    const parentText = parent ? parent.textContent.trim().replace(/\s+/g, ' ') : '';
    if (
      parentText.length > text.length &&
      parentText.length < MAX_BYLINE_PARENT_CHARS &&
      parentText.includes(text)
    ) {
      return parentText;
    }
    return text;
  }
  return null;
}

// Last-resort publication date, for pages where Readability found none in
// metadata AND swallowed the visible one into the byline it removed (see
// buildHeader). Only looks at <time datetime> inside a byline/date-ish
// container or a <header> — an unqualified `time[datetime]` search would
// happily return a date the article is *about* (a battle, a treaty, a
// birth) and label it as the publication date.
function findPublishedTime(doc) {
  const meta = doc.querySelector(PUBLISHED_META_SELECTORS);
  const metaContent = meta && meta.getAttribute('content');
  if (metaContent && metaContent.trim()) {
    return metaContent.trim();
  }

  for (const node of doc.querySelectorAll(PUBLISHED_ATTR_SELECTORS)) {
    const value = (node.getAttribute('content') || node.getAttribute('datetime') || '').trim();
    if (value) return value;
  }

  for (const time of doc.querySelectorAll('time[datetime]')) {
    const datetime = time.getAttribute('datetime').trim();
    if (!datetime) continue;

    for (let node = time; node; node = node.parentElement) {
      const marker = `${node.className || ''} ${node.id || ''}`;
      if (node.tagName === 'HEADER' || DATE_CONTEXT_RE.test(marker)) {
        return datetime;
      }
    }
  }

  return null;
}

// Takes the pre-parse capture only when it is a superset of what Readability
// reported — that is the signal the two came from the same element and the
// capture merely kept more of it. Anything else means they found different
// nodes, and Readability's scoring is the better judge of which is the byline.
function preferFullByline(captured, readabilityByline) {
  if (!captured) return readabilityByline;
  if (!readabilityByline) return captured;
  return captured.includes(readabilityByline) ? captured : readabilityByline;
}

// The publication metadata a page carries but may not display. The body is
// the page's visible text, so a date shown in a byline is already in it; this
// header covers the dates that exist only in metadata (JSON-LD, <meta>, RDFa),
// which the crude text cannot see, and bylines inside a <header> element,
// which it strips along with the site banner.
//
// No Title line: the page's <title> is already the first text of the body.
//
// The header goes at the front so it survives MAX_CONTENT_CHARS truncation.
function buildHeader({ byline, publishedTime, siteName }) {
  const lines = [
    ['Published', publishedTime],
    ['By', byline],
    ['Site', siteName],
  ]
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([label, value]) => `${label}: ${value.trim().replace(/\s+/g, ' ')}`);

  return lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
}

// Extracts text from an HTML document: the page's crude text (regexExtract),
// preceded by a publication-metadata header when Readability can read one.
//
// Readability's own article text is used only when the crude text would not
// fit under MAX_CONTENT_CHARS — see MIN_READABILITY_CHARS.
//
// Returns { content, truncated, bodyChars }. `bodyChars` is the length of the
// extracted body *excluding* the metadata header — callers deciding whether a
// page yielded usable content must use it, since a cookie wall with a fat
// byline can clear a content floor on header text alone.
function extractHtml(html, url) {
  // Bound the input before either extraction path touches it. Building a DOM
  // costs ~130 MB of heap per MB of markup and the regex chain is no cheaper,
  // so an unbounded page is a fatal OOM rather than a slow request — that is
  // what was killing the pod. See src/parseDocument.js. Everything below runs
  // on `markup`, never on `html`.
  const { markup, clamped } = prepareMarkup(html);

  let readabilityText = '';
  let header = '';
  let doc = null;

  try {
    // parseDocument, not `new JSDOM(markup, { url })`: the latter builds a
    // Window per page, ~1.8 MB of garbage that only a full mark-compact
    // retires, on a heap this service was already driving to its ceiling.
    doc = parseDocument(markup, url);
    if (isProbablyReaderable(doc)) {
      // Both of these must be read before parse(): Readability mutates the
      // document it is handed, removing the very nodes they look at.
      const bylineText = captureBylineText(doc);
      const publishedHint = findPublishedTime(doc);

      const article = new Readability(doc).parse();
      if (article) {
        readabilityText = (article.textContent || '').replace(/\s+/g, ' ').trim();
        header = buildHeader({
          byline: preferFullByline(bylineText, article.byline),
          // Readability reads publication metadata, but not all of it; fall
          // back to the tags and byline-scoped <time> elements it skips.
          publishedTime: article.publishedTime || publishedHint,
          siteName: article.siteName,
        });
      }
    }
  } catch {
    // jsdom/Readability choked on this document (malformed HTML, unsupported
    // constructs). The crude text below needs neither; only the header and
    // the over-cap article selection are lost.
    readabilityText = '';
    header = '';
  } finally {
    // Everything taken out of `doc` above is a string by now, and the document
    // is reachable from the shared parser's Window until it is emptied. In a
    // `finally` because the paths that DON'T reach Readability are exactly the
    // expensive ones: Readability strips the document it processes, so a page
    // that throws, or is judged not readerable, is the one that would retain
    // its full ~10 MB. See releaseDocument() in src/parseDocument.js.
    releaseDocument(doc);
  }

  let body = regexExtract(markup);
  if (
    header.length + body.length > MAX_CONTENT_CHARS &&
    readabilityText.length >= MIN_READABILITY_CHARS
  ) {
    body = readabilityText;
  }

  const { content, truncated } = truncate(`${header}${body}`);
  // `clamped` means we never saw the whole page, so the text we return may
  // stop short of evidence that was there. That is the same fact `truncated`
  // already carries for the MAX_CONTENT_CHARS cut, and the citation verifier
  // downstream treats a truncated source differently from a complete one — so
  // it has to be reported, not swallowed.
  return { content, truncated: truncated || clamped, bodyChars: body.length };
}

module.exports = { extractHtml };

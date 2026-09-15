'use strict';

const { JSDOM } = require('jsdom');
const { Readability, isProbablyReaderable } = require('@mozilla/readability');
const { MAX_CONTENT_CHARS } = require('./config');

// Below this, Readability's output is short enough to be suspicious rather
// than merely concise, and we compare it against the regex extraction (see
// the under-selection guard in extractHtml).
const MIN_READABILITY_CHARS = 500;

// ...and it's only treated as under-selection if the crude extractor found
// this many times more text. Readability legitimately returns far less than
// regexExtract on every page — that's the point of it — so the guard has to
// trigger on "a fragment instead of an article", not on "smaller".
const UNDERSELECTION_RATIO = 5;

// Class/id fragments that mark an element as publication metadata. The first
// five mirror Readability's own REGEXPS.byline (Readability.js), because that
// is exactly the set of nodes it strips out of the article body; the rest
// cover date-only containers it leaves in place but which we still want to
// recognize when hunting for a <time> element.
const DATE_CONTEXT_RE =
  /byline|author|dateline|writtenby|p-author|post-date|entry-date|published|pubdate|timestamp/i;

// Elements that hold publication metadata on a typical news CMS — the same
// nodes Readability strips from the article body. Matched in document order,
// so an author-bio box at the foot of the article loses to the byline at the
// top.
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

// Same crude strip-and-collapse approach as the reference Worker's
// extractText(): used as a fallback for pages Readability can't parse (JS-only
// shells, malformed markup, non-article pages) rather than as the primary
// method — Node lets us do much better than regex-stripping via jsdom.
function regexExtract(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
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

// Re-attaches the three things Readability computes and then drops on the
// floor, because `article.textContent` is the article *body* only:
//
//   - the <h1> headline, removed as a duplicate of the document title;
//   - the byline, removed from the body by _grabArticle and parked in
//     `article.byline` — and on most news CMSes the publication date is in
//     that same element, so removing the byline removes the date;
//   - `article.publishedTime`, parsed out of metadata and never used.
//
// A missing date is not a cosmetic loss for this service's one caller: a
// claim like "the impressions appeared in August 2026" is unverifiable
// against a source whose date has been stripped, and the model reports that
// as the citation failing rather than as the fetcher failing.
//
// The header goes at the front so it survives MAX_CONTENT_CHARS truncation.
function buildHeader({ title, byline, publishedTime, siteName }) {
  const lines = [
    ['Title', title],
    ['Published', publishedTime],
    ['By', byline],
    ['Site', siteName],
  ]
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([label, value]) => `${label}: ${value.trim().replace(/\s+/g, ' ')}`);

  return lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
}

// Extracts readable text from an HTML document. Tries Readability (a real
// article-extraction pass: strips nav/ads/boilerplate far better than regex)
// and falls back to the Worker's original tag-stripping approach when
// Readability can't find an article (JS-only shells, non-article pages, feed
// pages, etc.) so those cases degrade gracefully instead of returning nothing.
//
// Returns { content, truncated, bodyChars }. `bodyChars` is the length of the
// extracted body *excluding* the metadata header — callers deciding whether a
// page yielded usable content must use it, since a cookie wall with a fat
// <title> and byline can clear a content floor on header text alone.
function extractHtml(html, url) {
  let readabilityText = '';
  let header = '';

  try {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;
    if (isProbablyReaderable(doc)) {
      // Both of these must be read before parse(): Readability mutates the
      // document it is handed, removing the very nodes they look at.
      const bylineText = captureBylineText(doc);
      const publishedHint = findPublishedTime(doc);

      const article = new Readability(doc).parse();
      if (article && article.textContent) {
        readabilityText = article.textContent.replace(/\s+/g, ' ').trim();
        header = buildHeader({
          title: article.title,
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
    // constructs) — fall through to the regex extractor below.
    readabilityText = '';
    header = '';
  }

  // Under-selection guard. The existing fallback only fires when Readability
  // returns *nothing*; a run that picks the wrong container and returns a
  // sliver of a related-posts widget clears MIN_CONTENT_CHARS and ships as
  // the source, which is worse than the crude extraction it replaced because
  // it is confidently, silently wrong. Not a failure mode observed in the
  // wild — the fallback is cheap and the downside it covers is not.
  let body = readabilityText;
  let usedFallback = false;

  if (body.length === 0) {
    // Readability found no article at all — the original unconditional
    // fallback, unchanged: whatever the regex yields is what we have.
    body = regexExtract(html);
    usedFallback = true;
  } else if (body.length < MIN_READABILITY_CHARS) {
    const regexText = regexExtract(html);
    if (regexText.length >= Math.max(body.length * UNDERSELECTION_RATIO, MIN_READABILITY_CHARS)) {
      body = regexText;
      usedFallback = true;
    }
  }

  if (usedFallback) {
    // The header describes the Readability parse, not this text, and the
    // regex output already carries whatever byline/date the page showed.
    header = '';
  }

  const { content, truncated } = truncate(`${header}${body}`);
  return { content, truncated, bodyChars: body.length };
}

module.exports = { extractHtml };

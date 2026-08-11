'use strict';

const { JSDOM } = require('jsdom');
const { Readability, isProbablyReaderable } = require('@mozilla/readability');
const { MAX_CONTENT_CHARS } = require('./config');

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

// Extracts readable text from an HTML document. Tries Readability (a real
// article-extraction pass: strips nav/ads/boilerplate far better than regex)
// and falls back to the Worker's original tag-stripping approach when
// Readability can't find an article (JS-only shells, non-article pages, feed
// pages, etc.) so those cases degrade gracefully instead of returning nothing.
function extractHtml(html, url) {
  let readabilityText = '';
  try {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;
    if (isProbablyReaderable(doc)) {
      const article = new Readability(doc).parse();
      if (article && article.textContent) {
        readabilityText = article.textContent.replace(/\s+/g, ' ').trim();
      }
    }
  } catch {
    // jsdom/Readability choked on this document (malformed HTML, unsupported
    // constructs) — fall through to the regex extractor below.
    readabilityText = '';
  }

  const text = readabilityText.length > 0 ? readabilityText : regexExtract(html);
  return truncate(text);
}

module.exports = { extractHtml };

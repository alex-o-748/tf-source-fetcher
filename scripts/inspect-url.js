#!/usr/bin/env node
'use strict';

// Diagnostic: fetch one real URL and show what this service would return for
// it, and — when a publication date is found — which channel supplied it.
//
//   node scripts/inspect-url.js <url>
//
// The README asks for a manual smoke test against real URLs before flipping
// live traffic onto this service, because the sandbox these tests are written
// in has no general internet egress. This is that smoke test, plus the
// per-channel breakdown needed to answer "would the date survive on THIS
// page?" without reading the extractor's source.

const { Readability, isProbablyReaderable } = require('@mozilla/readability');
const { parseDocument } = require('../src/parseDocument');
const { extractHtml } = require('../src/extractHtml');
const { USER_AGENT } = require('../src/config');

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: node scripts/inspect-url.js <url>');
    process.exit(2);
  }

  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*' },
  });
  const html = await response.text();
  console.log(`HTTP ${response.status} — ${html.length} bytes of HTML\n`);

  // Report each date channel separately, against an unmutated document.
  // Readability.parse() rewrites the DOM it is given, so this parse must be
  // its own; parseDocument returns a fresh document every call, and using it
  // (rather than jsdom directly) is what keeps this diagnostic honest — it
  // parses the page exactly the way the service does.
  const doc = parseDocument(html, url);
  console.log(`isProbablyReaderable : ${isProbablyReaderable(doc)}`);
  if (!isProbablyReaderable(doc)) {
    console.log('  -> regex fallback path: nothing is removed, so nothing is lost.\n');
  }

  const metaTags = [...doc.querySelectorAll('meta[property],meta[name],meta[itemprop]')]
    .map((m) => ({
      key: m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop'),
      value: m.getAttribute('content'),
    }))
    .filter(({ key, value }) => value && /date|time|publish/i.test(key || ''));

  console.log('\ndate-ish <meta> tags in the document:');
  console.log(
    metaTags.length
      ? metaTags.map(({ key, value }) => `  ${key} = ${value}`).join('\n')
      : '  (none)'
  );

  const article = new Readability(parseDocument(html, url)).parse();
  console.log('\nwhat Readability itself reports:');
  console.log(`  title         : ${article && article.title}`);
  console.log(`  byline        : ${article && article.byline}`);
  console.log(`  publishedTime : ${article && article.publishedTime}`);
  console.log(`  siteName      : ${article && article.siteName}`);
  console.log(
    '  (Firefox Reader View shows title, byline and body — it never displays\n' +
      '   publishedTime, so a date missing from Reader View may still be here.)'
  );

  const extracted = extractHtml(html, url);
  const headerEnd = extracted.content.indexOf('\n\n');
  console.log('\nwhat this service would return:');
  console.log(`  bodyChars ${extracted.bodyChars} | truncated ${extracted.truncated}`);
  console.log('  ---');
  console.log(
    headerEnd > 0
      ? extracted.content.slice(0, headerEnd)
      : '  (no metadata header — took the regex fallback path)'
  );
  console.log('  ---');
  console.log(`  body begins: ${JSON.stringify(extracted.content.slice(headerEnd + 2, headerEnd + 160))}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

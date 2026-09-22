'use strict';

// Saves real article HTML to test/fixtures/pages/ so the leak hunt can run
// offline, repeatably, against the thing that actually triggers the bug.
//
// WHY THIS EXISTS. scripts/load-memory.js measures flat — 0.0005 MB/request
// over 1,000 extractions — while production retains 2-3 MB per successfully
// extracted page. The harness is not wrong about what it measures; it is
// measuring the wrong input. Its fixture is this:
//
//   <html><head><title>Load fixture</title></head><body><article><h1>…</h1>
//   <p>Representative article content. (x100)</p></article></body></html>
//
// ~3 KB, one paragraph, no nesting, no attributes, no inline SVG, no
// tracking pixels, no comment widget. A real news page is 100-500 KB of
// deeply nested CMS output. Readability walks every node scoring it, so the
// node count is the workload — and a page with 40 nodes exercises none of
// what a page with 20,000 nodes does.
//
// Real pages also cannot be checked in: they are third-party content, they
// are large, and they change. So this script fetches them once into a
// gitignored directory, keyed by URL, and skips anything already there.
//
// Usage:
//   node scripts/capture-fixtures.js                 # the default URL list
//   node scripts/capture-fixtures.js urls.txt        # one URL per line
//   node scripts/capture-fixtures.js --force         # refetch what's cached

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { USER_AGENT, MAX_HTML_BYTES } = require('../src/config');

const FIXTURE_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'pages');
const MANIFEST = path.join(FIXTURE_DIR, 'manifest.json');

// A spread of the shapes this service actually meets: wire services, a
// broadsheet, a public broadcaster, a government page, a journal abstract, a
// wiki. Deliberately not a curated set of *easy* pages — the heavy,
// widget-laden ones are the point.
const DEFAULT_URLS = [
  'https://www.bbc.co.uk/news',
  'https://apnews.com/hub/world-news',
  'https://www.theguardian.com/world',
  'https://www.reuters.com/world/',
  'https://www.npr.org/sections/world/',
  'https://www.gov.uk/government/news',
  'https://www.nature.com/articles/d41586-024-00001-0',
  'https://en.wikipedia.org/wiki/Wikipedia:Citing_sources',
  'https://www.cdc.gov/media/site.html',
  'https://www.nasa.gov/news/',
];

function keyFor(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    return {};
  }
}

// Mirrors src/fetchTarget.js's cap so a fixture can never be larger than what
// the service would have accepted. A fixture the real path would have rejected
// would make the harness measure a case that cannot happen.
async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*' },
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_HTML_BYTES) return { error: 'too large' };
    return { html: buf.toString('utf8') };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const listFile = args.find((a) => !a.startsWith('--'));

  const urls = listFile
    ? fs
        .readFileSync(listFile, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
    : DEFAULT_URLS;

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const manifest = readManifest();

  let saved = 0;
  let skipped = 0;
  let failed = 0;

  for (const url of urls) {
    const key = keyFor(url);
    const file = path.join(FIXTURE_DIR, `${key}.html`);

    if (!force && fs.existsSync(file)) {
      skipped += 1;
      continue;
    }

    const { html, error } = await fetchPage(url);
    if (error) {
      console.log(`  skip  ${url} — ${error}`);
      failed += 1;
      continue;
    }

    fs.writeFileSync(file, html);
    manifest[key] = { url, bytes: Buffer.byteLength(html), capturedAt: new Date().toISOString() };
    saved += 1;
    console.log(`  saved ${(Buffer.byteLength(html) / 1024).toFixed(0).padStart(5)} KB  ${url}`);
  }

  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  const total = Object.values(manifest).reduce((sum, e) => sum + e.bytes, 0);
  console.log(
    `\n${Object.keys(manifest).length} fixtures, ${(total / 1024 / 1024).toFixed(1)} MB total ` +
      `(${saved} new, ${skipped} cached, ${failed} failed)`
  );
  console.log(`  -> ${FIXTURE_DIR}`);

  if (Object.keys(manifest).length === 0) {
    console.error('\nNo fixtures captured. The leak hunt needs at least one real page.');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { FIXTURE_DIR, MANIFEST, keyFor };

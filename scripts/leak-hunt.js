'use strict';

// Reproduces the production retention locally, and bisects the extraction
// pipeline to say which stage holds the memory.
//
// THE MEASUREMENT PRODUCTION GAVE US. Over 180 requests on a live pod, heap
// grew from 43 MB to 245 MB. It did not track origins (`hosts` was flat at 18
// for the last 30 requests while heap rose 16 MB), it did not track bytes
// downloaded (+12.8 MB of downloads against +184 MB of heap), and external
// memory spiked with PDFs and came straight back. It tracked *successful
// extractions*, at roughly 2-3 MB each:
//
//   interval   new extractions   heap retained
//   60 -> 70         0              +1.0 MB
//   160 -> 170       1              +3.2 MB
//   120 -> 130       2              +2.4 MB
//   110 -> 120       6             +12.6 MB
//   90 -> 100        9             +30.2 MB
//
// The interval that extracted nothing retained nothing. That is the signal
// this script exists to reproduce off the pod.
//
// WHY --stage MATTERS MORE THAN THE TOTAL. Knowing "extraction leaks" does not
// name a fix. The stages below run progressively more of the pipeline over the
// same pages, so the first one that leaks is the one holding the memory:
//
//   parse        prepareMarkup + parseDocument         jsdom, and the shared
//                                                      DOMParser Window
//   readability  parse + isProbablyReaderable + parse  Readability's scoring
//   regex        prepareMarkup + regexExtract          string handling only
//   full         extractHtml, exactly as the service   (default)
//
// If `parse` leaks, the suspect is src/parseDocument.js — and specifically the
// one Window that lives for the life of the process, which was measured at
// 0.006 MB/page against a 3 KB synthetic fixture and has never been measured
// against a real one. `--parser fresh` builds a Window per page instead, the
// arrangement that change replaced, so the two can be compared directly rather
// than argued about.
//
// Usage:
//   node --expose-gc scripts/leak-hunt.js                       # 400 extractions, full
//   node --expose-gc scripts/leak-hunt.js --stage parse         # bisect
//   node --expose-gc scripts/leak-hunt.js --parser fresh        # A/B the shared Window
//   node --expose-gc scripts/leak-hunt.js --snapshot-at 150     # dump at 150 MB retained
//   node --expose-gc scripts/leak-hunt.js --n 1000 --fail-over 0.25

const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');

const { JSDOM } = require('jsdom');
const { Readability, isProbablyReaderable } = require('@mozilla/readability');

const { extractHtml } = require('../src/extractHtml');
const { prepareMarkup, parseDocument } = require('../src/parseDocument');
const { FIXTURE_DIR, MANIFEST } = require('./capture-fixtures');

function parseArgs(argv) {
  const args = {
    n: 400,
    stage: 'full',
    parser: 'shared',
    sampleEvery: 25,
    snapshotAt: null,
    failOver: null,
    snapshotDir: path.join(__dirname, '..', 'heapsnapshots'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--n') args.n = Number(value);
    else if (flag === '--stage') args.stage = value;
    else if (flag === '--parser') args.parser = value;
    else if (flag === '--sample-every') args.sampleEvery = Number(value);
    else if (flag === '--snapshot-at') args.snapshotAt = Number(value);
    else if (flag === '--fail-over') args.failOver = Number(value);
    else if (flag === '--snapshot-dir') args.snapshotDir = value;
  }
  return args;
}

function loadFixtures() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    return [];
  }
  const pages = [];
  for (const [key, meta] of Object.entries(manifest)) {
    const file = path.join(FIXTURE_DIR, `${key}.html`);
    if (!fs.existsSync(file)) continue;
    pages.push({ url: meta.url, html: fs.readFileSync(file, 'utf8') });
  }
  return pages;
}

// Each stage returns something derived from the page, which is then discarded.
// Returning a value matters: a stage whose result is never read is a stage V8
// may optimize away, and a benchmark of nothing measures nothing.
const STAGES = {
  parse(html, url, { parser }) {
    const { markup } = prepareMarkup(html);
    const doc =
      parser === 'fresh' ? new JSDOM(markup, { url }).window.document : parseDocument(markup, url);
    return doc.querySelectorAll('*').length;
  },

  readability(html, url, { parser }) {
    const { markup } = prepareMarkup(html);
    const doc =
      parser === 'fresh' ? new JSDOM(markup, { url }).window.document : parseDocument(markup, url);
    if (!isProbablyReaderable(doc)) return 0;
    const article = new Readability(doc).parse();
    return article ? article.textContent.length : 0;
  },

  regex(html) {
    const { markup } = prepareMarkup(html);
    return markup
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim().length;
  },

  full(html, url) {
    return extractHtml(html, url).content.length;
  },
};

// Two collections with a turn of the event loop between them. One gc() call is
// not enough to retire a backlog of detached contexts — the README documents a
// case where that alone made a non-leak read as 1.76 MB/page — so a sample that
// still shows growth after this has survived the strongest cheap test there is.
async function settle() {
  global.gc();
  await new Promise((resolve) => setImmediate(resolve));
  global.gc();
}

// Least-squares slope over the sample points, in MB per extraction. Preferred
// over (last - first) / n because one badly-timed sample near a heap expansion
// can dominate a two-point estimate.
function slope(samples) {
  const n = samples.length;
  if (n < 2) return 0;
  const meanX = samples.reduce((sum, s) => sum + s.done, 0) / n;
  const meanY = samples.reduce((sum, s) => sum + s.heapMB, 0) / n;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    num += (s.done - meanX) * (s.heapMB - meanY);
    den += (s.done - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function writeSnapshot(dir, label) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}-${Date.now()}.heapsnapshot`);
  v8.writeHeapSnapshot(file);
  const sizeMB = fs.statSync(file).size / 1024 / 1024;
  console.log(`\n  heap snapshot: ${file} (${sizeMB.toFixed(0)} MB)`);
  console.log('  Open it in Chrome DevTools -> Memory -> Load, then sort by Retained Size.');
  console.log('  The top entry holding one object per extraction is the leak.\n');
  return file;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!global.gc) {
    console.error('Run with --expose-gc:\n  node --expose-gc scripts/leak-hunt.js');
    process.exitCode = 1;
    return;
  }
  if (!STAGES[args.stage]) {
    console.error(`Unknown --stage ${args.stage}. One of: ${Object.keys(STAGES).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const pages = loadFixtures();
  if (pages.length === 0) {
    console.error(
      'No fixtures found. Capture real pages first:\n' +
        '  node scripts/capture-fixtures.js\n\n' +
        'The synthetic fixture in scripts/load-memory.js does not reproduce this — ' +
        'see the header of this file.'
    );
    process.exitCode = 1;
    return;
  }

  const totalKB = pages.reduce((sum, p) => sum + Buffer.byteLength(p.html), 0) / 1024;
  console.log(
    `${pages.length} fixtures, ${(totalKB / pages.length).toFixed(0)} KB average, ` +
      `stage=${args.stage}, parser=${args.parser}, n=${args.n}\n`
  );
  console.log('  done    heap MB   retained MB/extraction');

  const run = STAGES[args.stage];
  const samples = [];
  let snapshotWritten = false;

  await settle();
  const baseline = process.memoryUsage().heapUsed / 1024 / 1024;

  for (let i = 1; i <= args.n; i += 1) {
    const page = pages[i % pages.length];
    run(page.html, page.url, args);

    if (i % args.sampleEvery !== 0) continue;

    await settle();
    const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
    const retained = heapMB - baseline;
    samples.push({ done: i, heapMB });
    console.log(
      `${String(i).padStart(6)}  ${heapMB.toFixed(1).padStart(9)}   ${(retained / i)
        .toFixed(4)
        .padStart(10)}`
    );

    if (args.snapshotAt !== null && retained >= args.snapshotAt && !snapshotWritten) {
      writeSnapshot(args.snapshotDir, `${args.stage}-${args.parser}`);
      snapshotWritten = true;
    }
  }

  // Second half only. The first extractions pay one-off costs — V8 code
  // objects, Readability's regex caches, the shared Window — that are not
  // retention and would otherwise be amortized into the headline figure.
  const secondHalf = samples.slice(Math.floor(samples.length / 2));
  const perExtraction = slope(secondHalf);
  const finalRetained = samples.at(-1).heapMB - baseline;

  console.log(
    `\n  retained ${finalRetained.toFixed(1)} MB over ${args.n} extractions\n` +
      `  second-half slope: ${perExtraction.toFixed(4)} MB/extraction`
  );

  // Production measured 2-3 MB per successful extraction. Anything near that
  // here means the bug is reproduced and the next run can bisect it.
  if (perExtraction >= 0.5) {
    console.log(
      `\n  REPRODUCED. At this rate a pod with ~250 MB of headroom dies after ` +
        `~${Math.round(200 / perExtraction)} extractions.`
    );
    if (!snapshotWritten && args.snapshotAt === null) {
      console.log('  Re-run with --snapshot-at 100 to capture what is holding it.');
    }
  } else if (perExtraction < 0.05) {
    console.log('\n  Flat. This stage does not retain — bisect further with --stage.');
  }

  if (args.failOver !== null && perExtraction > args.failOver) {
    console.error(
      `\nFAIL: ${perExtraction.toFixed(4)} MB/extraction exceeds --fail-over ${args.failOver}`
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { STAGES, slope };

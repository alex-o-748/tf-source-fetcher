'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const unpdfPath = require.resolve('unpdf');
const extractorPath = require.resolve('../src/extractPdf');

function loadWithMock({ text = 'Useful PDF text', extractError, pending = false } = {}) {
  const calls = { cleanup: 0, destroy: 0 };
  let rejectExtraction;
  const pdf = {
    numPages: 3,
    getPage: async () => ({
      getTextContent: async () => {
        if (extractError) throw extractError;
        return { items: [{ str: text, hasEOL: false }] };
      },
    }),
    cleanup: async () => {
      calls.cleanup += 1;
    },
    loadingTask: {
      destroy: async () => {
        calls.destroy += 1;
        rejectExtraction?.(new Error('worker destroyed'));
      },
    },
  };

  require.cache[unpdfPath] = {
    id: unpdfPath,
    filename: unpdfPath,
    loaded: true,
    exports: {
      getDocumentProxy: async () => pdf,
      extractText: async () => {
        if (extractError) throw extractError;
        if (pending) {
          return new Promise((resolve, reject) => {
            rejectExtraction = reject;
          });
        }
        return { text };
      },
    },
  };
  delete require.cache[extractorPath];
  return { ...require('../src/extractPdf'), calls };
}

test.afterEach(() => {
  delete require.cache[extractorPath];
  delete require.cache[unpdfPath];
});

test('destroys PDF resources after successful extraction', async () => {
  const { extractPdf, calls } = loadWithMock();
  const result = await extractPdf(Buffer.from('pdf'));
  assert.equal(result.content, 'Useful PDF text');
  assert.deepEqual(calls, { cleanup: 1, destroy: 1 });
});

test('destroys PDF resources when extraction fails', async () => {
  const { extractPdf, calls } = loadWithMock({ extractError: new Error('bad font') });
  await assert.rejects(extractPdf(Buffer.from('pdf')), /bad font/);
  assert.deepEqual(calls, { cleanup: 1, destroy: 1 });
});

test('destroys PDF resources when page validation fails', async () => {
  const { extractPdf, InvalidPageError, calls } = loadWithMock();
  await assert.rejects(extractPdf(Buffer.from('pdf'), 99), InvalidPageError);
  assert.deepEqual(calls, { cleanup: 1, destroy: 1 });
});

test('destroys PDF resources after single-page extraction', async () => {
  const { extractPdf, calls } = loadWithMock({ text: 'Page two text' });
  const result = await extractPdf(Buffer.from('pdf'), 2);
  assert.equal(result.content, 'Page two text');
  assert.equal(result.page, 2);
  assert.deepEqual(calls, { cleanup: 1, destroy: 1 });
});

test('destroys PDF resources when single-page extraction fails', async () => {
  const { extractPdf, calls } = loadWithMock({ extractError: new Error('bad page') });
  await assert.rejects(extractPdf(Buffer.from('pdf'), 2), /bad page/);
  assert.deepEqual(calls, { cleanup: 1, destroy: 1 });
});

test('aborting extraction destroys its worker exactly once', async () => {
  const { extractPdf, calls } = loadWithMock({ pending: true });
  const controller = new AbortController();
  const extraction = extractPdf(Buffer.from('pdf'), null, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(extraction, /worker destroyed/);
  assert.deepEqual(calls, { cleanup: 1, destroy: 1 });
});


// The tests below run the real unpdf/PDF.js against a bundled three-page PDF
// (test/fixtures/three-pages.pdf). Each page has two lines: "Page N first line
// alphaN" and "Page N second line omegaN".
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_PDF = fs.readFileSync(path.join(__dirname, 'fixtures', 'three-pages.pdf'));

function loadReal() {
  delete require.cache[unpdfPath];
  delete require.cache[extractorPath];
  return require('../src/extractPdf');
}

test('page=2 returns only page 2 text (real PDF)', async () => {
  const { extractPdf } = loadReal();
  const result = await extractPdf(FIXTURE_PDF, '2');
  assert.equal(result.page, 2);
  assert.equal(result.totalPages, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.content, 'Page 2 first line alpha2 Page 2 second line omega2');
  assert.ok(!/alpha1|omega1|alpha3|omega3/.test(result.content));
});

test('no page param still returns the whole document (real PDF)', async () => {
  const { extractPdf } = loadReal();
  const result = await extractPdf(FIXTURE_PDF);
  assert.equal(result.page, null);
  assert.equal(result.totalPages, 3);
  for (const n of [1, 2, 3]) {
    assert.ok(result.content.includes(`Page ${n} first line alpha${n}`));
    assert.ok(result.content.includes(`Page ${n} second line omega${n}`));
  }
});

test('out-of-range page is still an InvalidPageError (real PDF)', async () => {
  const { extractPdf, InvalidPageError } = loadReal();
  await assert.rejects(extractPdf(FIXTURE_PDF, 4), (err) => {
    assert.ok(err instanceof InvalidPageError);
    assert.equal(err.totalPages, 3);
    return true;
  });
});

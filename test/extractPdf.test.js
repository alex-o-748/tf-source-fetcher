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

test('aborting extraction destroys its worker exactly once', async () => {
  const { extractPdf, calls } = loadWithMock({ pending: true });
  const controller = new AbortController();
  const extraction = extractPdf(Buffer.from('pdf'), null, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(extraction, /worker destroyed/);
  assert.deepEqual(calls, { cleanup: 1, destroy: 1 });
});


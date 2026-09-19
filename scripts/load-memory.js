'use strict';

// Repeatable extraction load test. Run with --expose-gc so each sample
// measures retained memory rather than ordinary garbage awaiting V8's next
// collection: `node --expose-gc scripts/load-memory.js 1000`.

const assert = require('node:assert/strict');
const { extractHtml } = require('../src/extractHtml');
const { extractPdf } = require('../src/extractPdf');

const requests = Number(process.argv[2] || 1000);
const sampleEvery = 50;
const html = `<html><head><title>Load fixture</title></head><body><article><h1>Load fixture</h1><p>${'Representative article content. '.repeat(100)}</p></article></body></html>`;

function makePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 93 >>\nstream\nBT /F1 12 Tf 72 720 Td (Representative PDF text for retained memory testing across requests.) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n `)
    .join('\n')}\ntrailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

function memoryRow(request, pdfs, baseline) {
  const usage = process.memoryUsage();
  const retained = usage.heapUsed - baseline;
  return {
    request,
    pdfs,
    rssMB: usage.rss / 1024 / 1024,
    heapUsedMB: usage.heapUsed / 1024 / 1024,
    heapTotalMB: usage.heapTotal / 1024 / 1024,
    externalMB: usage.external / 1024 / 1024,
    arrayBuffersMB: usage.arrayBuffers / 1024 / 1024,
    retainedMBPerRequest: retained / Math.max(1, request) / 1024 / 1024,
  };
}

async function main() {
  assert.ok(global.gc, 'run with: node --expose-gc scripts/load-memory.js [requests]');
  assert.ok(Number.isInteger(requests) && requests >= 500, 'request count must be at least 500');
  const pdf = makePdf();
  global.gc();
  const baseline = process.memoryUsage().heapUsed;
  const samples = [];
  let pdfs = 0;

  for (let request = 1; request <= requests; request += 1) {
    if (request % 5 === 0) {
      await extractPdf(pdf);
      pdfs += 1;
    } else {
      extractHtml(html, `https://fixture.invalid/article/${request}`);
    }
    if (request % sampleEvery === 0) {
      global.gc();
      await new Promise((resolve) => setImmediate(resolve));
      global.gc();
      const row = memoryRow(request, pdfs, baseline);
      samples.push(row);
      console.log(JSON.stringify(row));
    }
  }

  const midpoint = samples[Math.floor(samples.length / 2)];
  const last = samples.at(-1);
  const plateauSlope =
    (last.heapUsedMB - midpoint.heapUsedMB) / (last.request - midpoint.request);
  assert.ok(plateauSlope < 0.05, `heap did not plateau: ${plateauSlope.toFixed(3)} MB/request`);
  console.log(`PASS plateau slope ${plateauSlope.toFixed(3)} MB/request`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});


'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeHtml, guessLegacyCharset } = require('../src/charset');

// Node has no TextEncoder for legacy charsets; invert its decoder table.
function encode(text, label) {
  const decoder = new TextDecoder(label);
  const table = new Map();
  for (let b = 0; b < 256; b++) table.set(decoder.decode(Uint8Array.of(b)), b);
  return Buffer.from([...text].map((ch) => table.get(ch) ?? 0x3f));
}

const RU = 'Евреям, покинувшим Россию, было запрещено возвращаться обратно. ';
const FR = 'Le café de la rue est fermé depuis l’été dernier, après une décision municipale. ';
const page = (body, head = '') => `<html><head>${head}<title>t</title></head><body><p>${body.repeat(20)}</p></body></html>`;

test('the regression: Windows-1251 with a <meta> declaration and a bare Content-Type', () => {
  const bytes = encode(page(RU, '<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">'), 'windows-1251');
  // What buf.toString('utf8') used to return:
  assert.ok(bytes.toString('utf8').includes('�'));
  const { text, charset, source } = decodeHtml(bytes, 'text/html');
  assert.ok(text.includes(RU.trim()));
  assert.equal(charset, 'windows-1251');
  assert.equal(source, 'meta');
});

test('HTML5 <meta charset> is read', () => {
  const bytes = encode(page(RU, '<meta charset="koi8-r">'), 'koi8-r');
  assert.equal(decodeHtml(bytes, 'text/html').charset, 'koi8-r');
  assert.ok(decodeHtml(bytes, 'text/html').text.includes(RU.trim()));
});

test('the Content-Type header wins over <meta>', () => {
  const bytes = encode(page(RU, '<meta charset="koi8-r">'), 'windows-1251');
  const { charset, source } = decodeHtml(bytes, 'text/html; charset=windows-1251');
  assert.equal(charset, 'windows-1251');
  assert.equal(source, 'header');
});

test('a page wrongly declared UTF-8 is not believed', () => {
  const bytes = encode(page(RU), 'windows-1251');
  const { text, charset } = decodeHtml(bytes, 'text/html; charset=utf-8');
  assert.equal(charset, 'windows-1251');
  assert.ok(text.includes(RU.trim()));
});

test('ordinary UTF-8 pages are untouched', () => {
  const html = page(RU + FR, '<meta charset="utf-8">');
  const { text, charset } = decodeHtml(Buffer.from(html, 'utf8'), 'text/html; charset=UTF-8');
  assert.equal(text, html);
  assert.equal(charset, 'utf-8');
});

test('undeclared UTF-8 is detected as UTF-8', () => {
  const html = page(RU);
  assert.equal(decodeHtml(Buffer.from(html, 'utf8'), 'text/html').text, html);
});

test('a UTF-8 byte order mark decides, and is stripped', () => {
  const html = page(RU);
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html, 'utf8')]);
  const { text, source } = decodeHtml(bytes, 'text/html; charset=windows-1251');
  assert.equal(text, html);
  assert.equal(source, 'bom');
});

test('an unknown charset label falls through instead of throwing', () => {
  const bytes = encode(page(RU, '<meta charset="x-no-such-charset">'), 'windows-1251');
  const { text, source } = decodeHtml(bytes, 'text/html; charset=bogus');
  assert.equal(source, 'guess');
  assert.ok(text.includes(RU.trim()));
});

test('undeclared legacy pages: Cyrillic encodings vs Western European', () => {
  assert.equal(guessLegacyCharset(encode(page(RU), 'windows-1251')), 'windows-1251');
  assert.equal(guessLegacyCharset(encode(page(RU), 'koi8-r')), 'koi8-r');
  assert.equal(guessLegacyCharset(encode(page(FR), 'windows-1252')), 'windows-1252');
  const fr = decodeHtml(encode(page(FR), 'windows-1252'), 'text/html');
  assert.ok(fr.text.includes(FR.trim()));
});

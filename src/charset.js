'use strict';

// Turning a fetched HTML body (bytes) into text, in the page's own encoding.
//
// This used to be `buf.toString('utf8')`. Every page that isn't UTF-8 —
// Windows-1251 and KOI8-R are still common on older Russian sites, and the
// Wayback Machine serves 2000s-era snapshots in their original encoding —
// came back as a wall of U+FFFD replacement characters (72% of the text on
// the crjs.ru snapshot cited by ru:Еврейские беженцы, 82% on a lechaim.ru
// one), with a 200 and no error. The verifier then judged a claim against
// noise and reported a passage that is in the source verbatim as "not
// mentioned" (reported by a ruwiki editor, 2026-11-05).
//
// Resolution order follows the HTML spec's, with one deliberate deviation:
//   1. byte order mark
//   2. charset= in the Content-Type header
//   3. <meta charset> / <meta http-equiv="Content-Type"> in the first 4 KB
//   4. no declaration: UTF-8 if the bytes are valid UTF-8, else a guess
//      between Windows-1251, KOI8-R and Windows-1252 (guessLegacyCharset)
// The deviation: a page *declared* UTF-8 whose bytes are not valid UTF-8 is
// not believed. Russian servers misconfigured to send `charset=utf-8` for
// Windows-1251 files are common enough that trusting the label would leave
// those pages exactly as broken as before; the meta tag, then the guess,
// decide instead.

const PRESCAN_BYTES = 4096;

const META_CHARSET = /<meta\b[^>]*?charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i;
const HEADER_CHARSET = /charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i;

function isUtf8Label(label) {
  return /^(utf-?8|unicode-1-1-utf-8)$/i.test(label);
}

// A TextDecoder for `label`, or null if the runtime doesn't know it — an
// unknown or misspelled charset must fall through to the next source, not
// throw out of the fetch.
function decoderFor(label, fatal = false) {
  try {
    return new TextDecoder(label, { fatal });
  } catch {
    return null;
  }
}

function isValidUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function bomCharset(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

function headerCharset(contentType) {
  const m = HEADER_CHARSET.exec(contentType || '');
  return m ? m[1].toLowerCase() : null;
}

// The declaration lives in ASCII markup, so reading the head as Latin-1 finds
// it whatever the body's encoding is (one byte -> one char, nothing lost).
function metaCharset(bytes) {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, PRESCAN_BYTES)).toString('latin1');
  const m = META_CHARSET.exec(head);
  return m ? m[1].toLowerCase() : null;
}

// For an undeclared, non-UTF-8 page. Cyrillic text in a single-byte encoding
// is runs of high bytes (whole words), while Western European text has an
// isolated accented letter between ASCII ones — so the share of high bytes
// that sit next to another high byte separates the two cleanly. Between the
// two Cyrillic encodings: both put letters in 0xC0-0xFF, but Windows-1251 has
// lowercase in the upper half (0xE0-0xFF) and KOI8-R in the lower, and running
// text is mostly lowercase.
function guessLegacyCharset(bytes) {
  let high = 0;
  let paired = 0;
  let upperHalf = 0;
  let lowerHalf = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) continue;
    high++;
    if ((i > 0 && bytes[i - 1] >= 0x80) || (i + 1 < bytes.length && bytes[i + 1] >= 0x80)) paired++;
    if (b >= 0xe0) upperHalf++;
    else if (b >= 0xc0) lowerHalf++;
  }
  if (high === 0 || paired / high < 0.5) return 'windows-1252';
  return upperHalf >= lowerHalf ? 'windows-1251' : 'koi8-r';
}

/**
 * Decodes an HTML response body.
 * @param {Uint8Array|Buffer} bytes
 * @param {string} [contentType]  the response's Content-Type header
 * @returns {{ text: string, charset: string, source: 'bom'|'header'|'meta'|'utf8-valid'|'guess' }}
 */
function decodeHtml(bytes, contentType) {
  const bom = bomCharset(bytes);
  if (bom) return { text: new TextDecoder(bom).decode(bytes), charset: bom, source: 'bom' };

  const utf8Valid = isValidUtf8(bytes);
  const candidates = [
    [headerCharset(contentType), 'header'],
    [metaCharset(bytes), 'meta'],
  ];
  for (const [label, source] of candidates) {
    if (!label) continue;
    if (isUtf8Label(label)) {
      if (utf8Valid) return { text: new TextDecoder('utf-8').decode(bytes), charset: 'utf-8', source };
      continue; // declared UTF-8, isn't: see the header comment
    }
    const decoder = decoderFor(label);
    if (decoder) return { text: decoder.decode(bytes), charset: decoder.encoding, source };
  }

  if (utf8Valid) return { text: new TextDecoder('utf-8').decode(bytes), charset: 'utf-8', source: 'utf8-valid' };
  const guess = guessLegacyCharset(bytes);
  return { text: new TextDecoder(guess).decode(bytes), charset: guess, source: 'guess' };
}

module.exports = { decodeHtml, guessLegacyCharset };

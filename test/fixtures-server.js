'use strict';

// A local fixture "publisher" server used only for manual/e2e smoke testing
// against the source-fetcher service, since this dev sandbox has no general
// internet egress. Not part of the deployed service.

const http = require('http');
const fs = require('fs');

const PDF_FIXTURE = '/mnt/skills/examples/theme-factory/theme-showcase.pdf';

function longArticleHtml() {
  const para = 'This is a real sentence of article content about a notable topic. ';
  return `<!doctype html><html><head><title>Test Article</title></head><body>
<nav>Home | About | Contact</nav>
<header>Site Header</header>
<article><h1>A Notable Headline</h1><p>${para.repeat(80)}</p></article>
<footer>Copyright footer junk</footer>
</body></html>`;
}

// Encodes a string in a single-byte legacy charset, by inverting Node's own
// decoder table. Node has no TextEncoder for anything but UTF-8.
function encodeSingleByte(text, label) {
  const decoder = new TextDecoder(label);
  const table = new Map();
  for (let b = 0; b < 256; b++) table.set(decoder.decode(Uint8Array.of(b)), b);
  return Buffer.from([...text].map((ch) => table.get(ch) ?? 0x3f));
}

// A 2000s-era Russian page as the Wayback Machine's raw id_ endpoint serves
// it: Windows-1251 bytes, declared only by a <meta> tag, and a Content-Type
// header with no charset at all.
function cp1251ArticleHtml() {
  const para = 'Евреям, покинувшим Россию, было запрещено возвращаться обратно. ';
  return `<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251">
<title>От редактора</title></head><body><p>${para.repeat(40)}</p></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('User-agent: *\nDisallow: /blocked\n');
    return;
  }
  if (url.pathname === '/article') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(longArticleHtml());
    return;
  }
  if (url.pathname === '/cp1251-meta') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(encodeSingleByte(cp1251ArticleHtml(), 'windows-1251'));
    return;
  }
  if (url.pathname === '/short') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>Too short</body></html>');
    return;
  }
  if (url.pathname === '/forbidden') {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  if (url.pathname === '/notfound') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  if (url.pathname === '/ratelimited') {
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('Too many requests');
    return;
  }
  if (url.pathname === '/blocked') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(longArticleHtml());
    return;
  }
  if (url.pathname === '/slow') {
    // Never responds — used to test the fetch timeout path.
    return;
  }
  if (url.pathname === '/doc.pdf') {
    const buf = fs.readFileSync(PDF_FIXTURE);
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(buf);
    return;
  }

  res.writeHead(404);
  res.end('no fixture');
});

const port = process.env.FIXTURES_PORT || 0;
server.listen(port, () => {
  console.log(`fixtures server listening on ${server.address().port}`);
});

module.exports = server;

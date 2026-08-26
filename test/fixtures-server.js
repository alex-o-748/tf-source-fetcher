'use strict';

// A local fixture "publisher" server used only for manual/e2e smoke testing
// against the source-fetcher service, since this dev sandbox has no general
// internet egress. Not part of the deployed service.
//
// Instances also record what they were asked for and how much of it arrived
// at once, which is what the concurrency tests assert against — the only
// honest way to check "did we actually make one request" or "did we actually
// pace them" is from the publisher's side.

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

function createFixtureServer() {
  const stats = { hits: [], inFlight: 0, maxInFlight: 0 };

  function enter(pathname) {
    stats.hits.push({ path: pathname, at: Date.now() });
    stats.inFlight += 1;
    if (stats.inFlight > stats.maxInFlight) stats.maxInFlight = stats.inFlight;
  }

  function leave() {
    stats.inFlight -= 1;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /blocked\n');
      return;
    }

    enter(url.pathname);
    res.on('close', leave);

    if (url.pathname === '/article' || url.pathname === '/blocked') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(longArticleHtml());
      return;
    }
    // Same body as /article, but held open for `ms` first — used to check
    // that a host slot is occupied for the whole request, not just its start.
    if (url.pathname === '/hold') {
      const ms = Number(url.searchParams.get('ms')) || 300;
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(longArticleHtml());
      }, ms);
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
      const headers = { 'Content-Type': 'text/plain' };
      const retryAfter = url.searchParams.get('retryAfter');
      if (retryAfter) headers['Retry-After'] = retryAfter;
      res.writeHead(429, headers);
      res.end('Too many requests');
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

  server.stats = stats;
  server.reset = () => {
    stats.hits.length = 0;
    stats.maxInFlight = 0;
  };
  server.hitsFor = (pathname) => stats.hits.filter((h) => h.path === pathname);
  return server;
}

// The default instance, listening on FIXTURES_PORT. Extra instances (on other
// ports, so they count as distinct hosts to the per-host limiter) are created
// by tests via `createFixtureServer`.
const server = createFixtureServer();
server.listen(process.env.FIXTURES_PORT || 0, () => {
  console.log(`fixtures server listening on ${server.address().port}`);
});

module.exports = server;
module.exports.createFixtureServer = createFixtureServer;

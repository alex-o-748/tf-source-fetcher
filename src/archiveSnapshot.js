'use strict';

// Recognizes Wayback Machine URLs that pin one specific, already-captured
// snapshot — both the `id_` raw-content endpoint the citation-checker client
// constructs itself (`web.archive.org/web/<timestamp>id_/<url>`, see that
// repo's main.js findWaybackSnapshot) and the equivalent form without the
// `id_` suffix that a citation may link to directly. Either way, once the
// timestamp is fully specified, the content at that URL cannot change —
// Wayback does not edit or delete a capture in place — which makes it safe
// to cache far longer than an ordinary "fact about the world right now"
// response (see src/cachePolicy.js).
//
// Deliberately conservative about what counts as "fully specified": Wayback
// also serves ambiguous URLs like `/web/2025/<url>` ("closest capture to
// some date"), which is NOT pinned the way a full 14-digit YYYYMMDDhhmmss
// timestamp is — which capture that resolves to isn't fixed. Anything
// shorter than a full timestamp is left as ordinary, not-forever-cacheable
// content instead of risking treating a moving target as immutable.
const SNAPSHOT_PATH_PATTERN = /^\/web\/\d{14}(?:id_)?\//;

function isImmutableSnapshotUrl(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  if (parsed.hostname.toLowerCase() !== 'web.archive.org') return false;
  return SNAPSHOT_PATH_PATTERN.test(parsed.pathname);
}

module.exports = { isImmutableSnapshotUrl };

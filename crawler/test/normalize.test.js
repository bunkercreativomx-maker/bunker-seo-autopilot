import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, sameUrl, isSkipScheme, resolveHref, sameHost, pathDepth } from "../src/normalize.js";

test("normalize: strips fragment and default port", () => {
  assert.equal(normalizeUrl("https://example.com/page#section"), "https://example.com/page");
  assert.equal(normalizeUrl("https://example.com:443/x"), "https://example.com/x");
});

test("normalize: trailing slash on non-root", () => {
  assert.equal(normalizeUrl("https://example.com/page/"), "https://example.com/page");
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com/");
});

test("normalize: drops query when keepQuery=false", () => {
  assert.equal(normalizeUrl("https://example.com/p?x=1&y=2", { keepQuery: false }), "https://example.com/p");
  assert.equal(normalizeUrl("https://example.com/p?x=1&y=2", { keepQuery: true }), "https://example.com/p?x=1&y=2");
});

test("normalize: collapses duplicate slashes and dot segments", () => {
  assert.equal(normalizeUrl("https://example.com/a//b/./c"), "https://example.com/a/b/c");
  assert.equal(normalizeUrl("https://example.com/a/../b"), "https://example.com/b");
});

test("normalize: rejects non-http(s) schemes", () => {
  assert.equal(normalizeUrl("ftp://example.com/x"), null);
  assert.equal(normalizeUrl("mailto:a@b.com"), null);
  assert.equal(normalizeUrl("data:text/html,x"), null);
});

test("sameUrl: /page and /page#section and /page/ are the same", () => {
  assert.ok(sameUrl("https://example.com/page", "https://example.com/page/"));
  assert.ok(sameUrl("https://example.com/page", "https://example.com/page#section"));
  assert.ok(!sameUrl("https://example.com/page", "https://example.com/page?q=1", { ignoreQuery: false }));
});

test("isSkipScheme: filters non-crawlable link types", () => {
  assert.ok(isSkipScheme("mailto:x@y.com"));
  assert.ok(isSkipScheme("tel:+1555"));
  assert.ok(isSkipScheme("javascript:void(0)"));
  assert.ok(isSkipScheme("data:image/png;base64"));
  assert.ok(isSkipScheme("#anchor"));
  assert.ok(!isSkipScheme("https://example.com/a"));
  assert.ok(!isSkipScheme("/relative"));
});

test("resolveHref: resolves relative against base", () => {
  assert.equal(resolveHref("https://example.com/a/", "../b"), "https://example.com/b");
  assert.equal(resolveHref("https://example.com/a/", "b"), "https://example.com/a/b");
});

test("sameHost: ignores www and matches host", () => {
  assert.ok(sameHost("https://example.com/", "https://www.example.com/x"));
  assert.ok(!sameHost("https://example.com/", "https://evil.com/"));
});

test("pathDepth: homepage is 1, deep pages count segments", () => {
  assert.equal(pathDepth("https://example.com/"), 1);
  assert.equal(pathDepth("https://example.com/a/b/c"), 3);
});
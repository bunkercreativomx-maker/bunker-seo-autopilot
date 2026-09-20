import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSitemapXml } from "../src/sitemap.js";

test("sitemap: parses a urlset", () => {
  const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/about</loc></url>
  <url><loc>https://example.com/contact#form</loc></url>
</urlset>`;
  const { urls, children } = parseSitemapXml(xml);
  assert.equal(urls.length, 3);
  assert.ok(urls.includes("https://example.com/"));
  assert.ok(urls.includes("https://example.com/about"));
  assert.equal(children.length, 0);
});

test("sitemap: parses a sitemap index into children", () => {
  const xml = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
</sitemapindex>`;
  const { urls, children } = parseSitemapXml(xml);
  assert.equal(urls.length, 0);
  assert.equal(children.length, 2);
  assert.ok(children.includes("https://example.com/sitemap-1.xml"));
});

test("sitemap: handles malformed XML without throwing", () => {
  const bad = "<urlset><url><loc>https://example.com/a</loc></url><url><loc";
  const { urls } = parseSitemapXml(bad);
  assert.ok(Array.isArray(urls));
});

test("sitemap: ignores invalid URLs and negative -nonsense", () => {
  const xml = `<urlset>
    <url><loc>not a url</loc></url>
    <url><loc>ftp://example.com/x</loc></url>
    <url><loc>https://example.com/ok</loc></url>
  </urlset>`;
  const { urls } = parseSitemapXml(xml);
  assert.deepEqual(urls, ["https://example.com/ok"]);
});
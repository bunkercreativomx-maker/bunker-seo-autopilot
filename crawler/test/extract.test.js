import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSeo, determineIndexable } from "../src/extract.js";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Home - Acme Co</title>
  <meta name="description" content="Acme Co makes the best widgets.">
  <link rel="canonical" href="https://acme.com/">
  <meta name="robots" content="index,follow">
  <meta property="og:title" content="Acme Co">
  <script type="application/ld+json">{"@type":"LocalBusiness","name":"Acme Co"}</script>
</head>
<body>
  <h1>Welcome to Acme</h1>
  <h2>Our products</h2>
  <h3>Widgets</h3>
  <p>Acme Co makes widgets. This is a long sentence about widgets. Real content here.</p>
  <a href="/about">About us</a>
  <a href="https://external.com/partner">Partner</a>
  <img src="/img/w1.jpg" alt="A widget">
  <img src="/img/w2.jpg">
</body>
</html>`;

test("extractSeo: title, meta, canonical, robots", () => {
  const s = extractSeo(HTML, "https://acme.com/");
  assert.equal(s.title, "Home - Acme Co");
  assert.equal(s.meta_description, "Acme Co makes the best widgets.");
  assert.equal(s.canonical_url, "https://acme.com/");
  assert.deepEqual(s.robots_directives, ["index", "follow"]);
});

test("extractSeo: headings, schema, links, images, word count", () => {
  const s = extractSeo(HTML, "https://acme.com/");
  assert.equal(s.h1_count, 1);
  assert.equal(s.h1, "Welcome to Acme");
  assert.equal(s.headings.h2.length, 1);
  assert.deepEqual(s.schema_types, ["LocalBusiness"]);
  assert.equal(s.internal_links_count, 1);
  assert.equal(s.external_links_count, 1);
  assert.equal(s.images_count, 2);
  assert.equal(s.images_missing_alt, 1);
  assert.equal(s.language, "en");
  assert.ok(s.word_count > 10);
});

test("extractSeo: missing title and h1 detected as empty", () => {
  const s = extractSeo("<html><body><p>hi</p></body></html>", "https://x.com/");
  assert.equal(s.title, "");
  assert.equal(s.h1_count, 0);
  assert.equal(s.meta_description, "");
});

test("determineIndexable: status + robots + canonical", () => {
  assert.equal(determineIndexable({ statusCode: 404, metaRobots: "" }).indexable, false);
  assert.equal(determineIndexable({ statusCode: 200, metaRobots: "noindex", xRobots: "" }).indexable, false);
  assert.equal(determineIndexable({ statusCode: 200, metaRobots: "noindex", xRobots: "" }).reason, "Noindex");
  assert.equal(determineIndexable({ statusCode: 200, metaRobots: "", xRobots: "" }).indexable, true);
  assert.equal(determineIndexable({ statusCode: 301, metaRobots: "" }).indexable, false);
});
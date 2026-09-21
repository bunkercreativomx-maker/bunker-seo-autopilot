import { test } from "node:test";
import assert from "node:assert/strict";
import { pageIssues, crossPageIssues } from "../src/issues.js";

function page(overrides = {}) {
  return {
    title: "", title_length: 0, meta_description: "", meta_description_length: 0,
    canonical_url: "", h1_count: 0, h1: "", word_count: 300, images_count: 0,
    images_missing_alt: 0, invalid_schema: false, schema_types: [], indexable: true,
    indexability_reason: "Indexable", robots_directives: [], isHtml: true, html: " ",
    ...overrides,
  };
}

test("pageIssues: missing title detected", () => {
  const issues = pageIssues(page({ title: "", status_code: 200 }), { statusCode: 200 });
  assert.ok(issues.some((i) => i.issue_type === "missing_title"));
});

test("pageIssues: 404 detected as high", () => {
  const issues = pageIssues(page({ status_code: 404 }), { statusCode: 404 });
  assert.ok(issues.some((i) => i.issue_type === "page_404" && i.severity === "high"));
});

test("pageIssues: server error critical", () => {
  const issues = pageIssues(page({ status_code: 500 }), { statusCode: 500 });
  assert.ok(issues.some((i) => i.issue_type === "server_error" && i.severity === "critical"));
});

test("pageIssues: missing meta, missing H1, thin content", () => {
  const issues = pageIssues(page({ word_count: 80 }), { statusCode: 200 });
  assert.ok(issues.some((i) => i.issue_type === "missing_meta_description"));
  assert.ok(issues.some((i) => i.issue_type === "missing_h1"));
  assert.ok(issues.some((i) => i.issue_type === "very_thin_content"));
});

test("pageIssues: all images missing alt", () => {
  const issues = pageIssues(page({ images_count: 3, images_missing_alt: 3 }), { statusCode: 200 });
  assert.ok(issues.some((i) => i.issue_type === "missing_alt" && i.severity === "medium"));
});

test("pageIssues: noindex page flagged", () => {
  const issues = pageIssues(page({ indexable: false, indexability_reason: "Noindex" }), { statusCode: 200 });
  assert.ok(issues.some((i) => i.issue_type === "noindex_page"));
});

test("pageIssues: redirect chain flagged low", () => {
  const p = page({ status_code: 200 });
  const issues = pageIssues(p, { statusCode: 200, redirects: [1, 2, 3] });
  assert.ok(issues.some((i) => i.issue_type === "redirect_chain"));
});

test("crossPageIssues: duplicate titles detected across pages", () => {
  const result = crossPageIssues({
    pages: [
      { id: "a", url: "https://x.com/a", title: "Same", meta_description: "m1" },
      { id: "b", url: "https://x.com/b", title: "Same", meta_description: "m1" },
    ],
    links: [], sitemapUrls: [], siteDomain: "https://x.com",
  });
  assert.ok(result.some((i) => i.issue_type === "duplicate_title"));
  assert.ok(result.some((i) => i.issue_type === "duplicate_meta_description"));
});

test("crossPageIssues: broken internal link", () => {
  const result = crossPageIssues({
    pages: [],
    links: [{ link_type: "internal", destination_url: "https://x.com/gone", status_code: 404, source_url: "https://x.com/a", anchor_text: "gone" }],
    sitemapUrls: [], siteDomain: "https://x.com",
  });
  assert.ok(result.some((i) => i.issue_type === "broken_internal_link"));
});

test("crossPageIssues: orphan detection", () => {
  const result = crossPageIssues({
    pages: [{ id: "h", url: "https://x.com/", status_code: 200, isHtml: true }],
    links: [],
    sitemapUrls: ["https://x.com/", "https://x.com/lonely"],
    siteDomain: "https://x.com",
  });
  assert.ok(result.some((i) => i.issue_type === "potential_orphan_page"));
});
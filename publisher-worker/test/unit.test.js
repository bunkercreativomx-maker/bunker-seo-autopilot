import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, verify, memoryNonceStore, HEADERS } from "../src/signing.js";
import { encrypt, decrypt, secretsOf } from "../src/secrets.js";
import { checkDestination, PublishError } from "../src/net.js";
import { markdownToSafeHtml, jsonLdString, sanitizeSchema, snapshotHash, stableStringify, publicPayload, canonicalFor } from "../src/content.js";
import { lockedSnapshot } from "../src/engine.js";

const SECRET = "s3cret-for-tests-0123456789";
const body = JSON.stringify({ operation: "publish", website_id: "abc" });

test("valid HMAC signature verifies", async () => {
  const h = sign(SECRET, body);
  assert.deepEqual(await verify({ secrets: [SECRET], body, headers: h, nonceStore: memoryNonceStore() }), { ok: true });
});

test("invalid signature is rejected", async () => {
  const h = sign(SECRET, body);
  h[HEADERS.signature] = "v1=" + "0".repeat(64);
  assert.equal((await verify({ secrets: [SECRET], body, headers: h, nonceStore: memoryNonceStore() })).code, "SIGNATURE_INVALID");
});

test("tampered body is rejected", async () => {
  const h = sign(SECRET, body);
  assert.equal((await verify({ secrets: [SECRET], body: body.replace("abc", "xyz"), headers: h, nonceStore: memoryNonceStore() })).code, "SIGNATURE_INVALID");
});

test("wrong website secret is rejected", async () => {
  const h = sign("another-website-secret-xyz", body);
  assert.equal((await verify({ secrets: [SECRET], body, headers: h, nonceStore: memoryNonceStore() })).code, "SIGNATURE_INVALID");
});

test("expired signature is rejected", async () => {
  const h = sign(SECRET, body, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal((await verify({ secrets: [SECRET], body, headers: h, nonceStore: memoryNonceStore() })).code, "SIGNATURE_EXPIRED");
});

test("replayed request (same nonce) is rejected", async () => {
  const store = memoryNonceStore();
  const h = sign(SECRET, body);
  assert.equal((await verify({ secrets: [SECRET], body, headers: h, nonceStore: store })).ok, true);
  assert.equal((await verify({ secrets: [SECRET], body, headers: h, nonceStore: store })).code, "REPLAY");
});

test("missing signature headers are rejected", async () => {
  assert.equal((await verify({ secrets: [SECRET], body, headers: {}, nonceStore: memoryNonceStore() })).code, "SIGNATURE_MISSING");
});

test("secret rotation: previous secret accepted only inside grace window", async () => {
  const key = "k".repeat(32);
  const integ = { secret_encrypted: encrypt("new-secret-aaaaaaaaaaaa", key), previous_secret_encrypted: encrypt("old-secret-bbbbbbbbbbbb", key), previous_secret_valid_until: new Date(Date.now() + 3600e3).toISOString() };
  assert.deepEqual(secretsOf(integ, key), ["new-secret-aaaaaaaaaaaa", "old-secret-bbbbbbbbbbbb"]);
  integ.previous_secret_valid_until = new Date(Date.now() - 1000).toISOString();
  assert.deepEqual(secretsOf(integ, key), ["new-secret-aaaaaaaaaaaa"]);
});

test("AES-GCM round trip and tamper detection", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const c = encrypt("hello-secret", key);
  assert.equal(decrypt(c, key), "hello-secret");
  const buf = Buffer.from(c, "base64"); buf[14] ^= 1;
  assert.throws(() => decrypt(buf.toString("base64"), key));
});

test("SSRF: private, loopback, metadata and non-allowlisted targets are blocked", async () => {
  const env = {};
  await assert.rejects(checkDestination("https://127.0.0.1/x", ["127.0.0.1"], env), (e) => e.code === "SSRF_BLOCKED");
  await assert.rejects(checkDestination("https://169.254.169.254/latest", ["169.254.169.254"], env), (e) => e.code === "SSRF_BLOCKED");
  await assert.rejects(checkDestination("https://10.0.0.5/", ["10.0.0.5"], env), (e) => e.code === "SSRF_BLOCKED");
  await assert.rejects(checkDestination("https://localhost/", ["localhost"], env), (e) => e.code === "SSRF_BLOCKED");
  await assert.rejects(checkDestination("https://evil.example.com/", ["good.example.com"], env), (e) => e.code === "DOMAIN_NOT_ALLOWED");
  await assert.rejects(checkDestination("http://good.example.com/", ["good.example.com"], env), (e) => e.code === "INVALID_TARGET");
  await assert.rejects(checkDestination("https://user:pw@good.example.com/", ["good.example.com"], env), (e) => e.code === "INVALID_TARGET");
  await assert.rejects(checkDestination("https://127.0.0.1:3399/", ["127.0.0.1"], { BSA_PUBLISH_PRIVATE_ALLOWLIST: "127.0.0.1:4000" }), (e) => e.code === "SSRF_BLOCKED");
  const ok = await checkDestination("http://127.0.0.1:3399/x", ["127.0.0.1"], { BSA_PUBLISH_PRIVATE_ALLOWLIST: "127.0.0.1:3399" });
  assert.equal(ok.port, "3399");
});

test("unsafe HTML is escaped; javascript: links are dropped", () => {
  const html = markdownToSafeHtml('# T\n\n<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) [ok](https://a.example/x) [p](//evil.example)\n\n<iframe src="https://evil"></iframe>');
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.ok(!/<iframe/i.test(html));
  assert.ok(!/href="javascript/i.test(html));
  assert.ok(!/href="\/\/evil/i.test(html));
  assert.ok(html.includes('href="https://a.example/x"'));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("JSON-LD cannot close the script element", () => {
  const s = jsonLdString({ "@type": "Article", headline: "</script><script>alert(1)</script>" });
  assert.ok(!s.includes("</script>"));
  assert.ok(!s.includes("<"));
  assert.equal(JSON.parse(s).headline, "</script><script>alert(1)</script>");
});

test("schema sanitizer drops internal keys and functions", () => {
  const s = sanitizeSchema({ "@type": "Article", claims: [1], research: "x", qa: 1, _id: 2, headline: "ok", f: () => 1 });
  assert.deepEqual(s, { "@type": "Article", headline: "ok", f: null });
});

test("public payload contains only public fields", () => {
  const snap = { version: 3, title: "T", slug: "t", seo_title: "", meta_description: "d", excerpt: "e", content: "c", og_title: "", og_description: "", canonical_url: "https://evil.example/x", featured_image: "javascript:x", structured_data: null, language: "es", content_type: "blog_article" };
  const website = { base_url: "https://site.example", blog_path: "/blog", allowed_domains: ["site.example"], publishing_configuration: {} };
  const p = publicPayload(snap, website, { url: "https://site.example/blog/t", publishedAt: "a", updatedAt: "b", hash: "f".repeat(64) });
  assert.deepEqual(Object.keys(p).sort(), ["author_public_name", "canonical_url", "category", "content", "content_format", "content_type", "excerpt", "featured_image", "language", "meta_description", "og_description", "og_title", "published_at", "revision", "schema", "seo_title", "slug", "tags", "title", "updated_at"]);
  assert.equal(p.canonical_url, "https://site.example/blog/t", "foreign canonical replaced by real URL");
  assert.equal(p.featured_image, "", "no fake/unsafe image");
  assert.equal(canonicalFor({ canonical_url: "https://site.example/c" }, website, "u"), "https://site.example/c");
});

test("stable hash is key-order independent", () => {
  assert.equal(stableStringify({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
  assert.equal(snapshotHash({ a: 1, b: 2 }), snapshotHash({ b: 2, a: 1 }));
});

test("version lock: changed content after approval requires re-approval", () => {
  const snapshot = { version: 2, title: "T", slug: "t", seo_title: "", meta_description: "", excerpt: "", content: "c", og_title: "", og_description: "", canonical_url: "", featured_image: "", structured_data: null, language: "es", content_type: "blog_article" };
  const hash = snapshotHash(snapshot);
  const article = { ...snapshot, current_version: 2, status: "approved", approved_by: "u", approved_at: "x", approved_snapshot: snapshot, approved_hash: hash, approved_version: 2, fact_check_status: "passed" };
  const job = { operation: "publish", version_hash: hash, article_version: 2 };
  assert.deepEqual(lockedSnapshot(job, article), snapshot);
  assert.throws(() => lockedSnapshot(job, { ...article, content: "edited" }), (e) => e.code === "REAPPROVAL_REQUIRED");
  assert.throws(() => lockedSnapshot(job, { ...article, current_version: 3 }), (e) => e.code === "REAPPROVAL_REQUIRED");
  assert.throws(() => lockedSnapshot({ ...job, version_hash: "x" }, article), (e) => e.code === "REAPPROVAL_REQUIRED");
  assert.throws(() => lockedSnapshot(job, { ...article, status: "draft" }), (e) => e.code === "NOT_APPROVED");
  assert.throws(() => lockedSnapshot(job, { ...article, approved_by: "" }), (e) => e.code === "NOT_APPROVED");
  assert.throws(() => lockedSnapshot(job, { ...article, high_risk: true }), (e) => e.code === "HIGH_RISK_REVIEW_REQUIRED");
  assert.throws(() => lockedSnapshot(job, { ...article, approved_snapshot: { ...snapshot, content: "tampered" } }), (e) => e.code === "INTEGRITY");
});

test("PublishError carries safe code", () => {
  const e = new PublishError("X", "m", { retryable: true });
  assert.equal(e.code, "X"); assert.equal(e.retryable, true);
});

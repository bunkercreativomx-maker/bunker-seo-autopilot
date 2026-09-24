import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLocalTarget } from "./lib/local-only.mjs";

test("fixture guard refuses production hostnames and port", () => {
  assert.equal(checkLocalTarget("https://seo-pb.bunkeragent.cloud").ok, false);
  assert.equal(checkLocalTarget("http://127.0.0.1:8096").ok, false);
  assert.equal(checkLocalTarget("http://localhost:8096").ok, false);
  assert.equal(checkLocalTarget("http://172.67.207.95:8090").ok, false);
  assert.equal(checkLocalTarget("not a url").ok, false);
});

test("fixture guard accepts ephemeral loopback PocketBase", () => {
  assert.equal(checkLocalTarget("http://127.0.0.1:8097").ok, true);
  assert.equal(checkLocalTarget("http://localhost:8095").ok, true);
});

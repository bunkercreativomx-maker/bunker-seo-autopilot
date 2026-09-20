import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicIp, validateHost } from "../src/ssrf.js";

test("isPublicIp: blocks all private/special IPv4", () => {
  assert.ok(!isPublicIp("10.0.0.1", 4));
  assert.ok(!isPublicIp("127.0.0.1", 4));
  assert.ok(!isPublicIp("169.254.169.254", 4));
  assert.ok(!isPublicIp("192.168.1.5", 4));
  assert.ok(!isPublicIp("172.16.0.1", 4));
  assert.ok(!isPublicIp("100.64.0.1", 4)); // CGNAT
});

test("isPublicIp: allows public IPv4", () => {
  assert.ok(isPublicIp("8.8.8.8", 4));
  assert.ok(isPublicIp("104.21.60.5", 4));
  assert.ok(isPublicIp("73.9.0.5", 4));
});

test("isPublicIp: blocks IPv6 loopback and ULA", () => {
  assert.ok(!isPublicIp("::1", 6));
  assert.ok(!isPublicIp("fe80::1", 6));
  assert.ok(!isPublicIp("fc00::1", 6));
});

test("validateHost: localhost resolves to private -> blocked", async () => {
  const r = await validateHost("localhost");
  assert.equal(r.safe, false);
});

test("validateHost: public host passes", async () => {
  const r = await validateHost("example.com");
  assert.equal(r.safe, true);
});

test("validateHost: hostname with private record is blocked (fail closed)", async () => {
  const r = await validateHost("169.254.169.254.nip.io");
  // nip.io resolves to the literal ip -> blocked
  assert.equal(r.safe, false);
});
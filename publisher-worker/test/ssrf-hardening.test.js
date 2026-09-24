import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { isPublicIp } from "../src/ssrf.js";
import { safeLookup, checkDestination, request } from "../src/net.js";

const BLOCKED = [
  ["127.0.0.1", 4], ["10.1.2.3", 4], ["172.16.5.5", 4], ["192.168.1.254", 4], ["100.64.0.1", 4], ["0.0.0.0", 4],
  ["169.254.169.254", 4], // cloud metadata
  ["::1", 6], ["::", 6], ["fd00::1", 6], ["fd00:ec2::254", 6], ["fe80::1", 6], ["ff02::1", 6], ["2001:db8::1", 6],
  // IPv4 embedded in IPv6 must not bypass the IPv4 ranges
  ["::ffff:127.0.0.1", 6], ["::ffff:169.254.169.254", 6], ["::ffff:7f00:1", 6], ["::ffff:a9fe:a9fe", 6], ["::127.0.0.1", 6],
  ["2002:7f00:1::1", 6], ["2002:a9fe:a9fe::1", 6], ["64:ff9b::a9fe:a9fe", 6], ["2001:0:4136:e378::1", 6],
  ["1.2.3", 4], ["999.1.1.1", 4],
];
const ALLOWED = [["172.67.207.95", 4], ["104.21.61.75", 4], ["8.8.8.8", 4], ["::ffff:8.8.8.8", 6], ["2606:4700:3033::6815:3d4b", 6], ["2002:0808:0808::1", 6], ["2606::1", 6]];

test("SSRF: private, loopback, link-local, metadata and IPv6 local/embedded forms are blocked", () => {
  for (const [ip, f] of BLOCKED) assert.equal(isPublicIp(ip, f), false, `${ip} must be blocked`);
});

test("SSRF: public IPv4/IPv6 addresses are allowed", () => {
  for (const [ip, f] of ALLOWED) assert.equal(isPublicIp(ip, f), true, `${ip} must be allowed`);
});

test("SSRF: connect-time lookup rejects a hostname that resolves (or rebinds) to a private address", async (t) => {
  const answers = [[{ address: "172.67.207.95", family: 4 }], [{ address: "169.254.169.254", family: 4 }], [{ address: "172.67.207.95", family: 4 }, { address: "10.0.0.5", family: 4 }]];
  let i = 0;
  t.mock.method(dns, "lookup", (host, opts, cb) => cb(null, answers[i++]));
  const call = () => new Promise((resolve) => safeLookup("staging.example.com", { all: true }, (err, res) => resolve({ err, res })));
  const ok = await call();
  assert.equal(ok.err, null);
  assert.equal(ok.res[0].address, "172.67.207.95");
  const rebind = await call();
  assert.equal(rebind.err?.code, "SSRF_BLOCKED");
  const mixed = await call();
  assert.equal(mixed.err?.code, "SSRF_BLOCKED", "any private address in the answer set blocks the connection");
});

test("SSRF: DNS failure fails closed with DNS_FAILED", async (t) => {
  t.mock.method(dns, "lookup", (host, opts, cb) => cb(Object.assign(new Error("nx"), { code: "ENOTFOUND" })));
  const r = await new Promise((resolve) => safeLookup("nx.example.com", { all: true }, (err) => resolve(err)));
  assert.equal(r.code, "DNS_FAILED");
});

test("SSRF: hostname allowlist is enforced before any DNS lookup; http and credentials refused", async () => {
  await assert.rejects(checkDestination("https://evil.example.net/x", ["seo-staging.bunkeragent.cloud"], {}), { code: "DOMAIN_NOT_ALLOWED" });
  await assert.rejects(checkDestination("http://seo-staging.bunkeragent.cloud/x", ["seo-staging.bunkeragent.cloud"], {}), { code: "INVALID_TARGET" });
  await assert.rejects(checkDestination("https://u:p@seo-staging.bunkeragent.cloud/x", ["seo-staging.bunkeragent.cloud"], {}), { code: "INVALID_TARGET" });
});

test("SSRF: allowlisted hostname resolving to a private IP is refused (pre-flight)", async (t) => {
  t.mock.method(dns.promises, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(request("https://internal-rebind.example.org/", { allowedDomains: ["internal-rebind.example.org"], env: {} }), (e) => ["SSRF_BLOCKED", "DNS_FAILED"].includes(e.code));
});

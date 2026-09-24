// SSRF protection — validates that a URL resolves to a public, non-blocked IP
// BEFORE fetching and on every redirect hop. Critical: the worker is server-side,
// so a malicious website URL or redirect must never reach internal infra.
import dns from "node:dns/promises";

// IPv4 and IPv6 private/special ranges that must never be connected to.
const FORBIDDEN = [
  // IPv4
  { fam: 4, net: "0.0.0.0", bits: 8 },          // this network
  { fam: 4, net: "10.0.0.0", bits: 8 },         // private
  { fam: 4, net: "100.64.0.0", bits: 10 },      // CGNAT (shared address space)
  { fam: 4, net: "127.0.0.0", bits: 8 },        // loopback
  { fam: 4, net: "169.254.0.0", bits: 16 },     // link-local (incl. metadata 169.254.169.254)
  { fam: 4, net: "172.16.0.0", bits: 12 },      // private
  { fam: 4, net: "192.168.0.0", bits: 16 },     // private
  { fam: 4, net: "192.0.0.0", bits: 24 },       // IETF protocol assignments
  { fam: 4, net: "192.0.2.0", bits: 24 },       // TEST-NET-1
  { fam: 4, net: "198.18.0.0", bits: 15 },      // benchmarking
  { fam: 4, net: "198.51.100.0", bits: 24 },    // TEST-NET-2
  { fam: 4, net: "203.0.113.0", bits: 24 },     // TEST-NET-3
  { fam: 4, net: "224.0.0.0", bits: 4 },        // multicast
  { fam: 4, net: "240.0.0.0", bits: 4 },        // reserved
  { fam: 4, net: "255.255.255.255", bits: 32 }, // broadcast
  // IPv6
  { fam: 6, net: "::", bits: 128 },             // unspecified
  { fam: 6, net: "::1", bits: 128 },            // loopback
  { fam: 6, net: "fc00::", bits: 7 },           // unique local (ULA)
  { fam: 6, net: "fe80::", bits: 10 },          // link-local
  { fam: 6, net: "ff00::", bits: 8 },           // multicast
  { fam: 6, net: "2001:db8::", bits: 32 },      // documentation
  { fam: 6, net: "64:ff9b::", bits: 96 },       // NAT64 well-known prefix
];

let ipNetCache = new Map();
await buildIpNets();

async function buildIpNets() {
  const net = await import("node:net");
  for (const f of FORBIDDEN) {
    ipNetCache.set(f.net, { net: net.isIP(f.net) === 4 ? ipv4ToInt(f.net) : ipv6ToBigInt(f.net), bits: f.bits, fam: f.fam });
  }
}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, o) => (acc << 8) | parseInt(o, 10), 0) >>> 0;
}
function ipv6ToBigInt(ip) {
  // Proper :: expansion (the head/tail groups are counted, not the colons).
  const str = String(ip).toLowerCase();
  let groups;
  if (str.includes("::")) {
    const [l, r] = str.split("::");
    const left = l ? l.split(":") : [];
    const right = r ? r.split(":") : [];
    groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  } else groups = str.split(":");
  if (groups.length !== 8) return -1n; // malformed -> never matches; callers reject
  let big = 0n;
  for (const p of groups) big = (big << 16n) | BigInt(parseInt(p || "0", 16) || 0);
  return big;
}

function inRange(fam, value) {
  for (const f of FORBIDDEN) {
    const c = ipNetCache.get(f.net);
    if (!c) continue;
    if (c.fam !== fam) continue;
    // mask check
    const mask = fam === 4 ? (0xffffffff << (32 - c.bits)) >>> 0 : (((1n << 128n) - 1n) ^ ((1n << BigInt(128 - c.bits)) - 1n));
    const masked = fam === 4 ? (value & mask) >>> 0 : value & mask;
    if (fam === 4) {
      if (masked === (c.net & mask) >>> 0) return true;
    } else {
      if (masked === (c.net & mask)) return true;
    }
  }
  return false;
}

/**
 * Check a single IP+family (the numeric form, already parsed).
 * Returns true if SAFE (public, not blocked).
 */
function v4Ok(str) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(str) || str.split(".").some((o) => Number(o) > 255)) return false;
  return !inRange(4, ipv4ToInt(str));
}
const intToV4 = (n) => [24, 16, 8, 0].map((b) => (n >>> b) & 255).join(".");

/**
 * Check a single resolved IP. Returns true only if SAFE (public, not blocked).
 * IPv6 forms that embed an IPv4 address (IPv4-mapped ::ffff:a.b.c.d or hex,
 * IPv4-compatible ::a.b.c.d, 6to4 2002::/16, NAT64) are unwrapped and the
 * embedded IPv4 is checked too, so ::ffff:127.0.0.1 / ::ffff:169.254.169.254
 * cannot bypass the private/metadata ranges. Teredo (2001::/32) is refused.
 */
export function isPublicIp(address, family) {
  const fam = family === 6 || String(address).includes(":") ? 6 : 4;
  if (fam === 4) return v4Ok(String(address));
  let a = String(address).toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (dotted) {
    if (dotted[2].split(".").some((x) => Number(x) > 255)) return false;
    const n = ipv4ToInt(dotted[2]);
    a = dotted[1] + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  if (!/^[0-9a-f:]+$/.test(a) || (a.match(/::/g) || []).length > 1) return false;
  const value = ipv6ToBigInt(a);
  if (value < 0n) return false;
  if (inRange(6, value)) return false;
  const high96 = value >> 32n;
  const low32 = Number(value & 0xffffffffn);
  if (high96 === 0xffffn) return v4Ok(intToV4(low32));        // IPv4-mapped
  if (high96 === 0n) return false;                             // ::, ::1, IPv4-compatible (deprecated)
  if (value >> 112n === 0x2002n) return v4Ok(intToV4(Number((value >> 80n) & 0xffffffffn))); // 6to4
  if (value >> 96n === 0x20010000n) return false;              // Teredo
  return true;
}

// DNS cache keyed by hostname -> { safe, addresses, reason, expiresAt }.
const dnsCache = new Map();
const DNS_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Resolve a hostname to every address and return { safe: bool, addresses: [...] }.
 * Considers the URL SAFE only if at least one address is public AND none are private.
 * (Async DNS, cached to avoid a resolver round-trip per page/redirect.)
 */
export async function validateHost(hostname) {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return { safe: cached.safe, addresses: cached.addresses, reason: cached.reason };
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { safe: false, addresses: [], reason: `DNS resolution failed for ${hostname}` };
  }
  if (!records || records.length === 0) {
    const r0 = { safe: false, addresses: [], reason: `No addresses for ${hostname}` };
    dnsCache.set(hostname, { ...r0, expiresAt: Date.now() + DNS_TTL_MS });
    return r0;
  }
  const addrs = records.map((r) => `${r.family === 4 ? 4 : 6}:${r.address}`);
  // Block if ANY resolved address is private (someone could route to it).
  const blocked = records.filter((r) => !isPublicIp(r.address, r.family));
  let out;
  if (blocked.length > 0) {
    out = { safe: false, addresses: addrs, reason: `Blocked private/special address (${blocked.map((b) => b.address).join(", ")}) for ${hostname}` };
  } else {
    out = { safe: true, addresses: addrs, reason: null };
  }
  dnsCache.set(hostname, { ...out, expiresAt: Date.now() + DNS_TTL_MS });
  return out;
}

/**
 * Full SSRF gate for an absolute URL: parse, allow only http/https, and validate host.
 * Returns { ok, reason, url }.
 */
export async function ssrfCheck(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return { ok: false, reason: `Invalid URL: ${urlString}`, url: urlString };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `Unsupported protocol ${u.protocol}`, url: urlString };
  }
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  // Do not allow bare IP literals that are private (skip DNS entirely).
  const { isIP } = await import("node:net");
  if (isIP(host) !== 0) {
    const fam = isIP(host) === 6 ? 6 : 4;
    if (!isPublicIp(host, fam)) {
      return { ok: false, reason: `Blocked private IP host ${host}`, url: urlString };
    }
  }
  const res = await validateHost(host);
  if (!res.safe) {
    return { ok: false, reason: res.reason, url: urlString };
  }
  return { ok: true, reason: null, url: urlString };
}

/** Check a resolved destination for a redirect hop (host may be an IP). */
export async function ssrfCheckRedirect(urlString) {
  return ssrfCheck(urlString);
}
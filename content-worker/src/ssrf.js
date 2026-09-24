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
  // expand :: notation
  let str = ip.toLowerCase();
  const colon = str.match(/:/g)?.length ?? 0;
  if (str.includes("::")) {
    const missing = 8 - colon;
    const [l, r] = str.split("::");
    str = (l ? l + ":" : "") + "0:".repeat(missing) + (r || "");
  }
  // full 8 groups
  const parts = str.split(":");
  if (parts.length < 8) {
    while (parts.length < 8) parts.push("0");
  }
  let big = 0n;
  for (const p of parts) {
    const v = BigInt(parseInt(p || "0", 16) || 0);
    big = (big << 16n) | v;
  }
  return big;
}

function inRange(fam, value) {
  for (const f of FORBIDDEN) {
    const c = ipNetCache.get(f.net);
    if (!c) continue;
    if (c.fam !== fam) continue;
    // mask check
    const mask = fam === 4 ? (0xffffffff << (32 - c.bits)) >>> 0 : (BigInt(0xffffffffffffffffn) << BigInt(128 - c.bits));
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
export function isPublicIp(address, family) {
  const fam = family === 6 ? 6 : 4;
  let value;
  if (fam === 4) value = ipv4ToInt(address);
  else value = ipv6ToBigInt(address);
  return !inRange(fam, value);
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
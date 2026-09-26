// One-click "Connect website" for sites hosted on Vercel (or anything that can
// proxy a path): the client's /blog is rewritten to the Bunker Rank blog hub
// (blog.bunkerank.com/s/<websiteId>/blog). Nothing here edits the client's
// site, repo or DNS — the person pastes the rewrite, then presses Verify.
//
// Verify:
//   1. enables PocketBase-CMS publishing for this website in STAGING (the hub
//      serves it noindex) so the rewrite has something to show;
//   2. fetches https://<domain>/blog from the server and looks for
//      <meta name="bunker-hub" content="<websiteId>">, which only the hub
//      renders for THIS website (a client catch-all page never has it);
//   3. only when the marker matches: switches publishing to PRODUCTION, marks
//      the connection as connected and lets autopilot publish there.
// Websites already connected another way (WordPress, API, webhook) are never
// overwritten.

const HUB = "https://blog.bunkerank.com";

function lib() { return require(`${__hooks}/bsa_lib.js`); }
function pub() { return require(`${__hooks}/bsa_publish.js`); }

function hubUrl(id) { return HUB + "/s/" + id + "/blog"; }
function cleanDomain(v) { return String(v || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, ""); }

function snippet(id) {
  return JSON.stringify({ rewrites: [
    { source: "/blog", destination: hubUrl(id) },
    { source: "/blog/:path*", destination: hubUrl(id) + "/:path*" },
  ] }, null, 2);
}

function load(actor, websiteId) {
  const L = lib();
  if (actor.role !== "admin" && actor.role !== "super_admin") L.fail(403, "FORBIDDEN", "Only organization admins can connect websites.");
  const w = L.getOne("websites", String(websiteId || ""));
  if (!w || w.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Website not found.");
  const domain = cleanDomain(w.domain);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) L.fail(400, "INVALID", "This website has no valid domain.");
  if (w.publisher_type && w.publisher_type !== "pocketbase_cms") L.fail(409, "ALREADY_CONNECTED", "This website publishes through " + w.publisher_type + ". Change it in Advanced settings first.");
  return { w: w, domain: domain };
}

function info(actor, body) {
  const x = load(actor, body.websiteId);
  return {
    domain: x.domain, hub_url: hubUrl(x.w.id), snippet: snippet(x.w.id),
    connected: x.w.publisher_type === "pocketbase_cms" && x.w.publishing_environment === "production" && x.w.connection_status === "connected",
  };
}

function checkLive(domain, id) {
  const url = "https://" + domain + "/blog";
  let res;
  try {
    res = $http.send({ url: url, method: "GET", headers: { "user-agent": "Mozilla/5.0 (compatible; BunkerRankVerify/1.0)", accept: "text/html" }, timeout: 20 });
  } catch (err) {
    return { ok: false, status: 0, reason: "Could not reach " + url + "." };
  }
  const html = toString(res.body || []).slice(0, 400000);
  const m = /<meta[^>]+name=["']bunker-hub["'][^>]+content=["']([a-z0-9]{15})["']/i.exec(html) || /<meta[^>]+content=["']([a-z0-9]{15})["'][^>]+name=["']bunker-hub["']/i.exec(html);
  if (res.statusCode !== 200) return { ok: false, status: res.statusCode, reason: url + " returned " + res.statusCode + "." };
  if (!m) return { ok: false, status: 200, reason: url + " still shows the website's own page. Check that the rewrite is at the TOP of vercel.json and that the deploy finished." };
  if (m[1] !== id) return { ok: false, status: 200, reason: url + " points to a different Bunker Rank website." };
  return { ok: true, status: 200 };
}

function verify(actor, body) {
  const L = lib();
  const x = load(actor, body.websiteId);
  const w = x.w, domain = x.domain;
  const allowed = [domain];
  if (domain.indexOf("www.") === 0) allowed.push(domain.slice(4)); else allowed.push("www." + domain);
  const baseUrl = "https://" + domain;
  const cfg = Object.assign({}, w.publishing_configuration || {}, { revalidate_url: "", sitemap_url: baseUrl + "/blog/sitemap.xml", verify_sitemap: true, hub: HUB });

  // 1) make sure the hub serves this website (staging = noindex) before checking.
  if (!w.publishing_enabled || w.publisher_type !== "pocketbase_cms") {
    pub().saveConfig(actor, {
      websiteId: w.id, publisherType: "pocketbase_cms", publishingMode: "approval", environment: "staging", enabled: true,
      allowedDomains: allowed, baseUrl: baseUrl, blogPath: "/blog", sitemapUrl: baseUrl + "/blog/sitemap.xml", verifySitemap: true, autoRevalidate: false,
    });
  }

  // 2) check the live client URL.
  const r = checkLive(domain, w.id);
  const ts = L.now();
  if (!r.ok) {
    $app.runInTransaction(function (tx) {
      L.updateRec("websites", w.id, { connection_status: "invalid_response", last_connection_test: ts, last_connection_error: r.reason.slice(0, 500) }, tx);
    });
    return { connected: false, reason: r.reason, snippet: snippet(w.id), hub_url: hubUrl(w.id) };
  }

  // 3) go live.
  $app.runInTransaction(function (tx) {
    L.updateRec("websites", w.id, {
      publishing_enabled: true, publisher_type: "pocketbase_cms", publishing_mode: "approval", publishing_environment: "production",
      base_url: baseUrl, blog_path: "/blog", allowed_domains: allowed, publication_requires_approval: true, auto_revalidate: false,
      publishing_configuration: cfg, connection_status: "connected", last_connection_test: ts, last_connection_error: "",
    }, tx);
    const p = L.findFirst("autopilot_policies", "website = {:w}", "", { w: w.id }, tx);
    if (p) {
      const envs = Array.isArray(p.allowed_environments) ? p.allowed_environments.slice() : [];
      if (envs.indexOf("production") === -1) envs.push("production");
      L.updateRec("autopilot_policies", p.id, { allowed_environments: envs, updated_at: ts, updated_by: actor.id, version: Number(p.version || 0) + 1 }, tx);
    }
    L.logActivity(tx, { organization: w.organization, client: w.client, website: w.id, user: actor.id, action: "WEBSITE_CONNECTED", entity_type: "website", entity_id: w.id, metadata: { method: "vercel_rewrite", domain: domain, hub: HUB } });
  });
  return { connected: true, url: baseUrl + "/blog" };
}

function disconnect(actor, body) {
  const L = lib();
  const x = load(actor, body.websiteId);
  $app.runInTransaction(function (tx) {
    L.updateRec("websites", x.w.id, { publishing_environment: "staging", connection_status: "not_configured", last_connection_error: "" }, tx);
    L.logActivity(tx, { organization: x.w.organization, client: x.w.client, website: x.w.id, user: actor.id, action: "WEBSITE_DISCONNECTED", entity_type: "website", entity_id: x.w.id, metadata: { method: "vercel_rewrite" } });
  });
  return { connected: false };
}

module.exports = { HUB, info, verify, disconnect, checkLive, snippet };

// Phase 6 — Search Console analytics (trusted PocketBase side).
//
// * OAuth 2.0 with Google: anti-CSRF state bound to user + organization +
//   website + expiry + single-use nonce (stored hashed). The client secret and
//   the encryption key are read from files in /pb_secrets (never Git, never
//   the browser). Refresh tokens are AES-256-GCM encrypted at rest in a hidden
//   field and never leave the server.
// * Read-only: the only Search Console scope requested is webmasters.readonly
//   (+ openid/email to show which Google account is connected).
// * Aggregations run server-side in SQL; the browser only receives
//   paginated, already-aggregated rows.
// * Nothing here edits, creates, publishes or unpublishes content. Accepting
//   an opportunity may create a Phase 3 content opportunity ONLY when the user
//   explicitly asks for it.

const READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const REQUESTED_SCOPES = ["openid", "email", READONLY_SCOPE];
const STATE_TTL_MS = 10 * 60 * 1000;
const SOURCE_TZ = "Google Search Console / PT";
const METRIC_TABLES = {
  gsc_site_daily: { keys: ["website", "property", "date", "search_type"], extra: ["data_state"] },
  gsc_page_daily: { keys: ["website", "property", "date", "search_type", "page"], extra: [] },
  gsc_query_daily: { keys: ["website", "property", "date", "search_type", "query"], extra: ["normalized_query"] },
  gsc_query_page_daily: { keys: ["website", "property", "date", "search_type", "query", "page"], extra: ["normalized_query"] },
};
const RANGES = { "7d": 7, "28d": 28, "3m": 91, "6m": 182, "90d": 90 };
const MAX_CUSTOM_DAYS = 486; // Search Console keeps ~16 months.
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function lib() {
  return require(`${__hooks}/bsa_lib.js`);
}

// ---------------------------------------------------------------- dates
function isDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ""))) return false;
  const d = new Date(v + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function addDays(date, n) {
  return new Date(Date.parse(date + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
function spanDays(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000) + 1;
}
function todayPT() {
  // PT offset approximation is not needed: Search Console dates are validated
  // against latest_final_date, which is always determined from Google.
  return new Date(Date.now() - 7 * 3600000).toISOString().slice(0, 10);
}
function pbDate(iso) {
  return String(iso || new Date().toISOString()).replace("T", " ");
}

// ---------------------------------------------------------------- secrets
function readSecretFile(envName, def) {
  const path = $os.getenv(envName) || def;
  try { return toString($os.readFile(path)).trim(); } catch (_) { return ""; }
}
function gscKey() {
  const key = readSecretFile("GSC_KEY_FILE", "/pb_secrets/gsc.key");
  if (key.length !== 32) lib().fail(503, "SECRETS_UNAVAILABLE", "Search Console token storage is not configured on the server.");
  return key;
}
function oauthConfig(required) {
  let cfg = {};
  try { cfg = JSON.parse(readSecretFile("GOOGLE_OAUTH_FILE", "/pb_secrets/google_oauth.json") || "{}"); } catch (_) { cfg = {}; }
  const out = {
    clientId: String(cfg.client_id || "").trim(),
    clientSecret: String(cfg.client_secret || "").trim(),
    redirectUri: String(cfg.redirect_uri || "").trim(),
    testingMode: cfg.testing_mode !== false,
  };
  if (required && (!out.clientId || !out.clientSecret || !/^https:\/\/[^\s]+$/.test(out.redirectUri) && !/^http:\/\/127\.0\.0\.1(:\d+)?\//.test(out.redirectUri))) {
    lib().fail(503, "OAUTH_NOT_CONFIGURED", "Google OAuth is not configured on the server yet.");
  }
  return out;
}
function endpoints() {
  return {
    auth: $os.getenv("GSC_GOOGLE_AUTH_URL") || "https://accounts.google.com/o/oauth2/v2/auth",
    token: $os.getenv("GSC_GOOGLE_TOKEN_URL") || "https://oauth2.googleapis.com/token",
    userinfo: $os.getenv("GSC_GOOGLE_USERINFO_URL") || "https://openidconnect.googleapis.com/v1/userinfo",
    revoke: $os.getenv("GSC_GOOGLE_REVOKE_URL") || "https://oauth2.googleapis.com/revoke",
    api: String($os.getenv("GSC_API_BASE") || "https://www.googleapis.com/webmasters/v3").replace(/\/+$/, ""),
  };
}
function sanitize(text) {
  return String(text || "")
    .replace(/ya29\.[\w.-]+/g, "[REDACTED]")
    .replace(/1\/\/[\w.-]+/g, "[REDACTED]")
    .replace(/(access_token|refresh_token|client_secret|id_token|code)["'=:\s]+[\w./-]+/gi, "$1=[REDACTED]")
    .slice(0, 300);
}
function form(obj) {
  return Object.keys(obj).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]); }).join("&");
}
function randomId() {
  return $security.randomStringWithAlphabet(15, ID_ALPHABET);
}

// ---------------------------------------------------------------- access
function assertIntegrationAdmin(actor) {
  if (actor.role !== "admin" && actor.role !== "super_admin") lib().fail(403, "FORBIDDEN", "Only organization admins can manage Search Console connections.");
}
function assertAnalyst(actor) {
  if (actor.role === "viewer" || actor.role === "client") lib().fail(403, "FORBIDDEN", "You do not have permission to change analytics data.");
}
function websiteFor(actor, websiteId) {
  const L = lib();
  const w = L.getOne("websites", String(websiteId || ""));
  if (!w || w.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Website not found.");
  const client = L.getOne("clients", String(w.client || ""));
  if (!client || client.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Website not found.");
  return w;
}
function connectionFor(actor, connectionId) {
  const L = lib();
  const c = L.getOne("gsc_connections", String(connectionId || ""));
  if (!c || c.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Search Console connection not found.");
  return c;
}
function propertyFor(actor, propertyId) {
  const L = lib();
  const p = L.getOne("gsc_properties", String(propertyId || ""));
  if (!p || p.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Search Console property not found.");
  return p;
}
function selectedProperty(websiteId) {
  return lib().findFirst("gsc_properties", "website = {:w} && selected = true", "", { w: websiteId });
}
function publicConnection(c) {
  if (!c) return null;
  return {
    id: c.id, organization: c.organization, google_account_email: c.google_account_email, scopes: c.scopes || [], status: c.status,
    last_refresh_at: c.last_refresh_at, last_error: c.last_error, created_at: c.created_at, connected_by: c.connected_by,
  };
}

// ---------------------------------------------------------------- property matching
function normHost(v) {
  return String(v || "").trim().toLowerCase().replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/[\/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "").replace(/^www\./, "");
}
function propertyType(siteUrl) {
  return String(siteUrl).indexOf("sc-domain:") === 0 ? "domain" : "url_prefix";
}
/** MATCHED / POSSIBLE MATCH / MISMATCH against the website's own domains. */
function matchStatus(website, siteUrl) {
  const host = normHost(siteUrl);
  const primary = normHost(website.domain);
  if (!host) return "mismatch";
  if (primary && host === primary) return "matched";
  const others = [];
  for (const d of website.allowed_domains || []) others.push(normHost(d));
  if (website.base_url) others.push(normHost(website.base_url));
  const related = function (a, b) { return a && b && (a === b || a.endsWith("." + b) || b.endsWith("." + a)); };
  if (related(host, primary)) return "possible_match";
  for (const o of others) if (related(host, o)) return "possible_match";
  return "mismatch";
}

// ---------------------------------------------------------------- google calls (short, synchronous)
function httpJson(req, label) {
  let res;
  try {
    res = $http.send({ url: req.url, method: req.method || "GET", body: req.body || "", headers: req.headers || {}, timeout: 20 });
  } catch (err) {
    lib().fail(502, "GOOGLE_UNAVAILABLE", "Could not reach Google (" + label + "). Try again.");
  }
  const json = res.json || {};
  if (res.statusCode >= 200 && res.statusCode < 300) return json;
  const reason = typeof json.error === "string" ? json.error : (json.error && (json.error.status || json.error.message)) || "";
  if (label === "token" && (reason === "invalid_grant" || res.statusCode === 400 || res.statusCode === 401)) {
    const e = new Error("reauth");
    e.gsc = { code: "REAUTH_REQUIRED", status: res.statusCode };
    throw e;
  }
  if (res.statusCode === 429) lib().fail(429, "RATE_LIMITED", "Google rate limit reached. Try again in a few minutes.");
  if (res.statusCode >= 500) lib().fail(502, "GOOGLE_UNAVAILABLE", "Google returned an error (" + res.statusCode + "). Try again.");
  lib().fail(502, "GOOGLE_ERROR", "Google rejected the request (" + label + ", " + res.statusCode + "): " + sanitize(reason));
}
function exchangeCode(cfg, code) {
  return httpJson({
    url: endpoints().token, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ code: code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code" }),
  }, "token");
}
function refreshAccess(cfg, refreshToken) {
  return httpJson({
    url: endpoints().token, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "refresh_token" }),
  }, "token");
}
function listSites(accessToken) {
  const j = httpJson({ url: endpoints().api + "/sites", headers: { authorization: "Bearer " + accessToken } }, "sites.list");
  return (j.siteEntry || []).map(function (s) { return { site_url: String(s.siteUrl || ""), permission_level: String(s.permissionLevel || "") }; }).filter(function (s) { return s.site_url; });
}
function grantedScopes(scopeStr) {
  return String(scopeStr || "").split(/\s+/).filter(Boolean);
}

/** Upsert the properties Google lists; properties no longer listed → access_lost (data kept). */
function syncPropertyList(app, connection, sites) {
  const L = lib();
  const t = L.now();
  const seen = {};
  for (const s of sites) {
    seen[s.site_url] = true;
    const existing = L.findFirst("gsc_properties", "connection = {:c} && site_url = {:s}", "", { c: connection.id, s: s.site_url }, app);
    if (existing) {
      const status = existing.status === "access_lost" || existing.status === "disconnected" ? (existing.selected ? "active" : "available") : existing.status;
      L.updateRec("gsc_properties", existing.id, { permission_level: s.permission_level, last_verified_at: t, status: s.permission_level === "siteUnverifiedUser" ? "access_lost" : status, updated_at: t }, app);
    } else {
      L.createRec("gsc_properties", {
        organization: connection.organization, connection: connection.id, site_url: s.site_url, property_type: propertyType(s.site_url),
        permission_level: s.permission_level, status: s.permission_level === "siteUnverifiedUser" ? "access_lost" : "available", selected: false,
        last_verified_at: t, source_timezone: SOURCE_TZ, created_at: t, updated_at: t,
      }, app);
    }
  }
  const lost = [];
  for (const p of L.findMany("gsc_properties", "connection = {:c}", "", 500, { c: connection.id }, app)) {
    if (!seen[p.site_url] && p.status !== "access_lost") {
      L.updateRec("gsc_properties", p.id, { status: "access_lost", updated_at: t }, app);
      if (p.selected) lost.push(p);
    }
  }
  return lost;
}

function notify(app, fields) {
  const L = lib();
  const t = L.now();
  const existing = L.findFirst("notifications", "organization = {:o} && dedupe_key = {:k}", "", { o: fields.organization, k: fields.dedupe_key }, app);
  if (existing) {
    L.updateRec("notifications", existing.id, { occurrences: Number(existing.occurrences || 1) + 1, body: fields.body || existing.body, read_at: "", updated_at: t }, app);
    return existing.id;
  }
  return L.createRec("notifications", {
    organization: fields.organization, website: fields.website || "", kind: fields.kind, severity: fields.severity || "info", title: fields.title,
    body: fields.body || "", link: fields.link || "", dedupe_key: fields.dedupe_key, occurrences: 1, created_at: t, updated_at: t,
  }, app).id;
}

function log(app, actor, website, action, entityType, entityId, metadata) {
  lib().logActivity(app, {
    organization: actor.organization, user: actor.id, client: website ? website.client : "", website: website ? website.id : "",
    action: action, entity_type: entityType, entity_id: entityId, metadata: metadata || {},
  });
}

// ================================================================ OAuth
function startOAuth(actor, body) {
  assertIntegrationAdmin(actor);
  const L = lib();
  const w = websiteFor(actor, body.websiteId);
  const cfg = oauthConfig(true);
  gscKey(); // refuse to start a flow whose token could not be stored
  let reconnect = "";
  if (body.connectionId) reconnect = connectionFor(actor, body.connectionId).id;
  // One active state per user/website; stale ones are purged.
  const old = L.findMany("gsc_oauth_states", "user = {:u} && (used_at != '' || expires_at < {:n})", "", 200, { u: actor.id, n: pbDate() });
  for (const o of old) { try { $app.delete($app.findRecordById("gsc_oauth_states", o.id)); } catch (_) {} }
  const nonce = $security.randomString(48);
  L.createRec("gsc_oauth_states", {
    organization: actor.organization, user: actor.id, website: w.id, connection: reconnect,
    state_hash: $security.sha256(nonce), expires_at: pbDate(new Date(Date.now() + STATE_TTL_MS).toISOString()), created_at: L.now(),
  });
  const url = endpoints().auth + "?" + form({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: REQUESTED_SCOPES.join(" "),
    access_type: "offline", prompt: "consent select_account", include_granted_scopes: "false", state: nonce,
  });
  return { url: url, scopes: REQUESTED_SCOPES, expiresInSeconds: STATE_TTL_MS / 1000 };
}

/**
 * OAuth callback, called by the Next.js route AS THE SIGNED-IN USER.
 * The state must exist, be unused, unexpired and belong to this exact user +
 * organization; it is consumed BEFORE the code exchange (replay-proof).
 */
function completeOAuth(actor, body) {
  assertIntegrationAdmin(actor);
  const L = lib();
  const state = String(body.state || "");
  if (!state || state.length > 200) L.fail(400, "STATE_INVALID", "Invalid OAuth state.");
  const rec = L.findFirst("gsc_oauth_states", "state_hash = {:h}", "", { h: $security.sha256(state) });
  if (!rec) L.fail(400, "STATE_INVALID", "Unknown or already used OAuth state. Start the connection again.");
  if (rec.used_at) L.fail(400, "STATE_REPLAYED", "This authorization response was already used. Start the connection again.");
  if (rec.user !== actor.id || rec.organization !== actor.organization) L.fail(403, "STATE_MISMATCH", "This authorization was started by a different user or organization.");
  if (Date.parse(String(rec.expires_at).replace(" ", "T")) < Date.now()) L.fail(400, "STATE_EXPIRED", "The authorization request expired. Start the connection again.");
  // Consume first: a replay of the same state fails even if the exchange below fails.
  L.updateRec("gsc_oauth_states", rec.id, { used_at: L.now() });
  const w = websiteFor(actor, rec.website);
  if (body.error) L.fail(400, "OAUTH_DENIED", "Google authorization was cancelled or denied.");
  const code = String(body.code || "");
  if (!code || code.length > 2000) L.fail(400, "CODE_MISSING", "Google did not return an authorization code.");
  const cfg = oauthConfig(true);
  const key = gscKey();

  let tok;
  try { tok = exchangeCode(cfg, code); } catch (err) {
    if (err && err.gsc) L.fail(400, "OAUTH_EXCHANGE_FAILED", "Google rejected the authorization code. Start the connection again.");
    throw err;
  }
  const scopes = grantedScopes(tok.scope);
  if (scopes.indexOf(READONLY_SCOPE) === -1) L.fail(400, "SCOPE_MISSING", "Search Console read-only access was not granted. Connect again and allow Search Console access.");
  const info = httpJson({ url: endpoints().userinfo, headers: { authorization: "Bearer " + tok.access_token } }, "userinfo");
  const sub = String(info.sub || "");
  const email = String(info.email || "").toLowerCase().slice(0, 320);
  if (!sub) L.fail(502, "GOOGLE_ERROR", "Google did not identify the account.");

  let connection = L.findFirst("gsc_connections", "organization = {:o} && google_sub = {:s}", "", { o: actor.organization, s: sub });
  if (rec.connection) {
    const expected = L.getOne("gsc_connections", rec.connection);
    if (!expected || expected.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Search Console connection not found.");
    // google_sub is a hidden field: toObj() omits it, read it from the record.
    const expectedSub = $app.findRecordById("gsc_connections", expected.id).getString("google_sub");
    if (expectedSub && expectedSub !== sub) L.fail(409, "ACCOUNT_MISMATCH", "Reconnect with the same Google account (" + expected.google_account_email + ") or use Connect for a new account.");
    connection = expected;
  }
  const refresh = String(tok.refresh_token || "");
  const existingEnc = connection ? (function () { try { return $app.findRecordById("gsc_connections", connection.id).getString("encrypted_refresh_token"); } catch (_) { return ""; } })() : "";
  if (!refresh && !existingEnc) L.fail(400, "NO_REFRESH_TOKEN", "Google did not return offline access. Remove the app from your Google account permissions and connect again.");
  const encrypted = refresh ? $security.encrypt(refresh, key) : existingEnc;
  const t = L.now();
  const isReconnect = Boolean(connection);
  const fields = {
    organization: actor.organization, connected_by: actor.id, google_account_email: email, google_sub: sub,
    encrypted_refresh_token: encrypted, scopes: scopes, status: "connected", last_refresh_at: t, last_error: "", disconnected_at: "", updated_at: t,
  };
  connection = connection ? L.updateRec("gsc_connections", connection.id, fields) : L.createRec("gsc_connections", Object.assign({ created_at: t }, fields));

  const sites = listSites(tok.access_token);
  const lost = syncPropertyList($app, connection, sites);
  log($app, actor, w, isReconnect ? "GSC_RECONNECTED" : "GSC_CONNECTED", "gsc_connection", connection.id, { google_account_email: email, scopes: scopes, properties: sites.length });
  for (const p of lost) notify($app, { organization: actor.organization, website: p.website, kind: "gsc_access_lost", severity: "warning", title: "Search Console access lost", body: "The connected Google account no longer lists " + p.site_url + ". Historical data is kept; syncing is paused.", dedupe_key: "gsc_access_lost:" + p.id, link: p.website ? "/websites/" + p.website + "/search-console" : "" });
  return { connectionId: connection.id, websiteId: w.id, googleAccountEmail: email, properties: sites.length, reconnected: isReconnect };
}

function refreshProperties(actor, body) {
  assertIntegrationAdmin(actor);
  const L = lib();
  const c = connectionFor(actor, body.connectionId);
  if (c.status === "disconnected") L.fail(409, "DISCONNECTED", "This connection was disconnected. Connect again.");
  const cfg = oauthConfig(true);
  const key = gscKey();
  const enc = $app.findRecordById("gsc_connections", c.id).getString("encrypted_refresh_token");
  if (!enc) L.fail(409, "REAUTH_REQUIRED", "Reconnect Search Console.");
  let tok;
  try { tok = refreshAccess(cfg, $security.decrypt(enc, key)); } catch (err) {
    if (err && err.gsc) {
      L.updateRec("gsc_connections", c.id, { status: "reauth_required", last_error: "Google rejected the stored authorization. Reconnect Search Console.", updated_at: L.now() });
      notify($app, { organization: c.organization, kind: "gsc_reauth", severity: "critical", title: "Reconnect Search Console", body: "Google rejected the stored authorization for " + c.google_account_email + ".", dedupe_key: "gsc_reauth:" + c.id });
      L.fail(409, "REAUTH_REQUIRED", "Google rejected the stored authorization. Reconnect Search Console.");
    }
    throw err;
  }
  const sites = listSites(tok.access_token);
  const lost = syncPropertyList($app, c, sites);
  L.updateRec("gsc_connections", c.id, { status: "connected", last_refresh_at: L.now(), last_error: "", updated_at: L.now() });
  for (const p of lost) notify($app, { organization: c.organization, website: p.website, kind: "gsc_access_lost", severity: "warning", title: "Search Console access lost", body: "The connected Google account no longer lists " + p.site_url + ". Historical data is kept; syncing is paused.", dedupe_key: "gsc_access_lost:" + p.id });
  return { properties: sites.length, accessLost: lost.length };
}

/** Properties of a connection with their match status for a given website. */
function listProperties(actor, body) {
  const L = lib();
  const w = websiteFor(actor, body.websiteId);
  const filter = body.connectionId ? "organization = {:o} && connection = {:c}" : "organization = {:o}";
  const props = L.findMany("gsc_properties", filter, "site_url", 500, { o: actor.organization, c: String(body.connectionId || "") });
  const conns = {};
  return props.map(function (p) {
    if (!conns[p.connection]) conns[p.connection] = L.getOne("gsc_connections", p.connection);
    const c = conns[p.connection];
    return {
      id: p.id, site_url: p.site_url, property_type: p.property_type, permission_level: p.permission_level, status: p.status,
      selected: p.selected, website: p.website, match_status: matchStatus(w, p.site_url), mapped_to_this_website: p.website === w.id && p.selected,
      connection: p.connection, google_account_email: c ? c.google_account_email : "", connection_status: c ? c.status : "",
      latest_final_date: p.latest_final_date, last_sync_at: p.last_sync_at, last_sync_status: p.last_sync_status,
    };
  });
}

function selectProperty(actor, body) {
  assertIntegrationAdmin(actor);
  const L = lib();
  const w = websiteFor(actor, body.websiteId);
  const p = propertyFor(actor, body.propertyId);
  const c = connectionFor(actor, p.connection);
  if (c.status !== "connected") L.fail(409, "CONNECTION_NOT_READY", "The Google connection is " + c.status + ". Reconnect first.");
  if (p.status === "access_lost") L.fail(409, "ACCESS_LOST", "Google no longer grants access to this property.");
  if (p.permission_level === "siteUnverifiedUser") L.fail(409, "ACCESS_LOST", "The Google account is not a verified user of this property.");
  if (p.selected && p.website && p.website !== w.id) L.fail(409, "PROPERTY_IN_USE", "This property is already mapped to another website.");
  const match = matchStatus(w, p.site_url);
  if (body.confirm !== true) L.fail(400, "CONFIRMATION_REQUIRED", "Confirm the website mapping.");
  if (match !== "matched" && normHost(body.confirmDomain) !== normHost(p.site_url)) {
    L.fail(409, match === "mismatch" ? "PROPERTY_MISMATCH" : "PROPERTY_POSSIBLE_MATCH", "The property " + p.site_url + " does not exactly match " + w.domain + ". Type the property domain to confirm this mapping explicitly.");
  }
  const t = L.now();
  let queued = null;
  $app.runInTransaction(function (tx) {
    for (const prev of L.findMany("gsc_properties", "website = {:w} && selected = true && id != {:p}", "", 50, { w: w.id, p: p.id }, tx)) {
      L.updateRec("gsc_properties", prev.id, { selected: false, status: prev.status === "access_lost" ? "access_lost" : "available", updated_at: t }, tx);
    }
    L.updateRec("gsc_properties", p.id, { website: w.id, selected: true, status: "active", match_status: match, selected_by: actor.id, selected_at: t, source_timezone: SOURCE_TZ, updated_at: t }, tx);
    log(tx, actor, w, "GSC_PROPERTY_SELECTED", "gsc_property", p.id, { site_url: p.site_url, match_status: match, confirmed_domain: match !== "matched" });
    if (body.initialSync !== false) queued = queueSync(tx, actor, w, L.getOne("gsc_properties", p.id, tx), "initial", "90d", "", "");
  });
  return { propertyId: p.id, matchStatus: match, job: queued };
}

function disconnect(actor, body) {
  assertIntegrationAdmin(actor);
  const L = lib();
  const c = connectionFor(actor, body.connectionId);
  if (body.confirm !== true) L.fail(400, "CONFIRMATION_REQUIRED", "Confirm disconnecting Search Console.");
  let revoked = false;
  try {
    const enc = $app.findRecordById("gsc_connections", c.id).getString("encrypted_refresh_token");
    if (enc) {
      const token = $security.decrypt(enc, gscKey());
      const r = $http.send({ url: endpoints().revoke, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ token: token }), timeout: 15 });
      revoked = r.statusCode === 200;
    }
  } catch (_) { revoked = false; }
  const t = L.now();
  let cancelled = 0;
  $app.runInTransaction(function (tx) {
    L.updateRec("gsc_connections", c.id, { encrypted_refresh_token: "", status: "disconnected", disconnected_at: t, last_error: "", updated_at: t }, tx);
    for (const p of L.findMany("gsc_properties", "connection = {:c}", "", 500, { c: c.id }, tx)) {
      L.updateRec("gsc_properties", p.id, { status: "disconnected", updated_at: t }, tx);
      for (const j of L.findMany("gsc_sync_jobs", "property = {:p} && status = 'queued'", "", 50, { p: p.id }, tx)) {
        L.updateRec("gsc_sync_jobs", j.id, { status: "cancelled", error_code: "DISCONNECTED", error_message: "Search Console was disconnected.", completed_at: t, updated_at: t }, tx);
        cancelled++;
      }
    }
    lib().logActivity(tx, { organization: actor.organization, user: actor.id, action: "GSC_DISCONNECTED", entity_type: "gsc_connection", entity_id: c.id, metadata: { google_account_email: c.google_account_email, revoked_at_google: revoked, historical_data_kept: true, jobs_cancelled: cancelled } });
  });
  return { disconnected: true, revokedAtGoogle: revoked, historicalDataKept: true };
}

// ================================================================ sync jobs
function activeSync(propertyId, app) {
  return lib().findFirst("gsc_sync_jobs", "property = {:p} && (status = 'queued' || status = 'running')", "", { p: propertyId }, app);
}
function queueSync(app, actor, website, property, syncType, range, start, end) {
  const L = lib();
  const active = activeSync(property.id, app);
  if (active) return { id: active.id, status: active.status, deduplicated: true };
  const t = L.now();
  const job = L.createRec("gsc_sync_jobs", {
    organization: website.organization, website: website.id, property: property.id, status: "queued", sync_type: syncType, range_label: range,
    search_type: "web", data_state: "final", start_date: start || "", end_date: end || "", step: "Queued", progress: 0,
    rows_requested: 0, rows_received: 0, rows_stored: 0, api_requests: 0, pagination_completed: false, attempt: 0, dedupe_key: "",
    triggered_by: actor ? actor.id : "", created_at: t, updated_at: t,
  }, app);
  return { id: job.id, status: "queued", deduplicated: false };
}

function requestSync(actor, body) {
  assertAnalyst(actor);
  const L = lib();
  const w = websiteFor(actor, body.websiteId);
  const p = selectedProperty(w.id);
  if (!p || p.organization !== actor.organization) L.fail(409, "NO_PROPERTY", "Select a Search Console property for this website first.");
  const c = L.getOne("gsc_connections", p.connection);
  if (!c || c.status !== "connected") L.fail(409, "CONNECTION_NOT_READY", "Search Console needs to be reconnected.");
  if (p.status !== "active") L.fail(409, "ACCESS_LOST", "Search Console access to this property was lost.");
  const range = String(body.range || "90d");
  let start = "", end = "", type = "manual";
  if (range === "custom") {
    start = String(body.startDate || ""); end = String(body.endDate || "");
    if (!isDate(start) || !isDate(end) || start > end) L.fail(400, "INVALID_RANGE", "Use a valid date range (YYYY-MM-DD).");
    if (end > todayPT()) L.fail(400, "INVALID_RANGE", "The range cannot end in the future.");
    if (spanDays(start, end) > MAX_CUSTOM_DAYS || start < addDays(todayPT(), -MAX_CUSTOM_DAYS)) L.fail(400, "RANGE_TOO_LARGE", "Search Console keeps about 16 months of data; choose a smaller range.");
    if (spanDays(start, end) > 92) { assertIntegrationAdmin(actor); type = "backfill"; }
  } else if (range === "6m") {
    assertIntegrationAdmin(actor); type = "backfill";
  } else if (!RANGES[range]) {
    L.fail(400, "INVALID_RANGE", "Unknown range.");
  }
  const since = pbDate(new Date(Date.now() - 3600000).toISOString());
  const recent = L.findMany("gsc_sync_jobs", "organization = {:o} && created_at >= {:s}", "", 30, { o: actor.organization, s: since });
  if (recent.length >= 30) L.fail(429, "RATE_LIMITED", "Too many sync requests this hour. Try again later.");
  const job = queueSync($app, actor, w, p, type, range, start, end);
  return { job: job };
}

function cancelSync(actor, body) {
  assertAnalyst(actor);
  const L = lib();
  const j = L.getOne("gsc_sync_jobs", String(body.jobId || ""));
  if (!j || j.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Sync job not found.");
  if (j.status !== "queued") L.fail(409, "NOT_CANCELLABLE", "Only queued jobs can be cancelled.");
  L.updateRec("gsc_sync_jobs", j.id, { status: "cancelled", error_code: "CANCELLED", error_message: "Cancelled by user.", completed_at: L.now(), updated_at: L.now() });
  return { cancelled: true };
}

// ================================================================ internal (worker, superuser only)
function internalUpsert(body) {
  const L = lib();
  const table = String(body.table || "");
  const spec = METRIC_TABLES[table];
  if (!spec) L.fail(400, "BAD_TABLE", "Unknown table.");
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > 2000) L.fail(400, "TOO_MANY_ROWS", "At most 2000 rows per request.");
  const p = L.getOne("gsc_properties", String(body.property || ""));
  const w = L.getOne("websites", String(body.website || ""));
  if (!p || !w || p.website !== w.id || p.organization !== w.organization || !p.selected) L.fail(409, "TENANT_MISMATCH", "Property/website mismatch.");
  const synced = pbDate();
  const cols = ["id", "organization"].concat(spec.keys, spec.extra, ["clicks", "impressions", "ctr", "position", "synced_at"]);
  const updates = spec.extra.concat(["clicks", "impressions", "ctr", "position", "synced_at"]).map(function (c) { return c + " = excluded." + c; }).join(", ");
  const sql = "INSERT INTO " + table + " (" + cols.join(", ") + ") VALUES (" + cols.map(function (c) { return "{:" + c + "}"; }).join(", ") + ") ON CONFLICT (" + spec.keys.join(", ") + ") DO UPDATE SET " + updates;
  let stored = 0;
  $app.runInTransaction(function (tx) {
    for (const r of rows) {
      if (!isDate(r.date)) continue;
      const params = { id: randomId(), organization: w.organization, website: w.id, property: p.id, date: r.date, search_type: String(r.search_type || "web").slice(0, 20), synced_at: synced,
        clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0, ctr: Number(r.ctr) || 0, position: Number(r.position) || 0 };
      if (spec.keys.indexOf("page") !== -1) params.page = String(r.page || "").slice(0, 2000);
      if (spec.keys.indexOf("query") !== -1) { params.query = String(r.query || "").slice(0, 1000); params.normalized_query = String(r.normalized_query || "").slice(0, 1000); }
      if (spec.extra.indexOf("data_state") !== -1) params.data_state = String(r.data_state || "final").slice(0, 10);
      if ((params.page !== undefined && !params.page) || (params.query !== undefined && !params.query)) continue;
      tx.db().newQuery(sql).bind(params).execute();
      stored++;
    }
  });
  return { stored: stored };
}

function internalLabels(body) {
  const L = lib();
  const w = L.getOne("websites", String(body.website || ""));
  if (!w) L.fail(404, "NOT_FOUND", "Website not found.");
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 5000) : [];
  const sql = "INSERT INTO gsc_query_labels (id, organization, website, normalized_query, query, mapping, keyword, mapped_page, intent, brand, source, labeled_at) VALUES ({:id}, {:o}, {:w}, {:nq}, {:q}, {:m}, {:k}, {:mp}, {:i}, {:b}, {:s}, {:t}) " +
    "ON CONFLICT (website, normalized_query) DO UPDATE SET query = excluded.query, mapping = excluded.mapping, keyword = excluded.keyword, mapped_page = excluded.mapped_page, intent = excluded.intent, brand = excluded.brand, source = excluded.source, labeled_at = excluded.labeled_at";
  const t = pbDate();
  const ALLOWED = ["known_keyword", "related_variant", "new_query", "unmapped"];
  let n = 0;
  $app.runInTransaction(function (tx) {
    for (const r of rows) {
      if (!r.normalized_query || ALLOWED.indexOf(r.mapping) === -1) continue;
      tx.db().newQuery(sql).bind({ id: randomId(), o: w.organization, w: w.id, nq: String(r.normalized_query).slice(0, 1000), q: String(r.query || "").slice(0, 1000), m: r.mapping,
        k: /^[a-z0-9]{15}$/.test(String(r.keyword || "")) ? r.keyword : "", mp: String(r.mapped_page || "").slice(0, 2000), i: String(r.intent || "").slice(0, 20),
        b: ["branded", "non_branded", "unknown"].indexOf(r.brand) !== -1 ? r.brand : "unknown", s: "google_search_console", t: t }).execute();
      n++;
    }
  });
  return { labeled: n };
}

// ================================================================ aggregation (SQL, server-side)
function exclusionSql(ranges, params) {
  let sql = "";
  (ranges || []).forEach(function (r, i) {
    if (!isDate(r.start) || !isDate(r.end)) return;
    params["xs" + i] = r.start; params["xe" + i] = r.end;
    sql += " AND NOT (date BETWEEN {:xs" + i + "} AND {:xe" + i + "})";
  });
  return sql;
}
function one(sql, params, shape) {
  const m = new DynamicModel(shape);
  $app.db().newQuery(sql).bind(params).one(m);
  return JSON.parse(JSON.stringify(m));
}
function many(sql, params, shape) {
  const rows = arrayOf(new DynamicModel(shape));
  $app.db().newQuery(sql).bind(params).all(rows);
  return JSON.parse(JSON.stringify(rows));
}
function finish(r) {
  const clicks = Number(r.clicks) || 0, impressions = Number(r.impressions) || 0;
  const out = { clicks: clicks, impressions: impressions, ctr: impressions > 0 ? clicks / impressions : 0, position: impressions > 0 ? (Number(r.wpos) || 0) / impressions : null };
  if (r.days !== undefined) out.days = Number(r.days) || 0;
  return out;
}
function siteTotals(websiteId, propertyId, start, end, excl) {
  const params = { w: websiteId, p: propertyId, s: start, e: end };
  const r = one("SELECT COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(impressions),0) AS impressions, COALESCE(SUM(position*impressions),0) AS wpos, COUNT(DISTINCT date) AS days FROM gsc_site_daily WHERE website = {:w} AND property = {:p} AND search_type = 'web' AND date BETWEEN {:s} AND {:e}" + exclusionSql(excl, params), params, { clicks: -0, impressions: -0, wpos: -0, days: 0 });
  return finish(r);
}
function dailySeries(websiteId, propertyId, start, end) {
  return many("SELECT date, clicks, impressions, ctr, position FROM gsc_site_daily WHERE website = {:w} AND property = {:p} AND search_type = 'web' AND date BETWEEN {:s} AND {:e} ORDER BY date", { w: websiteId, p: propertyId, s: start, e: end }, { date: "", clicks: -0, impressions: -0, ctr: -0, position: -0 });
}
const SORTS = { clicks: "clicks DESC, impressions DESC", impressions: "impressions DESC, clicks DESC", ctr: "(CASE WHEN impressions > 0 THEN clicks*1.0/impressions ELSE 0 END) DESC, impressions DESC", position: "(CASE WHEN impressions > 0 THEN wpos/impressions ELSE 999 END) ASC, impressions DESC" };
function aggQueries(websiteId, propertyId, start, end, opt) {
  opt = opt || {};
  const params = { w: websiteId, p: propertyId, s: start, e: end, lim: Math.min(Number(opt.limit) || 50, 5000), off: Math.max(0, Number(opt.offset) || 0) };
  let where = "q.website = {:w} AND q.property = {:p} AND q.search_type = 'web' AND q.date BETWEEN {:s} AND {:e}" + exclusionSql(opt.excl, params).replace(/date BETWEEN/g, "q.date BETWEEN");
  if (opt.search) { params.q = "%" + String(opt.search).toLowerCase().slice(0, 200) + "%"; where += " AND q.normalized_query LIKE {:q}"; }
  if (opt.queries && opt.queries.length) { where += " AND q.query IN (" + opt.queries.map(function (x, i) { params["qq" + i] = x; return "{:qq" + i + "}"; }).join(",") + ")"; }
  let having = "";
  if (opt.intent) { params.intent = String(opt.intent); having += " AND l.intent = {:intent}"; }
  if (opt.brand) { params.brand = String(opt.brand); having += " AND COALESCE(NULLIF(l.brand_override,''), l.brand) = {:brand}"; }
  if (opt.mapping) { params.mapping = String(opt.mapping); having += " AND l.mapping = {:mapping}"; }
  const base = "SELECT q.query AS query, MAX(q.normalized_query) AS normalized_query, SUM(q.clicks) AS clicks, SUM(q.impressions) AS impressions, SUM(q.position*q.impressions) AS wpos, COUNT(DISTINCT q.date) AS days FROM gsc_query_daily q WHERE " + where + " GROUP BY q.query";
  const sql = "SELECT a.*, COALESCE(l.mapping,'') AS mapping, COALESCE(l.intent,'') AS intent, COALESCE(NULLIF(l.brand_override,''), l.brand, 'unknown') AS brand, COALESCE(l.mapped_page,'') AS mapped_page FROM (" + base + ") a LEFT JOIN gsc_query_labels l ON l.website = {:w} AND l.normalized_query = a.normalized_query WHERE 1=1" + having;
  const rows = many(sql + " ORDER BY " + (SORTS[opt.sort] || SORTS.clicks) + " LIMIT {:lim} OFFSET {:off}", params, { query: "", normalized_query: "", clicks: -0, impressions: -0, wpos: -0, days: 0, mapping: "", intent: "", brand: "", mapped_page: "" });
  const total = opt.count ? one("SELECT COUNT(*) AS n FROM (" + sql + ")", params, { n: 0 }).n : undefined;
  return { rows: rows.map(function (r) { return Object.assign({ query: r.query, normalized_query: r.normalized_query, mapping: r.mapping, intent: r.intent, brand: r.brand, mapped_page: r.mapped_page }, finish(r)); }), total: total };
}
function aggPages(websiteId, propertyId, start, end, opt) {
  opt = opt || {};
  const params = { w: websiteId, p: propertyId, s: start, e: end, lim: Math.min(Number(opt.limit) || 50, 5000), off: Math.max(0, Number(opt.offset) || 0) };
  let where = "website = {:w} AND property = {:p} AND search_type = 'web' AND date BETWEEN {:s} AND {:e}" + exclusionSql(opt.excl, params);
  if (opt.search) { params.q = "%" + String(opt.search).toLowerCase().slice(0, 300) + "%"; where += " AND LOWER(page) LIKE {:q}"; }
  if (opt.pages && opt.pages.length) { where += " AND page IN (" + opt.pages.map(function (x, i) { params["pp" + i] = x; return "{:pp" + i + "}"; }).join(",") + ")"; }
  const sql = "SELECT page, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position*impressions) AS wpos, COUNT(DISTINCT date) AS days FROM gsc_page_daily WHERE " + where + " GROUP BY page";
  const rows = many(sql + " ORDER BY " + (SORTS[opt.sort] || SORTS.clicks) + " LIMIT {:lim} OFFSET {:off}", params, { page: "", clicks: -0, impressions: -0, wpos: -0, days: 0 });
  const total = opt.count ? one("SELECT COUNT(*) AS n FROM (" + sql + ")", params, { n: 0 }).n : undefined;
  return { rows: rows.map(function (r) { return Object.assign({ page: r.page }, finish(r)); }), total: total };
}
function aggQueryPages(websiteId, propertyId, start, end, opt) {
  opt = opt || {};
  const params = { w: websiteId, p: propertyId, s: start, e: end, lim: Math.min(Number(opt.limit) || 50, 20000) };
  let where = "website = {:w} AND property = {:p} AND search_type = 'web' AND date BETWEEN {:s} AND {:e}" + exclusionSql(opt.excl, params);
  if (opt.queries && opt.queries.length) where += " AND query IN (" + opt.queries.map(function (x, i) { params["qq" + i] = x; return "{:qq" + i + "}"; }).join(",") + ")";
  if (opt.page) { params.pg = String(opt.page); where += " AND page = {:pg}"; }
  const rows = many("SELECT query, page, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position*impressions) AS wpos FROM gsc_query_page_daily WHERE " + where + " GROUP BY query, page ORDER BY impressions DESC LIMIT {:lim}", params, { query: "", page: "", clicks: -0, impressions: -0, wpos: -0 });
  return rows.map(function (r) { return Object.assign({ query: r.query, page: r.page }, finish(r)); });
}

function internalAggregate(body) {
  const L = lib();
  const p = L.getOne("gsc_properties", String(body.property || ""));
  if (!p || p.website !== String(body.website || "")) L.fail(409, "TENANT_MISMATCH", "Property/website mismatch.");
  if (!isDate(body.start) || !isDate(body.end)) L.fail(400, "INVALID_RANGE", "Invalid range.");
  const opt = { limit: body.limit, excl: body.exclude || [] };
  if (body.kind === "site") return siteTotals(p.website, p.id, body.start, body.end, opt.excl);
  if (body.kind === "queries") return aggQueries(p.website, p.id, body.start, body.end, opt).rows;
  if (body.kind === "pages") return aggPages(p.website, p.id, body.start, body.end, opt).rows;
  if (body.kind === "query_pages") return aggQueryPages(p.website, p.id, body.start, body.end, opt);
  L.fail(400, "BAD_KIND", "Unknown aggregate.");
}

// ================================================================ read API (users)
function periodFor(p, body) {
  const L = lib();
  const latest = p.latest_final_date;
  if (!isDate(latest)) return null;
  const range = String(body.range || "28d");
  let start, end;
  if (range === "custom") {
    start = String(body.startDate || ""); end = String(body.endDate || "");
    if (!isDate(start) || !isDate(end) || start > end) L.fail(400, "INVALID_RANGE", "Use a valid date range (YYYY-MM-DD).");
    if (end > latest) end = latest;
    if (spanDays(start, end) > MAX_CUSTOM_DAYS) L.fail(400, "RANGE_TOO_LARGE", "Choose a range of at most 16 months.");
  } else {
    const days = RANGES[range];
    if (!days) L.fail(400, "INVALID_RANGE", "Unknown range.");
    end = latest; start = addDays(latest, -(days - 1));
  }
  const days = spanDays(start, end);
  const prevEnd = addDays(start, -1);
  return { range: range, start: start, end: end, days: days, prevStart: addDays(prevEnd, -(days - 1)), prevEnd: prevEnd };
}
function changeOf(cur, prev) {
  const abs = cur - prev;
  return { current: cur, previous: prev, abs: abs, pct: prev > 0 ? abs / prev : null };
}
function compareTotals(cur, prev) {
  return {
    clicks: changeOf(cur.clicks, prev.clicks), impressions: changeOf(cur.impressions, prev.impressions), ctr: changeOf(cur.ctr, prev.ctr),
    position: cur.position === null || prev.position === null ? { current: cur.position, previous: prev.position, abs: null, pct: null } : changeOf(cur.position, prev.position),
  };
}
function context(actor, body) {
  const w = websiteFor(actor, body.websiteId);
  const p = selectedProperty(w.id);
  const conn = p ? lib().getOne("gsc_connections", p.connection) : null;
  return { website: w, property: p && p.organization === actor.organization ? p : null, connection: conn };
}
function propertyInfo(p, c) {
  if (!p) return null;
  return { id: p.id, site_url: p.site_url, property_type: p.property_type, permission_level: p.permission_level, status: p.status, match_status: p.match_status,
    latest_final_date: p.latest_final_date, first_data_date: p.first_data_date, last_synced_date: p.last_synced_date, last_sync_at: p.last_sync_at, last_sync_status: p.last_sync_status,
    source_timezone: p.source_timezone || SOURCE_TZ, google_account_email: c ? c.google_account_email : "", connection_status: c ? c.status : "" };
}

function summary(actor, body) {
  const ctx = context(actor, body);
  const p = ctx.property;
  if (!p) return { connected: false, property: null };
  const period = periodFor(p, body);
  if (!period) return { connected: true, property: propertyInfo(p, ctx.connection), period: null, hasData: false };
  const cur = siteTotals(ctx.website.id, p.id, period.start, period.end);
  const prev = siteTotals(ctx.website.id, p.id, period.prevStart, period.prevEnd);
  const counts = one("SELECT (SELECT COUNT(DISTINCT page) FROM gsc_page_daily WHERE website = {:w} AND property = {:p} AND date BETWEEN {:s} AND {:e}) AS pages, (SELECT COUNT(DISTINCT query) FROM gsc_query_daily WHERE website = {:w} AND property = {:p} AND date BETWEEN {:s} AND {:e}) AS queries, (SELECT COALESCE(SUM(clicks),0) FROM gsc_query_daily WHERE website = {:w} AND property = {:p} AND date BETWEEN {:s} AND {:e}) AS query_clicks, (SELECT COALESCE(SUM(impressions),0) FROM gsc_query_daily WHERE website = {:w} AND property = {:p} AND date BETWEEN {:s} AND {:e}) AS query_impressions",
    { w: ctx.website.id, p: p.id, s: period.start, e: period.end }, { pages: 0, queries: 0, query_clicks: -0, query_impressions: -0 });
  const opps = one("SELECT COUNT(*) AS n FROM analytics_opportunities WHERE website = {:w} AND status IN ('new','reviewed')", { w: ctx.website.id }, { n: 0 }).n;
  const flags = lib().findMany("gsc_data_quality_flags", "website = {:w} && active = true", "-start_date", 20, { w: ctx.website.id });
  return {
    connected: true, property: propertyInfo(p, ctx.connection), period: period, dataThrough: p.latest_final_date, source: "Google Search Console", dataState: "final",
    totals: cur, previousTotals: prev, comparison: compareTotals(cur, prev), coverage: { currentDays: cur.days, previousDays: prev.days },
    daily: dailySeries(ctx.website.id, p.id, period.start, period.end), counts: counts, openOpportunities: opps,
    qualityFlags: flags.map(function (f) { return { id: f.id, start_date: f.start_date, end_date: f.end_date, reason: f.reason, exclude_from_opportunities: f.exclude_from_opportunities }; }),
    hasData: cur.impressions > 0 || prev.impressions > 0,
  };
}

function landingPages(websiteId, propertyId, period, queries) {
  if (!queries.length) return {};
  const rows = aggQueryPages(websiteId, propertyId, period.start, period.end, { queries: queries, limit: 20000 });
  const out = {};
  for (const r of rows) if (!out[r.query]) out[r.query] = { page: r.page, impressions: r.impressions };
  return out;
}

function queries(actor, body) {
  const ctx = context(actor, body);
  const p = ctx.property;
  if (!p) return { connected: false, rows: [] };
  const period = periodFor(p, body);
  if (!period) return { connected: true, rows: [], total: 0, period: null };
  const perPage = Math.min(100, Math.max(10, Number(body.perPage) || 50));
  const pageNo = Math.max(1, Number(body.page) || 1);
  let restrict = null;
  if (body.pageUrl) {
    const qp = aggQueryPages(ctx.website.id, p.id, period.start, period.end, { page: String(body.pageUrl), limit: 5000 });
    restrict = qp.map(function (r) { return r.query; });
    if (!restrict.length) return { connected: true, rows: [], total: 0, period: period, dataThrough: p.latest_final_date };
    restrict = restrict.slice(0, 900);
  }
  const res = aggQueries(ctx.website.id, p.id, period.start, period.end, { limit: perPage, offset: (pageNo - 1) * perPage, sort: body.sort, search: body.search, intent: body.intent, brand: body.brand, mapping: body.mapping, queries: restrict, count: true });
  const names = res.rows.map(function (r) { return r.query; });
  const prev = names.length ? aggQueries(ctx.website.id, p.id, period.prevStart, period.prevEnd, { queries: names, limit: names.length }).rows : [];
  const prevBy = {};
  for (const r of prev) prevBy[r.query] = r;
  const landing = landingPages(ctx.website.id, p.id, period, names);
  return {
    connected: true, period: period, dataThrough: p.latest_final_date, total: res.total, page: pageNo, perPage: perPage, source: "Google Search Console",
    rows: res.rows.map(function (r) {
      const b = prevBy[r.query] || { clicks: 0, impressions: 0, ctr: 0, position: null };
      return Object.assign({}, r, { landing_page: landing[r.query] ? landing[r.query].page : "", previous: b, change: compareTotals(r, b) });
    }),
  };
}

function normUrl(u) {
  try {
    const m = String(u).match(/^https?:\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?/i);
    if (!m) return String(u || "").toLowerCase();
    return m[1].toLowerCase().replace(/^www\./, "") + (m[2].replace(/\/+$/, "") || "/") + (m[3] || "");
  } catch (_) { return String(u || ""); }
}
function pageMappings(website, urls) {
  const L = lib();
  const out = {};
  if (!urls.length) return out;
  const wanted = {};
  for (const u of urls) wanted[normUrl(u)] = u;
  for (const wp of L.findMany("website_pages", "website = {:w}", "", 5000, { w: website.id })) {
    const k = normUrl(wp.url);
    if (wanted[k]) out[wanted[k]] = Object.assign(out[wanted[k]] || {}, { website_page: { id: wp.id, title: wp.title, path: wp.path } });
  }
  for (const pub of L.findMany("article_publications", "website = {:w} && public_url != ''", "", 2000, { w: website.id })) {
    const k = normUrl(pub.public_url);
    if (wanted[k]) {
      const a = L.getOne("articles", pub.article);
      out[wanted[k]] = Object.assign(out[wanted[k]] || {}, { article: a ? { id: a.id, title: a.title, status: pub.status, published_at: pub.published_at } : null });
    }
  }
  const latest = L.findFirst("strategy_versions", "website = {:w}", "-version", { w: website.id });
  if (latest) {
    for (const k of L.findMany("keywords", "strategy_version = {:v} && (recommended_target_page != '' || existing_target_page != '')", "", 3000, { v: latest.id })) {
      let target = k.recommended_target_page || "";
      if (k.existing_target_page) { const wp = L.getOne("website_pages", k.existing_target_page); if (wp) target = wp.url; }
      if (!target) continue;
      if (target.charAt(0) === "/") target = "https://" + String(website.domain).replace(/^https?:\/\//, "").replace(/\/.*$/, "") + target;
      const key = normUrl(target);
      if (wanted[key]) {
        const cur = out[wanted[key]] || {};
        const list = cur.strategy_keywords || [];
        if (list.length < 5) list.push(k.keyword);
        out[wanted[key]] = Object.assign(cur, { strategy_keywords: list });
      }
    }
  }
  return out;
}

function pages(actor, body) {
  const ctx = context(actor, body);
  const p = ctx.property;
  if (!p) return { connected: false, rows: [] };
  const period = periodFor(p, body);
  if (!period) return { connected: true, rows: [], total: 0, period: null };
  const perPage = Math.min(100, Math.max(10, Number(body.perPage) || 50));
  const pageNo = Math.max(1, Number(body.page) || 1);
  const res = aggPages(ctx.website.id, p.id, period.start, period.end, { limit: perPage, offset: (pageNo - 1) * perPage, sort: body.sort, search: body.search, count: true });
  const urls = res.rows.map(function (r) { return r.page; });
  const prev = urls.length ? aggPages(ctx.website.id, p.id, period.prevStart, period.prevEnd, { pages: urls, limit: urls.length }).rows : [];
  const prevBy = {};
  for (const r of prev) prevBy[r.page] = r;
  const maps = pageMappings(ctx.website, urls);
  return {
    connected: true, period: period, dataThrough: p.latest_final_date, total: res.total, page: pageNo, perPage: perPage, source: "Google Search Console",
    rows: res.rows.map(function (r) {
      const b = prevBy[r.page] || { clicks: 0, impressions: 0, ctr: 0, position: null };
      return Object.assign({}, r, { previous: b, change: compareTotals(r, b), mapping: maps[r.page] || {} });
    }),
  };
}

function queryDetail(actor, body) {
  const ctx = context(actor, body);
  const p = ctx.property;
  if (!p) return { connected: false };
  const period = periodFor(p, body);
  if (!period) return { connected: true, period: null };
  const q = String(body.query || "").slice(0, 1000);
  const cur = aggQueries(ctx.website.id, p.id, period.start, period.end, { queries: [q], limit: 1 }).rows[0] || null;
  const prev = aggQueries(ctx.website.id, p.id, period.prevStart, period.prevEnd, { queries: [q], limit: 1 }).rows[0] || { clicks: 0, impressions: 0, ctr: 0, position: null };
  const landing = aggQueryPages(ctx.website.id, p.id, period.start, period.end, { queries: [q], limit: 50 });
  const daily = many("SELECT date, clicks, impressions, ctr, position FROM gsc_query_daily WHERE website = {:w} AND property = {:p} AND search_type = 'web' AND query = {:q} AND date BETWEEN {:s} AND {:e} ORDER BY date", { w: ctx.website.id, p: p.id, q: q, s: period.start, e: period.end }, { date: "", clicks: -0, impressions: -0, ctr: -0, position: -0 });
  const maps = pageMappings(ctx.website, landing.map(function (r) { return r.page; }));
  const opps = lib().findMany("analytics_opportunities", "website = {:w} && query = {:q}", "-last_detected_at", 20, { w: ctx.website.id, q: q });
  return { connected: true, period: period, dataThrough: p.latest_final_date, query: q, totals: cur, previous: prev, change: cur ? compareTotals(cur, prev) : null, daily: daily,
    landingPages: landing.map(function (r) { return Object.assign({}, r, { mapping: maps[r.page] || {} }); }), opportunities: opps.map(function (o) { return { id: o.id, type: o.type, status: o.status, priority: o.priority }; }), source: "Google Search Console" };
}

/** Search performance of a published article (since publication only). */
function articlePerformance(actor, body) {
  const L = lib();
  const a = L.getOne("articles", String(body.articleId || ""));
  if (!a || a.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Article not found.");
  websiteFor(actor, a.website);
  const pub = L.findFirst("article_publications", "article = {:a} && website = {:w}", "", { a: a.id, w: a.website });
  if (!pub || !pub.public_url) return { published: false };
  const p = selectedProperty(a.website);
  const base = { published: pub.status === "published", publicUrl: pub.public_url, publishedAt: pub.published_at, publicationStatus: pub.status };
  if (!p) return Object.assign(base, { connected: false });
  const pubDay = String(pub.published_at || "").slice(0, 10);
  base.daysLive = isDate(pubDay) ? Math.max(0, spanDays(pubDay, todayPT()) - 1) : null;
  if (!isDate(p.latest_final_date) || !isDate(pubDay) || pubDay > p.latest_final_date) return Object.assign(base, { connected: true, hasData: false, dataThrough: p.latest_final_date || null });
  const start = pubDay, end = p.latest_final_date;
  const variants = [pub.public_url, pub.public_url.replace(/\/$/, ""), pub.public_url.replace(/\/?$/, "/")].filter(function (v, i, arr) { return arr.indexOf(v) === i; });
  const t = aggPages(a.website, p.id, start, end, { pages: variants, limit: 5 }).rows;
  const totals = t.reduce(function (acc, r) { acc.clicks += r.clicks; acc.impressions += r.impressions; acc.wpos += (r.position || 0) * r.impressions; return acc; }, { clicks: 0, impressions: 0, wpos: 0 });
  const fin = finish(totals);
  const top = variants.reduce(function (acc, v) { return acc.concat(aggQueryPages(a.website, p.id, start, end, { page: v, limit: 10 })); }, []).sort(function (x, y) { return y.impressions - x.impressions; }).slice(0, 10);
  return Object.assign(base, { connected: true, hasData: fin.impressions > 0, dataThrough: p.latest_final_date, sincePublication: { start: start, end: end }, totals: fin, topQueries: top, source: "Google Search Console" });
}

function orgOverview(actor, body) {
  const L = lib();
  const range = RANGES[String(body.range || "28d")] ? String(body.range || "28d") : "28d";
  const props = L.findMany("gsc_properties", "organization = {:o} && selected = true && website != ''", "", 500, { o: actor.organization });
  let clicks = 0, impressions = 0, pclicks = 0, pimpr = 0, withData = 0, latest = "";
  for (const p of props) {
    const period = periodFor(p, { range: range });
    if (!period) continue;
    const c = siteTotals(p.website, p.id, period.start, period.end);
    const b = siteTotals(p.website, p.id, period.prevStart, period.prevEnd);
    clicks += c.clicks; impressions += c.impressions; pclicks += b.clicks; pimpr += b.impressions;
    if (c.impressions > 0) withData++;
    if (!latest || p.latest_final_date < latest) latest = p.latest_final_date;
  }
  const count = function (filter) { return one("SELECT COUNT(*) AS n FROM analytics_opportunities WHERE organization = {:o} AND " + filter, { o: actor.organization }, { n: 0 }).n; };
  return {
    range: range, source: "Google Search Console", websitesConnected: props.length, websitesWithData: withData, dataThrough: latest || null,
    clicks: changeOf(clicks, pclicks), impressions: changeOf(impressions, pimpr), ctr: impressions > 0 ? clicks / impressions : 0,
    opportunities: count("status IN ('new','reviewed')"), growingPages: count("type = 'growing_page' AND status IN ('new','reviewed')"), pagesLosingTraffic: count("type = 'content_decay' AND status IN ('new','reviewed')"),
  };
}

function clientOverview(actor, body) {
  const L = lib();
  const client = L.getOne("clients", String(body.clientId || ""));
  if (!client || client.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Client not found.");
  const range = RANGES[String(body.range || "28d")] ? String(body.range || "28d") : "28d";
  const sites = L.findMany("websites", "client = {:c} && organization = {:o}", "name", 200, { c: client.id, o: actor.organization });
  const rows = [];
  let clicks = 0, impressions = 0, wpos = 0;
  for (const w of sites) {
    const p = selectedProperty(w.id);
    if (!p) { rows.push({ website: { id: w.id, name: w.name, domain: w.domain }, connected: false }); continue; }
    const period = periodFor(p, { range: range });
    if (!period) { rows.push({ website: { id: w.id, name: w.name, domain: w.domain }, connected: true, hasData: false, property: p.site_url }); continue; }
    const c = siteTotals(w.id, p.id, period.start, period.end);
    const b = siteTotals(w.id, p.id, period.prevStart, period.prevEnd);
    clicks += c.clicks; impressions += c.impressions; wpos += (c.position || 0) * c.impressions;
    rows.push({ website: { id: w.id, name: w.name, domain: w.domain }, connected: true, hasData: c.impressions > 0, property: p.site_url, period: period, totals: c, comparison: compareTotals(c, b) });
  }
  // Sum clicks/impressions; CTR = total clicks / total impressions; position is
  // shown per site (an impression-weighted blend is provided but labeled).
  return { range: range, source: "Google Search Console", sites: rows, aggregate: { clicks: clicks, impressions: impressions, ctr: impressions > 0 ? clicks / impressions : 0, weightedPosition: impressions > 0 ? wpos / impressions : null } };
}

// ================================================================ opportunities & settings
function decideOpportunity(actor, body) {
  assertAnalyst(actor);
  const L = lib();
  const o = L.getOne("analytics_opportunities", String(body.opportunityId || ""));
  if (!o || o.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Opportunity not found.");
  const w = websiteFor(actor, o.website);
  const action = String(body.action || "");
  const map = { review: "reviewed", accept: "accepted", ignore: "ignored", reopen: "new" };
  if (!map[action]) L.fail(400, "INVALID_ACTION", "Unknown action.");
  const note = L.clean(body.note, 1000);
  const t = L.now();
  let contentOpportunity = "";
  $app.runInTransaction(function (tx) {
    // Optional, explicit human step: send an accepted opportunity to Phase 3.
    if (action === "accept" && body.createContentOpportunity === true && !o.content_opportunity) {
      const version = L.findFirst("strategy_versions", "website = {:w}", "-version", { w: w.id }, tx);
      if (!version) L.fail(409, "NO_STRATEGY", "This website has no SEO strategy yet; accept without creating a content opportunity.");
      const typeMap = { new_query: "create", content_decay: "refresh", striking_distance: "optimize", high_impressions_low_ctr: "optimize", page_query_mismatch: "optimize", potential_cannibalization: "merge", position_decline: "refresh" };
      const co = L.createRec("content_opportunities", {
        organization: w.organization, client: w.client, website: w.id, strategy_version: version.id, opportunity_type: typeMap[o.type] || "optimize",
        recommended_page_type: o.page ? "existing_page" : "blog_article", recommended_url: o.page || "", title_suggestion: o.query ? String(o.query).slice(0, 200) : "",
        reason: "<p>From Search Console analytics (" + o.type + "): " + String(o.reason || "").replace(/[<>&]/g, "") + "</p>", priority: o.priority, status: "proposed",
        evidence: { source: "google_search_console", analytics_opportunity: o.id, evidence: o.evidence, accepted_by: actor.id }, confidence: 0.5, created_at: t, updated_at: t,
      }, tx);
      contentOpportunity = co.id;
    }
    const fields = { status: map[action], decided_by: actor.id, decided_at: t, decision_note: note, updated_at: t };
    if (map[action] === "new") fields.resolved_at = "";
    if (contentOpportunity) fields.content_opportunity = contentOpportunity;
    L.updateRec("analytics_opportunities", o.id, fields, tx);
    const actions = { review: "ANALYTICS_OPPORTUNITY_REVIEWED", accept: "ANALYTICS_OPPORTUNITY_ACCEPTED", ignore: "ANALYTICS_OPPORTUNITY_IGNORED", reopen: "ANALYTICS_OPPORTUNITY_REOPENED" };
    log(tx, actor, w, actions[action], "analytics_opportunity", o.id, { type: o.type, query: o.query, page: o.page, note: note, content_opportunity: contentOpportunity || undefined });
  });
  return { status: map[action], contentOpportunity: contentOpportunity || null };
}

function setBrandOverride(actor, body) {
  assertAnalyst(actor);
  const L = lib();
  const w = websiteFor(actor, body.websiteId);
  const label = L.findFirst("gsc_query_labels", "website = {:w} && normalized_query = {:q}", "", { w: w.id, q: String(body.normalizedQuery || "") });
  if (!label) L.fail(404, "NOT_FOUND", "Query not found.");
  const v = String(body.brand || "");
  if (v !== "branded" && v !== "non_branded" && v !== "") L.fail(400, "INVALID", "Invalid brand classification.");
  L.updateRec("gsc_query_labels", label.id, { brand_override: v });
  log($app, actor, w, "GSC_BRAND_OVERRIDE", "gsc_query_label", label.id, { query: label.query, brand: v || "auto" });
  return { ok: true };
}

function addQualityFlag(actor, body) {
  assertIntegrationAdmin(actor);
  const L = lib();
  const w = websiteFor(actor, body.websiteId);
  if (body.flagId) {
    const f = L.getOne("gsc_data_quality_flags", String(body.flagId));
    if (!f || f.website !== w.id) L.fail(404, "NOT_FOUND", "Flag not found.");
    L.updateRec("gsc_data_quality_flags", f.id, { active: false, updated_at: L.now() });
    log($app, actor, w, "GSC_DATA_QUALITY_FLAG_REMOVED", "gsc_data_quality_flag", f.id, {});
    return { ok: true };
  }
  const s = String(body.startDate || ""), e = String(body.endDate || "");
  if (!isDate(s) || !isDate(e) || s > e || spanDays(s, e) > 120) L.fail(400, "INVALID_RANGE", "Use a valid date range (max 120 days).");
  const reason = L.clean(body.reason, 500);
  if (!reason) L.fail(400, "REASON_REQUIRED", "Explain why this period is unreliable.");
  const f = L.createRec("gsc_data_quality_flags", { organization: w.organization, website: w.id, start_date: s, end_date: e, reason: reason, exclude_from_opportunities: body.exclude !== false, active: true, created_by: actor.id, created_at: L.now(), updated_at: L.now() });
  log($app, actor, w, "GSC_DATA_QUALITY_FLAGGED", "gsc_data_quality_flag", f.id, { start_date: s, end_date: e, reason: reason });
  return { id: f.id };
}

function saveSettings(actor, body) {
  assertIntegrationAdmin(actor);
  const L = lib();
  const w = websiteFor(actor, body.websiteId);
  const input = body.settings || {};
  const allowed = { low_ctr: ["min_impressions", "max_position", "ratio"], striking: ["min_position", "max_position", "min_impressions"], decay: ["min_prev_clicks", "min_click_drop", "click_drop_pct", "min_prev_impressions", "impression_drop_pct"], growth: ["min_clicks", "min_click_gain", "click_gain_pct"], new_query: ["min_impressions"], zero_click: ["min_impressions", "max_position"] };
  const out = {};
  for (const g of Object.keys(allowed)) {
    if (!input[g]) continue;
    for (const k of allowed[g]) {
      const v = Number(input[g][k]);
      if (input[g][k] === undefined || input[g][k] === "" || !isFinite(v) || v < 0 || v > 100000) continue;
      out[g] = out[g] || {}; out[g][k] = v;
    }
  }
  for (const k of ["resolve_after_days", "window_days"]) { const v = Number(input[k]); if (isFinite(v) && v >= 1 && v <= 90) out[k] = v; }
  L.updateRec("websites", w.id, { analytics_settings: out });
  log($app, actor, w, "ANALYTICS_SETTINGS_UPDATED", "website", w.id, { settings: out });
  return { settings: out };
}

function markNotification(actor, body) {
  const L = lib();
  const n = L.getOne("notifications", String(body.notificationId || ""));
  if (!n || n.organization !== actor.organization) L.fail(404, "NOT_FOUND", "Notification not found.");
  L.updateRec("notifications", n.id, { read_at: L.now() });
  return { ok: true };
}

function connectionInfo(actor, body) {
  const L = lib();
  const w = websiteFor(actor, body.websiteId);
  const conns = L.findMany("gsc_connections", "organization = {:o}", "-created_at", 50, { o: actor.organization }).map(publicConnection);
  const p = selectedProperty(w.id);
  const cfg = oauthConfig(false);
  return {
    connections: conns, selected: p ? propertyInfo(p, L.getOne("gsc_connections", p.connection)) : null,
    oauth: { configured: Boolean(cfg.clientId && cfg.clientSecret && cfg.redirectUri), testingMode: cfg.testingMode, scopes: REQUESTED_SCOPES, redirectUri: cfg.redirectUri },
    canManage: actor.role === "admin" || actor.role === "super_admin",
  };
}

module.exports = {
  READONLY_SCOPE, REQUESTED_SCOPES, matchStatus, normHost,
  startOAuth, completeOAuth, refreshProperties, listProperties, selectProperty, disconnect, connectionInfo,
  requestSync, cancelSync, internalUpsert, internalLabels, internalAggregate,
  summary, queries, pages, queryDetail, articlePerformance, orgOverview, clientOverview,
  decideOpportunity, setBrandOverride, addQualityFlag, saveSettings, markNotification, notify,
};

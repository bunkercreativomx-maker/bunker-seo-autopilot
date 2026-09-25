// Read-only Search Console probe run inside trusted infra (prod secrets mount).
// Prints ONLY non-secret facts: token scope list, sites (site_url + permission),
// available dates, and sample rows requested via argv. Never prints tokens.
import PocketBase from "pocketbase";
import { loadKey, loadOAuth, decrypt } from "./src/secrets.js";
import { SearchConsoleClient } from "./src/google.js";

const mode = process.argv[2] || "sites";
const pb = new PocketBase(process.env.PB_URL);
await pb.collection("_superusers").authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASSWORD);
const conn = await pb.collection("gsc_connections").getOne(process.env.CONN_ID);
const rt = decrypt(conn.encrypted_refresh_token, loadKey(process.env));
const oauth = loadOAuth(process.env);
const tr = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: oauth.client_id, client_secret: oauth.client_secret, refresh_token: rt, grant_type: "refresh_token" }),
});
const tj = await tr.json();
if (!tj.access_token) { console.log(JSON.stringify({ refresh: "FAILED", status: tr.status, error: tj.error })); process.exit(0); }
console.log(JSON.stringify({ refresh: "OK", expires_in: tj.expires_in, scope: tj.scope }));
const H = { authorization: `Bearer ${tj.access_token}` };
if (mode === "sites") {
  const r = await fetch("https://www.googleapis.com/webmasters/v3/sites", { headers: H });
  const j = await r.json();
  console.log(JSON.stringify({ status: r.status, sites: (j.siteEntry || []).map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel })), error: j.error?.message }));
} else if (mode === "query") {
  const site = process.env.SITE_URL;
  const body = JSON.parse(process.env.BODY);
  const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  console.log(JSON.stringify({ status: r.status, rows: j.rows || [], aggregation: j.responseAggregationType, error: j.error?.message }));
}
void SearchConsoleClient;

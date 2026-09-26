// Public blog hub — minimal, read-only website profile for the multi-client
// blog (blog.bunkeragent / <client>.com/blog via Vercel rewrite).
// Returns ONLY public branding: name, public site URL, blog path, phone and
// service area when a human has VERIFIED them. Never tenant ids beyond the
// website id, never credentials, never unverified facts.

routerAdd("GET", "/api/bsa/public/site/{id}", (e) => {
  const lib = require(`${__hooks}/bsa_lib.js`);
  const id = String(e.request.pathValue("id") || "");
  if (!/^[a-z0-9]{15}$/.test(id)) return e.json(404, { code: "NOT_FOUND" });
  const w = lib.getOne("websites", id);
  if (!w || !w.publishing_enabled || w.publisher_type !== "pocketbase_cms") return e.json(404, { code: "NOT_FOUND" });
  const facts = $app.findRecordsByFilter("business_facts", "website = {:w} && (verified = true || verification_state = 'verified' || verification_state = 'user_confirmed') && (fact_type = 'phone' || fact_type = 'business_name' || fact_type = 'service_area' || fact_type = 'email')", "-created_at", 20, 0, { w: id }) || [];
  const pick = (t) => { for (const f of facts) if (f && f.getString("fact_type") === t) return f.getString("value").slice(0, 200); return ""; };
  const siteUrl = String(w.base_url || (w.domain ? "https://" + String(w.domain).replace(/^https?:\/\//, "") : "")).replace(/\/+$/, "");
  e.response.header().set("Cache-Control", "public, max-age=300");
  return e.json(200, {
    id: w.id,
    name: pick("business_name") || String(w.name || "").slice(0, 200),
    site_url: siteUrl,
    blog_path: String(w.blog_path || "/blog"),
    environment: String(w.publishing_environment || ""),
    language: String(w.primary_language || "es").slice(0, 10),
    phone: pick("phone"),
    email: pick("email"),
    service_area: pick("service_area"),
  });
});

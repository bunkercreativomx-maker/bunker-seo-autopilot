// Quick questions: the owner answers Yes / No / Skip and every answer becomes
// a business fact the writer may (Yes) or must never (No) use. This is how a
// post gets real trust signals (warranty, years, a real review…) without the
// AI inventing them. Works for any business: universal questions + "is this
// true?" for every fact we read on the site but nobody confirmed yet.
//
// JSVM note: handlers require() this file inside each handler.

function L() { return require(`${__hooks}/bsa_lib.js`); }
function assertSite(record, actor) {
  if (!record || record.organization !== actor.organization) L().fail(404, "NOT_FOUND", "Website not found.");
  return record;
}

function norm(v) {
  let s = String(v === undefined || v === null ? "" : v).replace(/<[^>]+>/g, " ");
  try { s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); } catch (_) { /* goja without normalize */ }
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
function plain(v) { return String(v === undefined || v === null ? "" : v).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function isNegative(f) { return /\b(not offered|no ofrece|no ofrecido|no disponible|not available)\b/i.test(plain(f.label) + " " + plain(f.value)); }
function isConfirmed(f) {
  if (f.verification_state === "ai_inferred" || f.provenance === "ai_inferred") return false;
  return f.verified === true || f.verification_state === "verified" || f.verification_state === "user_confirmed";
}

// Universal question bank (any business). `covered` = a fact already answers it.
const BANK = [
  { key: "free_estimate", type: "promotion", input: "none", covered: /(cotiza|presupuesto|estimad|estimate|quote|consulta|consultation).{0,40}(grat|sin costo|free)|(grat|free|sin costo).{0,40}(cotiza|estimate|quote|presupuesto|consulta|consultation)/,
    q: "Do you offer free quotes, estimates or consultations?", hint: "Posts can then invite readers to ask for one.",
    label: { es: "Cotización o consulta gratis", en: "Free quote or consultation" }, yes: { es: "Cotización o consulta sin costo", en: "Free quotes or consultations" } },
  { key: "warranty", type: "warranty", input: "text", optional: true, skipFor: /\b(credito|creditos|prestamo|prestamos|loan|loans|pension|jubilad)/, covered: /garant|warrant|guarant/,
    q: "Do you give a warranty or guarantee on your work or products?", hint: "", placeholder: "What it covers, e.g. 1 year on labor (optional)",
    label: { es: "Garantía", en: "Warranty" }, yes: { es: "Ofrecemos garantía", en: "We offer a warranty" } },
  { key: "financing", type: "financing", input: "text", optional: true, covered: /financ|meses sin intereses|payment plan|planes de pago|credito|credit/,
    q: "Do you offer financing or payment plans?", hint: "", placeholder: "The plan, e.g. 12 months interest-free (optional)",
    label: { es: "Financiamiento", en: "Financing" }, yes: { es: "Ofrecemos financiamiento o planes de pago", en: "We offer financing or payment plans" } },
  { key: "years", type: "other", input: "number", noNo: true, covered: /\d+\s*(anos|years)\b|years in business|anos en el negocio/,
    q: "How many years has the business been open?", hint: "Posts can mention your experience — only with the real number.", placeholder: "Years",
    label: { es: "Años en el negocio", en: "Years in business" } },
  { key: "review", type: "other", input: "text", noNo: true, covered: /resena|testimon|review/,
    q: "Paste one real customer review, exactly as the customer wrote it.", hint: "From Google, Facebook or WhatsApp. Posts may quote it word for word — never invent one.", placeholder: "“They arrived on time and…”",
    label: { es: "Reseña de cliente (testimonios)", en: "Customer review (testimonials)" } },
  { key: "on_site", type: "service", input: "none", skipFor: /\b(credito|creditos|prestamo|prestamos|loan|loans|software|saas|punto de venta|point of sale)/, covered: /domicilio|a tu casa|on.?site|we go to you|mobile service|servicio movil|vamos a tu/,
    q: "Do you offer service at the customer's home or business?", hint: "",
    label: { es: "Servicio a domicilio", en: "On-site service" }, yes: { es: "Vamos al domicilio o negocio del cliente", en: "We go to the customer's home or business" } },
  { key: "same_day", type: "other", input: "none", skipFor: /\b(credito|creditos|prestamo|prestamos|loan|loans|pension|jubilad|software|saas|punto de venta|point of sale)/, covered: /emergenc|24\/?7|24 horas|24 hours|mismo dia|same.?day|after.?hours/,
    q: "Do you offer same-day or emergency service?", hint: "If not, posts will never promise it.",
    label: { es: "Servicio el mismo día o de emergencia", en: "Same-day or emergency service" }, yes: { es: "Servicio el mismo día o de emergencia", en: "Same-day or emergency service" } },
  { key: "bilingual", type: "other", input: "none", covered: /bilingu|ingles y espanol|english and spanish|espanol e ingles|spanish and english/,
    q: "Do you serve customers in both English and Spanish?", hint: "",
    label: { es: "Atención en español e inglés", en: "English and Spanish service" }, yes: { es: "Atendemos en español e inglés", en: "We serve customers in English and Spanish" } },
  { key: "licensed", type: "certification", input: "text", optional: true, covered: /licen|certific|acredit/,
    q: "Are you licensed or certified?", hint: "", placeholder: "Which one? (optional)",
    label: { es: "Licencia o certificación", en: "License or certification" }, yes: { es: "Contamos con licencia o certificación", en: "Licensed or certified" } },
];

function langOf(site) { return /^en/i.test(String(site.primary_language || "")) ? "en" : "es"; }

function answeredKeys(websiteId) {
  const out = {};
  for (const row of L().findMany("activity_logs", "website = {:w} && action = 'FACT_QUESTION_ANSWERED'", "", 1000, { w: websiteId })) {
    let m = row.metadata;
    if (typeof m === "string") { try { m = JSON.parse(m); } catch (_) { m = {}; } }
    if (m && m.key) out[m.key] = m.answer || "skip";
  }
  return out;
}

function siteQuestions(site) {
  const facts = L().findMany("business_facts", "website = {:w}", "-created_at", 300, { w: site.id });
  const answered = answeredKeys(site.id);
  const lang = langOf(site);
  const out = [];
  // 1. Things we read on the site (or guessed) that nobody confirmed yet.
  for (const f of facts) {
    if (isConfirmed(f) || isNegative(f) || answered["fact:" + f.id]) continue;
    if (["business_name", "phone", "email"].indexOf(f.fact_type) !== -1 && f.provenance === "website") continue; // contact data is confirmed by the crawler itself
    const value = plain(f.value).slice(0, 220);
    if (!value) continue;
    out.push({ key: "fact:" + f.id, kind: "confirm", websiteId: site.id, websiteName: site.name, label: plain(f.label) || f.fact_type, value: value,
      q: "Is this true about your business?", hint: f.source_url ? "We read it on " + String(f.source_url).replace(/^https?:\/\//, "").slice(0, 60) : "We weren't sure about this one.",
      input: "none", allowNo: true, sourceUrl: f.source_url || "" });
  }
  // 2. Universal questions not covered by any fact yet.
  const factText = facts.map((f) => norm(f.label) + " " + norm(f.value)).join(" \n ");
  for (const b of BANK) {
    if (answered[b.key] || b.covered.test(factText) || (b.skipFor && b.skipFor.test(factText + " " + norm(site.name)))) continue; // not relevant to this kind of business
    out.push({ key: b.key, kind: "bank", websiteId: site.id, websiteName: site.name, label: b.label[lang], value: "", q: b.q, hint: b.hint,
      input: b.input, optional: !!b.optional, placeholder: b.placeholder || "", allowNo: !b.noNo });
  }
  return out;
}

function listQuestions(actor, body) {
  const websiteId = String(body.websiteId || "");
  const sites = websiteId
    ? [assertSite(L().getOne("websites", websiteId), actor)]
    : L().findMany("websites", "organization = {:o} && status = 'active'", "name", 200, { o: actor.organization });
  let questions = [];
  for (const s of sites) questions = questions.concat(siteQuestions(s));
  return { ok: true, total: questions.length, questions: questions };
}

function answerQuestion(actor, body) {
  const lib = L();
  if (actor.role === "viewer" || actor.role === "client") L().fail(403, "FORBIDDEN", "You do not have permission to edit this data.");
  const site = assertSite(L().getOne("websites", String(body.websiteId || "")), actor);
  const key = L().clean(body.key, 40);
  const answer = String(body.answer || "");
  if (["yes", "no", "skip"].indexOf(answer) === -1) L().fail(400, "INVALID", "Answer yes, no or skip.");
  const detail = L().clean(body.detail, 600);
  const lang = langOf(site);
  const t = L().now();
  const base = { organization: site.organization, client: site.client, website: site.id };
  const confirmed = { verified: true, verification_state: "user_confirmed", verified_by: actor.id, verified_at: t, provenance: "user_provided", manual_override: true, updated_at: t };
  let factId = "";

  $app.runInTransaction(function (tx) {
    if (key.indexOf("fact:") === 0) {
      const fact = L().getOne("business_facts", key.slice(5), tx);
      if (!fact || fact.website !== site.id || fact.organization !== actor.organization) L().fail(404, "NOT_FOUND", "Fact not found.");
      factId = fact.id;
      if (answer === "yes") {
        const data = Object.assign({}, confirmed, { manual_fields: ["verified", "verification_state"].concat(detail ? ["value"] : []) });
        if (detail) data.value = detail;
        L().updateRec("business_facts", fact.id, data, tx);
      } else if (answer === "no") {
        L().updateRec("business_facts", fact.id, Object.assign({}, confirmed, {
          value: "NOT OFFERED: " + plain(fact.label) + " — " + plain(fact.value).slice(0, 300) + ". Never claim it.",
          manual_fields: ["value", "verified", "verification_state"],
        }), tx);
      }
    } else {
      const b = BANK.filter((x) => x.key === key)[0];
      if (!b) L().fail(400, "INVALID", "Unknown question.");
      if (answer === "no" && b.noNo) L().fail(400, "INVALID", "Skip it instead.");
      let value = "";
      if (answer === "yes") {
        if (b.input === "number") {
          const n = parseInt(detail, 10);
          if (!(n > 0 && n < 200)) L().fail(400, "INVALID", "Type the number of years.");
          value = lang === "en" ? n + " years in business" : n + " años en el negocio";
        } else if (b.key === "review") {
          if (detail.length < 15) L().fail(400, "INVALID", "Paste the review exactly as the customer wrote it.");
          value = "\u201c" + detail.replace(/^["“”']+|["“”']+$/g, "") + "\u201d";
        } else {
          value = b.yes[lang] + (detail ? (lang === "en" ? ": " : ": ") + detail : "");
        }
      } else if (answer === "no") {
        value = "NOT OFFERED: " + b.label[lang] + ". Never claim it.";
      }
      if (value) {
        const rec = L().createRec("business_facts", Object.assign({}, base, confirmed, {
          fact_type: answer === "no" ? "other" : b.type, label: b.label[lang], value: value,
          source: "Owner answer in Bunker Rank (Quick questions)", manual_fields: ["value", "verified", "verification_state"], created_at: t,
        }), tx);
        factId = rec.id;
      }
    }
    L().logActivity(tx, {
      organization: site.organization, client: site.client, website: site.id, user: actor.id,
      action: "FACT_QUESTION_ANSWERED", entity_type: "business_facts", entity_id: factId,
      metadata: { key: key, answer: answer },
    });
  });
  return { ok: true, factId: factId, remaining: siteQuestions(site).length };
}

module.exports = { BANK, listQuestions, answerQuestion, siteQuestions };

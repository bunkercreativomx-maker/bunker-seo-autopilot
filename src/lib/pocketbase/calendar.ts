import "server-only";
import type PocketBase from "pocketbase";
import { daysIn, localParts, planDays, TZ } from "@/lib/plan";

export type CalItem = {
  day: number;
  kind: "published" | "ready" | "writing" | "planned" | "attention";
  title: string;
  websiteId: string;
  websiteName: string;
  articleId?: string;
  url?: string;
};

export type CalSite = { id: string; name: string; postsPerMonth: number; on: boolean; done: number; planned: number };

type Raw = Record<string, unknown> & { id: string };
const s = (v: unknown) => (typeof v === "string" ? v : "");
const WRITING = ["queued", "researching", "brief_ready", "outlining", "drafting", "draft", "fact_checking", "qa", "revising"];

/** Month calendar: real posts (by date) + upcoming slots from each site's package. */
export async function loadCalendar(pb: PocketBase, year: number, month: number, siteFilter = "") {
  const dim = daysIn(year, month);
  // Wide UTC window, then bucket by local (Juárez) date.
  const from = new Date(Date.UTC(year, month - 1, 1) - 86400000).toISOString().replace("T", " ");
  const to = new Date(Date.UTC(year, month - 1, dim) + 2 * 86400000).toISOString().replace("T", " ");
  const siteQ = siteFilter ? ` && website = "${siteFilter.replace(/"/g, "")}"` : "";
  const [articles, websites, policies] = await Promise.all([
    pb.collection("articles").getFullList<Raw>({
      filter: `status != "rejected" && ((published_at >= "${from}" && published_at <= "${to}") || (created_at >= "${from}" && created_at <= "${to}"))${siteQ}`,
      fields: "id,title,primary_keyword,status,website,published_at,created_at", requestKey: null,
    }).catch(() => [] as Raw[]),
    pb.collection("websites").getFullList<Raw>({ sort: "name", fields: "id,name,domain", requestKey: null }).catch(() => [] as Raw[]),
    pb.collection("autopilot_policies").getFullList<Raw>({ fields: "website,enabled,mode,schedule,posts_per_month,paused", requestKey: null }).catch(() => [] as Raw[]),
  ]);
  const siteName = new Map(websites.map((w) => [w.id, s(w.name) || s(w.domain)]));
  const inMonth = (iso: string) => {
    if (!iso) return 0;
    const p = localParts(new Date(iso.replace(" ", "T")), TZ);
    return p.year === year && p.month === month ? p.day : 0;
  };

  const items: CalItem[] = [];
  const doneBy = new Map<string, number>();
  for (const a of articles) {
    const st = s(a.status);
    const live = ["published", "publish_queued", "publishing"].includes(st);
    const day = inMonth(live && s(a.published_at) ? s(a.published_at) : s(a.created_at));
    const createdDay = inMonth(s(a.created_at));
    if (createdDay) doneBy.set(s(a.website), (doneBy.get(s(a.website)) || 0) + 1);
    if (!day) continue;
    const kind: CalItem["kind"] = live ? "published" : st === "awaiting_approval" || st === "approved" ? "ready" : WRITING.includes(st) ? "writing" : "attention";
    items.push({ day, kind, title: s(a.title) || s(a.primary_keyword) || "Untitled", websiteId: s(a.website), websiteName: siteName.get(s(a.website)) || "", articleId: a.id });
  }

  // Upcoming slots: package days after today not yet covered by a real post.
  const today = localParts(new Date(), TZ);
  const isPast = year < today.year || (year === today.year && month < today.month);
  const isCurrent = year === today.year && month === today.month;
  const sites: CalSite[] = [];
  for (const w of websites) {
    if (siteFilter && w.id !== siteFilter) continue;
    const p = policies.find((x) => s(x.website) === w.id);
    const on = Boolean(p?.enabled) && s(p?.mode) === "SUPERVISED" && !p?.paused;
    const n = Number(p?.posts_per_month) || 0;
    const days = n ? planDays(n, dim) : [];
    const done = doneBy.get(w.id) || 0;
    let planned = 0;
    if (on && n && !isPast) {
      const remaining = days.slice(Math.min(done, days.length));
      for (const d of remaining) {
        if (isCurrent && d < today.day) continue; // overdue slots roll into the next run, not shown in the past
        items.push({ day: isCurrent && d < today.day ? today.day : d, kind: "planned", title: "Planned post", websiteId: w.id, websiteName: siteName.get(w.id) || "" });
        planned++;
      }
    }
    if (n || done) sites.push({ id: w.id, name: siteName.get(w.id) || "", postsPerMonth: n, on, done, planned });
  }
  return { year, month, dim, items, sites, websites: websites.map((w) => ({ id: w.id, name: siteName.get(w.id) || "" })), today: isCurrent ? today.day : 0 };
}

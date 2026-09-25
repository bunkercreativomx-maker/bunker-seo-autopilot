import "server-only";
import type PocketBase from "pocketbase";
import { userOperation } from "@/lib/pocketbase/operations";

// "Today" — the one screen for daily work across ALL clients. Reads use the
// signed-in user's session (PocketBase rules scope rows to the organization).

export type TodayPost = {
  id: string;
  title: string;
  keyword: string;
  status: string;
  score: number | null;
  qaStatus: string;
  factStatus: string;
  highRisk: boolean;
  websiteId: string;
  websiteName: string;
  domain: string;
  updated: string;
  excerpt: string;
  publicUrl: string;
};

export type TodaySite = {
  id: string;
  name: string;
  domain: string;
  dailyOn: boolean;
  autoPublish: boolean;
  connected: boolean;
  environment: string;
  nextRunAt: string;
  paused: boolean;
};

type Raw = Record<string, unknown> & { id: string };
const s = (v: unknown) => (typeof v === "string" ? v : "");

export const IN_PROGRESS = ["queued", "researching", "brief_ready", "outlining", "drafting", "draft", "fact_checking", "qa", "revising"];
const READY = ["awaiting_approval"];
const LIVE = ["published", "publish_queued", "publishing", "approved"];

/** 0-100 score shown to humans. QA BLOCKED / fact-check blocked never show as green. */
function scoreOf(a: Raw): number | null {
  const raw = a.qa_score;
  const n = typeof raw === "number" ? raw : raw && typeof raw === "object" && typeof (raw as { score?: unknown }).score === "number" ? (raw as { score: number }).score : null;
  if (n === null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toPost(a: Raw, pubs: Map<string, string>): TodayPost {
  const w = (a.expand as { website?: Raw } | undefined)?.website;
  return {
    id: a.id,
    title: s(a.title) || s(a.primary_keyword) || "Untitled",
    keyword: s(a.primary_keyword),
    status: s(a.status),
    score: scoreOf(a),
    qaStatus: s(a.qa_status),
    factStatus: s(a.fact_check_status),
    highRisk: Boolean(a.high_risk),
    websiteId: s(a.website),
    websiteName: s(w?.name) || s(w?.domain),
    domain: s(w?.domain),
    updated: s(a.updated_at) || s(a.updated),
    excerpt: s(a.excerpt) || s(a.meta_description),
    publicUrl: pubs.get(a.id) || "",
  };
}

export async function loadToday(pb: PocketBase) {
  const fields = "id,title,primary_keyword,status,qa_score,qa_status,fact_check_status,high_risk,website,updated,updated_at,excerpt,meta_description,expand.website.name,expand.website.domain";
  const [articles, websites, policies, pubs] = await Promise.all([
    pb.collection("articles").getFullList<Raw>({ sort: "-updated", expand: "website", fields, filter: `status != "rejected"`, requestKey: null }).catch(() => [] as Raw[]),
    pb.collection("websites").getFullList<Raw>({ sort: "name", requestKey: null }).catch(() => [] as Raw[]),
    pb.collection("autopilot_policies").getFullList<Raw>({ requestKey: null }).catch(() => [] as Raw[]),
    pb.collection("article_publications").getFullList<Raw>({ fields: "article,public_url,status", requestKey: null }).catch(() => [] as Raw[]),
  ]);
  const pubBy = new Map<string, string>(pubs.filter((p) => s(p.public_url)).map((p) => [s(p.article), s(p.public_url)]));
  const posts = articles.map((a) => toPost(a, pubBy));
  const polBy = new Map(policies.map((p) => [s(p.website), p]));
  const sites: TodaySite[] = websites.map((w) => {
    const p = polBy.get(w.id);
    const on = Boolean(p?.enabled) && s(p?.mode) === "SUPERVISED" && s(p?.schedule) === "daily";
    return {
      id: w.id, name: s(w.name) || s(w.domain), domain: s(w.domain),
      dailyOn: on, autoPublish: Boolean(p?.publish_after_human_approval), paused: Boolean(p?.paused),
      connected: s(w.connection_status) === "connected" && Boolean(w.publishing_enabled),
      environment: s(w.publishing_environment), nextRunAt: s(p?.next_run_at),
    };
  });
  return {
    ready: posts.filter((p) => READY.includes(p.status)),
    writing: posts.filter((p) => IN_PROGRESS.includes(p.status)),
    attention: posts.filter((p) => ["needs_revision", "failed", "publish_failed"].includes(p.status)),
    live: posts.filter((p) => LIVE.includes(p.status)).slice(0, 8),
    sites,
  };
}

/** Simple-mode settings for one website: 2 switches, everything else fixed. */
export async function saveSimpleSettings(pb: PocketBase, websiteId: string, dailyOn: boolean, autoPublish: boolean) {
  return userOperation(pb, "autopilot/policy/save", {
    websiteId,
    enabled: dailyOn,
    mode: dailyOn ? "SUPERVISED" : "OFF",
    schedule: "daily",
    autoPickOpportunities: true,
    publishAfterHumanApproval: autoPublish,
    allowedActions: ["CRAWL", "STRATEGY_REFRESH", "GENERATE_CONTENT", "RECHECK_CONTENT", "REQUEST_REVISION", "PUBLISH", "VERIFY_PUBLICATION", "UPDATE_PUBLICATION", "NOTIFY_HUMAN", "WAIT"],
    // Sensible fixed defaults: 1 post/day, max 7/week, 1 auto-fix per post.
    maxContentJobsPerDay: 1, maxContentJobsPerWeek: 7, maxPublicationsPerWeek: 7, maxRevisionJobsPerArticle: 1,
    maxActionsPerDay: 10, maxCrawlsPerWeek: 1, maxStrategyRefreshPerWeek: 1,
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { claimNextJob, DEFAULT_COLLECTIONS, loadJobInput } from "../src/pb.js";

function pbFixture({ inconsistent = false, pages = [{ id: "p", url: "https://x.test" }] } = {}) {
  const records = {
    clients: { c: { id: "c", organization: "o", services: "SEO" } },
    websites: { w: { id: "w", organization: "o", client: inconsistent ? "other" : "c" } },
    organizations: { o: { id: "o" } },
  };
  return {
    collection(name) {
      return {
        async getOne(id) {
          const value = records[name]?.[id];
          if (!value) throw Object.assign(new Error("not found"), { status: 404 });
          return value;
        },
        async getFullList() {
          if (name === "website_pages") return pages;
          if (name === "page_links" || name === "seo_issues" || name === "business_facts") return [];
          if (Object.values(DEFAULT_COLLECTIONS).includes(name)) return [];
          throw new Error(`unexpected collection ${name}`);
        },
        async getList() { return { items: [] }; },
      };
    },
  };
}

test("loads only a tenant-consistent job and real crawler inputs", async () => {
  const input = await loadJobInput(pbFixture(), { status: "running", organization: "o", client: "c", website: "w" });
  assert.equal(input.client.id, "c");
  assert.equal(input.pages.length, 1);
  assert.equal(input.previous_version, 0);
  assert.deepEqual(input.existing.keywords, []);
});

test("rejects forged cross-tenant relationships", async () => {
  await assert.rejects(loadJobInput(pbFixture({ inconsistent: true }), { status: "running", organization: "o", client: "c", website: "w" }), /inconsistent/);
});

test("requires crawler output rather than inventing strategy inputs", async () => {
  await assert.rejects(loadJobInput(pbFixture({ pages: [] }), { status: "running", organization: "o", client: "c", website: "w" }), /run a crawl/);
});

test("claims the oldest queued strategy job", async () => {
  const calls = [];
  const pb = {
    collection(name) {
      assert.equal(name, "strategy_jobs");
      return {
        async getList(page, count, options) {
          calls.push({ page, count, options });
          return { items: [{ id: "j1", status: "queued" }] };
        },
        async update(id, payload) { calls.push({ id, payload }); return { id, ...payload }; },
      };
    },
  };
  const job = await claimNextJob(pb);
  assert.equal(job.id, "j1");
  assert.equal(job.status, "running");
  assert.equal(calls[0].options.sort, "created_at");
});

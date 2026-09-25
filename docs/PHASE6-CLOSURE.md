# Phase 6 — Search Console Analytics & SEO Feedback

**Status: PHASE 6 — CLOSED** (2026-09-25, accepted by the product owner with 0 real rows)
Acceptance commit: `3df4a6d` (closure docs + zero-data display fix follow in the next commit).

## Closure condition
The real Google Search Console connection works and the real property
`sc-domain:tlalocsolfuturo.com` (permission `siteOwner`, match `MATCHED`) is connected and
validated. Google legitimately returns **0 rows** across the available history (~16 months,
search types web/image/video/news, `dataState` final and all). Phase 6 is not kept open
waiting for an external system to accumulate data.

## Accepted production results
- Real OAuth flow; Google account `bunkercreativomx@gmail.com` connected (status `connected`).
- Scopes: `webmasters.readonly` only (+ `openid`, `userinfo.email` for the account label).
- Refresh token encrypted at rest (AES-GCM, key in `/DATA/AppData/pocketbase-seo-secrets/gsc.key`); never returned to the browser, API responses or logs.
- Real token refresh by the worker without user interaction.
- Property discovery (`sites.list`) and mapping with manual confirmation.
- Real sync jobs `ojdjkj90272befa`, `pheclg0uzmz766t`, `t90jg9bmas5zfeo` → `completed_with_warnings` / `NO_DATA`, 0 rows; the repeated sync is idempotent (counts unchanged).
- Dashboard zero-data state: Clicks 0 · Impressions 0 · CTR — · Average Position — · Queries 0 · Pages 0 · Opportunities 0. CTR is never shown as 0% and position never as 0 without evidence.
- No invented metrics (no search volume, CPC, difficulty, conversions or revenue), no invented opportunities.
- Tests 319/319, lint, typecheck, production build; tenant isolation and OAuth security suites pass.
- tlalocsolfuturo.com was not modified (no content, deploy, repo push, publishing, sitemap or robots change).

## Follow-up: `GSC_REAL_DATA_VALIDATION_PENDING`
Not a Phase 6 blocker. Does not reopen Phase 6 unless it reveals a real bug.

Trigger: Search Console returns at least one real row for `sc-domain:tlalocsolfuturo.com`
(check with `python3 /opt/data/scripts/gsc-probe.py query 'sc-domain:tlalocsolfuturo.com' '{"startDate":"<16 months ago>","endDate":"<today>","dimensions":["date"],"type":"web","dataState":"final","rowLimit":1000}'`).

Steps:
1. Re-sync (Website → Integrations · Search Console → Sync Now, 90 days).
2. Compare Google API vs PocketBase for one real query / page / date (`gsc-probe.py query …` vs `gsc_*_daily` records).
3. Verify clicks.
4. Verify impressions.
5. Verify CTR (source value; aggregates = total clicks / total impressions).
6. Verify Average Position (impression-weighted for aggregates).
7. Run analytics opportunity detection (happens at the end of every sync).
8. If a legitimate opportunity exists: Accept / Ignore and verify persistence after refresh and logout/login.
9. Document the result below.

Rules: never create artificial data to complete this validation. 0 legitimate
opportunities with real data is still a valid result. Pass → append evidence here.
Fail → open a specific bug; do not rebuild the phase.

### Evidence
_(pending)_

## Known issues
- Google OAuth app is in **Testing** mode (test users only; refresh tokens expire after 7 days → reconnect). Moving the OAuth app to Production (Google verification) is a separate task before broad client adoption.

# Security TODO — REQUIRED before Phase 5

Status: OPEN · Owner: Bunker ops · Created 2026-09-24 (after Phase 4 acceptance)

Do NOT start Phase 5 until both items are closed. Never rotate while a
`content_jobs` / `strategy_jobs` / `crawl_jobs` record is `running`.

## 1. ROTATE PB SUPERUSER CREDENTIALS

Why: the previous superuser password was stored in plain text inside the
Portainer stack 14 compose (removed during the auth fix, but it was visible in
Portainer's UI/history).

Steps:
1. Confirm no running jobs (`status="running"` in content_jobs, strategy_jobs, crawl_jobs).
2. Inside container `pb-seo`: `pocketbase superuser upsert <email> <NEW_PASSWORD>`.
3. Update the protected file `/opt/data/.pb-seo-admin.txt` (mode 600).
4. Update the env of the 3 workers and redeploy them:
   `bunker-seo-crawler`, `bunker-seo-intelligence`, `bunker-seo-content`.
5. Verify each worker logs `authenticated` and processes a heartbeat cycle.
6. Revoke old sessions: rotate the superuser token key
   (`$app.refreshTokenKey` / Dashboard → superuser → "Invalidate all tokens")
   and confirm the old password fails `auth-with-password`.

## 2. ROTATE APP ADMIN PASSWORD

Why: `/opt/data/.pb-seo-login.txt` held the `admin@bunkercreativo.mx`
application password in plain text and it was used for automated smoke tests.

Steps:
1. Change the password of `admin@bunkercreativo.mx` (users collection).
2. Update `/opt/data/.pb-seo-login.txt` (mode 600) — or remove it and use a
   dedicated low-privilege test user for smoke tests.
3. Verify login at https://bunker-seo-autopilot.vercel.app/login.
4. Revoke old tokens (logout → `/api/bsa/logout` rotates the token key) and
   confirm the old password is rejected.

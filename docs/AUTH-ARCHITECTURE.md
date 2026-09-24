# Authentication & authorization architecture

## Principle

The web application (Next.js on Vercel) **never** holds PocketBase superuser
credentials. Every request runs as the signed-in user; PocketBase decides.

```
Browser ──(httpOnly session cookie: {token})──▶ Next.js server action / page
      └─ reconstruct PocketBase client with the user's token (authRefresh:
         verifies signature/expiry and loads role/org/status from the DB)
             ├─ reads + simple writes ─▶ PocketBase REST + collection API rules
             └─ workflows ─────────────▶ POST /api/bsa/*  (pb_hooks, same user token)
                                          ├─ actor = e.auth (users collection only;
                                          │  superuser tokens are rejected)
                                          ├─ load target records, check
                                          │  organization + client/website
                                          │  relationships + role + state transition
                                          ├─ write records + activity log in one
                                          │  DB transaction ($app.runInTransaction)
                                          └─ enqueue content_jobs (queued)
Workers (bunker-seo-crawler / -intelligence / -content) ─▶ PocketBase as superuser
         (trusted server infrastructure only; process queued jobs)
```

Tenant ids sent by the browser are never trusted: hooks derive
`organization/client/website` from the stored records and the authenticated
user; REST create/update rules verify relationships (`website.organization`,
`client.organization`, `website.client`) and make tenant fields immutable.

## Endpoints (pb_hooks/bsa_routes.pb.js)

All `POST`, require a `users` token (`$apis.requireAuth("users")`).

| Endpoint | Who | Checks |
|---|---|---|
| `/api/bsa/content/generate` | owner/admin/editor/strategist | website + approved opportunity/plan item in the user's org and same website/client; inputs validated; idempotent |
| `/api/bsa/content/edit` | writers | same org; not locked (approved/rejected/active job) |
| `/api/bsa/content/restore` | writers | same org; version exists |
| `/api/bsa/content/approve` | writers | same org; `awaiting_approval`; QA PASS; high-risk/warning acknowledgements |
| `/api/bsa/content/reject` | writers | same org; reason required; approved cannot be rejected |
| `/api/bsa/content/revision` | writers | same org; state allows it; no active job |
| `/api/bsa/content/{retry,recheck,continue,brief,cancel}` | writers | same org + state |
| `/api/bsa/strategy/record` | non viewer/client | record belongs to the website + org |
| `/api/bsa/organization` | org admin | own org only |
| `/api/bsa/logout` | any user | rotates the user's `tokenKey` → every issued token is revoked |

## Activity log (pb_hooks/bsa_activity.pb.js)

`activity_logs` has `createRule = null`: users cannot write it. Entries are
created only by trusted server code:

- route handlers above (same transaction as the change): `CONTENT_GENERATION_STARTED`,
  `ARTICLE_EDITED`, `ARTICLE_VERSION_RESTORED`, `ARTICLE_APPROVED`,
  `ARTICLE_REJECTED`, `REVISION_REQUESTED`, `STRATEGY_RECORD_UPDATED`, …
- record hooks on successful user REST mutations (`onRecordCreateRequest` /
  `onRecordUpdateRequest`): `CLIENT_CREATED/UPDATED/ARCHIVED`,
  `WEBSITE_CREATED/UPDATED/ARCHIVED`, `WEBSITE_ANALYSIS_STARTED`,
  `STRATEGY_GENERATION_STARTED`, `USER_INVITED`
- `onRecordAuthRequest` (users): `USER_LOGIN`
- worker transitions (`onRecordAfterUpdateSuccess`): `STRATEGY_GENERATED`
  (attributed to the user who triggered the job)
- the content worker keeps writing its own pipeline events.

Each entry stores `user`, `organization`, `action`, `entity_type`,
`entity_id`, `metadata`, `created_at`; reads are org-scoped by rule.

## Account guards

- users can edit only their own profile fields (not `role`, `organization`, `status`)
- org admins manage members of their own org only, cannot change their own
  role, cannot grant `super_admin`, cannot move members between orgs
- disabled accounts are refused by every workflow endpoint and by the app session

## Superuser usage that remains (trusted infrastructure only)

| Where | Why | Credential location |
|---|---|---|
| `bunker-seo-crawler`, `bunker-seo-intelligence`, `bunker-seo-content` | process queued jobs across tenants; write generated records whose collections are worker-only | container env on the private server (Portainer), never Vercel |
| `scripts/setup-pocketbase.mjs` (schema), deploy/backup scripts | migrations & maintenance | `/opt/data/.pb-seo-admin.txt` (mode 600) on the server |
| local test suites | fixtures & read-back only | local throwaway PocketBase |

PocketBase 0.40 has no scoped service-account/API-key primitive; a dedicated
auth collection with rule-based access would still need write access to every
worker-only collection (equivalent blast radius), so the workers keep the
superuser **only on the private server**. Rotation: `pocketbase superuser
upsert <email> <new-password>` inside `pb-seo`, update
`/opt/data/.pb-seo-admin.txt`, redeploy the three workers
(`deploy-seo-phase4.py worker`, phase 2/3 deploy scripts).

## Session security

- cookie `pb_auth` = `{token}` only (no user record, no password), `httpOnly`,
  `Secure` in production, `SameSite=Lax`, `path=/`, 5-day max-age
- the token is validated server-side on every request (`authRefresh`); role/org/status
  are re-read from the database, never from the cookie
- a fresh token is minted at login; the previous cookie is replaced (no fixation)
- logout calls `/api/bsa/logout`, which rotates the user's `tokenKey` (all
  sessions revoked), then deletes the cookie
- Server Actions are POST-only with Next.js origin checks (CSRF)

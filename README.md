# Bunker SEO Autopilot

Multi-tenant SEO platform with AI — **Phase 1: Foundation**.

This phase builds the solid base: authentication, multi-tenant architecture, client &
website management, activity logging, and backend-enforced tenant isolation. Later phases
add research, keyword strategy, content generation, QA, publishing, analytics and the
autopilot — the architecture is prepared for them but **none are implemented yet**.

## Stack

- **Next.js 16** (App Router) + **TypeScript** + **Tailwind CSS v4**
- **PocketBase** — database, auth backend, file storage, core data layer
- **GitHub** + **Vercel** (frontend deploy)

> PocketBase is the single backend. No Supabase / Firebase / Postgres / MongoDB.

## Architecture

Multi-tenant hierarchy:

```
Organization
├── Users (admin, client, editor, viewer, super_admin)
└── Clients
    └── Websites
```

Example:

```
Bunker Creativo
├── Home Systems → homesystems.com, secondary-site.com
├── Solace Skin Lab → solaceskinlab.com
└── Client 3 → website.com
```

Tenant isolation is enforced **in PocketBase access rules** (not just hidden UI), so a user
in Organization A can never read or write Organization B's data — verified by the test suite.

## Local Setup

Prereqs: Node 20+, a PocketBase binary (or Docker).

```bash
# 1. Install deps
npm install

# 2. Start PocketBase (any port; 8095 used here)
./pocketbase serve --http=127.0.0.1:8095 --dir=./pb_data

# 3. Create the superuser (one-time)
./pocketbase superuser upsert admin@seo.autopilot <STRONG_PASSWORD> --dir=./pb_data

# 4. Configure env
cp .env.example .env.local
# edit .env.local with your PB URL + superuser creds

# 5. Create the collections + access rules
npm run pb:setup

# 6. Run the app
npm run dev
# open http://localhost:3000
```

## PocketBase Setup

`npm run pb:setup` (scripts/setup-pocketbase.mjs) creates/updates all collections and access
rules idempotently. It requires the superuser to already exist.

## Environment Variables

See `.env.example`:

| Variable | Purpose | Secret? |
|---|---|---|
| `NEXT_PUBLIC_POCKETBASE_URL` | Public PB URL (browser + server) | No |
| `POCKETBASE_URL` | Server-side PB URL (optional, falls back) | No |
| `PB_ADMIN_EMAIL` | Superuser email — server-only (activity logs, org update, user invites) | **Yes** |
| `PB_ADMIN_PASSWORD` | Superuser password — server-only | **Yes** |

Never commit `.env.local` or real secrets.

## Collections

| Collection | Key fields | Notes |
|---|---|---|
| `organizations` | name, slug, status | Top tenant |
| `users` (auth) | name, organization, role, status | Roles: super_admin, admin, client, editor, viewer |
| `clients` | organization, business_name, slug, industry, description, languages, country, location, service_areas, target_audience, brand_voice, services, products, USP, CTA, phone, email, status | Belongs to one organization |
| `websites` | organization, client, name, domain, platform, language, country, target_locations, sitemap/robots/blog URL, status | Belongs to one client |
| `activity_logs` | organization, user, client, website, action, entity_type, entity_id, metadata | Written server-side only |

## Access Rules (multi-tenant)

Enforced in PocketBase — the security floor, not just UI:

- **organizations**: user sees only their own org (`@request.auth.organization.id = id`).
- **clients / websites**: list/view scoped to the user's org; create/update require the record's
  `organization` to equal the user's org AND role ≠ viewer. Delete is superuser-only (archive via status).
- **activity_logs**: read scoped to org; create/update/delete are superuser-only (app writes via admin client).
- **users**: user sees own org's users + self; admins can invite; users can edit self.

## Development Commands

```bash
npm run dev          # dev server
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run build        # production build
npm run test         # run test suite (needs seeded PB)
npm run test:seed    # seed test data (2 orgs, 2 clients, 2 websites)
npm run pb:setup     # create/update PocketBase schema
```

## Testing

The suite (`scripts/test.mjs`, Node's built-in test runner) runs against a **live PocketBase**
and verifies, at the backend level:

- Login works / invalid credentials rejected
- Client creation, editing, website creation
- Multiple websites per client
- Data persistence across sessions
- Activity logging scoped to org
- **Tenant isolation**: user A cannot read/list/create org B's clients or websites

```bash
npm run pb:setup
npm run test:seed
npm run test
```

## Build

`npm run build` must pass clean (lint + typecheck + production build). See the Phase 1 report.

## Deployment Notes

- **Frontend**: push to `main` → Vercel auto-deploys. Set env vars in Vercel
  (`NEXT_PUBLIC_POCKETBASE_URL` as Config; `PB_ADMIN_EMAIL`/`PB_ADMIN_PASSWORD` as Secrets).
- **PocketBase**: run a production instance (Docker/Portainer) reachable over HTTPS, point
  `NEXT_PUBLIC_POCKETBASE_URL` at it, and run `npm run pb:setup` against it once.

## How to create the first Super Admin

The platform's `super_admin` role is a **PocketBase superuser** (it bypasses all access rules).

1. Start PocketBase.
2. Create the superuser (one-time, from the CLI):
   ```bash
   ./pocketbase superuser upsert admin@seo.autopilot <STRONG_PASSWORD> --dir=./pb_data
   ```
   Or via the Admin UI (`/_/`) → Settings → Admins → New admin.
3. Run `npm run pb:setup` to create the schema.
4. Create the first **organization** and an **admin user** for it. Do this from the Admin UI
   (`/_/`) or a script: create an `organizations` record, then a `users` record with
   `role: "admin"`, `organization: <orgId>`, `status: "active"`, and a password.
5. That admin can now log in at `/login` and invite more users (admins can create users in
   their org).

> Never hardcode credentials. The superuser password lives only in your env / password manager.

## Future Architecture (not implemented in Phase 1)

The schema and data layer are ready for: SEO crawler, website audits, keywords, topic clusters,
content strategy, AI research/writer/QA agents, image generation, blog publishing, Next.js &
WordPress publishing, Search Console, analytics, and the autopilot. No decisions in Phase 1
block these.

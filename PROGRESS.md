# Progress

_Last updated: Wednesday 11 November 2026, ~12:20 Europe/Guernsey (session 1)._

Every session: read this file, [DESIGN.md](DESIGN.md) and
[docs/REQUIREMENTS_FROM_REVIEWS.md](docs/REQUIREMENTS_FROM_REVIEWS.md) (lessons from competitor reviews:
offline that never loses work, honest saved/sent/paid states, several contacts per site, safe defaults,
fast pages). Apply them to whatever milestone you are on. Do not widen scope beyond the build plan.

## Done (session 1)

1. **Monorepo scaffold.** pnpm workspaces (`apps/web`, `apps/api`, `packages/shared`), strict TypeScript,
   ESLint (flat config, react-hooks), Prettier, EditorConfig, GitHub Actions workflow (not pushed
   anywhere), `pnpm check` runs everything CI runs.
2. **Database.** Postgres 17 schema in `apps/api/migrations`:
   - tenants, users, memberships, customers, sites, **contacts with roles** (bill payer, on-site contact,
     tenant, landlord, letting agent, managing agent), number_sequences, quotes, quote_revisions,
     quote_lines, jobs, job_lines, idempotency_keys, audit_log.
   - Row-level security forced on every tenant table; the API connects as a non-owner role (`app_user`).
   - Composite `(tenant_id, id)` foreign keys so nothing can point at another business's rows.
   - `allocate_number()` hands out numbers inside the transaction with a row lock: quotes `Q-0001`,
     jobs continue from **122**, invoices gap-free (rollback releases the number).
   - `UNIQUE(jobs.source_quote_id)` guarantees a quote converts once.
3. **API** (Hono; same app runs in Node for dev and as a Cloudflare Worker, verified under `wrangler dev`
   with a local Hyperdrive connection): customers (+sites, contacts), quotes (create, edit draft, mark as
   sent, revise → rev B with the same number, accept with chosen extras, decline), **Convert to job**
   (row lock + unique backstop + `Idempotency-Key` replay), jobs (from scratch or from a quote, status,
   active filter, search, paging), `/me`. Plain-English errors with stable codes. Every write is audited.
4. **PWA shell.** Apple-HIG style UI with design tokens and reusable components (see DESIGN.md): bottom
   tab bar on phones, sidebar on desktop, large titles, sheets for create/edit, swipe actions, honest save
   status with retry, light/dark mode, reduced motion. Screens: Jobs list + job detail, Quotes list + quote
   editor (lines, extras, totals, status actions, revisions, create job), Customers list + detail (sites,
   contacts, quotes, jobs). Installable (manifest + service worker caching the app shell).
5. **Static preview build** (`apps/web/dist-preview`) running on in-browser demo data (fictional only) for
   Joe to review without any server. Labelled as a preview in the UI.

### Tests (all passing)

| Suite                                   | Count     | What                                                                                                                                                                                                           |
| --------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` (Vitest)              | 28        | money rounding, parsing, numbering, quote totals                                                                                                                                                               |
| `apps/api` (Vitest + real Postgres)     | 35        | numbering atomicity under 50 concurrent calls, rollback gap-free, RLS isolation, cross-tenant FK, single conversion (DB constraint, 10 concurrent taps, idempotent replay), validation, status flow, revisions |
| `apps/web` (Vitest + Testing Library)   | 3         | serial save ordering, honest save status                                                                                                                                                                       |
| `apps/web` e2e (Playwright, real stack) | 4         | customer → quote → line → sent → accepted → job, on mobile and desktop                                                                                                                                         |
| Screenshots (Playwright, preview build) | 36 images | 9 screens × mobile/desktop × light/dark in `screenshots/`                                                                                                                                                      |

## How to run

```bash
pnpm install
pnpm db:start                         # Postgres 17 on 127.0.0.1:54329 (npm binaries, data in .devdb/)
pnpm db:seed                          # migrate + fictional demo data; writes apps/api/.dev.vars
pnpm --filter @lse/api seed:reset     # wipe the LOCAL dev database and reseed
pnpm dev                              # API http://127.0.0.1:8787, web http://127.0.0.1:5173
pnpm --filter @lse/api dev:worker     # same API inside the Workers runtime (wrangler dev)
pnpm check                            # format, lint, typecheck, unit + integration tests, builds
pnpm test:e2e                         # Playwright against the real stack (needs db:start + db:seed)
pnpm --filter @lse/web build:preview  # static preview with demo data -> apps/web/dist-preview
pnpm --filter @lse/web screenshots    # rebuild preview and regenerate screenshots/
```

Static hosting of `dist-preview`: any static host; SPA fallback is in `public/_redirects`
(`/* /index.html 200`, Cloudflare Pages / Netlify format). Nothing has been deployed.

## Decisions made this session

- **Raw SQL migrations + postgres.js** instead of Drizzle: fewer moving parts, RLS and functions are
  first-class in SQL, works on Workers via Hyperdrive. Revisit if the schema grows unwieldy.
- **Dev-only auth**: the API trusts `X-User-Id` (or `DEV_USER_ID`) in `AUTH_MODE=dev`. Must be replaced by
  real sign-in (magic link / passkey) before anything is deployed.
- **Totals stored per revision** (computed by the shared pricing code) so lists are fast; line prices are
  always recomputed with the shared rules, never trusted from the client.
- **Labour without a price defaults to the business rate** (never £0). £0 or empty quotes can't be
  marked as sent (reviews: Tradify £0 trap).
- **"Mark as sent" records a fact**; sending email arrives with the approval inbox (AI drafts, Joe approves).
- **PC sums are labelled "Allowance"** in the UI and pass through at cost unless a markup is set.
- **Quote edits autosave** (serialised, latest-wins) with a visible Saving / Saved / Not saved · Retry.
- **Offline**: for now the app shell opens offline and says plainly that changes can't be saved; the real
  offline data layer (local DB + sync queue) is the next milestone in the plan.
- Static preview uses an in-browser mock of the API (`apps/web/src/demo/mockApi.ts`) that reuses the
  shared validation and pricing. It is excluded from the normal build.

## Next (in plan order)

1. **Real sign-in** (magic link or passkey) replacing dev auth; owner 2FA. Settings screen for business
   details (name, address, bank details, labour rate, markup, terms) with the pre-send completeness check
   (reviews M8).
2. **Offline data layer** (plan sessions 3–4): local SQLite/IndexedDB on the device, sync queue with
   idempotency keys (the API already supports them), draft numbers until sync, airplane-mode tests,
   persistence across app-kill (reviews M1).
3. Job detail: timesheets, materials, notes and photos; quote vs actual.
4. Quote PDF in the LSE layout; then supplier bills, invoices (incl. progress / part invoices, reviews M3),
   payments.
5. Polish backlog: edit customer/site/contact sheets, swipe-to-delete with undo on contacts, job editing
   sheet, list virtualisation for long histories, consider `zod/mini` to trim the bundle (134 KB gzip now).

## Open questions for Joe

1. Do the screens feel right? (See `screenshots/` or open the static preview.) Anything to rename?
2. Statuses: jobs use **To do / Booked in / In progress / Done / Cancelled**; quotes use **Draft / Sent /
   Accepted / Job created / Declined / Expired**. Happy with those words?
3. Old quotes: number them Q-0001 to Q-0014 on import (current plan), or start fresh?
4. Should "Customer said yes" be allowed straight from a draft (e.g. verbal yes before sending)? Currently
   it must be marked as sent first.
5. Product name for when it's sold (the app currently says "LSE Trade").

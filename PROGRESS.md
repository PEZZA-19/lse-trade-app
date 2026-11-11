# Progress

_Last updated: Wednesday 11 November 2026, ~12:50 Europe/Guernsey (session 2)._

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

## Done (session 2)

6. **Real sign-in (passwordless email link), replacing the dev `X-User-Id` header.**
   - `POST /api/auth/request-link` always answers 202 with the same message (emails can't be probed);
     links last 15 minutes, work once, and only their SHA-256 hash is stored. The token travels in the URL
     fragment (`/sign-in/verify#token=…`), so it never reaches server logs; the landing page needs a tap on
     **Continue**, so email link-scanners can't use it up, and it strips the token from the address bar.
   - Sessions: 30-day sliding, `HttpOnly; SameSite=Lax` cookie (`__Host-` + `Secure` over HTTPS), hashed
     at rest, revoked on sign-out, and instantly useless if the membership is removed.
   - Auth tables have **no grants** for the app role; it can only call `SECURITY DEFINER` functions.
   - **CSRF:** per-session token in `X-CSRF-Token` on every change + Origin check (+ SameSite).
   - **Rate limits** (Postgres fixed window): 5 links per email and 30 per IP per 15 min; 30 verifies per
     IP. IP from `CF-Connecting-IP`.
   - `GET /api/auth/session` (user, businesses, role, CSRF token), `POST /api/auth/switch-tenant`
     (membership checked), `POST /api/auth/logout`.
   - Email: a `Mailer` interface. Dev prints the link (`pnpm sign-in-link`); the Worker uses
     `UnconfiguredMailer`, which fails loudly. **No email is sent anywhere yet.**
   - Seed script and every API test sign in through the real flow (no back door left).
7. **Business settings** (`GET/PATCH /api/settings`, owner only; staff get 403) and a Settings tab:
   trading/legal name, address, phone, email, labour rate, default markup, **tax rate (0% default)**, quote
   validity, payment terms (14 days), bank details (sort code / account number validated), quote and
   invoice terms, and **numbering** (prefix, digits, next number per sequence, live preview; the next
   number must be above the last one used; prefixes are letters, `-` and `/` only so numbers can't
   collide). Changes are audited (changed fields only). Explicit Save with _Unsaved changes → Saving… →
   Saved / Not saved_.
8. **Pre-send completeness check** (reviews M8/A4): `GET /api/settings/readiness`, shared rule in
   `packages/shared/src/settings.ts`. Marking a quote as sent is refused (422 `business_details_missing`)
   until business name, address, phone or email, and a labour rate above £0 are set; the app disables the
   button and says what's missing with a link to Settings. Invoice readiness (adds bank details) is
   computed now for the invoice milestone.
9. **Offline saving and sync** (reviews M1/A3).
   - Server: `version` column on customers, quotes and jobs (bumped by trigger); quote and job edits
     accept `If-Match: <version>` and answer **409 `version_conflict`** with the current record.
   - App: an **outbox in IndexedDB** (`apps/web/src/offline/`). Job status changes and quote edits are
     written to the device first, survive reloads and the app being killed, merge per record (latest
     value per field), are sent in order with `If-Match` and an idempotency key, and leave the device
     only when the server confirmed them or the person discarded them. Only the signed-in business's
     edits are sent.
   - **Conflict rules:** (1) fields you didn't touch never conflict; (2) if only other fields changed
     elsewhere, your edit is re-sent on the new version automatically; (3) if the server already has your
     value, done; (4) same field changed on both sides → the Sync screen shows both values and asks
     **Keep mine / Use theirs**; (5) business refusals (e.g. quote sent from another device) show as
     "couldn't save" with the server's reason, with Try again / Discard. Network errors, 5xx and 401
     keep edits pending; retried on reconnect, on returning to the app and every 30 s.
   - **Honest sync states:** _Saved on this device · will sync_ (becomes _Saved_ once delivered); a sync
     badge ("2 changes saved on this device, waiting for signal" / "Syncing…" / "1 change needs your
     attention"); offline banner states exactly what works offline. **Mark as sent is disabled while
     the quote has unsynced edits.**
   - Server data the device has seen is persisted in IndexedDB (TanStack Query persister), so the app
     reopens offline with jobs and quotes (verified against the production build + service worker).
   - Sign-out deletes cached data and the outbox, warning first if edits haven't synced.

### Review lessons applied

From [docs/REQUIREMENTS_FROM_REVIEWS.md](docs/REQUIREMENTS_FROM_REVIEWS.md):

| Lesson                                          | What the app does now                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M1 / A3** Offline that never loses work       | Outbox in IndexedDB, saved before "saved" is shown, survives app-kill (unit-tested), retries, never drops silently; app reopens offline with cached data (PWA test)                              |
| **M1 / A4** Never show a false saved/sent state | _Saved_ only after server confirmation; _Saved on this device · will sync_ otherwise; Mark as sent blocked while edits are unsynced; offline banner and errors say "Nothing was saved" when true |
| **M6** Several contacts per site, with roles    | Contacts with roles (bill payer, on-site, tenant, landlord, agents) per customer and site (session 1)                                                                                            |
| **M8** Safe defaults before sending             | Labour defaults to the business rate, never £0; tax rate 0% set explicitly; pre-send check blocks sending until name, address, contact and labour rate are set                                   |
| **A4** No £0 or blank documents                 | £0/empty quotes can't be marked as sent; incomplete business details block sending                                                                                                               |
| **M3** Separate numbering                       | Quotes Q-0001…, jobs from 122; numbering editable in Settings but never reuses a number                                                                                                          |
| **M7** Approval-first                           | "Mark as sent" records a fact only; no email is sent by the app; sign-in mailer refuses to run unconfigured                                                                                      |
| **S5** Fast pages                               | Lists ordered by indexed columns; app shell cached by the service worker; cached data shows instantly                                                                                            |
| **A1/A2** Simple, fair                          | Multi-tenant from day one with per-business isolation (RLS) and per-session business switching                                                                                                   |

Still to do from the list: logo on documents (M8, with the PDF milestone), protecting settings from an
accounts sync (M8/A8, with Xero), creating records offline (M1, next).

### Tests (all passing)

| Suite                                        | Count     | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` (Vitest)                   | 35        | money, numbering, quote totals, **readiness rules, settings validation**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `apps/api` (Vitest + real Postgres)          | 69        | session 1 suite, plus **sign-in** (cookie flags, single use, expiry, hashes only, unknown email, logout, expired session, app role can't read auth tables), **CSRF** (missing/foreign token, foreign Origin), **rate limits** (per email, per IP), **tenant-scoped authorisation** (cross-tenant read/write, switching needs membership, data follows active business, removed membership revoked, staff can't change settings), **settings** (defaults, update + audit, validation, numbering never reuses), **pre-send check**, **versions / If-Match** |
| `apps/web` (Vitest + jsdom + fake-indexeddb) | 24        | serial save, save states incl. queued, API client (CSRF header, stale-token retry, 401 sign-out, offline message), settings form conversion, **outbox** (survives app-kill, merging, ordering, server errors, business isolation, all five conflict rules)                                                                                                                                                                                                                                                                                                |
| `apps/web` e2e (Playwright, real stack)      | 17        | sign-in setup; signed-out redirect, link reuse refused, sign-out; settings save survives reload; quote → job flow; jobs filter; **offline status change syncs on reconnect; same-field conflict → Keep mine; different-field auto-merge; offline quote edit blocks Mark as sent until synced** (mobile + desktop)                                                                                                                                                                                                                                         |
| PWA (Playwright, production build)           | 1         | app reopens offline from the service worker with cached jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Screenshots (preview build)                  | 40 images | 10 screens (now incl. Settings) × mobile/desktop × light/dark in `screenshots/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## How to run

```bash
pnpm install
pnpm db:start                         # Postgres 17 on 127.0.0.1:54329 (npm binaries, data in .devdb/)
pnpm db:seed                          # migrate + fictional demo data (owner@lse.example)
pnpm db:migrate                       # apply new migrations to an existing dev database
pnpm --filter @lse/api seed:reset     # wipe the LOCAL dev database and reseed
pnpm dev                              # API http://127.0.0.1:8787, web http://127.0.0.1:5173
pnpm sign-in-link                     # after requesting a link on the sign-in screen (no email is sent)
pnpm --filter @lse/api dev:worker     # same API inside the Workers runtime (wrangler dev)
pnpm check                            # format, lint, typecheck, unit + integration tests, builds
pnpm test:e2e                         # Playwright against the real stack (needs db:start + db:seed)
pnpm --filter @lse/web test:e2e:pwa   # production build: reopens offline with cached data
pnpm --filter @lse/web build:preview  # static preview with demo data -> apps/web/dist-preview
pnpm --filter @lse/web screenshots    # rebuild preview and regenerate screenshots/
```

Static hosting of `dist-preview`: any static host; SPA fallback is in `public/_redirects`
(`/* /index.html 200`, Cloudflare Pages / Netlify format). Nothing has been deployed.

## Decisions made (session 2)

- **Magic link first, passkeys later.** Works on any device with no extra hardware and fits Workers (Web
  Crypto only). Passkeys (WebAuthn) and owner 2FA are a follow-up once a real domain exists (they need a
  fixed RP ID).
- **Sessions in Postgres**, not JWTs: instant revocation and membership checks on every request; the
  extra lookup is one indexed primary-key read.
- **Email delivery deliberately not wired.** Needs a decision (business Gmail via API vs a provider such
  as Postmark/Resend) and a domain; the Worker refuses to pretend.
- **Settings save is explicit** (not autosave) because changes affect every future document.
- **Offline scope this session:** edits to existing jobs (status) and quotes (title, notes, lines, site)
  work offline. Creating customers/quotes/jobs offline needs client-generated IDs and draft numbers;
  that's next. Until then those actions say plainly they need signal.
- **IndexedDB via `idb`** (1 KB) rather than SQLite/WASM: enough for the outbox and cache; revisit with
  Capacitor (native SQLite) if data grows.

## Decisions made (session 1)

- **Raw SQL migrations + postgres.js** instead of Drizzle: fewer moving parts, RLS and functions are
  first-class in SQL, works on Workers via Hyperdrive. Revisit if the schema grows unwieldy.
- ~~Dev-only auth (`X-User-Id`)~~: replaced by real sign-in in session 2.
- **Totals stored per revision** (computed by the shared pricing code) so lists are fast; line prices are
  always recomputed with the shared rules, never trusted from the client.
- **Labour without a price defaults to the business rate** (never £0). £0 or empty quotes can't be
  marked as sent (reviews: Tradify £0 trap).
- **"Mark as sent" records a fact**; sending email arrives with the approval inbox (AI drafts, Joe approves).
- **PC sums are labelled "Allowance"** in the UI and pass through at cost unless a markup is set.
- **Quote edits autosave** (serialised, latest-wins) with a visible Saving / Saved / Not saved · Retry.
- **Offline**: (session 1) shell only; (session 2) outbox + cached data, see above.
- Static preview uses an in-browser mock of the API (`apps/web/src/demo/mockApi.ts`) that reuses the
  shared validation and pricing. It is excluded from the normal build.

## Next (in plan order)

1. **Offline, part 2:** create customers, quotes and jobs offline (client-generated UUIDs accepted by the
   API, "Draft" numbers shown until the server allocates Q-/job numbers on sync), offline line add on
   jobs, airplane-mode tests on a real iPhone/Android once Capacitor is in. Show pending local values on
   lists after a reload (overlay the outbox on cached data).
2. **Before any deployment:** choose the email sender for sign-in links, set `APP_ORIGIN`, create the
   Neon database and Hyperdrive config, make sure migrations run as a role that owns the tables (the
   `owner_access` policies in 0003 rely on it), add passkeys + owner 2FA.
3. Job detail: timesheets, materials, notes and photos; quote vs actual.
4. Quote PDF in the LSE layout (logo, legal name: completes M8); then supplier bills, invoices
   (progress/part invoices, M3; invoice readiness is already computed), payments.
5. Polish backlog: edit customer/site/contact sheets, swipe-to-delete with undo on contacts, job editing
   sheet, list virtualisation, `zod/mini` to trim the bundle (≈145 KB gzip now), shorter Settings labels
   on narrow phones.

## Open questions for Joe

1. Do the screens feel right? (See `screenshots/` or open the static preview.) Anything to rename?
2. Statuses: jobs use **To do / Booked in / In progress / Done / Cancelled**; quotes use **Draft / Sent /
   Accepted / Job created / Declined / Expired**. Happy with those words?
3. Old quotes: number them Q-0001 to Q-0014 on import (current plan), or start fresh?
4. Should "Customer said yes" be allowed straight from a draft (e.g. verbal yes before sending)? Currently
   it must be marked as sent first.
5. Product name for when it's sold (the app currently says "LSE Trade").
6. Sign-in links: happy with email links, or would you rather have Face ID / fingerprint (passkeys) as
   well from day one? (Needs the real web address first.)
7. Which email should sign-in links (and later quotes) come from: the business Gmail, or a sending
   service on the app's own domain?
8. Settings: anything else you want on every quote (e.g. registration body number, insurance)?

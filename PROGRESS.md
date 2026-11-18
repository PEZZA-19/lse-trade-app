# Progress

_Last updated: Wednesday 18 November 2026, early morning Europe/Guernsey (session 4: business overview and Xero-style reports)._

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

10. **Tradify-style job stages** (Joe's priority change), replacing To do / Booked in / In progress /
    Done / Cancelled.
    - **8 system stages per business** (migration `0005_job_stages.sql`, `create_system_stages()` runs for
      every new business; defaults shared in `packages/shared/src/stages.ts` and tested against the DB):
      Unassigned (grey), Assigned (indigo), Scheduled shown as **Booked in** (blue), In Progress
      (orange), To Invoice (purple), Complete (green, off the active list), On Hold (yellow), Cancelled
      (red, off the active list). Old statuses were mapped (open → Unassigned, completed → Complete, …).
    - **Automatic moves** (one shared rule, `autoStage()`, used by the API and the preview): assigning
      someone → Unassigned to Assigned; creating an appointment → Unassigned/Assigned to Booked in;
      starting the timer → In Progress (from anything except Complete/Cancelled, custom stages included);
      deleting the last appointment → Booked in back to Assigned (if anyone is assigned) or Unassigned;
      fully invoiced and paid → Complete.
    - **Manual moves** from the job screen (Stage picker) and the list (swipe: _To Invoice_ or
      _Complete_, _On Hold_, and _Stage_ for every stage). Manual moves go through `PATCH /jobs/:id`
      (`stageId` or `stageKey`), so they work offline via the outbox with `If-Match` like other edits.
    - **History:** every change, automatic or manual, writes `job_history` (from, to, cause, user, time;
      stage names snapshotted so history survives renames/deletes). Append-only for the app role (no
      UPDATE/DELETE grant). The job screen shows it newest first with a plain-English cause.
    - **Custom stages** (Settings → Job stages, owner only): name, colour (10), active flag, order. System
      stages can't be renamed or deleted except To Invoice and On Hold; their active flag is fixed, colour
      and order can change. Names unique per business; a stage with jobs in it can't be deleted.
    - **Lists:** coloured chips; filter **Active / All / Stage…** (Active = jobs whose stage has the
      active flag).
    - **Stubs, so the transitions are wired before those features exist** (tested, no UI yet):
      `job_assignees`, `appointments`, `job_timers` tables with `POST/DELETE /api/jobs/:id/assignees`,
      `POST /api/jobs/:id/appointments`, `DELETE /api/appointments/:id`,
      `POST /api/jobs/:id/timer/start|stop` (one running timer per person). **Invoices don't exist yet:**
      `markFullyInvoicedAndPaid()` in `apps/api/src/services/jobs.ts` is the hook the invoice/payment
      milestone must call; it is tested at the service level and not exposed over HTTP.
    - Demo data: job 122 booked in today then timer started (In Progress), extractor fan booked in, PAT
      testing Complete via To Invoice, a custom "Waiting on parts" stage, an Unassigned call-out.

11. **Scheduler, timer, assigning staff, Home tab** (on top of the stage stubs; migration
    `0006_schedule_timesheets.sql`).
    - **Tabs:** phones show **Home, Jobs, Schedule, Quotes, More** (Apple's limit of five); Customers,
      Settings and Sync live under More, and the More tab stays highlighted inside them. The desktop
      sidebar lists everything. Signing in now lands on Home.
    - **Home / Today:** running-timer card (live clock, Stop), quick create (New job, Book, New quote,
      Customer), today's appointments with Start/Stop per job, jobs In Progress, and jobs not booked in
      yet. Honest empty and error states.
    - **Schedule:** Apple Calendar-style **Day** (week strip, red "now" line), **Week** (7 columns)
      and **Month** (dots on phones, times and job numbers on desktop; tap a day to open it). Overlapping
      appointments sit side by side. Tap an empty half-hour to book (pick the job, time, person); tap an
      appointment to move, reassign or delete it; **drag to move** (mouse: drag; touch: press and hold,
      then drag), snapping to 15 minutes, across days in Week view. Moves show at once and roll back
      with a Retry toast if refused. Coloured by job stage. Booking drives **Booked in**; deleting the
      last appointment steps the stage back (from the previous milestone).
    - **API:** `GET /api/members`, `GET /api/appointments?from&to` (overlap, max ~2 months),
      `PATCH /api/appointments/:id` (move/resize/reassign, audited; checks the person is in the
      business), `GET /api/timer`.
    - **Job timer:** Start/Stop on the job screen, Home card and today's appointments. Starting drives
      **In Progress**. **Stopping creates a timesheet entry** (`timesheets` table, linked to the job and
      the timer) shown under "Time" on the job with a total. One timer per person: starting on another
      job asks "Switch timer?", which stops the first (recording its time) and starts the new one.
    - **Timer works offline:** start/stop are saved on the device as outbox _actions_ with the time
      they happened (`at`), shown at once, and sent in order when there's signal with an idempotency
      key (replays are harmless). The server trusts the device clock within 7 days back / 5 minutes
      ahead and never records negative time. A refusal (e.g. timer already running elsewhere from
      another device) shows on the Sync screen like any other.
    - **Assign staff:** "Assigned to" on the job with a tick-list sheet of the business's people;
      assigning drives **Assigned**. Demo data adds a fictional staff member, Sam Spark.
    - After cached data is restored on launch, screens refresh from the server unless edits are still
      waiting to sync (fixes the stale chip after a quick reload noted earlier).
    - Assigning and booking need signal (they say so if offline); creating appointments offline is
      in "Next".

### Done (session 2, chunk 4: price list, kits, invoices)

- **Price list** (More → Pricing → Price List): items with code, supplier, unit, cost, markup (or the
  business default) and sell price (a fixed sell price overrides the markup). **CSV import** shows a
  preview (new / changed with old → new / unchanged / errors) before anything is saved; rows match on
  code, else supplier + description; only columns present in the file change an item. Export to CSV.
  Every cost change is kept in **price history** (created / manual / CSV / supplier bill, who and when).
  Items used in a kit can't be deleted (switch them off instead).
- **Supplier-bill price update** is a tested service only (`applySupplierBillPrices` in
  `apps/api/src/services/pricelist.ts`): matched lines update the cost with history source
  "supplier bill" and the bill reference; unmatched lines are reported, never created. No route or UI yet.
- **Kits** (More → Pricing → Kits): a named set of price-list items with quantities, cost and sell worked
  out live. When any item's cost changes, every kit using it records its **old and new cost and sell**
  (shown on the kit and on the item change).
- **Kits on quotes:** "Add kit" adds one costed block (Kit pill, components listed) with a frozen
  snapshot. If prices have moved, a draft shows "Kit price now £x (was £y)" with **Use New Price**;
  **Expand into Items** turns it into normal lines. Sent quotes never change (existing lock).
- **Invoices** (More → Money → Invoices, plus an **Invoices section on each job** where invoicing starts):
  - Create from a job (**time and materials**: unbilled timesheets and materials, reserved so they can't
    be billed twice) or from the quote (**whole, deposit, percentage**, and **remainder** after earlier
    invoices).
  - Statuses Draft → Approved → Sent → Part paid → Paid; **Overdue** is worked out from the due date.
  - Numbers are the **job number, then 122-2, 122-3…**, allocated only at approval so there are no gaps;
    only drafts can be deleted. Approval needs a billing email and readiness checks, and records who
    approved and when. 14-day terms with the 5%-a-month wording; carriage hidden when zero.
  - **Every decision is an explicit owner tap with a confirm sheet** (Approve, Mark as Sent, Record
    Payment); the server refuses staff (owner only). Mark as Sent records the fact; nothing is emailed.
  - Payments (bank transfer, cash, card, cheque, other; no overpaying, no future dates). When the job is
    fully invoiced and paid, the payment calls **`markFullyInvoicedAndPaid()`** and the job moves to
    **Complete**.
- Demo data: fictional supplier price list (10 items), two kits, draft quote Q-0007 with a kit whose
  cable cost has since risen, job 122 with a paid 30% deposit invoice and a remainder draft, and a
  part-paid time-and-materials invoice.

### Done (session 2, chunk 5: PDFs, supplier bills, suppliers, credit notes)

- **Quote, invoice and credit note PDFs in the LSE layout** (from the LSE layout notes on the box and
  the spec): logo square (business initials until a logo can be uploaded), business name, address,
  email and mobile; who it's for and the job/site; labour itemised (hours), then materials, allowances
  and other; carriage only when it isn't zero; no VAT wording unless a tax rate is set; total, paid,
  credit notes and balance due; a "How to pay" box with the bank details and reference `INV n`; terms
  (quotes: valid for N days). Text wraps properly, tables repeat their headings across pages, "Page n of
  m" only when there is more than one page, no vendor footer. Drafts carry a DRAFT watermark.
  - One layout model (`packages/shared/src/documents.ts`) drives both the **in-app preview** (HTML paper
    that scales to the screen) and the **PDF** (`pdf-lib`, pure JS: runs in the Cloudflare Worker and on
    the device). Server routes: `GET /api/{invoices|quotes|credit-notes}/:id/document` and `/pdf`
    (inline, `private, no-store`). Offline, or in the preview, the phone renders the same PDF itself.
  - **Preview PDF** row on quotes, invoices and credit notes opens a large sheet with **Share** (the
    iOS/Android share sheet with the PDF file, else a download). Sharing never changes a status: draft
    invoices and credit notes can be previewed but not shared; quotes can't be shared while edits are
    unsynced or settings are incomplete; after sharing an approved invoice the app reminds you to tap
    Mark as Sent.
  - The business address, bank details and terms all come from **Settings**; nothing is hardcoded. The
    demo uses "Demo Workshop, Little Sark (fictional)" and bank 11-22-33 / 12345678.
- **Supplier Bills** (More → Money → Supplier Bills; sidebar on desktop):
  - Enter a bill or a **supplier credit note**: supplier (picked or typed; new ones are added), reference,
    date, optional job. Lines **by hand**, from a **CSV** (forgiving headers; Total ÷ Qty works out the
    unit cost; bad rows are listed with their row numbers) or **alongside a PDF** (the file name is kept;
    lines are typed while reading it; automatic reading comes later).
  - Lines are **matched to the price list** (code, then supplier + description); each shows On list
    (with list cost → bill cost) or Not on list; tap to change the match, switch off "Update list cost",
    or choose where it goes (Job / Stock / Home).
  - **Review and Apply…** (owner only) shows every price change, every kit that recalculates (old → new
    cost and sell) and the job materials at sell price **before anything changes**; Apply then runs the
    existing price-update service (history source "supplier bill" with the reference) and locks the bill.
    Credit notes never change list prices and reduce job costs instead.
  - Lines on a job become **job materials** (cost × the item's markup, else the default markup) and are
    picked up by the next **time-and-materials invoice**. The job screen now shows "Quoted work" and
    "Materials and extras" separately.
  - Duplicate bill references per supplier are refused; a job allocation without a job is refused.
- **Suppliers** (More → Pricing → Suppliers): list with price-list item count, bills and net spend
  (applied bills less credit notes; a supplier only in credit reads "£48.00 credit"); detail with email,
  phone, account number and notes (owner edits; renaming also renames it on price-list items) and all
  their bills.
- **Customer credit notes** (on a sent or part-paid invoice: "New credit note…"): amount (never more than
  is owed, counting other drafts) and a reason. Saved as a **draft that changes nothing**; the owner taps
  **Approve Credit Note…** (confirm sheet: "It becomes credit note CN-0001 and £x comes off invoice 125…
  Nothing is sent"). Approval takes the next **CN-** number (gap-free, in the same transaction), reduces
  the invoice balance, shows on the invoice and its PDF, and, if that settles the job, moves it to
  Complete. Only drafts can be deleted. Payments respect credits (no overpaying).
- Demo data (fictional): Island Electrical (demo) contact details; an applied stock bill; a Sarnia
  Wholesale credit note; today's draft bill for job 122 with a cable price rise (£1.12 → £1.24) and an
  unmatched line; credit note CN-0001 on the PAT invoice.

### Done (session 2, chunk 6: logo, PDF bill reading, statements, enquiries, AI approvals, reports)

- **Logo**: Settings › Logo upload (PNG/JPEG, resized on the device, stored in the database), shown on
  quote, invoice and credit-note PDFs; LSE's logo seeded for the demo and used for the app icons.
- **Supplier PDFs read on the device** (pdf.js via `unpdf`, in its own `@lse/shared/pdftext` entry so the
  API bundle never loads it): CEF (several invoices per PDF, wrapped descriptions, "less 35%"
  discounts, due date from "Settlement thirty days"), DOCI (RRP, Date Payable, order and your-reference)
  and CI Lighting statements (rotated page, INV/CRN/CAS/DIS rows, running balance checked). Every
  bill is checked (lines × qty, sum = goods, goods + VAT = total) and shows "Adds up" or the problems;
  a job is suggested from the order reference; Save Drafts goes through the usual review-then-apply.
  Unknown layouts get an "Ask the AI helper" button (fake model only, logged, monthly cap).
- **Statement check** (Supplier Bills › Check a Statement…): matches each statement line to the bills
  here (matched / amount differs / not in the app / payments), lists bills not on the statement, and
  confirms the balance due.
- **Privacy**: Joe's real PDFs stay in `/workspace/bill-samples` (outside the repo). A local-only test
  reads them and skips anywhere they are missing; the repo has synthetic look-alike PDFs (fictional
  names, addresses and accounts) in `packages/shared/test/fixtures` and `apps/web/public/samples`.
- **Enquiries** (Home › Enquiries, also More › Inbox and the sidebar): To Do and Done lists, a manual
  New Enquiry sheet, and a public form endpoint `POST /api/public/enquiries/:formKey` (per-IP and
  per-form rate limits, honeypot/link/keyword spam rules that silently accept, Turnstile stubbed; the
  form key is set in Settings › Enquiry Form). Actions: turn into a Quote, a Job, or a Job with an
  Appointment (finds the customer by email or phone, or adds them), Mark Actioned, Reject (private
  reason).
- **Approvals inbox** (Home › Approvals, Home tab badge): AI helpers only make drafts: reply emails to
  enquiries, overdue reminders, quote drafts from enquiries, and price-update suggestions from a bill.
  Each card says "Will do: …", shows a preview, and waits for the owner: Approve, Edit or Discard.
  Approved emails wait 2 minutes with a Stop button and a countdown; with no email sender connected
  they end as "Not sent" (nothing can leave the app). Quote drafts become a draft quote; price updates
  apply the bill. Every model call (`ai_calls`), draft and decision (`proposal_events` + audit) is
  logged and shown in the card's Log.
- **AI Gateway**: one interface, pluggable providers; a deterministic fake provider for tests, the
  local stack and the preview; a Cloudflare Workers AI provider written but not configured. Outputs are
  validated with zod; a monthly spend cap (default £5) stops calls.
- **Reports** (More › Reports, owner only, sidebar on desktop): This Month / Last Month / This Year.
  Money in (payments), invoiced less credit notes, supplier bills applied, owed now and overdue;
  profit per job (accepted quote ex VAT, or the job lines when not quoted, minus time at the labour
  rate and materials at cost, with margin %); time by person and by job.
- **Navigation (still 5 tabs)**: Approvals and Enquiries hang off Home (inbox cards and a badge on the
  Home tab: "Home, N to check" for VoiceOver); Reports sits under More › Money; the statement check
  under Supplier Bills.

### Done (session 3, chunk 7: job detail, cost rates, honest profit, stages, offline create, deploy stubs)

- **Staff cost rates** (Settings › Team: base + tax and on-costs, owner only), report year setting,
  **CSV export** of reports. Tax and on-costs can be a **% of the base** or a **fixed £/h** (segmented
  control); a percentage is saved as the £/h it comes to (rounded half up to the penny, e.g. £20 +
  22.5% = £24.50) and a database check keeps the two consistent (migration 0017; existing rates stay
  fixed amounts), so reports, quote vs actual and the CSV all use the same figure.
- **Job detail**: time logged by hand (owner for anyone, staff for themselves; overlaps, future time,
  over 16 h and invoiced time refused; **cannot overlap a running timer**), materials by hand (price =
  cost × markup unless typed; quote and invoiced lines locked), notes, **photos** (resized on the phone,
  type-sniffed, max 3 MB, served same-origin with a strict CSP; R2 adapter ready, 503 until a bucket
  exists). Every change is audited. Lists answer 404 for a job another business owns.
- **Honest profit** (Quote vs Actual and Reports), like Xero Projects / Tradify:
  - **Profit so far** = invoiced (ex VAT, less approved credit notes) − labour at cost − materials at cost.
  - **Expected profit** = the quote − expected cost, where expected cost never assumes less than has
    already been spent: max(quoted labour at cost, actual) + max(quoted materials at cost, actual).
  - Demo job 122: so far £509.16, expected £704.28 (38%) instead of the old misleading figure.
- **Job stages hardened**: removing the last person steps Assigned → Unassigned (history cause
  "Last person unassigned", migration 0015); the timer is refused on a cancelled job; custom stages
  are kept by assign/book; a full event × stage matrix test.
- **Offline create** for customers, quotes and jobs: creates are replay-safe (Idempotency-Key); with no
  signal the same request is queued **under the same key**, so a request that did reach the server is
  never made twice. Lists show an honest "Waiting to sync" section (no fake numbers or pages); the
  Sync screen names them ("New customer"). A quote or job for a customer still waiting to sync has to
  wait until it syncs.
- **Deploy-readiness stubs** (nothing deployed, no accounts): Worker `scheduled()` cron every minute
  releases held emails through one narrow function `held_due_tenants()` (migration 0016; only business
  ids, the release runs in each business's RLS scope); fail-closed slots in `services-for-env.ts` for
  email (sign-in and approved), Turnstile (website form answers 503 until `TURNSTILE_SECRET`; the stub
  that accepts anything can no longer reach a Worker) and R2 photos. Checklist: `DEPLOY.md`.
- **Private local demo support** (generic code only): `pnpm --filter @lse/web build:local-demo` makes a
  single HTML file (hash routing, no service worker, everything inlined) with a seed hook that reads an
  **external** JSON file. The real-bill demo is built outside the repo and is never committed or put in
  the preview.

Tests now: shared 127 (+1 local-only skipped), API 182, web 49, e2e 30 mobile + 1 skipped (incl.
setup), all passing. New screenshots: `53`–`58` (team cost rate, job detail time/material/notes/photos,
quote vs actual), `59-offline-create` (mobile light/dark, taken from the real stack).

### Done (session 3, 11 Nov evening: charge-out per person, admin access)

- **Charge-out rate per person** (Q22): Settings › Team › person has an editable charge-out rate next to
  the cost rate. Empty = the business labour rate (£45/h), so existing data is unchanged (migration
  0018, no row = default). Job costing, Quote vs Actual, Reports, the CSV and time-and-materials
  invoice lines use each person's own rate.
- **Admin-controlled access (Tradify-style)**: Settings › Access (admins only) lists everyone with a
  preset (Admin, Office, Field worker, Subcontractor, or Custom) and per-area switches: Accounts
  (invoices, credit notes, supplier bills, statements, payments, suppliers), Reports and profit
  (incl. Quote vs Actual), Cost rates, Quotes and pricing (quotes, price list, kits), Settings.
  Enforced by the API for every route in an area (403 `no_access`), not only hidden: menus, Home's
  "New quote", the job's invoicing and Quote vs Actual sections follow it, and a shared link shows a
  "No access" screen. The owner is always an admin; there is always at least one admin. Only admins
  change access and rates (`admin_only`). Defaults keep today's behaviour: staff and accountants =
  Office (accounts, quotes, settings view), subcontractors = Field worker (jobs, schedule, own time).
  Migration 0019 (no row = the role's default). Screenshot `60-settings-access` (and `54` refreshed with the charge-out field).

Tests now: shared 129 (+1 local-only skipped), API 188, web 52, e2e 31 mobile + 1 skipped (incl.
setup; new `access.spec`: Sam as Field worker sees no accounts/quotes/settings and gets "No access" on
a link, then sees them once switched on), all passing.

### Done (session 3, 11 Nov late evening: calendar subscription feed)

- **One-way calendar feed (iCal)**: More › Calendar (everyone can open it, whatever their access) makes a
  private link of the person's booked jobs (booked with them, or unbooked-person appointments on jobs
  they're assigned to). Owner and admins can also have an "All jobs" link. Buttons: Copy Link, Add to
  Google Calendar (`calendar.google.com/calendar/r?cid=webcal://…`), Add to Outlook
  (`outlook.live.com/calendar/0/addfromweb?url=…`), Open in Calendar App (`webcal://`), Regenerate
  Link (asks first; the old link 404s at once) and Switch Off. Note on screen: changes show up in
  Google or Outlook within a few hours.
- **Feed** `GET /api/public/calendar/<43-char token>.ics`: RFC 5545 (CRLF, 75-octet folding that never
  splits a character, TEXT escaping, `UID:<appointment id>@lse-trade` stable across fetches, `DTSTAMP`,
  timed events in UTC, whole-day bookings (local midnight to midnight, Europe/London) as all-day
  `VALUE=DATE` events, `X-WR-TIMEZONE`, 1-hour refresh hint). Cancelled jobs and deleted bookings drop
  out; window 60 days back to 400 days ahead. Event text: job number and title, customer name and
  phone, site address, who it's with, a link to the job. Never prices or money. Admin-only feeds stop
  (404) if admin is taken away; a removed member's links stop too. Rate-limited per IP and per link.
  Checked with an independent parser (Python `icalendar`) as well as the tests.
- **Data**: migration 0020 `calendar_feeds` (one row per person and scope, each person sees only their
  own; token lookup through one narrow definer function). Tokens are stored as-is so the link can be
  shown again (like Google's "secret address"); anyone with database access could read them. Hashing
  would mean showing the link only once.
- **Demo**: the file:// demo can't serve a feed, so More › Calendar says "Works once the app is online"
  and offers a one-off **.ics download** of the demo bookings.
- **Fix found on the way** (migration 0021): `held_due_tenants()` (the cron that releases held emails)
  couldn't read `proposals` on a non-superuser database (FORCE RLS binds the owner), so once deployed it
  would never have released anything. Added a read-only owner policy, the same pattern as 0003.
- Screenshot `61-calendar` (mobile light/dark, taken from the real stack: `CAPTURE=1` on
  `e2e/calendar.spec.ts`).

Tests now: shared 135 (+1 local-only skipped), API 194, web 52, e2e 32 mobile + 1 skipped, all passing.

### Done (session 3, 11 Nov late evening: stage picker, prices hidden, private demo with real jobs)

- **Job stage picker** (Joe's Windows feedback: the native dropdown was faint, small, right-aligned
  and every stage looked the same): replaced with an accessible listbox (`components/Stage.tsx`,
  `StagePicker`). Each stage shows its own colour dot (the same palette as the stage pill and
  pipeline, separate light and dark shades), full-contrast 16px left-aligned system-font text, a
  tick on the current stage. Keyboard: arrows, Home/End, Enter/Space, Escape, type-ahead; screen
  readers get `listbox`/`option`/`aria-selected`/`aria-activedescendant`. The list opens in a portal
  with fixed position so cards never clip it, flips upwards near the bottom of the screen and closes
  on resize. Checked in desktop Chrome light and dark. e2e `stages.spec.ts` covers mouse and keyboard;
  `offline.spec.ts` updated. All screenshots refreshed; new `62-stage-picker-open` (desktop light and dark).
- **Prices hidden** from anyone without Quotes and pricing or Accounts access (Q31): see Q31 below.
- **Private demo with Joe's real jobs** (outside the repo; never in git, tests or the preview):
  `/workspace/lse-demo-local-build/real-jobs-calls.mjs` reads
  `/workspace/lse-private-data/real-jobs.json` and replays it through the demo's mock API at build
  time. The invented example jobs go; the real CEF/DOCI bills and CI Lighting statement stay. Mapping:
  Quoting → a sent quote (not a job yet); In progress → In Progress; Completed (work done, invoice
  not sent) → To Invoice with a draft invoice; Invoiced → Complete with an approved, sent invoice;
  Paid → paid; the `on_hold_not_billable` flag → On Hold. No VAT. Result: 47 customers, 44 jobs,
  3 open quotes, 8 sent invoices. Known gaps: negative lines (credits, e.g. "Rent payments" on job 14
  and one each on jobs 79, 108, 110, 111) aren't in the demo, because quote lines can't be negative,
  so those totals differ from Joe's sheet; job 52 (paid) has no customer email, so its invoice stays a
  draft (approving needs a bill payer email); job numbers are the app's own, not Joe's. Smoke test:
  all checks pass from file:// with the real data.

Tests now: shared 136 (+1 local-only skipped), API 196, web 52, e2e mobile all passing.

### Design note: two-way calendar sync (Google and Microsoft) — engine built in session 4, sign-in not yet

- **Connect**: per person, Settings › Calendar › "Connect Google" / "Connect Microsoft 365" via OAuth
  (Google: `calendar.events` scope on a dedicated "LSE jobs" calendar the app creates, not the whole
  account; Microsoft Graph: `Calendars.ReadWrite` + `offline_access`). Refresh tokens encrypted at rest
  (Worker secret key), revocable from the app; disconnect deletes them.
- **App → calendar**: on appointment create/move/delete, enqueue an outbox job (same pattern as held
  emails) that upserts the event by our id (Google `extendedProperties.private.lseId`, Graph
  `singleValueExtendedProperties`) and stores the provider event id and etag. Retries with backoff;
  never blocks the booking.
- **Calendar → app**: only for events in the LSE calendar. Google push notifications (`events.watch`,
  renewed before expiry) or Graph subscriptions (renewed every ~3 days), each followed by an
  incremental sync (Google `syncToken`, Graph delta query). A moved or deleted event becomes a
  **proposal** in Approvals ("Sam moved Job 122 to Thursday 9:00: apply?") rather than a silent
  change, in keeping with "AI drafts, Joe decides". Optional per business: apply moves automatically.
- **Conflicts**: last writer wins by `updated` timestamp; if both changed since the last sync, keep the
  app's version and raise a proposal. Events created in the calendar by hand are ignored (or offered
  as "make a job?").
- **Busy time** (later): read free/busy from the person's main calendar to warn about clashes when
  booking, without copying private event details.
- **Needs**: Google Cloud project with OAuth consent (verification for the sensitive scope), Azure app
  registration, a public HTTPS webhook endpoint, and Joe's go-ahead for both accounts. Nothing was
  created tonight.

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
| **A4** Honest states (stages)                   | Every stage change is recorded with who, when and why; automatic moves are labelled as such (e.g. "Timer started"); deleted stages keep their name in history                                    |
| **M1** Timer that never loses time (offline)    | Start/stop saved on the device with the real time and synced later; replay-safe; the clock never goes negative; refused actions are shown, never dropped                                         |
| **A4** Honest states (schedule/timer)           | Moves show instantly but roll back with Retry if refused; "Timer started on this device · will sync" until delivered; Home and Schedule show real empty/error states                             |
| **S5** Fast pages (schedule)                    | Appointments fetched per visible range with an index on start time; previous range kept on screen while the next loads                                                                           |
| **M3** Invoice numbering (job-based, no gaps)   | Invoice number = job number, then -2, -3; allocated only on approval; drafts have no number and are the only invoices that can be deleted                                                        |
| **M7** Approval-first (money)                   | Approve, Mark as Sent and Record Payment each need an owner tap and a confirm sheet; server enforces owner-only; nothing is emailed; job only completes when fully invoiced and paid             |
| **A4** Honest prices                            | Kit price changes show old → new and never alter a sent quote; CSV import previews every change first and never blanks columns missing from the file; price history keeps every cost change      |
| **A4** No double billing                        | Time-and-materials invoices reserve the timesheets they bill; remainder invoices subtract what's already invoiced; overpayment refused                                                           |
| **M7** Approval-first (bills, credit notes)     | Supplier bills change nothing until the owner reviews every price, kit and job change and taps Apply; credit notes are drafts until the owner approves; nothing is emailed or shared by the app  |
| **A4** Honest documents                         | The PDF is built from the same model as the on-screen preview; drafts are watermarked and can't be shared; no VAT wording when no tax is charged; carriage hidden at £0                          |
| **M3** Credit note numbering                    | CN-0001… allocated only on approval inside the transaction (no gaps); approved credit notes can't be deleted                                                                                     |
| **A4** No double billing (materials)            | Bill lines go onto the job once (the bill locks on apply); T&M invoices reserve the job lines they bill; a credit can never exceed what is owed                                                  |
| **A1/A2** Simple, fair                          | Multi-tenant from day one with per-business isolation (RLS) and per-session business switching                                                                                                   |

**Bugs found in my own review this chunk (and fixed, with tests):**

| Found by                   | Bug                                                                                           | Fix                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Screenshot review (item)   | Editing an item's cost cleared its code, supplier and markup (zod `.partial()` kept defaults) | Explicit PATCH schema; API + shared tests that a one-field edit changes only that field   |
| Screenshot review (import) | CSV import without a Markup column wiped existing markups                                     | `importChanges()` only touches columns present in the file (API and preview mock), tested |
| Code review (autosave)     | Quote autosave dropped the kit snapshot, turning kits into plain lines                        | `quoteLinesToInput` keeps `kit`                                                           |
| e2e                        | Payment sheet kept the previous amount after a part payment                                   | Sheet is mounted only while open                                                          |
| e2e (strict selectors)     | Ambiguous labels (CSV text box vs file input; sidebar vs More link)                           | Role-based selectors scoped to the main area                                              |

**Bugs found in my own review this chunk (and fixed):**

| Found by             | Bug                                                                                                               | Fix                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Box restore (~14:03) | The box was restored mid-chunk: uncommitted API files, a test and node_modules were lost; Postgres data dir broke | Rebuilt the lost files, reinstalled, re-created the dev DB. **Lesson: commit after every working step** (done since) |
| API test             | A new business had no supplier rows, so bills from a price-list supplier created a second spelling                | New suppliers reuse the price-list spelling                                                                          |
| Code review (bills)  | A line allocated to "Job" on a bill with no job silently became stock                                             | Refused at save with "Pick the job first…" (API + mock)                                                              |
| Screenshot review    | Picker values were right-to-left, so long job names showed their end ("…lighting · 122")                          | Selects keep the start of the value with an ellipsis (all screens)                                                   |
| Screenshot review    | A supplier you only had credit from showed "-£48.00"                                                              | Reads "£48.00 credit"                                                                                                |
| Screenshot review    | Editing an existing bill line focused the description, scrolling long text to its end                             | Only a new line gets focus                                                                                           |
| e2e                  | Credit notes needed the invoice balance everywhere (list, payments, PDF)                                          | `balance = total − paid − credited` in one place (API, mock, shared status rule)                                     |

Still to do from the list: uploaded logo on documents (M8; initials for now), protecting settings from an
accounts sync (M8/A8, with Xero). Creating records offline is done (session 3).

### Tests (all passing)

| Suite                                        | Count                   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` (Vitest)                   | 127 (+1 local)          | **new: PDF bill reading (CEF, DOCI, CI Lighting statement from synthetic PDFs), bill checks, statement reconciliation, logo on documents, enquiry spam rules; local-only real-sample test** · documents (LSE layout: sections, carriage/tax hidden at zero, draft numbering, quote extras and validity, wrapping, multi-page PDFs), supplier bills (CSV parsing, totals), credit notes (validation, who can be credited, settling, layout, PDF)**, price list, kits, invoice maths, scheduling, stages, numbering, pricing, settings readiness                                                                                                                                                                                                                                                                                           |
| `apps/api` (Vitest + real Postgres)          | 182                     | **new: enquiries (public form, rate limits, Turnstile stub, spam, convert to quote/job/appointment, reject, isolation), approvals (drafts only, owner decides, 2-minute hold, Stop, send blocked with no sender, quote and price-update apply, logs), AI bill read (fake model, cap), reports (money, profit per job, time, owner only)** · documents and PDFs (address from settings, draft → numbered, no status change, tenant isolation), suppliers and bills (matching, preview changes nothing, owner-only apply, prices + kits + job materials, credit notes, duplicates, job required), customer credit notes (draft changes nothing, owner approves CN-0001, gap-free, never more than owed incl. other drafts, payments respect credits, settling completes the job, delete drafts only, isolation)**, plus all earlier suites |
| `apps/web` (Vitest + jsdom + fake-indexeddb) | 49                      | **new: demo enquiries, approvals (hold, Stop, not sent), quote drafts, reports** · demo mock: seeded bills/suppliers, preview-then-apply with prices, kits and job materials; seeded CN-0001 and a new credit note**, plus calendar maths, outbox, sync, settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/web` e2e (Playwright, real stack)      | 34 mobile (incl. setup) | **new: CEF PDF → 4 checked drafts; DOCI PDF with RRP; CI Lighting statement check; enquiry → AI reply draft → approve → 2-minute hold → Stop → discard, with the log; quote draft → approve → draft quote; convert to job; reject; owner reports** · invoice PDF (draft preview can’t be shared; approved invoice shares the LSE layout; `/pdf` is a real PDF, no-store); supplier bill from CSV → matched → review shows price and kit changes with nothing changed → owner applies → list cost updated, materials on the job, bill under the supplier; credit note drafted → owner approves → balance drops** · billing, flow, stages, schedule, offline, auth                                                                                                                                                                         |
| PWA (Playwright, production build)           | 1                       | app reopens offline from the service worker with cached jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Screenshots (preview build)                  | 212 images              | 53 screens (new this chunk: `45-home-inbox`, `46-approvals`, `47-approval-detail`, `48-enquiries`, `49-enquiry-detail`, `50-reports`, `51-bill-pdf-import`, `52-statement-check`; PDFs 34/35/43/44 refreshed with the logo; earlier: `34-quote-pdf`, `35-invoice-pdf`, `36-bills`, `37-bill-detail`, `38-bill-review`, `39-bill-line-sheet`, `40-new-bill-sheet`, `41-suppliers`, `42-supplier-detail`, `43-credit-note`, `44-credit-note-pdf`) × mobile/desktop × light/dark in `screenshots/`                                                                                                                                                                                                                                                                                                                                          |

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

- **Chunk 6:** PDFs are read on the phone, not the server (nothing uploaded, works offline once
  loaded); discounted lines keep the merchant's printed total; due dates come from the bill
  ("Date Payable", or tax point + 30 days for "Settlement thirty days"). AI drafts never act on their
  own: email drafts go to a 2-minute hold after approval, and with no sender configured they stop as
  "Not sent". Quote drafts and price updates apply at the owner's tap (they change nothing outside
  the app). Held emails are released when Approvals is read (a cron comes with deployment). Public
  form spam is accepted silently (202) so bots learn nothing; a failed Turnstile check is a 400.
  Reports are owner only, and a job's profit is the whole job, not the period.

- **PDFs: pdf-lib, one layout model.** Pure JS (no headless browser), so the same code renders in the
  Worker (bundle 2.0 MB / 450 KB gzip, inside the Workers limit) and on the phone (lazy-loaded, for
  offline and the preview). The spec's "HTML templates rendered to PDF" is met by rendering the HTML
  preview and the PDF from the same model rather than converting HTML, which Workers can't do cheaply.
- **Sharing is the phone's share sheet**, never an automatic send; it never changes a status. Emailing
  documents waits for the email-sender decision and the 2-minute hold.
- **Supplier bills:** matched when saved (a hand-picked match always wins); applied only by the owner
  after a preview; applied bills are read-only. The PDF file itself isn't stored yet (needs R2), only
  its name. Supplier credit notes never change list prices.
- **Customer credit notes** reduce an issued invoice's balance (sent or part paid only); a draft or
  unsent invoice is edited instead. Refunds of money already paid are not covered yet.

- **Scheduler:** built in-house (no calendar library) to keep the bundle small and the look native;
  local device time, weeks start Monday. Touch drag needs press-and-hold so scrolling the day still
  works. Every drag action also has a non-drag route (the edit sheet) for keyboard and screen readers.
- **Timer offline:** modelled as outbox _actions_ (POST with the device time) rather than field edits,
  because a start/stop is an event, not a value. Stage history records when the server learned of it;
  the timesheet uses the device times.
- **Timesheets** come only from the timer for now (`source = 'timer'`); manual entries, editing and
  rounding rules come with job costing.

- **Stages (interpretations to confirm with Joe):** a stage's "active" flag means its jobs show on the
  Active list; system stages keep a fixed active flag (Complete and Cancelled off, others on). The timer
  moves a job to In Progress from any stage except Complete and Cancelled. Assigning a job that is
  already further along (e.g. On Hold) doesn't move it. Setting the stage a job is already in writes no
  history. Stage changes bump the job's `version`, so an offline edit made before an automatic move
  re-sends on the new version (rule 2) rather than conflicting, unless it changed the stage too.

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

0. **Still open from chunk 6/7:** a real email sender and Turnstile site key once accounts exist (slots
   ready, see `DEPLOY.md`); store bill and statement PDFs in R2 next to the drafts; a hosted enquiry
   form page/snippet; more merchant layouts as samples arrive; per-person charge-out rates.

1. **Schedule/timer follow-ups:** resize appointments by
   dragging the bottom edge; filter the Schedule by person; book appointments and assign offline; drag-to-reorder stages.
2. **Offline, part 3:** a quote or job for a customer created offline (needs client-side ids or
   chaining), offline time/material/note add on jobs, airplane-mode tests on a real iPhone/Android once Capacitor is in. Show pending local values on
   lists after a reload (overlay the outbox on cached data).
3. **Before any deployment:** choose the email sender for sign-in links, set `APP_ORIGIN`, create the
   Neon database and Hyperdrive config, make sure migrations run as a role that owns the tables (the
   `owner_access` policies in 0003 rely on it), add passkeys + owner 2FA.
4. Job detail follow-ups: photo storage in R2 once a bucket exists; who sees notes and photos.
5. Documents and money, next steps: **uploaded logo** on PDFs; **store PDFs and bill files in R2**;
   email sending with the 2-minute hold after approval (needs the sender decision); **refunds and
   payment corrections**; overdue reminders (drafted, approved by Joe); **AI bill reading** (suggest
   lines from the supplier PDF, Joe checks them in the same review screen); stock quantities for lines
   marked Stock; manual job lines; on-hold flag UI.
6. Polish backlog: edit customer/site/contact sheets, swipe-to-delete with undo on contacts, job editing
   sheet, list virtualisation, `zod/mini` to trim the bundle (≈145 KB gzip now), shorter Settings labels
   on narrow phones.

## Open questions for Joe

1. Do the screens feel right? (See `screenshots/` or open the static preview.) Anything to rename?
2. Job stages now follow Tradify (Unassigned, Assigned, Booked in, In Progress, To Invoice, Complete, On
   Hold, Cancelled, plus your own). Happy with the colours and the swipe actions (To Invoice / Complete,
   On Hold, Stage)? Quotes still use **Draft / Sent / Accepted / Job created / Declined / Expired**.
3. Old quotes: number them Q-0001 to Q-0014 on import (current plan), or start fresh?
4. Should "Customer said yes" be allowed straight from a draft (e.g. verbal yes before sending)? Currently
   it must be marked as sent first.
5. Product name for when it's sold (the app currently says "LSE Trade").
6. Sign-in links: happy with email links, or would you rather have Face ID / fingerprint (passkeys) as
   well from day one? (Needs the real web address first.)
7. Which email should sign-in links (and later quotes) come from: the business Gmail, or a sending
   service on the app's own domain?
8. Settings: anything else you want on every quote (e.g. registration body number, insurance)?
9. Schedule: colour appointments by job stage (now) or by person? Default day start 07:00 OK?
10. Timer: should time be rounded (e.g. to 15 minutes) on timesheets, and should stopping ask for a
    note?
11. Invoices: is a deposit invoice usually 30%, or should the default be set in Settings? Should a
    remainder invoice list the original quote lines (now) or just "Balance for Q-xxxx"?
12. Price list: which suppliers' CSV formats should import cleanly first (please send a sample export)?
13. Kits on quotes: show customers the kit as one line (now) or always list its parts?
14. PDFs: your logo is now on them. Please confirm the layout in `screenshots/*-34-quote-pdf.png`
    and `*-35-invoice-pdf.png` matches your current invoices (anything missing, e.g. a registration
    number or a signature line?).
15. Supplier bills: which merchants' bills should import first (a sample CSV or PDF from each helps)?
    Should bill materials on a job be charged at the item's markup (now) or at cost?
16. Credit notes: do you ever refund money already paid (needs a refund record), or only reduce what's
    owed (now)?
17. Reports: profit currently values time at your charge-out rate (£45/h). Do you want a separate
    cost rate per person (e.g. Sam's wages) so profit is real profit? And calendar year or tax year?
18. Approvals: which helpers should be on from day one (enquiry replies, overdue reminders, quote
    drafts, price updates)? Is 2 minutes the right hold before an approved email goes?
19. Enquiry form: will it live on your website (we give you a snippet) or a page on the app's domain?
20. PDF bills: CEF, DOCI and CI Lighting now read. Which other merchants send PDFs? A sample of each helps.
21. Sarnia: the rename is still waiting for your go-ahead (nothing changed).
22. Charge-out rate: ANSWERED 11 Nov 2026 by Joe: a rate per person (default £45/h, editable). Build first next session; job costing, quotes, Reports and CSV must use each person's own rate.
23. Expected profit: quoted labour is costed at the job's own average cost so far (or the team average,
    or the labour rate if no cost rates are set). Is that the estimate you want?
24. Should subcontractors see a job's notes and photos, or only the owner and staff?
25. The private file:// demo contains your real CEF/DOCI bills, including your order references. It
    stays on this computer only; say if you want them masked before you show it to anyone.
26. The credit-note sheet's placeholder reads "e.g. GUR/334230" (added in chunk 5). Is that a real CEF
    reference? If so we'll change it to an invented one.
27. Offline: a new customer created with no signal can't have a quote or job until it syncs. OK for now?
28. Charge-out per person: quote labour lines aren't tied to a person, so quotes still price labour
    at the business rate (£45/h); the person's own rate is used once their time is logged (costing,
    Reports, CSV, T&M invoices). Should a quote line be able to name who will do the work?
29. Access: money and price decisions (approving invoices and bills, applying price updates, changing
    settings) are still the owner's alone, even for other admins. Should other admins be able to make
    them too?
30. Access presets: Office = accounts, quotes and settings (view); Field worker and Subcontractor see
    jobs, schedule, customers and their own time only. Is that right for Sam and any subcontractors?
31. ANSWERED 11 Nov 2026 by Joe: yes, hide all prices from anyone without Quotes and pricing or
    Accounts access (field workers, subcontractors). Done: the API takes every money field out of
    what it sends them and refuses changes to priced job lines; the job screen shows no prices,
    totals or Add Material.
32. ANSWERED 18 Nov 2026 by Joe: Google Calendar only, and a move or delete made in Google **applies
    straight away** (no Approvals). Done in session 6, with a log and Undo.
33. Calendar events show the customer's phone number and site address so whoever is booked can get
    there. OK, or leave the phone out?
34. Business overview: what was your bank balance on the day you'd like the app's records to start
    (e.g. 1 Jan 2027)? It makes Bank and Cash and the Balance Sheet match your bank.
35. Do you want a budget for 2027 (monthly income and materials targets) for Budget vs Actual?
36. ANSWERED 18 Nov 2026 by Joe: a job that comes to less than £0 is a **customer credit**, used on
    that customer's next invoice (not a refund). Done in session 5 (see below).
37. ANSWERED 18 Nov 2026: Google only, no Microsoft. The step-by-step setup is in
    `docs/GOOGLE_CALENDAR_SETUP.md` (about 20 minutes: Google Cloud project, consent screen, OAuth
    client, three secrets). The app only asks for non-sensitive scopes, so Google doesn't need to
    review it. Nothing has been created in your Google account. Say when you'd like to do it.
38. Labour on kits uses the business charge-out rate. Should it use a named person's rate when the
    job is assigned to them (ties in with Q28)?
39. ANSWERED 18 Nov 2026 by Joe: a credit never comes off an invoice that's already approved or sent;
    it stays on the customer's account for a later invoice. Done in session 6 (see Q41).
40. ANSWERED 18 Nov 2026 by Joe: a quote can never come to less than £0. Done in session 6: blocked
    in the app and by the server, with a clear message; minus lines are still fine above £0.
41. ANSWERED 18 Nov 2026, 10:27 by Joe: "You can apply the credit if the job hasn't been invoiced but
    if it has don't worry about it." Done in session 6: on a quote or job not yet invoiced, the owner
    can switch on "Use their credit" (the quote itself isn't reduced; the choice carries from quote
    to job). It sets the default on the invoice's Approve sheet, which still confirms. Updated 10:35:
    credit can also be used on an invoice already issued ("Use Customer Credit…", confirmed); it
    lowers what they owe but the invoice as billed and its PDF don't change.
42. ANSWERED 18 Nov 2026, 10:36 by Joe: "Expenses just come from the profit of the company." Done:
    no "paid personally" option; every expense comes out of the business account and off profit
    (migration 0032 turned any recorded as personal into business expenses and dropped the column).
43. ANSWERED 18 Nov 2026, 10:36 by Joe: "If changed in either it updates both." Done: true two-way;
    when a booking was changed in both before a sync, the **most recent change wins** (by the app's
    and Google's change times). App newer: nothing comes in and Google is updated (a booking
    deleted in Google but changed in the app since is put back as a new event). Google newer: it
    applies, and the log says the app's change was overwritten. Without Google's time, Google wins.
    Joe (10:37): "Ideally changes will be made in app": the app is the main place, Google the
    fallback.
44. ANSWERED 18 Nov 2026, 10:38 by Joe: "Anyone with the correct level of access can make the
    expenses change." Done: anyone with Accounts access (Admin and Office presets; not Field worker
    or Subcontractor) can add and remove expenses and wages; the API refuses others (403). Removing
    still asks to confirm, and every change is audited.

## Next (after session 4)

1. ~~Business overview and Xero-style reports~~ (done, session 4).
2. ~~Labour in every quote kit~~ (done, session 4).
3. ~~Minus (credit) lines on invoices and quotes; private demo re-imported~~ (done, session 4;
   see Q36 for jobs that come to less than £0).
4. ~~Two-way calendar sync~~: engine (session 4), Google sign-in, adapter and 15-minute schedule
   (session 5). Waiting on the one-off Google setup (Q37, `docs/GOOGLE_CALENDAR_SETUP.md`).
5. Later for the books: expenses/overheads and wages (so net profit is real), bank feed or bank
   statement import and reconciliation, refunds.

## Next session, top priority (Joe, 11 Nov 2026, late) — item 1 done in session 4

1. **Business overview dashboard (Xero-style)** for admins, shown only with Accounts and Reports
   access (enforced on the API like every area): bank and cash position, money owed to the business
   (aged receivables: current, 1-30, 31-60, 61-90, 90+ days) and money it owes (supplier bills due),
   cash flow over time (money in and out by month), profit for the period (honest "so far" and
   "expected" figures, as in Reports), unpaid invoices and unpaid bills lists, and the job pipeline
   by stage (counts and value). Apple-quality design: large clear figures, simple charts, light and
   dark, phone and desktop. No bank feed exists yet, so "bank and cash" needs a source: payments
   recorded in the app to start with, a bank feed later (ask Joe).
   It also includes **Xero-like reports**: Profit and Loss, Balance Sheet, Aged Receivables and Aged
   Payables, Cash Flow, a tax summary (GST/VAT, if any applies on Sark; ask Joe), Budget vs Actual
   and Account Transactions. Each has date ranges, comparison periods (previous period, same period
   last year) and CSV and PDF export. A Balance Sheet and Account Transactions need proper ledger
   accounts (a chart of accounts and double-entry postings from invoices, payments, bills and credit
   notes), so that comes first.
2. **Labour in every quote kit** (Joe, 11 Nov 2026): each kit gets labour hours (and optionally hours
   per item in the kit), priced at the charge-out rate (the business default, or a named person's
   rate if Q28 goes that way). When a kit is added to a quote, the labour line appears next to the
   kit's materials and can be changed on that quote without changing the kit. Needs a labour-hours
   field on kits and kit items (migration), the kit sheet, the quote's add-kit step, and tests.
   Kits exist already, but this touches pricing on quotes, so it was left for next session.
3. **Two-way calendar sync** (Google and Microsoft): see the design note above. The one-way link is
   done.

## Next session, top priority (Joe, 11 Nov 2026)

1. Per-person charge-out rates (default £45/h, editable per person); used in job costing, quotes, Reports and CSV.
2. Admin-controlled visibility (Tradify-style): a master admin sets, per person, which areas they can see (financials, accounts, reports, costs/profit, etc.). Enforce on the API, not just by hiding things in the UI; add tests per permission.
3. Two-way calendar sync with Google Calendar and Outlook (Joe asked 11 Nov 2026); after 1 and 2.

- Credits: Joe decided (11 Nov 2026) to ALLOW negative (minus) lines on invoices/quotes for credits (e.g. job 14 rent payments); totals net them off. Then re-import real jobs 14, 79, 108, 110, 111 so the private demo matches his Accounts sheet.

## Done (session 4, Wed 18 Nov 2026: business overview and Xero-style reports)

- **Books from the documents** (`packages/shared/src/ledger.ts`): a small fixed chart of accounts
  (090 Bank, 610 Receivables, 800 Payables, 820 GST/VAT, 880 Drawings, 960/970 equity, 200 Sales:
  labour, 210 Sales: materials and other, 310 Materials) and double-entry postings from issued
  invoices, customer payments, approved credit notes (split pro rata across labour, materials and
  tax), applied supplier bills and credit notes (home lines go to drawings) and supplier bill
  payments, plus an opening bank balance. Every document's postings sum to zero, so the Balance
  Sheet always balances (tested at many dates).
- **Reports** (pure functions → one `ReportTable` model used by screen, CSV and print): Profit and
  Loss (accrual) with a comparison column and Change; Balance Sheet (as at, retained vs current
  year earnings, comparison date); Aged Receivables and Aged Payables (by days past due: current,
  1-30, 31-60, 61-90, 90+, per contact); Cash Flow (cash basis, monthly columns up to 12 months,
  opening and closing bank); Tax Summary (none charged today, Guernsey/Sark); Budget vs Actual
  (monthly budgets per P&L account, positive variance = good); Account Transactions (running
  balance; P&L accounts start each period at zero). Periods: this/last month, this/last quarter,
  this/last year, year to date, custom; the year follows Settings (calendar year by default).
  Comparison: previous period (whole months stay whole months; month/quarter-to-date step back by
  their months; longer to-date periods compare with last year) or same period last year. Exports:
  CSV (spreadsheet-safe) and Print / Save as PDF (print stylesheet hides the app chrome).
- **API**: `GET /api/business` returns the inputs (issued documents only), job pipeline by stage
  (count and line value) and quotes awaiting an answer; the app works the reports out with the
  shared code, so date ranges and comparisons switch instantly and the offline demo matches.
  Needs **Reports and Accounts** access (403 otherwise, tested); `PUT /api/business/opening` and
  `PUT /api/business/budget` are admin-only; `GET/POST /api/supplier-bills/:id/payments` (owner
  only, never more than is owed, not in the future, idempotent). Migration **0022**
  (`supplier_bill_payments`, `business_books`, `budgets`, all RLS).
- **Invoices**: approve takes an optional earlier `issueDate` (bringing in invoices already sent;
  not future, at most a year back). The private demo uses Joe's own invoice dates, so overdue
  figures match his Accounts sheet.
- **Screens**: More › Business Overview and a sidebar "Business" item (hidden without both
  areas): Bank and Cash (with Set Opening Balance), Owed to You and You Owe (stacked age bars),
  Cash In and Out chart (bars in/out, bank balance line, drawn at real pixel size; hidden data table
  for screen readers), Profit (year to date vs last year, this month), Job Pipeline (stage colours),
  Unpaid Invoices, Bills to Pay, Reports. Report pages with period, comparison, as-at and account
  pickers; account lines open Account Transactions. Budget sheet (12 months per account, "Same
  Every Month"). Bill screen: Payments section with Record Payment.
- **Phone polish** (Joe's iPhone 14 screenshots): compact demo banner on phones, more room above
  the tab bar (plus scroll padding), "By Stage" and "Record Payment" labels (no ellipsis), Reports'
  profit per job as a tidy figure grid, reports and overview checked at 390 px.
- Screenshots `63-business-overview` (desktop light/dark, mobile) and `64-profit-and-loss`.

Known limits: no wages/overheads/expenses yet (net profit is before them); no bank feed (bank =
opening balance + recorded payments); supplier bills are recorded gross (no input tax); a refund
of money already paid isn't modelled; the demo's real supplier bills stay drafts until applied,
so You Owe is £0 there until they are.

### Done (session 4, later: labour on kits, minus lines)

- **Labour on quote kits**: each kit has fitting time for the whole kit and per item (per unit,
  e.g. 15 min per socket), migration **0023**. The kit page shows time for the kit, time from
  items, labour per kit and the kit with labour at the charge-out rate. Adding a kit to a quote asks
  for the labour hours per kit (filled in from the kit) and the rate (the business charge-out
  rate), and adds an ordinary labour line "Labour: <kit>" under the kit block, so it books to
  labour sales and can be changed on that quote only. Editing the kit block keeps the labour line in
  step with the number of kits (and lets you change hours or rate); removing the kit removes its
  labour line (Undo puts both back). Quote snapshots keep the kit's fitting minutes.
- **Fixed**: renaming a kit (or editing only its description) emptied its item list, because the
  update schema filled in a default empty list. Now only the fields sent are changed (tested).
- **Minus (credit) lines**: the quote line sheet and the invoice line sheet have a "Minus line
  (credit)" switch with an amount to take off; minus lines show in green and net off the total.
  Quote, job and invoice totals round minus lines the same size as plus lines. A minus line on a
  quote carries through to the job and the invoice (API test), the books net it off sales (ledger
  test), and an invoice still can't be approved at £0 or less.
- **Private demo**: real jobs re-imported with their minus lines (job 14 rent payments, job 108
  supplier credit, and minus lines on one more job) and with price-less lines kept at £0 (jobs 79,
  110, 111: a heading and blank carriage lines, which is what was skipped before, not credits).
  Jobs 14 and 108 come to less than £0, so they have no draft invoice (see Q36).

### Done (session 4, later: two-way calendar sync engine)

- **Shared plans** (`packages/shared/src/calendarSync.ts`): what goes in each calendar event (job
  number and title, customer, site, who's booked; never money; our appointment id on the event), a
  hash of what we wrote, the app → calendar plan (create new, update changed, delete gone) and the
  calendar → app plan (a move or delete of one of our events becomes a proposal; our own writes
  echoing back and events made by hand are ignored; if the app changed it too, the proposal says so).
- **API**: migration **0024** (`calendar_connections` per person and provider, tokens stored
  encrypted; `calendar_event_links`; proposals kind `calendar_change`; RLS). `GET /api/calendar-sync`
  (which providers can be connected, my connections), `POST /api/calendar-sync/run` (my calendars:
  calendar changes first, then the app's changes out), `DELETE /api/calendar-sync/:id`,
  `POST /api/calendar-sync/connect/:provider` (says plainly it needs setting up until the Google /
  Microsoft app registrations exist). Approving a calendar proposal moves or removes the
  appointment; discarding puts the app's time back into the calendar on the next sync.
  Appointments waiting on a proposal aren't pushed. Each person only syncs their own bookings.
- **Screens**: More › Calendar › Two-way sync (Google Calendar, Outlook; Connect / Needs setting up,
  Sync Now, Disconnect); Approvals shows calendar changes (booked now → moved to, or deleted).
- **Tests**: shared planner (7), API with an in-memory calendar (5: push, echo, move → approve,
  discard → restored, app move/delete out, calendar delete → approve, per-person), e2e (setup state).
- **Not yet**: the Google and Microsoft adapters and OAuth sign-in (need Q38), push notifications /
  a schedule so it runs without "Sync Now", token encryption key handling in the Worker.

## Joe's decisions (18 Nov 2026, 06:20)

- Jobs 14 and 108 (totals below £0): treat as a **credit** for the customer (customer credit balance / credit note style, applied to their next invoice), not a refund.
- Kit labour: keep it **optional** per kit; a kit can be items only, labour only, or both. Don't force a labour line when a kit is added.
- Calendar: two-way sync with **Google Calendar** only for now (no Outlook). Build the Google sign-in/connection next.

## Done (session 5, Wed 18 Nov 2026)

### Customer credit (Q36, Joe's decision)

- A draft invoice that comes to **less than £0** (e.g. job 14: rent payments bigger than the work)
  shows **Issue Customer Credit…** instead of Approve. Issuing it (owner only) gives it the next
  **credit note number** (CN-0001…, shared with credit notes so the sequence has no gaps; the job's
  invoice numbers aren't used up), status **Customer credit**, no due date, nothing to send or pay,
  and moves the job to Complete if nothing else is owed. Exactly £0 still can't be approved. A quote
  may now be sent when it comes to less than £0 (exactly £0 is still refused), so such a job can
  go quote → job → credit.
- When the owner approves that customer's **next invoice**, the credit comes off it automatically:
  oldest credit first, never more than the invoice owes, and only credits issued on or before the
  invoice date. Recorded in `credit_uses` (migration **0025**; the app's database user can only
  insert, never change or delete). An invoice fully covered by credit is settled when marked sent.
- **Shown** on the customer (Customer credit section: CN number and what's left, hidden from people
  who can't see money), on the credit (Used on invoice …, Credit left), on the invoice (Customer
  credit CN-0001 used −£…, Balance due) and its PDF; the approve sheet says how much comes off. The
  credit's PDF is titled **Credit Note**, "Credit to you", no bank details, and says it comes off the
  next invoice and isn't paid out.
- **Books**: the credit posts like an invoice with minus amounts (sales down, Accounts receivable
  down). Using it moves nothing in the books (receivable to receivable); it only changes what is
  owed on each, so Aged Receivables, the overview and Account Transactions stay consistent and the
  Balance Sheet balances. An unused credit is a negative item in Aged Receivables; the overview's
  Owed to You is net of it and says "£x customer credit to use".
- **Demo** mirrors all of it (`mockBilling`, `mockBusiness`, customer detail).
- **Tests**: API `customerCredit.test.ts` (6: CN numbering, owner only, no send/pay/credit note,
  job complete, customer view and field-worker view, PDF wording, next invoices oldest first and
  partial, fully covered → paid on send, P&L/Balance Sheet/aged/overview figures, £0 still blocked,
  other business can't see it, earlier-dated invoice doesn't use a later credit, grants); shared
  ledger (2) and `planCreditUse` (1); demo `mockCredit.test.ts` (1).
- **Private demo**: real jobs 14 and 108 are now issued as customer credits (were left without an
  invoice).
- **E2E** (`billing.spec.ts`): issue a customer credit from the invoice screen, see it on the
  customer, approve their next invoice and see the credit come off.

### Kit labour optional per kit (Joe's decision)

- Adding a kit to a quote has an **Include labour** switch. It starts on when the kit has fitting
  time (or has no items), off otherwise; switched off, no labour line is added even if the kit has
  time. A kit can be **items only, labour only, or both**: a kit with no items adds just its own
  "Labour: <kit>" line (no £0 block); a kit with neither is refused with a plain reason. The kit
  list says "Labour only" for kits without items. Editing a kit block on a quote still lets you
  clear the hours to drop its labour line.
- Shared `kitAddLines` (used by the picker) decides the lines. **Tests**: shared (4: items only with
  labour off, both, labour only, nothing to add) and e2e (items only by switching labour off;
  labour-only kit adds just the labour line). Existing kit labour e2e unchanged and passing.

### Two-way sync with Google Calendar only (Joe's decision)

- **Outlook/Microsoft removed** from two-way sync: the providers list is just `google`, the screen
  shows one Google Calendar row, and migration `0026_google_calendar.sql` narrows the database check
  to Google. (The one-way calendar link still has its "Add to Outlook" button: that's a plain
  subscription link and needs no setup.)
- **Sign-in (OAuth)**: More › Calendar › Connect asks the API for a Google address (authorization
  code + PKCE S256, `access_type=offline`, `prompt=consent`), the browser goes to Google and comes
  back to `GET /api/calendar-sync/google/callback`, which checks the one-off state (stored hashed,
  10 minutes, only for the same person who started it; PKCE verifier kept server-side), exchanges the
  code, insists the calendar permission was ticked, then sends the browser back to `/calendar` with
  a plain message either way.
- **Narrow permission**: `calendar.app.created` + `openid email`: the app makes its own **“LSE
  jobs”** calendar (Europe/Guernsey) and can only touch that one. Non-sensitive, so no Google review.
- **Tokens encrypted at rest**: only the refresh token is stored, sealed with AES-GCM using the
  Worker secret `CALENDAR_TOKEN_KEY` (32 random bytes) and bound to the person, so it can't be
  swapped between people. Access tokens live in memory only (`apps/api/src/lib/sealed.ts`).
- **Google adapter** (`services/googleCalendar.ts`): create/check the calendar, put/delete events
  (put falls back to insert if Google lost the event), incremental reads with `syncToken` and
  paging, a full re-read when Google says the token has expired (410), refreshes access tokens
  (one retry on 401). If access is removed in Google, the connection shows **Connect Again** with
  the reason; if the LSE jobs calendar was deleted, reconnecting makes a new one and refills it.
  One person's problem never stops the others syncing.
- **"Needs setting up"**: until `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
  `CALENDAR_TOKEN_KEY` are all set, the screen says so plainly and Connect answers 503
  `not_configured`. A malformed key stops the Worker loudly rather than storing tokens badly.
- **Runs by itself**: the Worker's minute cron syncs every connected calendar that's due, every 15
  minutes (`calendar_sync_due` database function); **Sync Now** still works.
- **Setup steps for Joe**: `docs/GOOGLE_CALENDAR_SETUP.md`. Nothing was created in any Google
  account.
- **Tests**: `apps/api/test/googleCalendar.test.ts` (9) against a faked Google
  (`src/dev/fakeGoogle.ts`: token endpoint with PKCE checks, calendars, events, sync tokens, paging,
  410s, revoked access): not set up, missing/bad settings, sealing (tamper, wrong key, wrong person,
  PKCE S256), full connect flow, someone else's/replayed/denied/no-calendar-permission sign-ins,
  push + echo + paging + Google move/delete as approvals + app move pushed out, expired sync token,
  revoked access → Connect Again → reconnect, deleted calendar → new one, the schedule. Existing
  calendar sync tests updated; e2e: "Needs setting up" and the back-from-Google message.

## Next (after session 5)

1. Do the one-off Google setup with Joe (Q37, `docs/GOOGLE_CALENDAR_SETUP.md`), then try two-way
   sync for real.
2. Later for the books: expenses/overheads and wages (so net profit is real), bank feed or bank
   statement import and reconciliation, refunds.
3. Answers needed: Q33, Q34 (opening bank balance), Q35 (2027 budget), Q38.

## Joe's decisions (18 Nov 2026, 10:02)

- Google Calendar setup session with Joe: Friday 20 Nov 2026, 8pm Guernsey.
- A move/delete made in Google Calendar should **apply straight away** in the app (no Approvals queue for these).
- Credits must NOT come off an invoice that's already been sent/approved; they stay allocated to the client's account and come off their future invoices. If the related job is only at quote stage, the credit is irrelevant and can be ignored, but the app must ask for confirmation first.
- A quote must never total less than £0 (block it with a clear message).

## Done (session 6, Wed 18 Nov 2026)

All four of Joe's 10:02 decisions are done, plus expenses and wages.

- **Google Calendar changes apply straight away** (migration 0027). A move or delete made in Google
  updates the booking in the app at once (the job's stage too) and is written to a new activity log.
  Calendar shows "Changes from Google Calendar" with **Undo** for the latest change (only while the
  app still matches it; undoing a delete brings the booking back with the same links, and the next
  sync puts it back in Google). Old pending proposals can still be approved or discarded.
  `docs/GOOGLE_CALENDAR_SETUP.md` rewritten as a short step-by-step for Friday 20 Nov, 8pm.
- **Customer credit asks first.** Approving an invoice for a customer with credit asks whether to
  take it off ("Use their credit on this invoice", on by default) or keep it for later. Credit never
  touches an invoice that's already approved or sent, and never touches quotes; the quote shows the
  credit as a note. The API refuses to approve without a choice (422 `credit_choice_needed`).
- **Quotes never below £0.** Server (create, edit, send) and app both block it with a clear message,
  including when a minus option would take it below £0. Send and Share are disabled while it is.
- **Private demo banner** now says it's your own jobs, customers and supplier bills when built with
  real jobs.
- **Expenses and wages** (migration 0028). Business › Profit › "Expenses and wages": add an overhead
  (Xero codes: bank fees, accountancy, general, insurance, vehicle and fuel, software, tools and
  repairs, phone and internet, travel and ferries) or wages for a team member, paid from the
  business account (updated 10:36, Q42), with any reclaimable tax. They post to the ledger, so the P&L shows
  operating expenses and real net profit, Cash Flow splits suppliers / wages / expenses, Balance
  Sheet and budgets include them. Anyone with Accounts access adds or removes them (Q44; confirm
  and audit).

Tests: API 235, shared 181 (+1 skipped), web unit 57; e2e billing, calendar and business all pass on
iPhone 14 and desktop.

### Credit on work not yet invoiced (Joe, 18 Nov 10:27, Q41)

Migration 0030 (`quotes.use_credit`, `jobs.use_credit`). `PUT /api/quotes/:id/credit` and
`PUT /api/jobs/:id/credit` (owner only; 409 `job_invoiced` once the job has an approved/sent
invoice). The quote screen has a "Use their credit" switch under Totals; the invoice's Approve
switch starts from that choice (on if none) and still has to be confirmed. Job screen: a
"Customer credit" section (Accounts access; switch for the owner) when the customer has credit;
once the job is invoiced it points to Use Customer Credit on the invoice. The job API now returns
`customerCreditPence`, `useCredit`, `invoiced` (credit zero/hidden without Accounts access).

### Credit on an invoice already issued (Joe, 18 Nov 10:35, updates Q41)

"Actually it can be applied to one which has been invoiced it obviously just won't adjust the billed
amount but will show on the p&l." Migration 0031 (`credit_uses.after_issue`). An approved, sent or
part-paid invoice shows "Use Customer Credit…" (owner, with a confirm sheet): the credit comes off
what they owe and is used up, but the invoice's lines, total and PDF stay as billed (the PDF leaves
after-issue credit out). The credit was already in the P&L as reduced sales when it was issued, so
using it doesn't change profit again; the books still balance. `POST /api/invoices/:id/use-credit`.

### Bank statements (steps 1–3 done)

Step 1 done: CSV import (migration 0029, `POST /api/bank/imports`, `GET /api/bank/transactions`).
Reads Lloyds, Nationwide, Starling, Monzo, Barclays, HSBC (no headings) and similar; owner only;
re-importing or overlapping statements adds nothing twice.

Step 2 done: matching. Each unmatched line lists up to 3 suggestions: customer payments (not cash),
supplier bill payments and expenses with exactly the same amount and direction within 10 days,
ranked by date and by names or numbers on the line ("strong" = a name/number and ≤ 5 days).
`POST /api/bank/transactions/:id/match`, `PUT /api/bank/transactions/:id/status` (unmatched /
ignored, e.g. transfers between your own accounts). One bank line per payment/expense. Anyone with
Accounts access can import and match (same rule as expenses, Q44). Matching never changes the
books.

Step 3 done: the screen. Business › Bank and Cash › "Bank statement: import and match" opens
**Bank Statement**: Import Bank Statement (CSV) (shows new / already imported and any skipped lines),
then To Match / Matched / Ignored. Each line shows its suggestions with Match (likely ones
highlighted), Ignore, Unmatch and Restore. Mirrored in the demo (works in the private file demo).

Step 4 done: **Add as Expense** on an unmatched money-out line opens the Add Expense sheet with
the bank's date and amount (fixed) and the payee from the line; saving records the expense and
matches the line (`POST /api/bank/transactions/:id/expense`). Mirrored in the demo.

Step 5 done: **Check against your bank** on the Bank Statement screen (when the CSV has a Balance
column): the bank's closing balance on the statement's last day vs the app's Bank and Cash at the
end of that day, and the difference (with a hint: unrecorded money in/out, or the opening balance).
Shared `closingBalance` / `reconcileBank` handle banks listing newest-first or oldest-first.

Step 6 done: **Record Payment** on an unmatched money-in line (owner only, like recording a
payment on the invoice; Accounts users see "ask the owner"). Pick a sent / part-paid invoice
with at least that much owed (same amount listed first); the payment is recorded as a bank
transfer on the bank's date with the bank's description as the reference, and the line is
matched in the same step. Paid in full completes the job as usual. Demo mirrors it.
`POST /api/bank/transactions/:id/payment {invoiceId}`.

Step 7 done: **Pay Bill** on an unmatched money-out line (owner only, like paying on the bill):
pick an applied supplier bill with at least that much owed (same amount first); recorded as a bank
transfer on the bank's date, bank description as reference, and matched in one step. Demo mirrors
it. `POST /api/bank/transactions/:id/bill-payment {billId}`.

The bank feature is complete for now: import, suggestions, match/unmatch/ignore, Add as Expense,
Record Payment, Pay Bill, and the balance check. Refunds not started (as asked).

## Next (after session 6)

1. Google setup with Joe, Fri 20 Nov 8pm (`docs/GOOGLE_CALENDAR_SETUP.md`).
2. Refunds (not started, as asked). Bank is done apart from refunds. Then refunds (not started, as asked).
3. Answers needed: Q33, Q34, Q35, Q38. Q41–Q44 answered 18 Nov (credit, expenses, conflicts,
   expense access).

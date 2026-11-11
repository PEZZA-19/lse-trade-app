# Progress

_Last updated: Wednesday 11 November 2026, ~14:45 Europe/Guernsey (session 2, chunk 5: PDFs, supplier bills, suppliers, credit notes)._

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

## Next session, top priority (Joe, 11 Nov 2026)

1. Per-person charge-out rates (default £45/h, editable per person); used in job costing, quotes, Reports and CSV.
2. Admin-controlled visibility (Tradify-style): a master admin sets, per person, which areas they can see (financials, accounts, reports, costs/profit, etc.). Enforce on the API, not just by hiding things in the UI; add tests per permission.
3. Two-way calendar sync with Google Calendar and Outlook (Joe asked 11 Nov 2026); after 1 and 2.

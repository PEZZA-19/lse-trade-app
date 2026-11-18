# Product/code audit: one trade app, native accounting, safe voice AI

## Verdict

**A substantial trade-operations prototype with real internal books, not yet a production-ready Tradify + Xero-class + conversational/voice product.** Accounting is not dependent on Xero today, which matches the architectural direction. However, a document-derived ledger and Xero-style reports do not establish Xero-class accounting completeness. No working Xero connector or conversational/voice workflow was found.

Do not onboard real businesses yet. First close the assignment-permission gap, establish trustworthy accounting corrections/reconciliation, and obtain a passing database/browser verification run. Keep Xero optional: native books must remain the source of truth, with accountant interoperability an explicitly bounded adapter.

## Scope, provenance and limits

- Audited main/origin/main at `b13e784c98ad9c410c60df6f445c255a3395699a`.
- Verified PR [#1](https://github.com/PEZZA-19/lse-trade-app/pull/1) before review and again after tests: open, **draft/unmerged**, base main, head `369a8195e4d80dcec93add3515c3d67457779a6a` (`fix/schedule-job-picker-overflow`). Diff: eight web files, 586 additions/14 deletions. Evaluated separately; not counted as main functionality.
- Fresh branch `audit/product-code-review` from main. Documentation only; initial evidence checkpoint committed as `5a3d3aa`.
- Read README, all 1,080 lines of PROGRESS, DESIGN, DEPLOY and `docs/REQUIREMENTS_FROM_REVIEWS.md`. Progress mixes historical and newer claims; code and current checks take precedence. Memory confirms Joe's target: native accounting removes the day-to-day need for a second subscription; Xero is optional; voice should add materials/time.
- All work stayed inside this job workspace. No private demo/customer/job/bank files or real integration accounts were used. Tests used repository fixtures and synthetic inputs. No deployment, push, merge, feature or formatting fixes. Pre-existing untracked `ditto.json` left untouched.
- Static findings are explicitly distinguished from runtime evidence. API/database and browser assertions were **not verified** in this environment. This is not a penetration test, accounting certification, accessibility certification, or exhaustive parity assessment.

## What exists versus what is still aspirational

| Area                      | Implementation on main                                                                                                                                                 | Gap / limitation                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customers and sites       | Multiple sites/contacts with roles; customer history; enquiry intake and conversion                                                                                    | Complete migration/reconciliation and whole-business export not found; public customer portal still future work                                           |
| Quotes and jobs           | Separate numbering, revisions, acceptance state, convert-once linkage, stages/history, assignments, kits and price list                                                | Customer online acceptance not established; recurring jobs, working-hours recurrence, inventory/reorder and purchase orders not found                     |
| Schedule and work capture | Calendar views, appointments, timers, manual timesheets, materials, notes/photos and job profitability                                                                 | No hard appointment clash lock; offline work capture is selective; PR #1 picker improvements are not merged                                               |
| Invoicing and purchasing  | Quote/job invoicing, deposit/percentage/remainder modes, payments, customer credits, supplier bills/credits, preview/apply price updates, PDF documents                | Real email sender absent; specialised customer-credit treatment needs accounting sign-off; do not conflate recorded payments with moving money            |
| Native financials         | Double-entry postings derived from documents; P&L, balance sheet, ageing, cash flow, tax summary, budgets, account transactions, expenses/wages and statement matching | Small fixed chart/single bank opening; no general journals, period locks or full opening trial balance; wages are expense entries, not payroll processing |
| Integrations              | CSV price/bank import; iCal feed; Google OAuth/provider/sync code, status/errors and Undo/activity                                                                     | Google unconfigured and only fake-backed tests reviewed; no Xero connector, live bank feed or payment processor found                                     |
| AI                        | Purpose-limited gateway, JSON/schema checks, draft proposals, owner approval, email hold/Stop, event/audit logs; deterministic fake                                    | Production provider absent; no chat/voice-to-time/material flow; spend/privacy/delivery hardening needed before enabling                                  |
| Device/UX                 | React mobile sheets, PWA shell, query persistence, save/sync status and conflict UI, dark/light styles                                                                 | Browser assertions blocked; no full accessibility/keyboard/assistive-tech verification; offline session/cache boundaries need adversarial tests           |
| Deployment                | Worker build, Postgres RLS migrations, cron, fail-closed service slots and CI recipe                                                                                   | DEPLOY explicitly says not deployed; DB, email, storage, form and AI setup incomplete; backup/restore/operations runbook insufficient                     |

Representative code: `apps/api/src/services/{customers,quotes,jobs,jobDetail,schedule,invoices,bills,bank,business,reports,calendarSync}.ts`, `packages/shared/src/{ledger,access}.ts`, `apps/web/src/offline/`, `apps/api/src/{app,worker,services-for-env}.ts`.

## Prioritised findings

Priorities: **P0** = block any real-business pilot; **P1** = establish before claiming standalone accounting or enabling external actions; **P2** = subsequent product/quality milestones. “Static” means source-supported, not exercised against a database here.

### A01 — P0: subcontractor assignment-only access is not enforced

**Evidence (static, high confidence):** `packages/shared/src/access.ts` promises subcontractors see only jobs they are on, but `areaForPath` leaves jobs, customers and schedule open to any signed-in member. `apps/api/src/app.ts` applies area checks and monetary-field redaction, not assignment checks. `services/jobs.ts:listJobs/getJob` have no assignee predicate. `services/schedule.ts:listAppointments/getAppointment/updateAppointment` likewise lack one. Migrations `0001_core.sql` and `0005_job_stages.sql` use tenant-only RLS; no later assignment-visibility policy was found. `services/jobDetail.ts:assertCanRecord` blocks accountants, not unassigned subcontractors.

**Impact:** a subcontractor can potentially list/read/edit another team's jobs and schedule within the same business, including work notes and customer context. This is a within-tenant authorization failure, **not evidence that cross-tenant RLS is broken**. Hiding money does not protect operational records.

**Next:** enforce one consistent visibility/write rule on API and children (time, notes, photos, appointments), preferably defense-in-depth. Add assigned/unassigned subcontractor tests for list/detail, guessed IDs, writes, feed, and cache revocation. Also explicitly decide enquiry/proposal visibility: those paths are outside area checks and proposal payloads contain email/business text that suffix-based money redaction cannot protect.

### A02 — P0: release verification is incomplete and canonical check is red

**Evidence (runtime):** `pnpm check` stops at formatting of tracked `PROGRESS.md` and pre-existing untracked `ditto.json`; later canonical stages never execute. API tests cannot connect to local PostgreSQL; embedded `initdb` refuses root. Browser launches fail before assertions (details below).

**Next:** rerun in an approved non-root environment with browser OS dependencies and a synthetic database. Repair tracked formatting separately; decide how local harness files are excluded from formatting without hiding source failures. Require tenant/access, billing/credit, offline and end-to-end invoice flows plus PR picker viewport checks. Passing lint/build/unit tests is not release acceptance.

### A03 — P1: native ledger lacks the control surface needed for standalone accounts

**Evidence (static):** `packages/shared/src/ledger.ts` derives postings at read time from a fixed chart and source documents. `migrations/0022_books.sql` stores one opening bank balance, not a full opening trial balance. No general-journal or period-lock workflow was found. `services/expenses.ts:deleteExpense` deletes an expense (and audits it), so historical books can change rather than recording a reversal. `services/business.ts:setOpening` overwrites the opening balance.

**Impact:** migrating an established business, correcting accounts and reproducing closed-period/year-end reports cannot be treated as solved merely because totals balance.

**Next:** accountant-approved chart/opening balances, correction/reversal policy, lock/reopen permissions, trial-balance/general-ledger exports, and repeatable as-of reporting. Define tax jurisdictions and supported entity/accounting modes. Decide whether asset/depreciation, loans, transfers, payroll and multi-currency are required for first release; do not promise universal Xero parity without that scope.

### A04 — P1: cash and supplier-tax treatment are narrower than the UI/accounting claim

**Evidence (synthetic runtime + static):** invoking `ledger.ts:postings` with a synthetic £100 cash receipt produced `090 +10000` and `610 -10000`: it increases the **business bank** account without a deposit. Both receipt and supplier-payment loops ignore `method`. Conversely `services/bank.ts:candidates` excludes cash payments from bank matching. Supplier-bill postings send gross total less home allocation to materials/drawings and AP; `getBusiness` does not expose supplier tax separately. Expense tax is separately posted.

**Impact:** a cash-taking business can show an overstated bank balance; tax reporting is not demonstrated for tax-bearing supplier bills. A balanced ledger can still have wrong classifications.

**Next:** define cash-on-hand/deposit/transfer semantics, payment-account selection and tax recoverability with an accountant; add fixtures covering cash then deposit, supplier credits/tax, partial payments and as-of reconciliation. If deliberately out of scope, restrict and label unsupported paths.

### A05 — P1: bank CSV deduplication can collapse legitimate rows across files

**Evidence (synthetic runtime):** `packages/shared/src/bank.ts:parseBankCsv` fingerprints date/amount/description/reference plus a per-file occurrence count, not bank account or transaction identity/balance. Two separate synthetic files each containing a same-day £5 transaction with the same description but running balances £100 and £95 produced the same fingerprint. `services/bank.ts:importStatement` silently skips conflicts on `(tenant_id, fingerprint)`.

**Impact:** identical legitimate payments split across exports (or accounts) can be reported as already imported. Whole-file repeats and two identical rows within one file work, but that is not enough to prove arbitrary overlapping imports are lossless. Statement matching also lacks a complete locked-period reconciliation workflow; list results are capped at 2,000 without pagination.

**Next:** bank-account identity, stable bank transaction IDs where available, explicit ambiguity review where unavailable, duplicate diagnostics, paginated completeness and statement closing-balance reconciliation. Never silently deduplicate an uncertain match.

### A06 — P1: voice/conversational AI is missing, not an enhancement already present

**Evidence (static):** `ai/gateway.ts:AI_PURPOSES` only covers bill reading, email reply/reminder, quote drafting and price updates. No chat/transcription/speech capture or voice-to-time/material execution path was found. `worker.ts` supports only a fake or disabled provider; setting another provider name does not configure a real adapter.

**Next:** specify a bounded text command layer first, then voice transcription on top. Resolve tenant/job/person explicitly, display interpreted times/units/prices, request clarification for ambiguity, show a draft/diff, confirm before committing, audit provenance and support Undo. Never let model output bypass server permission, overlap, invoice-lock or idempotency rules. Untrusted bill/email/transcript content must remain data, not instructions. Keep manual entry fully usable when AI is unavailable.

### A07 — P1: AI budget/privacy and external-send guarantees need hardening

**Evidence (static):** gateway checks previously logged spend before calling the model, with no reservation or serialized budget lock; concurrent calls and a single expensive call can exceed the cap. Prompt/answer text is stored up to 20,000 characters in `ai_calls`; no retention/minimisation policy is specified. `proposals.ts:releaseDue` holds rows with `FOR UPDATE SKIP LOCKED`, but sends before the DB status/event update commits. A successful external send followed by rollback/crash could send twice on retry; provider idempotency is not part of `MessageSender`'s shown contract.

**Existing strengths:** schema validation, owner-only decision functions, version checks, two-minute email hold and Stop, narrow purposes, event logs, null sender/provider fail closed. No evidence of AI directly paying or deleting.

**Next:** privacy/region/consent and retention decisions, sanitised logs, reserved/concurrency-safe budget with bounded calls, adversarial prompt fixtures, and transactional delivery intent/provider dedupe. Test approve/Stop/cron races and crash-after-send before real email is enabled.

### A08 — P1: offline support does not cover core field capture consistently

**Evidence (static + passing outbox unit tests):** `offline/index.ts` queues cached job/quote edits, timers and customer/job/quote creation, with idempotent replay and explicit conflicts. `api/jobDetail.ts` directly posts manual time, materials, notes/photos; these do not go through the outbox or supply idempotency keys. `main.tsx` makes mutations fail fast offline rather than queueing automatically. Appointment/customer edits likewise are not covered by the job/quote edit queue.

**Impact:** core field tasks fail without signal; ambiguous retry can duplicate non-idempotent creation after a lost response. This is a capability gap, not proof those failures falsely show “saved”.

**Next:** explicit offline support matrix and user-facing status for every mutation, durable file/time/material queue with retry identity, safe photo storage limits and conflict handling. Test close/reopen device, lost response, large uploads and server rejection. Keep financial external actions online/confirmed unless specifically designed otherwise.

### A09 — P1: offline identity and permission-revocation boundaries need stronger guarantees

**Evidence (static risk, not a reproduced disclosure):** persisted queries use one device key (`offline/persist.ts`), include successful session data, and persist for seven days (`main.tsx`). Explicit sign-out does clear outbox/cache (`api/hooks.ts`), which is good. However, outbox operations bind only `tenantId`, not originating user; flush selects the current tenant once. Login verification clears queries but not the pending outbox. Expiry or a different user authenticating to the same tenant therefore needs tests to rule out replay under the new identity. Server-side role checks do not revoke already cached records offline.

**Next:** bind queue/cache to user + tenant, define session-expiry/offline-access and shared-device policy, quarantine stale operations on identity change, and purge/redact on permission changes. Test expired session, new login without explicit logout, revoked staff/subcontractor assignment, and tenant/user switches. Do not describe the existing tenant-only outbox guard as full identity isolation.

### A10 — P2: scheduling and concurrent time conflict coverage is incomplete

**Evidence (static):** appointment create/update checks membership and valid interval but not double-booking or version preconditions. Manual timesheet overlap checks are reads; creation locks the job, not the person across jobs, so concurrent entries for one person on different jobs may race. No cross-job exclusion constraint was found. Recurrence/working-hours scheduler and inventory/PO models were not found.

**Next:** optional hard clash lock (review requirement S1), appointment versions, per-person serialization/exclusion for time, deterministic timezone/DST tests and concurrent API tests. Keep recurrence, inventory and purchasing as explicit roadmap items rather than deployed claims.

### A11 — P2: UX/accessibility needs browser and real-device acceptance

**Evidence:** main sheets have dialog labels, focus trap/return, mobile layout and dark/light styling. PR #1 replaces the problematic native job picker with a bounded in-flow listbox, keyboard navigation and focus handling; its six additional web tests pass. Its eight viewport/theme tests remain blocked at launch. A source review cannot establish screen-reader usability, contrast, virtual-keyboard fit or touch drag reliability. Main production build warns on large chunks: entry ~793 kB, PDF.js ~1,626 kB (uncompressed); PWA precaches ~2,844 KiB.

**Next:** approve PR #1 only after 320px/landscape/light/dark/virtual-keyboard and Escape/Tab focus checks on a working runner/device. Test full quote→job→invoice and offline recovery with assistive tech; audit errors, target sizes and contrast. Consider lazy-loading heavy document tooling and selective precaching based on field-device performance.

### A12 — P1: production readiness requires implementations and operational ownership

**Evidence (static/build):** `DEPLOY.md` is candidly “not deployed”. `services-for-env.ts` always returns an unconfigured sign-in mailer/null sender: choosing an env name alone is insufficient. Worker has placeholders/disabled services; photos/Turnstile have adapters but require bindings. Google has OAuth, encrypted tokens and reconnect/sync status, but no real-account verification in this audit. No documented tested backup/restore, RPO/RTO, migration rollback, alerting or incident runbook was established. Complete portable export for review requirement M10 was not found; report CSV/PDF output is not that export.

**Next:** choose service providers/regions and operational owner, implement missing adapters, synthetic staging acceptance, backup restore drill, least-privilege runtime DB role, secret rotation procedures, health/cron/sync alerts, and full export including media/documents. Retain fail-closed behavior and prevent demo/fake providers entering a real business environment. Deployment must be a separate approved task.

## Test execution and honest blockers

Environment: Node `v22.23.4`, pinned pnpm `10.34.6` obtained via workspace-local Corepack. Frozen install succeeded; no lockfile/source changes. Tools, downloaded browser and logs stayed in ignored `node_modules`. PR tested in an isolated detached worktree, then removed.

| Command / target                                                                                       | Observed outcome                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                                                                       | Passed                                                                                                                                                             |
| `pnpm db:start`                                                                                        | Blocked: embedded PostgreSQL `initdb` cannot run as root                                                                                                           |
| **`pnpm check` (canonical)**                                                                           | Failed at `format:check`: `PROGRESS.md`, pre-existing `ditto.json`; later canonical stages did not run                                                             |
| `pnpm lint`                                                                                            | Passed; rerun after removing temporary PR worktree also passed                                                                                                     |
| `pnpm typecheck`                                                                                       | Passed shared/API/web                                                                                                                                              |
| `pnpm --filter @lse/shared test`                                                                       | 194 passed, 4 skipped; 18 files passed, 1 skipped                                                                                                                  |
| `pnpm --filter @lse/web test` (main)                                                                   | 63 passed, 17 files                                                                                                                                                |
| `pnpm --filter @lse/api test`                                                                          | Global setup failed: `ECONNREFUSED 127.0.0.1:54329`; no API assertions verified. Log's “No test files found” is not evidence of absent tests (31 test files exist) |
| `pnpm build`                                                                                           | Passed API Worker dry-run/shared/web; web large-chunk warnings                                                                                                     |
| Main `build:preview` + demo Playwright config                                                          | Preview build passed; 4 screenshot tests failed at browser launch after local Chromium download: missing `libglib-2.0.so.0`                                        |
| Main `playwright test --project=mobile --project=desktop`                                              | Setup failed: system Chrome absent at `/opt/google/chrome/chrome`; 84 tests did not run. Seeded DB is also unavailable                                             |
| Main `CI=1 pnpm --filter @lse/web test:e2e:pwa`                                                        | Build passed; 1 test blocked at Chromium launch by missing `libglib-2.0.so.0`                                                                                      |
| PR #1 `pnpm --filter @lse/web test`                                                                    | 69 passed, 18 files, including picker/Sheet tests                                                                                                                  |
| PR #1 `build:preview` + `CI=1 … playwright test --config playwright.screens.config.ts schedule-picker` | Preview build passed; 8 picker tests failed before assertions at Chromium launch (same missing library)                                                            |
| Synthetic `tsx` probes through API package                                                             | Passed: cash posts to bank 090; distinct balance rows share CSV fingerprint, as described in A04/A05                                                               |

Initial demo attempts lacked `dist-preview`; rebuilt correctly before recording final browser blocker. Initial PR worktree under `node_modules` hit Node's type-stripping restriction; moved it within this workspace and reran. An attempted `build:static` script did not exist; used the documented `build:preview`. No system library installation, real-service tests or production deployment attempted. Historical memory claims of passing e2e/checks are not counted here.

The CI workflow (`.github/workflows/ci.yml`) provisions a non-root Ubuntu runner and Chromium OS dependencies. It runs canonical checks, stack e2e and PWA tests; PR #1's demo picker suite is explicitly excluded from stack e2e, so it needs a dedicated invocation/CI gate. Actual remote CI status is not asserted by this report.

## Suggested delivery sequence and decisions

1. **Release-safety gate:** close A01; prove tenant/assignment isolation, restore non-root DB/browser checks, pass canonical check and PR #1 geometry/focus tests. Add identity-revocation coverage. No real pilot before this gate.
2. **Standalone accounting gate:** accountant signs off source-to-ledger mappings (including customer credit before/after issue), chart, cash, tax, opening balances, corrections/locks and bank reconciliation. Add regression fixtures before extending scope. Do not introduce a Xero dependency as a shortcut.
3. **Reliable field workflow gate:** complete explicit offline time/material/note/photo behavior, durable replay and concurrent scheduling/time rules. Demonstrate ordinary trade work without AI.
4. **Safe AI gate:** bounded text drafts for time/material entry → confirmation/audit/Undo → optional voice input. Prove ambiguous/hostile requests cannot cross permissions or send/pay/delete; address budget/privacy/delivery before configuring providers.
5. **Interoperability and deployment gate:** portable business export, then optional Xero accountant connector with mappings, preview/reconciliation, idempotency and visible last-success/error state. Choose one-way/two-way scope explicitly; never overwrite business name/tax/timezone silently. Complete provider setup, backup/restore and monitored synthetic staging before separate deployment approval.

**Decisions needed from Joe / accountant:** first-release jurisdiction/entity and exact “Xero-class” scope; cash/payroll/assets/multi-currency needs; customer-credit accounting treatment; assigned subcontractor and Office/accountant write permissions; offline shared-device/expiry policy; voice confirmation/Undo expectations; Xero export versus sync direction/conflict ownership; provider regions/budgets and who owns support/backups/incidents. One subscription remains a product/commercial goal, not something a Xero connection itself guarantees.

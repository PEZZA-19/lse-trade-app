# Offline field work: blocked on main

## Base and outcome

Reviewed `origin/main` at `b13e784` on branch `feature/offline-field-work`.
No feature code, migrations or tests were changed. No unpublished branch, assignment-scope
commit `73f0022`, Schedule picker PR #1 or audit branch was used.

Implementation stopped at the assignment-access prerequisite, as required by the task.
This document is a source review, not a runtime security test or an offline verification.

## Missing prerequisite

Main needs server-side enforcement of assignment-scoped job access before queued job writes
can safely replay for subcontractors. The shared access contract says subcontractors only see
jobs they are on (`packages/shared/src/access.ts`), but main does not enforce that restriction
in the job write paths reviewed:

- `apps/api/src/app.ts:279–314`: middleware checks session/business membership, access areas
  and price visibility. `areaForPath()` returns `null` for job timer, time, note and photo
  writes. The priced-material restriction is real and must remain; it is not an assignment check.
- `apps/api/src/services/jobs.ts:272–275`: `lockJob(tx, id)` selects a job by ID under tenant
  RLS. It receives no user identity and does not consult `job_assignees`.
- `apps/api/src/services/jobDetail.ts`: `assertCanRecord()` blocks accountants, not unassigned
  subcontractors. `addTimesheet()`, `addJobLine()`, `addNote()` and `addPhoto()` use that check
  followed by `lockJob()`. Time-entry ownership/member checks do not establish job access.
- `apps/api/src/services/jobs.ts`: timer start/stop also use `lockJob()`, without an assignment
  check. `getJob()` selects by job ID without checking the caller's assignments.
- `apps/api/migrations/0001_core.sql`, `0005_job_stages.sql`, `0006_schedule_timesheets.sql`
  and `0014_job_detail.sql`: relevant policies isolate by `tenant_id = app_current_tenant()`;
  they do not restrict a user to assigned jobs within that business.
- `apps/api/src/app.ts:1029–1095`: manual time, materials, notes and photo routes call these
  services directly. Their create routes also lack the existing `idempotent()` wrapper;
  their edit routes do not consume `If-Match`. Those replay/version gaps belong to the
  eventual offline implementation, not an access workaround.

Tenant isolation and own-time restrictions are not absent. The specific missing protection
is refusal of a job-level operation against an unassigned job in the same business for a
caller whose access is assignment-scoped. Child-ID reads/edits/deletes must inherit the job's
access check, not merely check ownership of the child row.

## Owner decision required

Make an approved, server-enforced assignment-access prerequisite available on `origin/main`,
with synthetic integration coverage for assigned/unassigned jobs, other businesses and child
record routes. Then rerun this task from the new main. This task does not authorize adding
that prerequisite, importing the excluded fix, using client-only guards or bypassing existing
price/role restrictions.

## Scope deferred

All feature goals remain deferred: timer gap fixes and runtime verification; replay-safe manual
time and materials; optional notes; device photo storage/upload; pending overlays after reload;
outbox merge/replay/ordering tests; API integration tests for new paths; Sync refusal handling.

Photo feasibility/storage configuration was not assessed to completion after the stop decision.
Main's photo service does expose `storage_not_configured` and a 3 MB upload cap, but this is
not evidence of durable device storage or configured production R2. No real account or secret
was inspected. A future implementation must keep photos queued until server confirmation and
show an explicit storage-not-configured state when applicable.

## Validation and limitations

- `git fetch origin main`: passed; base is `b13e784`.
- `git diff --cached --check`: passed for this documentation change.
- No unit/integration tests, typecheck, lint, build, `pnpm check`, browser e2e or airplane-mode
  tests were run: implementation stopped at the prerequisite; this workspace has no `pnpm`,
  `node_modules` or Docker executable. Dependencies were not installed for a documentation-only
  stop report.
- The task flags pre-existing canonical formatting failures in `PROGRESS.md` and `ditto.json`.
  They were not independently reproduced or fixed. The workspace-provided untracked
  `ditto.json` was left untouched and excluded from the commit.
- No real iPhone/Android behaviour, IndexedDB durability, R2 upload, or end-to-end replay is
  verified by this review. No private customer/job/bank data or `/workspace` files were accessed.

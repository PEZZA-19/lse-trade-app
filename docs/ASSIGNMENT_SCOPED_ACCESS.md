# Assignment-scoped API access

## Policy (release-blocking audit finding)

Sources: `packages/shared/src/access.ts` explicitly says subcontractors only see jobs they are on;
`services/access.ts` and migration 0019 define role defaults and admin overrides. `PROGRESS.md`
(session 3 and Q30–31) distinguishes area permissions from job/time access. `DESIGN.md` and
`REQUIREMENTS_FROM_REVIEWS.md` require honest server-confirmed work, paging, exports and offline
replays; neither grants wider job access. Existing `access.test.ts` explicitly permits staff with
Field worker access to read all business jobs. There is no persisted assignment-scoped Field worker
preset: Field worker and Subcontractor have identical area arrays; membership role distinguishes them.

- Non-admin **subcontractor memberships** are assignment-scoped, even with custom/Office area grants.
  Owners and explicitly promoted admins are not scoped. Staff (including Field worker) and accountants
  retain existing tenant-wide visibility and existing write restrictions. Missing membership fails closed.
- Assignment means a current `job_assignees` row matching **both tenant and signed-in user ID**.
  `MemberDto.userId`, `job_assignees.user_id` and `appointments.user_id` reference `users.id`, not a
  separate person/member ID. A booking, tenant membership, stage named Assigned, creation of a job,
  or an appointment for somebody else is **not** job assignment. An appointment booked to a subcontractor
  on an otherwise unassigned job does not grant job access; the office must assign the job too.
- Assigned jobs can be read and worked on using existing permissions (own time/notes/photos; stage
  and timer actions). Removing a scoped person's assignment closes their running timer in the same
  transaction; it must not leave a hidden timer blocking their next assigned job. All appointments on
  an accessible job remain visible. Money and priced-line writes
  still require the existing area permissions. Scope does not grant additional permissions.
- Scoped users cannot create unassigned jobs or manage job assignees (including assigning themselves).
  Hidden job/child IDs answer 404 just like another tenant's records; global capability denials use 403.
- Filtering must happen before counts, search and paging. Nested data, direct child IDs, invoice/credit
  documents, supplier bills, customer-linked jobs/quotes, reports and calendar feeds obey the same scope.
  Revocation also applies to cached idempotent responses and calendar activity/Undo. Scoped photo
  responses use `private, no-store` so later requests recheck authorization.
- Unstructured business-wide enquiry/AI inboxes and bank statement records cannot safely be separated
  by job; they are unavailable to scoped users, including custom area grants. Staff/admin behavior is
  unchanged. AI bill reads/price suggestions and global stage-configuration mutations are denied too:
  they cannot be confined to assigned-job work. Global customer/contact access remains as documented;
  linked job data is filtered.

## Enforcement

Migration 0034 adds restrictive RLS alongside existing tenant isolation. It derives scope from live
membership/access rows, not a request-provided flag, and filters jobs and job-bearing descendants.
`job_assignees` retains tenant-only SELECT deliberately: the job policy must consult it without RLS
recursion. No API exposes this table standalone; job detail checks the parent first. Its mutations
are restricted to unscoped users. No SECURITY DEFINER or owner/RLS bypass is added. Policies target
`app_user`, preserving the existing narrow schema-owner cron read policies from migration 0021.
Held-email releases authorize within the tenant as its owner (missing owners fail closed); event
records retain the existing NULL system actor, rather than attributing cron work to that owner.

The API checks job parents inside the same transaction before executing any `/jobs/:id` handler,
including idempotent replay, and explicitly denies scope-escalating operations. Idempotency responses
are person-bound and rechecked for job references. Guards and replays derive scope from live
transaction membership, even if a previously loaded role/access object is stale. Public calendar feeds and scheduled sync use the
same database policy; the person identified by a feed/connection is the authorization identity.

## Verification

See `apps/api/test/assignmentAccess.test.ts` for synthetic, authenticated API integration coverage:
assigned, cross-assigned, unassigned and other-tenant jobs; person/tenant identity; search/counts/paging;
parent and direct-child read/write denial; money and document exports; linked converted quotes;
calendar lists/iCal/sync/activity/Undo; revocation and indirect cached bill/invoice responses; stale
role objects; unchanged staff Field, accountant and admin capabilities. Existing access, job-detail,
calendar, invoice, concurrency and cron regressions run alongside it.

Verification commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` (API build is a
Wrangler **dry run**, not a deployment). No real calendars, private data or deployments are needed.

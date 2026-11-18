# Product/code audit — evidence checkpoint

## Scope and refs

Target: one app with Tradify-style operations, native Xero-class accounting and safe conversational/voice AI. Xero must remain optional accountant interoperability.

- Main and origin/main: `b13e784c98ad9c410c60df6f445c255a3395699a`.
- PR #1: open, **draft and unmerged**, `fix/schedule-job-picker-overflow`, head `369a8195e4d80dcec93add3515c3d67457779a6a`. Fetched as `origin/pr-1` and inspected. Eight changed web files; this audit does not modify them.
- Audit branch: `audit/product-code-review`, based on main. Only this report is intended for commit.
- Read README, PROGRESS (all 1,080 lines), DESIGN, DEPLOY and review requirements. Progress contains contradictory historical/current sections; implementation is the authority.
- No private customer/job/bank files accessed; no real services, secrets or deployment configured.

## Initial checks

- Node `v22.23.4`; pnpm initially absent; project-pinned pnpm `10.34.6` available through Corepack with workspace-local cache.
- `pnpm install --frozen-lockfile`: succeeded; no preinstalled node_modules existed.
- `pnpm db:start`: failed: embedded PostgreSQL `initdb` cannot run as root. No database tests verified yet.
- Canonical `pnpm check`: failed at format:check, warnings for tracked `PROGRESS.md` and pre-existing untracked `ditto.json`. Later stages did not execute. No formatting fixes made in this audit pass.

## Work in progress

Implementation/domain review and independent checks follow. This checkpoint is not a completed capability or coverage claim.

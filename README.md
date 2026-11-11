# LSE Trade App

Jobs, quotes and (soon) invoicing for Little Sark Electric, built multi-business from day one so it can
be sold to other trades later. AI helpers will draft; a person always approves.

- **apps/web** – React + TypeScript installable web app (PWA). Runs on Windows, macOS, Linux, iPhone,
  Android and any browser. Capacitor store apps later reuse the same code.
- **apps/api** – Hono API for Cloudflare Workers (Postgres on Neon via Hyperdrive in production).
- **packages/shared** – money maths, numbering, zod validation and API types shared by both.

See [PROGRESS.md](PROGRESS.md) for status and how to run it, [DESIGN.md](DESIGN.md) for UI rules, and
[docs/REQUIREMENTS_FROM_REVIEWS.md](docs/REQUIREMENTS_FROM_REVIEWS.md) for lessons from competitor reviews.

## Quick start

```bash
pnpm install
pnpm db:start        # local Postgres 17 on :54329 (no system install needed)
pnpm db:seed         # migrate + fictional demo data (owner@lse.example)
pnpm dev             # API on :8787, web on http://127.0.0.1:5173
```

Sign in: open http://127.0.0.1:5173, enter `owner@lse.example`, then run `pnpm sign-in-link` and open the
link it prints. No email is ever sent in development; the API prints the link and writes it to
`apps/api/.dev-sign-in-link` (git-ignored).

Checks: `pnpm check` (format, lint, typecheck, unit/integration tests, builds), `pnpm test:e2e`, and
`pnpm --filter @lse/web test:e2e:pwa` (production build reopens offline).

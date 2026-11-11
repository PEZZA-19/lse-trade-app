# Deploy checklist (not deployed)

Nothing here has been run. No Cloudflare, Neon, R2 or email accounts exist yet; each step needs Joe.

Every slot **fails closed** until it is configured (`apps/api/src/services-for-env.ts`, tested in
`apps/api/test/deployReadiness.test.ts`):

| Slot            | How to switch it on                                                                                       | Until then                                         |
| --------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Database        | Neon (London) + Hyperdrive; put the Hyperdrive id in `wrangler.jsonc`; run migrations as the schema owner | the Worker can't start (placeholder id)            |
| Sign-in email   | choose a provider (UK/EU region), add an adapter in `services-for-env.ts`                                 | sign-in links fail loudly (`email_not_configured`) |
| Approved emails | same provider (or Joe's own mailbox)                                                                      | after the 2-minute hold they end **"not sent"**    |
| Held-email cron | already in `wrangler.jsonc` (`* * * * *`) → `scheduled()` in `worker.ts`                                  | the inbox still releases them when opened          |
| Website form    | Turnstile site key in the web form, `wrangler secret put TURNSTILE_SECRET`                                | the form answers 503 "not switched on yet"         |
| Photos          | create an R2 bucket (EU jurisdiction), uncomment `r2_buckets` (binding `PHOTOS`)                          | uploads answer 503 "storage not set up"            |
| AI drafts       | not chosen; `AI_PROVIDER` unset                                                                           | AI helpers are off and say so                      |

The held-email cron uses one narrow database function, `held_due_tenants()` (migration 0016),
which returns only business ids; each release then runs inside that business's RLS scope.

The private local demo (`/workspace/lse-demo-local/`) is never part of a deploy or the public preview.

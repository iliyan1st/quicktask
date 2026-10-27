# QuickTask — working notes

Single source of truth for project state (the old DEPLOYMENT_*/FINAL_SUMMARY/READY_TO_DEPLOY docs were stale and are gone). Architecture and setup: `SETUP.md`.

## Live
- Site: https://quicktask-five.vercel.app (Vercel Git integration, deploys `master`, serves `public/`)
- DB: Supabase `yboawqkhjkjutzerypiv` (eu-central-1, free org: max 2 active projects)
- Keep-alive: cron-job.org job 8736614, daily 09:17 Europe/Sofia, so the free project isn't auto-paused
- Task expiry: pg_cron job `quicktask-expire-tasks` every 5 min

## 2026-10-27: hardening + features
Decisions (from the user):
- QuickTask DB was paused (free tier). Restored by pausing `bonus-karta` (its site is down until restored).
- Payments: demo wallet with test credits, no real money. Escrow is held when the poster selects a bid and released on completion.
- Replace the unused `api/` Vercel functions with pg_cron in the DB.
- Push to master once tests pass.

Done:
- [x] Committed the backend files that were only on disk (f929e33)
- [x] DB migration `supabase/migrations/20261027_secure_rpcs_and_features.sql`, applied live (817d8b9)
- [x] DB tests `tests/db-security.test.mjs`: 148/148 pass (`node --test`)
- [x] Supabase auth site_url → live domain (was localhost:3000)
- [x] Removed `api/`, `lib/`, `vercel.json`, stale docs and scripts (6827542)
- [x] Frontend: RPC wiring, ratings, notifications + realtime (self-healing), photo upload, demo wallet, i18n completion, XSS fixes
- [x] E2E browser pass (`tests/e2e-flow.cjs`): 167 pass / 0 bugs after fixes; realtime recovery 14/14
- [x] Pushed and verified live 2026-10-27 (c2283f1): smoke test clean, cron succeeding

## Open items / decisions for later
- Google/Facebook login: providers are disabled in Supabase; the buttons are hidden behind `OAUTH_ENABLED` in index.html.
- Email confirmation is off (`mailer_autoconfirm`); no custom SMTP.
- In-progress cancellation rule: currently only the doer can back out (refund to poster). See `cancel_task` in the migration.
- Feed "Sponsored" cards are placeholder ads for fictional businesses.

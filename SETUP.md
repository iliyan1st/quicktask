# QuickTask - Setup Guide

## Architecture
- **Frontend**: one static page, `public/index.html` (HTML/CSS/JS inline, Supabase JS from a pinned CDN build). Bulgarian by default, English toggle.
- **Backend**: Supabase only. The browser talks to Postgres through Supabase with the anon key, so **Row Level Security, column grants, triggers and RPC functions are the backend**. There is no server code.
- **Scheduled work**: `pg_cron` inside the database runs `expire_tasks()` every 5 minutes.
- **Hosting**: Vercel serves `public/` (Git integration, deploys on push to `master`).
- **Cost**: €0/month on free tiers.

---

## Step 1: Supabase

1. Create a project (EU region) at https://supabase.com.
2. **SQL Editor**: run these in order:
   1. `supabase/schema.sql`: tables, base policies, triggers
   2. `supabase/functions.sql`: legacy helper functions
   3. `supabase/migrations/20261027_secure_rpcs_and_features.sql`: locks down direct writes, adds the workflow RPCs, demo wallet, notifications, ratings, photo bucket, realtime and the cron job. Safe to re-run.

   (`supabase/fix_runtime.sql` is superseded by the migration; you don't need to run it.)
3. **Authentication → URL Configuration**: Site URL = your deployed URL; add `http://localhost:8080/**` to redirect URLs for local dev.
4. Email confirmation is currently **off** (users are signed in right after sign-up).
5. Google/Facebook sign-in: enable the providers in **Authentication → Providers**, then set `OAUTH_ENABLED = true` in `public/index.html` to show the buttons.
6. Put the project URL and anon key in `public/index.html` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`). The anon key is public by design.

### Free-tier note
Free projects pause after about a week without API traffic, and an organization can have only 2 active free projects. A daily keep-alive request (cron-job.org job "QuickTask DB keep-alive") prevents the pause.

---

## Step 2: Deploy

Push to `master`. Vercel serves `public/` as static files, with no build step.

## Local development

```bash
python -m http.server 8080 --directory public
# open http://localhost:8080
```

Dev helper: while logged in, run `createDummyPosts()` in the browser console to add 15 sample tasks.

---

## How the workflow is enforced (database)

| Action | How the browser does it | Enforced by |
|---|---|---|
| Post task | `insert` into `tasks` | Column grants plus a `before_task_insert` trigger that sets status, counters and the deadline, and checks photo paths |
| Bid | `insert` into `bids` | `before_bid_insert`: not your own task, bidding open, fixed price forced |
| Select bid | `rpc('select_bid')` | Poster only; escrow holds the amount, rejects other bids, unlocks chat |
| Complete | `rpc('complete_task')` | Poster only; releases escrow and bumps the doer's count |
| Cancel / back out | `rpc('cancel_task')` | Poster before selection; doer while in progress (refunds escrow) |
| Withdraw bid | `rpc('withdraw_bid')` | Own pending bid |
| Rate | `rpc('rate_task')` | Participants of a completed task, once each |
| Demo top-up | `rpc('demo_top_up')` | €5–500 per call, €5000 cap. Test credits, not real money |
| Own profile incl. wallet | `rpc('get_my_profile')` | Other users only see public profile columns |
| Chat | `insert` into `messages` | Participants of an unlocked conversation; only `is_read` is updatable |

Errors come back as short keys (`insufficient_funds`, `own_task`, ...), which the frontend translates (`err_*` strings).

## Tests

```bash
node --test                 # DB security/workflow tests (tests/db-security.test.mjs) against the live project (needs .env with the service role key)
npm start                   # serve public/ on :8080, then in another terminal:
node tests/e2e-flow.cjs     # two-user browser flow (needs Playwright: npm i -g @playwright/test && npx playwright install chromium)
```

Both suites create throwaway `qa-*` / `e2e-*` users and delete everything they made at the end.

`.env` (not committed) holds `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. See `.env.example`.

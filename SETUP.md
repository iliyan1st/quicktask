# QuickTask - Setup Guide

## Architecture
- **Frontend**: Single HTML file (public/index.html)
- **Backend**: Vercel Serverless Functions (api/)
- **Database**: Supabase (PostgreSQL + Auth + Realtime)
- **Cost**: €0/month on free tiers

---

## Step 1: Create Supabase Project (Free)

1. Go to https://supabase.com and sign up
2. Click "New Project"
3. Choose a name (e.g., "quicktask"), set a database password, select EU region
4. Wait for the project to be created (~2 min)

### Get your credentials:
- Go to **Settings → API**
- Copy: `Project URL`, `anon/public key`, `service_role key`

### Set up the database:
- Go to **SQL Editor**
- Copy the contents of `supabase/schema.sql` and run it
- This creates all tables, indexes, security policies, and triggers

### Enable Auth providers:
- Go to **Authentication → Providers**
- Email is enabled by default
- Enable Google: Add your Google OAuth credentials
- Enable Facebook: Add your Facebook App credentials

---

## Step 2: Deploy to Vercel (Free)

1. Install Vercel CLI: `npm install -g vercel`
2. In the project folder, run: `vercel`
3. Follow the prompts to link your project
4. Add environment variables:
   ```
   vercel env add SUPABASE_URL
   vercel env add SUPABASE_ANON_KEY
   vercel env add SUPABASE_SERVICE_ROLE_KEY
   vercel env add CRON_SECRET
   ```
5. Deploy: `vercel --prod`

### Set up Cron (for task status transitions):
- In Vercel dashboard → Settings → Cron Jobs
- Add: `GET /api/cron/update-tasks` every 5 minutes
- Or use https://cron-job.org (free) to call the endpoint

---

## Step 3: Local Development

1. Copy `.env.example` to `.env` and fill in your Supabase credentials
2. Run: `npx vercel dev` (or install vercel globally)
3. Open: http://localhost:3000

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/signup | Register new user |
| POST | /api/auth/login | Login with email/password |
| POST | /api/auth/oauth | Get OAuth URL (Google/Facebook) |
| GET | /api/tasks | List tasks (filters: category, sort, search) |
| POST | /api/tasks | Create a new task |
| GET | /api/tasks/:id | Get task detail with bids |
| PATCH | /api/tasks/:id | Update task (select bid, complete, cancel) |
| GET | /api/bids?task_id=x | Get bids for a task |
| POST | /api/bids | Place a bid |
| GET | /api/messages | List conversations |
| GET | /api/messages?conversation_id=x | Get messages |
| POST | /api/messages | Send a message |
| GET | /api/wallet | Get balance + transactions |
| POST | /api/wallet | Add funds / set payment mode |
| GET | /api/users/:id | Get user profile |
| PATCH | /api/users/:id | Update own profile |
| GET | /api/users/me | Get current user + dashboard data |
| GET | /api/cron/update-tasks | Transition task statuses |

---

## Database Schema

- **profiles**: User profiles with trust levels, ratings, wallet
- **tasks**: Posted tasks with bidding/selection windows
- **bids**: User bids on tasks
- **conversations**: Chat threads (locked until bid selected)
- **messages**: Chat messages
- **ratings**: Post-task ratings
- **transactions**: Wallet transaction history
- **notifications**: Push/in-app notifications

---

## Free Tier Limits

### Supabase Free:
- 500MB database
- 1GB file storage
- 50,000 monthly active users
- 2GB bandwidth

### Vercel Free:
- 100GB bandwidth
- Serverless function executions: 100,000/month
- 6,000 build minutes/month

These limits are MORE than enough for launching and growing to your first 1,000+ users.

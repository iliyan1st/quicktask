# QuickTask Deployment - Complete Guide

## Current Status
- ✅ Code committed locally (4 commits)
- ✅ Vercel project configured (Project ID: prj_Qaz8qGA2YTiaztmMqsOHVHivsnBS)
- ✅ Supabase configured (credentials in .env)
- ⏳ Git remote NOT YET configured
- ⏳ Code NOT YET pushed to GitHub

## Prerequisites
You need:
1. GitHub account with a repository for QuickTask
2. Vercel account (already connected to the project)
3. Access to connect GitHub repo to Vercel

## Step 1: Identify or Create GitHub Repository

### Option A: If QuickTask repo already exists on GitHub
```bash
# Use your existing repo URL
export GITHUB_REPO="https://github.com/YOUR_USERNAME/quicktask.git"
```

### Option B: Create a new repository on GitHub
1. Go to https://github.com/new
2. Create repository named `quicktask`
3. Choose public or private
4. Do NOT initialize with README (we have one)
5. Copy the HTTPS URL: `https://github.com/YOUR_USERNAME/quicktask.git`

## Step 2: Setup Git Remote and Authentication

### For HTTPS (Username/Password or Token):
```bash
cd /c/Users/iliyan.h/QuickTask

# Add remote
git remote add origin https://github.com/YOUR_USERNAME/quicktask.git

# Push to GitHub
git push -u origin master

# You'll be prompted for:
# - GitHub username
# - GitHub password OR Personal Access Token (if 2FA enabled)
```

### For SSH (Recommended):
```bash
# First, ensure SSH key is added to GitHub
# https://github.com/settings/keys

cd /c/Users/iliyan.h/QuickTask

# Add SSH remote
git remote add origin git@github.com:YOUR_USERNAME/quicktask.git

# Push to GitHub
git push -u origin master
```

## Step 3: Connect GitHub to Vercel

### Option A: If already connected
- Vercel will auto-deploy when you push

### Option B: If NOT connected
1. Go to https://vercel.com/dashboard
2. Click "Add New" → "Project"
3. Select "Import Git Repository"
4. Choose GitHub from the list
5. Search for "quicktask"
6. Click "Import"
7. Vercel will ask for environment variables
8. Add `.env` variables:
   ```
   SUPABASE_URL=https://yboawqkhjkjutzerypiv.supabase.co
   SUPABASE_ANON_KEY=[from .env file]
   SUPABASE_SERVICE_ROLE_KEY=[from .env file]
   NEXT_PUBLIC_SITE_URL=https://quicktask-five.vercel.app
   CRON_SECRET=quicktask-cron-secret-2024
   ```
9. Click "Deploy"

## Step 4: Verify Deployment

After pushing to GitHub:

1. **Check Vercel Dashboard**
   - https://vercel.com/dashboard
   - Look for QuickTask project
   - Watch for "Building..." → "Ready"

2. **Check Live Site**
   - https://quicktask-five.vercel.app
   - Should load without errors
   - Look for language toggle button (EN/BG)

3. **Test Bilingual Feature**
   - [ ] Load page in Bulgarian
   - [ ] Click "EN" button
   - [ ] Verify all text switches to English
   - [ ] Reload page
   - [ ] Verify language persisted
   - [ ] Check browser console (F12) for errors

## Step 5: Monitor Deployment

```bash
# View recent deployments
# Via Vercel Dashboard → Deployments

# Check deployment logs
# Vercel Dashboard → Project → Deployments → Click deployment

# View live site
curl https://quicktask-five.vercel.app | head -20
```

## Troubleshooting

### "fatal: could not read from remote repository"
- Check GitHub repo exists
- Verify URL is correct
- Verify SSH key is added (if using SSH)
- Check git credentials are stored (if using HTTPS)

### "Permission denied (publickey)"
- SSH key not added to GitHub
- Generate new SSH key: `ssh-keygen -t ed25519`
- Add to GitHub: https://github.com/settings/keys

### Vercel deployment fails
- Check environment variables are set correctly
- Verify Supabase credentials are valid
- Check .env file is in .gitignore (it should be!)
- Review Vercel deployment logs

### Bilingual feature not working
- Clear browser cache
- Check localStorage for `qt_lang`
- Open DevTools (F12) and check Console for errors
- Verify HTML file was deployed (check file size)

## Git Commands Reference

```bash
# Check status
git status

# View commits
git log --oneline -10

# Add remote
git remote add origin <URL>

# View remotes
git remote -v

# Push to GitHub
git push -u origin master

# Pull latest changes
git pull origin master

# Create new branch
git checkout -b feature-name

# Commit changes
git add .
git commit -m "message"

# Push branch
git push -u origin feature-name
```

## Vercel Environment Setup

### Current Environment Variables
```
SUPABASE_URL=https://yboawqkhjkjutzerypiv.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
NEXT_PUBLIC_SITE_URL=https://quicktask-five.vercel.app
CRON_SECRET=quicktask-cron-secret-2024
```

### How to Set in Vercel
1. Go to Project Settings → Environment Variables
2. Click "Add New"
3. Enter key and value
4. Select which environments (Production/Preview/Development)
5. Click "Save"
6. Re-deploy for changes to take effect

## Database Setup (Supabase)

### Status: ✅ Already Configured

Database credentials are in `.env`. The schema should already be set up in Supabase.

To verify or update schema:
1. Go to https://app.supabase.com
2. Select your project: `yboawqkhjkjutzerypiv`
3. SQL Editor
4. Run schema from `supabase/schema.sql` if needed

### Tables Needed
- `profiles` (users)
- `tasks` (posted tasks)
- `bids` (task bids)
- `conversations` (messages)
- `messages` (message content)

## Next Actions

1. ✅ **Code committed** - Done
2. ⏳ **Setup GitHub repo** - You do this
3. ⏳ **Add git remote** - Run: `git remote add origin https://github.com/YOUR_USERNAME/quicktask.git`
4. ⏳ **Push to GitHub** - Run: `git push -u origin master`
5. ⏳ **Verify Vercel deployment** - Wait 5 min, check https://quicktask-five.vercel.app
6. ⏳ **Test bilingual feature** - Use testing checklist
7. ⏳ **Monitor for errors** - Check Vercel dashboard and browser console

## Support

If you need help:
1. Check Vercel deployment logs
2. Review browser console errors (F12)
3. Verify all environment variables
4. Check Supabase connectivity
5. Ensure .env file has correct credentials

---

**Created**: 2026-02-26 23:35 UTC
**Model Used**: Claude Sonnet 4.6
**Status**: Ready for GitHub/Vercel deployment

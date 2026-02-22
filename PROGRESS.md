# QuickTask - Progress Log

## What's Done

### 1. Frontend Prototype (index.html)
- Single HTML file SPA with all CSS/JS inline
- Views: Home, Task Detail, Create Task, My Tasks, Messages, Wallet, Profile
- Mobile-first design (430px), deep blue + teal color scheme

### 2. Backend (Supabase)
- Project: `yboawqkhjkjutzerypiv.supabase.co` (EU Frankfurt)
- Schema executed: 8 tables (profiles, tasks, bids, conversations, messages, ratings, transactions, notifications)
- Functions executed: `increment_tasks_posted`, `get_nearby_tasks`, `get_user_stats`
- **FIXED**: `handle_new_user()` trigger - changed `profiles` to `public.profiles`
- Email confirmation disabled for dev

### 3. Frontend ↔ Supabase Wiring (DONE)
- Supabase JS SDK v2 added via CDN
- Auth: login, signup, Google OAuth, sign out
- Session management with `onAuthStateChange`
- All views query real Supabase data
- Task creation, bidding, bid selection, task completion all work
- Messages/chat system wired
- Wallet view wired

### 4. Test Account
- Email: `test@quicktask.eu`
- Password: `QuickTask2024!`
- Username: `iliyan1st`
- Email manually confirmed via SQL

### 5. Translation to Bulgarian (IN PROGRESS)
- Translating all UI text from English to Bulgarian
- HTML static text: auth screen done
- Remaining: main app HTML labels, JS dynamic strings (toasts, error messages, labels, categories)

### 6. Deployed to Vercel (DONE)
- Live URL: **https://quicktask-five.vercel.app**
- Vercel project: `is-projects-311967fd/quicktask`
- Environment variables configured: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
- All views tested and working on live deployment

### 7. Responsive Design (DONE)
- Removed all 430px max-width constraints from body, app-frame, header, bottom-nav, modal
- Added 4 breakpoints: Mobile (<768px), Tablet (768px+), Desktop (1024px+), Large Desktop (1440px+)
- Task cards grid: 1 column (mobile) → 2 columns (tablet) → 3 columns (desktop) → 4 columns (large desktop)
- Desktop sidebar navigation (≥1024px): vertical nav with icons + labels, replaces bottom-nav
- Sidebar wired to same showView() function, active state synced
- Chat split-screen on desktop: chat list + conversation side-by-side
- Forms and detail views: max-width centered, prevent stretching
- Detail info grid: 4 columns on desktop
- Categories: flex-wrap on desktop instead of horizontal scroll
- My Tasks: 2-column grid on desktop, 3-column on large desktop
- Modals: centered on desktop instead of bottom-aligned
- Increased padding/gaps at larger breakpoints

### 8. More Categories + Sofia Neighborhoods Filter (DONE) — 2026-02-22

**Categories expanded from 7 → 14:**
- Added: Plumbing, Electrical, Painting, Gardening, Pet Care, Tutoring, Beauty & Wellness
- Updated: `CAT_MAP`, category chips, create task `<select>`, `schema.sql` constraint
- ⚠️ DB migration still needs to run manually in Supabase SQL Editor:
  ```sql
  ALTER TABLE tasks DROP CONSTRAINT tasks_category_check;
  ALTER TABLE tasks ADD CONSTRAINT tasks_category_check
    CHECK (category IN ('home-repair','cleaning','delivery','errands','moving','tech-help','plumbing','electrical','painting','gardening','pet-care','tutoring','beauty','other'));
  ```

**Sofia neighborhoods picker:**
- `SOFIA_DISTRICTS` JS object: 24 districts → color + quarters array
- Clickable location bar → opens neighborhood picker modal
- Modal: search input, collapsible district groups with colored dots, checkboxes per quarter
- Clear / Apply buttons; selected state in `selectedNeighborhoods[]`
- Task list filters client-side by selected neighborhoods
- Task cards show location tag (📍 квартал)
- Create task form: neighborhood `<select>` (grouped by district) + optional address input
- `postTask()` combines neighborhood + address into location field

**Bug fix — blank page on load:**
- `sb.auth.getSession()` could hang indefinitely due to Navigator LockManager timeout
- Added 3-second safety timeout + try/catch so auth screen always appears

### 9. SVG District Map + Advanced Search Filters (DONE) — 2026-02-22

**SVG District Map on Home Page:**
- Schematic SVG map of Sofia's 24 districts with colored clickable polygons
- Positioned on the home page below search, above task grid — always visible
- Click district on map → selects all its quarters, filters tasks immediately
- District dropdown (`<select>`) below map for quick district selection
- Selected districts shown as colored removable tags below dropdown
- Map also in neighborhood picker modal (synced with home map)
- Hover = highlights, selected = primary stroke

**Advanced Search & Filters:**
- Keyword search input — searches title, description, location (live filtering)
- Time remaining filter dropdown: 1h, 3h, 6h, 12h, 24h — filters by `bidding_ends_at`
- Category chips (existing) + neighborhood + keyword + time all stack as filters
- Task count text shows active filters: `"12 задачи · в Лозенец · "монтаж" · до 3ч"`
- Empty state message when no tasks match filters

**Sponsored ads fix:**
- Ad banners now span full grid row (`grid-column: 1 / -1`) — no longer cut off on desktop

## What's Left

### Translation to Bulgarian (partial)
- Auth screen translated; main app JS strings still in English

## File Structure
```
QuickTask/
├── public/index.html     ← Main frontend (single file SPA)
├── api/                   ← Vercel serverless functions
│   ├── auth/ (signup.js, login.js, oauth.js)
│   ├── tasks/ (index.js, [id].js)
│   ├── bids/index.js
│   ├── messages/index.js
│   ├── wallet/index.js
│   ├── users/ ([id].js, me.js)
│   └── cron/update-tasks.js
├── lib/supabase.js
├── supabase/ (schema.sql, functions.sql)
├── .env                   ← Supabase credentials
├── vercel.json
├── package.json
└── SETUP.md
```

## Credentials (.env)
- SUPABASE_URL=https://yboawqkhjkjutzerypiv.supabase.co
- SUPABASE_ANON_KEY=eyJhbGci...hPCnClaDEd925f1_aYoP89XVr45NssMYA3PYN_zNhk4
- SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...kQW7cAJDnFG4VPFVhDc_WguheTNQK0iDgw9LuVAhaSk

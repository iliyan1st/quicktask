// QuickTask end-to-end browser flow (two real users, realtime between them).
//
// Run:   node tests/e2e-flow.cjs            full flow + cleanup
//        node tests/e2e-flow.cjs --cleanup  only remove leftover e2e-* users and their data
//
// Needs the app served at http://localhost:8080/ and SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY in .env. The service-role client is used only to
// create the two test users and to clean up; every action goes through the UI.
'use strict';

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { execSync } = require('child_process');

const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), '@playwright/test'));
const ROOT = path.join(__dirname, '..');
const { createClient } = require(path.join(ROOT, 'node_modules', '@supabase', 'supabase-js'));

// ---------------------------------------------------------------- config
const BASE = process.env.QT_BASE || 'http://localhost:8080/';
const OUT = process.env.QT_E2E_OUT || path.join(__dirname, 'e2e-output');
const HEADLESS = process.env.HEADED ? false : true;
const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };
const BUCKET = 'task-photos';
const E2E_EMAIL_RE = /^e2e-\d+-[a-z0-9]+@quicktask\.test$/i;

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env');
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const RUN = String(Date.now());
const TAG = `QT${RUN.slice(-7)}`; // goes into every task title so filters only see our tasks
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- reporting
const results = []; // { kind: pass|fail|bug|note, step, msg, shot }
const timings = {};
let shotNo = 0;
let currentStep = '';
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(actor, name, opts = {}) {
  shotNo += 1;
  const file = path.join(OUT, `${String(shotNo).padStart(3, '0')}-${actor ? actor.name + '-' : ''}${name}.png`.replace(/[^\w.\-\\/: ]+/g, '_'));
  try { await actor.page.screenshot({ path: file, fullPage: Boolean(opts.fullPage) }); } catch (e) { return `(screenshot failed: ${e.message})`; }
  return file;
}
function pass(msg) { results.push({ kind: 'pass', step: currentStep, msg }); log('  PASS', msg); }
function note(msg, shotPath) { results.push({ kind: 'note', step: currentStep, msg, shot: shotPath }); log('  NOTE', msg, shotPath || ''); }
async function bug(actor, severity, msg, shotName) {
  const s = actor ? await shot(actor, shotName || 'bug') : undefined;
  results.push({ kind: 'bug', severity, step: currentStep, msg, shot: s });
  log(`  BUG[${severity}]`, msg, s || '');
}
// Soft check: record pass, or a bug with a screenshot, and keep going.
async function check(cond, msg, actor, severity = 'major', shotName) {
  if (cond) pass(msg); else await bug(actor, severity, 'FAILED: ' + msg, shotName);
  return Boolean(cond);
}
async function step(name, fn) {
  currentStep = name;
  log(`== ${name}`);
  const start = Date.now();
  try {
    await fn();
  } catch (e) {
    const shots = [];
    for (const a of Object.values(actors)) if (a.page && !a.page.isClosed()) shots.push(await shot(a, 'step-error'));
    results.push({ kind: 'fail', step: name, msg: e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e), shot: shots.join(', ') });
    log('  STEP FAILED', e.message);
  }
  timings[name] = Date.now() - start;
}

async function poll(fn, { timeout = 10000, interval = 250 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = undefined; }
    await sleep(interval);
  }
  return null;
}

// ---------------------------------------------------------------- test data
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round((x / w) * 255); raw[o + 1] = Math.round((y / h) * 255); raw[o + 2] = 160;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- users + cleanup
const createdUserIds = [];
async function makeUser(role) {
  const email = `e2e-${RUN}-${role}@quicktask.test`;
  const password = `E2e-${RUN}-${Math.random().toString(36).slice(2)}`;
  const fullName = role === 'poster' ? 'Poster Etest' : 'Doer Etest';
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: fullName, username: `e2e_${RUN}_${role}` },
  });
  if (error) throw new Error(`createUser ${role}: ${error.message}`);
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email, password, fullName };
}

async function e2eUserIds() {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  return data.users.filter((u) => E2E_EMAIL_RE.test(u.email || '')).map((u) => u.id);
}

async function cleanup(userIds) {
  const removed = {};
  if (!userIds.length) return removed;
  const ids = userIds.join(',');
  const { data: tasks, error: te } = await admin.from('tasks').select('id').in('poster_id', userIds);
  if (te) throw new Error(`cleanup tasks lookup: ${te.message}`);
  const taskIds = tasks.map((t) => t.id);
  const tIn = taskIds.length ? `,task_id.in.(${taskIds.join(',')})` : '';
  const { data: convs, error: ce } = await admin.from('conversations').select('id')
    .or(`poster_id.in.(${ids}),doer_id.in.(${ids})${tIn}`);
  if (ce) throw new Error(`cleanup conversations lookup: ${ce.message}`);
  const convIds = convs.map((c) => c.id);
  const del = async (table, build) => {
    const { error, count } = await build(admin.from(table).delete({ count: 'exact' }));
    if (error) throw new Error(`cleanup ${table}: ${error.message}`);
    removed[table] = (removed[table] || 0) + (count || 0);
  };
  await del('transactions', (q) => q.or(`user_id.in.(${ids})${tIn}`));
  await del('ratings', (q) => q.or(`rater_id.in.(${ids}),rated_id.in.(${ids})${tIn}`));
  await del('messages', (q) => q.or(`sender_id.in.(${ids})${convIds.length ? `,conversation_id.in.(${convIds.join(',')})` : ''}`));
  await del('conversations', (q) => q.or(`poster_id.in.(${ids}),doer_id.in.(${ids})${tIn}`));
  await del('notifications', (q) => q.in('user_id', userIds));
  await del('bids', (q) => q.or(`bidder_id.in.(${ids})${tIn}`));
  await del('tasks', (q) => q.in('poster_id', userIds));
  const paths = [];
  for (const id of userIds) {
    const { data: objs } = await admin.storage.from(BUCKET).list(id, { limit: 1000 });
    for (const o of objs || []) paths.push(`${id}/${o.name}`);
  }
  if (paths.length) {
    const { data: gone, error } = await admin.storage.from(BUCKET).remove(paths);
    if (error) throw new Error(`cleanup storage: ${error.message}`);
    removed.storage_objects = (gone || []).length;
  }
  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error && !/not.?found/i.test(error.message)) throw new Error(`cleanup deleteUser ${id}: ${error.message}`);
  }
  removed.users = userIds.length;
  return removed;
}

async function verifyClean(prefix = 'QT') {
  const left = await e2eUserIds();
  const { count: profs } = await admin.from('profiles').select('id', { count: 'exact', head: true }).like('username', 'e2e\\_%');
  const { count: tasks } = await admin.from('tasks').select('id', { count: 'exact', head: true }).like('title', `${prefix}%`);
  return { e2eUsers: left.length, e2eProfiles: profs, qtTitledTasks: tasks };
}

// ---------------------------------------------------------------- browser actors
const actors = {};
let browser;

const TOAST_HOOK = () => {
  window.__toasts = [];
  window.__vis = [];
  document.addEventListener('visibilitychange', () => window.__vis.push(`${Date.now()} ${document.visibilityState}`));
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('toast');
    if (!el) return;
    // showToast always rewrites the text, so a text mutation = one toast (even when the
    // same message repeats); style-only mutations are the show/hide of that toast.
    new MutationObserver((records) => {
      if (el.style.display === 'none' || !el.textContent) return;
      if (!records.some((r) => r.type !== 'attributes')) return;
      window.__toasts.push({ at: Date.now(), text: el.textContent, lang: localStorage.getItem('qt_lang') || 'bg' });
    }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  });
};

const redact = (u) => String(u).replace(/(apikey|access_token|token)=[^&\s]+/gi, '$1=<redacted>');

async function newActor(name, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, locale: 'bg-BG', ...(opts.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addInitScript(TOAST_HOOK);
  const page = await ctx.newPage();
  const a = { name, ctx, page, viewport, mobile: Boolean(opts.mobile), logs: { console: [], pageerror: [], requestfailed: [], http: [], dialogs: [] } };
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') a.logs.console.push(`${m.type()}: ${m.text().slice(0, 400)} @ ${redact(m.location()?.url || '')}:${m.location()?.lineNumber ?? ''}`); });
  page.on('pageerror', (e) => a.logs.pageerror.push(String(e.stack || e).split('\n').slice(0, 3).join(' | ')));
  page.on('requestfailed', (r) => a.logs.requestfailed.push(`${r.method()} ${redact(r.url()).slice(0, 200)} -> ${r.failure()?.errorText}`));
  page.on('response', async (r) => {
    if (r.status() >= 400) {
      let body = '';
      try { body = (await r.text()).slice(0, 300); } catch {}
      a.logs.http.push(`${r.status()} ${r.request().method()} ${redact(r.url()).slice(0, 200)} ${body}`);
    }
  });
  page.on('dialog', async (d) => { a.logs.dialogs.push(`${d.type()}: ${d.message()}`); await d.dismiss(); });
  a.logs.ws = []; a.logs.head = [];
  const ts = () => ((Date.now() - t0) / 1000).toFixed(1);
  page.on('websocket', (ws) => {
    a.logs.ws.push(`${ts()} OPEN`);
    ws.on('framesent', (f) => { const x = String(f.payload); if (!/,"heartbeat",/.test(x)) a.logs.ws.push(`${ts()} > ${x.replace(/"access_token":"[^"]+"/g, '"access_token":"<jwt>"').slice(0, 200)}`); });
    ws.on('framereceived', (f) => { const x = String(f.payload); if (!/"phoenix","phx_reply"/.test(x)) a.logs.ws.push(`${ts()} < ${x.slice(0, 200)}`); });
    ws.on('socketerror', (e) => a.logs.ws.push(`${ts()} SOCKETERROR ${e}`));
    ws.on('close', () => a.logs.ws.push(`${ts()} CLOSE`));
  });
  page.on('requestfinished', async (r) => { if (r.method() === 'HEAD') { const resp = await r.response().catch(() => null); a.logs.head.push(`${ts()} ok ${resp && resp.status()} ${redact(r.url()).replace(/^.*\/rest\/v1\//, '').slice(0, 90)}`); } });
  page.on('requestfailed', (r) => { if (r.method() === 'HEAD') a.logs.head.push(`${ts()} FAILED ${r.failure()?.errorText} ${redact(r.url()).replace(/^.*\/rest\/v1\//, '').slice(0, 90)}`); });
  actors[name] = a;
  return a;
}

async function toastMark(a) { return a.page.evaluate(() => (window.__toasts || []).length); }
async function toastsSince(a, mark) { return a.page.evaluate((m) => (window.__toasts || []).slice(m), mark); }
async function waitToast(a, mark, re, timeout = 12000) {
  const hit = await poll(async () => (await toastsSince(a, mark)).find((x) => re.test(x.text)), { timeout });
  return hit;
}

async function lang(a) { return a.page.evaluate(() => localStorage.getItem('qt_lang') || 'bg'); }
async function setLang(a, want) {
  if ((await lang(a)) !== want) {
    await a.page.locator('#lang-toggle').click();
    await poll(async () => (await lang(a)) === want, { timeout: 3000 });
  }
}

const NAV_DESKTOP = { home: 0, mytasks: 1, messages: 2, wallet: 3, create: 4 };
const NAV_MOBILE = { home: 0, mytasks: 1, create: 2, messages: 3, wallet: 4 };
async function nav(a, view) {
  if (a.mobile) await a.page.locator('.bottom-nav .nav-item').nth(NAV_MOBILE[view]).click();
  else await a.page.locator('.desktop-sidebar .sidebar-nav-item').nth(NAV_DESKTOP[view]).click();
  await a.page.locator(`#view-${view}.active`).waitFor({ timeout: 5000 });
}

async function login(a, user) {
  await a.page.locator('#header-auth-btns .btn-header-login').click();
  await a.page.locator('#auth-screen-wrapper.active').waitFor({ timeout: 5000 });
  await a.page.locator('#login-email').fill(user.email);
  await a.page.locator('#login-password').fill(user.password);
  await a.page.locator('#btn-login').click();
  await a.page.locator('#header-user-btns').waitFor({ state: 'visible', timeout: 15000 });
  await a.page.locator('#auth-screen-wrapper.active').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  // Realtime channel must be joined before the other side acts.
  const joined = await poll(() => a.page.evaluate(() => typeof realtimeChannel !== 'undefined' && realtimeChannel && realtimeChannel.state === 'joined'), { timeout: 15000 });
  if (!joined) note(`${a.name}: realtime channel did not reach "joined" within 15s after login`);
}

async function walletValues(a) {
  return a.page.evaluate(() => {
    const subs = [...document.querySelectorAll('#wallet-content .wallet-sub .sub-value')].map((e) => e.textContent.trim());
    const total = document.querySelector('#wallet-content .wallet-total')?.textContent.trim();
    const n = (s) => (s ? parseFloat(s.replace(/[^\d.\-]/g, '')) : NaN);
    return { avail: n(subs[0]), held: n(subs[1]), total: n(total), raw: { subs, total } };
  });
}
async function expectWallet(a, avail, held, label) {
  await nav(a, 'wallet');
  const ok = await poll(async () => { const w = await walletValues(a); return w.avail === avail && w.held === held ? w : null; }, { timeout: 10000 });
  const w = ok || (await walletValues(a));
  await check(Boolean(ok), `${label}: ${a.name} wallet shows €${avail.toFixed(2)} available / €${held.toFixed(2)} held (got ${JSON.stringify(w.raw)})`, a, 'major', 'wallet');
  return w;
}

async function feedTitles(a) {
  return a.page.$$eval('#tasks-grid .task-card h3', (els) => els.map((e) => e.textContent.trim()));
}
async function searchFeed(a, text) {
  await a.page.locator('#search-keyword').fill(text);
  await sleep(300);
}
async function openFromFeed(a, title) {
  await nav(a, 'home');
  await searchFeed(a, title);
  const card = a.page.locator('#tasks-grid .task-card', { hasText: title });
  await card.first().waitFor({ timeout: 10000 });
  await card.first().click();
  await a.page.locator('#view-detail.active #detail-content h1', { hasText: title }).waitFor({ timeout: 10000 });
}
async function openFromMyTasks(a, title, tab = 'posted') {
  await nav(a, 'mytasks');
  await a.page.locator('#view-mytasks .tab-btn').nth(tab === 'posted' ? 0 : 1).click();
  const card = a.page.locator(`#${tab === 'posted' ? 'posted' : 'bidding'}-tasks .my-task-card`, { hasText: title });
  await card.first().waitFor({ timeout: 10000 });
  await card.first().click();
  await a.page.locator('#view-detail.active #detail-content h1', { hasText: title }).waitFor({ timeout: 10000 });
}
async function detailActionsText(a) { return (await a.page.locator('#detail-actions').innerText()).trim(); }
// textContent: the badge is uppercased by CSS, innerText would return e.g. "ОТМЕНЕНА"
async function detailStatusBadge(a) {
  const b = a.page.locator('#detail-content .status-badge');
  return (await b.count()) ? ((await b.first().textContent()) || '').trim() : '';
}
async function cardText(loc) { return ((await loc.first().textContent()) || '').replace(/\s+/g, ' ').trim(); }
// Wait for CSS animations/transitions (view fade-in, modal slide-up) to finish before measuring.
async function settle(page, timeout = 3000) {
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'), null, { timeout }).catch(() => {});
}
async function realtimeSnapshot(a) {
  return a.page.evaluate(() => ({
    connected: sb.realtime.isConnected(),
    channels: sb.realtime.getChannels().map((c) => ({ topic: c.topic, state: c.state, bindings: Object.fromEntries(Object.entries(c.bindings || {}).map(([k, v]) => [k, v.length])) })),
    appChannelState: realtimeChannel && realtimeChannel.state,
    vis: window.__vis,
    notifCache: notifCache.length,
  }));
}
// Tap-twice-to-confirm on the SAME element (an in-between re-render would otherwise just re-arm a new button).
async function confirmTwice(a, loc, armedRe) {
  await settle(a.page);
  await sleep(1200); // let in-flight re-renders (openTask after realtime) land first
  const h = await loc.first().elementHandle();
  await h.click();
  const armedText = (await h.textContent()) || '';
  const armed = armedRe.test(armedText);
  await h.click();
  return { armed, armedText };
}

async function notifBadgeVisible(a) { return a.page.locator('#notif-badge').isVisible(); }
async function openNotifPanel(a) {
  if (!(await a.page.locator('#notif-panel.open').count())) await a.page.locator('#notif-btn').click();
  await a.page.locator('#notif-panel.open').waitFor({ timeout: 5000 });
  return a.page.$$eval('#notif-panel .notif-item', (els) => els.map((e) => ({ text: e.querySelector('.n-text')?.textContent.trim(), unread: e.classList.contains('unread') })));
}

async function createTask(a, t) {
  await nav(a, 'create');
  const p = a.page;
  await p.locator('#create-title').fill(t.title);
  await p.locator('#create-desc').fill(t.desc);
  await p.locator('#create-cat').selectOption(t.category);
  if (t.photo) {
    await p.locator('#create-photos').setInputFiles(t.photo);
    await p.locator('#photo-thumbs .photo-thumb img').first().waitFor({ timeout: 5000 });
  }
  await p.locator('#view-create .toggle-opt').nth(t.bidding === 'fixed' ? 1 : 0).click();
  await p.locator('#create-price').fill(String(t.price));
  await p.locator('#view-create .pay-method-card').nth(t.pay === 'escrow' ? 1 : 0).click();
  await p.locator('#create-duration').selectOption(String(t.duration));
  if (t.neighborhood) await p.locator('#create-neighborhood').selectOption(t.neighborhood);
  if (t.address) await p.locator('#create-address').fill(t.address);
  await p.locator('#view-create button.btn-primary.mt-12').click();
  await p.locator('#preview-card.show').waitFor({ timeout: 5000 });
  if (t.onPreview) await t.onPreview();
  const mark = await toastMark(a);
  const started = Date.now();
  await p.locator('#btn-post-task').click();
  const toast = await waitToast(a, mark, /публикувана|posted/i, 30000);
  if (!toast) {
    const got = await toastsSince(a, mark);
    throw new Error(`posting "${t.title}" gave no success toast; toasts: ${JSON.stringify(got)}`);
  }
  timings[`post ${t.key}`] = Date.now() - started;
  await p.locator('#view-home.active').waitFor({ timeout: 8000 });
}

async function placeBid(a, title, { amount, message }) {
  const p = a.page;
  await p.locator('#bid-sticky .place-bid-btn').click();
  await p.locator('#bid-modal.active').waitFor({ timeout: 5000 });
  if (amount != null) await p.locator('#bid-price-input').fill(String(amount));
  await p.locator('#bid-message-input').fill(message);
  const mark = await toastMark(a);
  await p.locator('#btn-submit-bid').click();
  const ok = await waitToast(a, mark, /Bid submitted|Офертата е изпратена/i, 10000);
  if (!ok) throw new Error(`bid on "${title}" not confirmed; toasts: ${JSON.stringify(await toastsSince(a, mark))}`);
  await p.locator('#bid-modal.active').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

// ---------------------------------------------------------------- language audit
async function visibleTexts(page) {
  return page.evaluate(() => {
    const out = [];
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0;
    };
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const txt = n.textContent.replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      const el = n.parentElement;
      if (!el || ['SCRIPT', 'STYLE', 'OPTION', 'OPTGROUP'].includes(el.tagName)) continue;
      if (!vis(el)) continue;
      out.push(txt);
    }
    document.querySelectorAll('input[placeholder],textarea[placeholder]').forEach((el) => { if (vis(el)) out.push('[placeholder] ' + el.placeholder); });
    document.querySelectorAll('select').forEach((sel) => { if (vis(sel)) sel.querySelectorAll('option,optgroup').forEach((o) => out.push('[option] ' + (o.label || o.textContent).trim())); });
    document.querySelectorAll('[aria-label]').forEach((el) => { if (vis(el)) out.push('[aria-label] ' + el.getAttribute('aria-label')); });
    out.push('[document.title] ' + document.title);
    return out;
  });
}
const RAW_KEY_RE = /(^|[^\w@.])((err|status|n|bid|tx|trust|cat|nav|pay|tip|u)_[a-z][a-z0-9_]*)\b|\{(task|name|n|bal|time|score|amount)\}|\bundefined\b|\bNaN\b|\[object /;
const SOFIA_PLACE_RE = /^(■ )?[А-Яа-я0-9 \-]+( \(\d+ (квартала|neighborhoods)\))?$/; // district / quarter names (proper nouns)
function auditTexts(texts, wantLang, whitelist) {
  const rawKeys = []; const wrong = []; const places = [];
  for (const raw of texts) {
    if (RAW_KEY_RE.test(raw)) rawKeys.push(raw);
    let s = raw;
    s = s.replace(/^\[(option|placeholder|aria-label|document\.title)\] /, '');
    for (const w of [...whitelist].sort((x, y) => y.length - x.length)) s = s.split(w).join(' ');
    if (wantLang === 'en') {
      if (/[А-Яа-я]/.test(s)) {
        const bare = s.replace(/^\[(option|placeholder|aria-label)\] /, '').trim();
        if (SOFIA_PLACE_RE.test(bare) || /ул\. Тестова/.test(s) || /^(📍 )?[А-Яа-я0-9 \-]+(, ул\. .*)?$/.test(bare)) places.push(raw); else wrong.push(raw);
      }
    } else {
      const stripped = s.replace(/QuickTask|you@example\.com|maria_p|MasterFix Tools|CleanPro Sofia|QuickMove BG|\bEN\b|\bBG\b|€\d+/g, ' ');
      if (/[A-Za-z]{3,}/.test(stripped)) wrong.push(raw);
    }
  }
  return { rawKeys: [...new Set(rawKeys)], wrong: [...new Set(wrong)], places: [...new Set(places)] };
}
const langFindings = []; // { actor, view, lang, rawKeys, wrong, shot }
async function langAudit(a, view, whitelist, { prep, teardown } = {}) {
  for (const l of ['bg', 'en']) {
    await setLang(a, l);
    await sleep(900); // views re-render asynchronously after the toggle
    if (prep) { await prep(); await sleep(300); }
    const texts = await visibleTexts(a.page);
    const res = auditTexts(texts, l, whitelist);
    const s = await shot(a, `lang-${view}-${l}`, { fullPage: true });
    langFindings.push({ actor: a.name, view, lang: l, ...res, shot: s });
    log(`  lang ${view} [${l}] rawKeys=${res.rawKeys.length} wrongLang=${res.wrong.length} places=${res.places.length}`);
    if (teardown) await teardown();
  }
}

// mobile layout probe
async function overflowReport(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const sw = document.documentElement.scrollWidth;
    const offenders = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || r.width === 0) return;
      if (r.right > vw + 1 || r.left < -1) {
        // skip children of horizontally scrollable containers
        let p = el.parentElement; let inScroller = false;
        while (p && p !== document.body) { const ps = getComputedStyle(p); if (/(auto|scroll|hidden)/.test(ps.overflowX)) { inScroller = true; break; } p = p.parentElement; }
        if (!inScroller) offenders.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''} [${Math.round(r.left)}..${Math.round(r.right)}]`);
      }
    });
    return { vw, scrollWidth: sw, hScroll: sw > vw, offenders: offenders.slice(0, 8) };
  });
}

// ---------------------------------------------------------------- the flow
async function main() {
  if (process.argv.includes('--cleanup')) {
    const ids = await e2eUserIds();
    log('cleanup-only: e2e users found', ids.length, JSON.stringify(await cleanup(ids)), JSON.stringify(await verifyClean()));
    return;
  }

  const pngPath = path.join(OUT, `photo-${RUN}.png`);
  fs.writeFileSync(pngPath, makePng(160, 120));

  let posterUser; let doerUser; let anon; let poster; let doer;

  const T = {
    A: { key: 'A', title: `${TAG} A assemble shelf`, desc: `Need a wall shelf assembled and mounted. ${TAG}`, category: 'home-repair', price: 40, bidding: 'price', pay: 'escrow', duration: 6, neighborhood: 'Лозенец', address: 'ул. Тестова 1', photo: pngPath },
    B: { key: 'B', title: `${TAG} B window cleaning`, desc: `Clean four windows inside and out. ${TAG}`, category: 'cleaning', price: 20, bidding: 'fixed', pay: 'cash', duration: 3, neighborhood: 'Младост 1' },
    C: { key: 'C', title: `${TAG} C parcel pickup`, desc: `Pick up a parcel from the post office. ${TAG}`, category: 'delivery', price: 15, bidding: 'price', pay: 'cash', duration: 1, neighborhood: 'Изгрев' },
    D: { key: 'D', title: `${TAG} D laptop setup`, desc: `Set up a new laptop and printer. ${TAG}`, category: 'tech-help', price: 30, bidding: 'price', pay: 'escrow', duration: 12, neighborhood: 'Център' },
    E: { key: 'E', title: `${TAG} E move sofa`, desc: `Carry a sofa down three floors. ${TAG}`, category: 'moving', price: 50, bidding: 'price', pay: 'escrow', duration: 24, neighborhood: 'Слатина' },
  };
  const WL = [TAG, 'Poster Etest', 'Doer Etest', `e2e_${RUN}_poster`, `e2e_${RUN}_doer`, 'assemble shelf', 'window cleaning', 'parcel pickup', 'laptop setup', 'move sofa',
    ...Object.values(T).map((t) => t.desc)];

  try {
    posterUser = await makeUser('poster');
    doerUser = await makeUser('doer');
    log('users created', posterUser.email, doerUser.email, 'tag', TAG);
    browser = await chromium.launch({ headless: HEADLESS });
    anon = await newActor('anon', DESKTOP);
    poster = await newActor('poster', DESKTOP);
    doer = await newActor('doer', DESKTOP);

    // ------------------------------------------------------------ 0. initial loads
    await step('0 initial load (anon/poster/doer)', async () => {
      for (const a of [anon, poster, doer]) {
        const s = Date.now();
        await a.page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await a.page.locator('#tasks-grid .task-card, #tasks-grid .empty-state').first().waitFor({ timeout: 15000 });
        timings[`feed first paint ${a.name}`] = Date.now() - s;
      }
      await check(await anon.page.locator('#header-auth-btns').isVisible(), 'anon header shows Log in / Sign up', anon);
      await shot(anon, 'feed-initial');
      await setLang(doer, 'en');
      await login(poster, posterUser);
      await login(doer, doerUser);
      pass('poster (BG) and doer (EN) logged in through the header modal');
      await check((await poster.page.locator('#header-user-btns .profile-avatar-sm').innerText()).trim() === 'PE', 'poster avatar initials in header', poster, 'minor');
    });

    // ------------------------------------------------------------ 2. top up
    await step('2a poster tops up €100', async () => {
      await nav(poster, 'wallet');
      await poster.page.locator('#wallet-content .add-funds-btn').waitFor({ timeout: 10000 });
      const w0 = await walletValues(poster);
      await check(w0.avail === 0 && w0.held === 0, `new wallet starts at €0/€0 (${JSON.stringify(w0.raw)})`, poster, 'minor');
      await poster.page.locator('#wallet-content .add-funds-btn').click();
      await poster.page.locator('#topup-modal.active').waitFor({ timeout: 5000 });
      const mark = await toastMark(poster);
      await poster.page.locator('#topup-modal').getByRole('button', { name: '€100', exact: true }).click();
      await check(Boolean(await waitToast(poster, mark, /100/)), 'top-up toast mentions €100', poster);
      await poster.page.locator('#topup-modal.active').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      await expectWallet(poster, 100, 0, 'after top-up');
      const tx = await poster.page.locator('#wallet-content .tx-item').allInnerTexts();
      await check(tx.length === 1 && /\+€100\.00/.test(tx[0]), `one deposit transaction +€100.00 listed (${JSON.stringify(tx)})`, poster, 'minor');
      await shot(poster, 'wallet-100');
    });

    // ------------------------------------------------------------ 2b. post tasks
    await step('2e create-form validation', async () => {
      const p = poster.page;
      await nav(poster, 'create');
      let mk = await toastMark(poster);
      await p.locator('#view-create button.btn-primary.mt-12').click();
      await check(Boolean(await waitToast(poster, mk, /попълнете всички/, 4000)), 'empty form → "Моля, попълнете всички задължителни полета"', poster, 'minor');
      await check(!(await p.locator('#preview-card.show').count()), 'no preview for an empty form', poster, 'minor');
      await p.locator('#create-title').fill('ab');
      await p.locator('#create-desc').fill('x');
      await p.locator('#create-cat').selectOption('other');
      await p.locator('#create-price').fill('10');
      mk = await toastMark(poster);
      await p.locator('#view-create button.btn-primary.mt-12').click();
      await check(Boolean(await waitToast(poster, mk, /поне 3 символа/, 4000)), '2-char title → "Заглавието трябва да е поне 3 символа"', poster, 'minor');
      await p.locator('#create-title').fill('abc');
      await p.locator('#create-price').fill('0.5');
      mk = await toastMark(poster);
      await p.locator('#view-create button.btn-primary.mt-12').click();
      await check(Boolean(await waitToast(poster, mk, /между €1 и €100 000/, 4000)), 'price 0.5 → "Цената трябва да е между €1 и €100 000"', poster, 'minor');
      await p.locator('#create-price').fill('0');
      mk = await toastMark(poster);
      await p.locator('#view-create button.btn-primary.mt-12').click();
      const z = await waitToast(poster, mk, /./, 4000);
      await check(z && /между €1/.test(z.text), `price 0 → price-range message (got "${z && z.text}")`, poster, 'cosmetic');
      for (const id of ['#create-title', '#create-desc', '#create-price']) await p.locator(id).fill('');
      await p.locator('#create-cat').selectOption('');
    });

    await step('2b poster posts task A (escrow, price bidding, photo)', async () => {
      // doer looks at the feed right before A is posted (used for the stale-feed check below)
      await nav(doer, 'home');
      await createTask(poster, {
        ...T.A,
        onPreview: async () => {
          const prev = await poster.page.locator('#preview-content').innerText();
          await check(/100\.00/.test(prev), `preview shows escrow balance hint with €100.00 (${prev.replace(/\s+/g, ' ').slice(0, 160)})`, poster, 'minor');
          await check(await poster.page.locator('#preview-content img.task-thumb').count() === 1, 'preview shows the photo thumbnail', poster, 'minor');
          await shot(poster, 'create-preview-A');
        },
      });
      await searchFeed(poster, T.A.title);
      const card = poster.page.locator('#tasks-grid .task-card', { hasText: T.A.title });
      await card.waitFor({ timeout: 10000 });
      const thumbOk = await poll(() => card.locator('img.task-thumb').evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false), { timeout: 10000 });
      await check(thumbOk, 'task A card in feed shows a loaded thumbnail', poster);
      await shot(poster, 'feed-A-thumb');
      await card.click();
      await poster.page.locator('#view-detail.active').waitFor();
      const photoOk = await poll(() => poster.page.locator('#detail-body .detail-photos img').first().evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false), { timeout: 10000 });
      await check(photoOk, 'task A detail shows the uploaded photo', poster);
      const head = await poster.page.locator('#detail-content').innerText();
      await check(/€40/.test(head) && /Ескроу/.test(head) && /Наддаване/.test(head), `detail header shows €40, escrow, price bidding (${head.replace(/\s+/g, ' ')})`, poster, 'minor');
      await check(!(await poster.page.locator('#bid-sticky').isVisible()), 'poster does not get "Place a bid" on own task', poster);
      await shot(poster, 'detail-A-photo');
    });

    await step('2c doer feed freshness right after A is posted', async () => {
      await nav(doer, 'home');
      await searchFeed(doer, T.A.title);
      await sleep(1500);
      const seen = (await feedTitles(doer)).includes(T.A.title);
      if (!seen) {
        await bug(doer, 'minor', `New task A not shown when the doer (who loaded the feed seconds earlier) clicks Home — feed is cached up to 60s (ensureHomeTasks) and there is no refresh; only a reload shows it`, 'stale-feed');
        await doer.page.reload();
        await doer.page.locator('#header-user-btns').waitFor({ state: 'visible', timeout: 15000 });
      } else pass('doer sees task A after clicking Home');
      await searchFeed(doer, '');
    });

    await step('2d poster posts tasks B–E', async () => {
      for (const k of ['B', 'C', 'D', 'E']) await createTask(poster, T[k]);
      await searchFeed(poster, TAG);
      const titles = await feedTitles(poster);
      await check(['A', 'B', 'C', 'D', 'E'].every((k) => titles.includes(T[k].title)), `all 5 tasks in poster feed (${titles.length})`, poster);
    });

    // ------------------------------------------------------------ 1. anonymous
    await step('1 anonymous: feed, filters, chips, sort, search, detail, bid gating', async () => {
      const p = anon.page;
      await p.reload();
      await p.locator('#tasks-grid .task-card').first().waitFor({ timeout: 15000 });
      await searchFeed(anon, TAG);
      let titles = await feedTitles(anon);
      await check(titles.length === 5, `search "${TAG}" shows exactly the 5 e2e tasks (got ${titles.length})`, anon);
      const count = await p.locator('#task-count').innerText();
      await check(/^5 /.test(count), `task count text reflects filter ("${count}")`, anon, 'minor');
      // newest first (default)
      await check(JSON.stringify(titles) === JSON.stringify(['E', 'D', 'C', 'B', 'A'].map((k) => T[k].title)), `default sort newest first (${titles.map((x) => x.split(' ')[1]).join('')})`, anon, 'minor');
      // category chip
      await p.locator('.cat-chip[data-cat="cleaning"]').click();
      titles = await feedTitles(anon);
      await check(titles.length === 1 && titles[0] === T.B.title, `chip "cleaning" leaves only task B (${titles.length})`, anon);
      await p.locator('.cat-chip[data-cat="all"]').click();
      // sort
      const order = async (v) => { await p.locator('#sort-tasks').selectOption(v); await sleep(250); return (await feedTitles(anon)).map((x) => x.split(' ')[1]).join(''); };
      await check((await order('price_low')) === 'CBDAE', 'sort price low→high = C(15) B(20) D(30) A(40) E(50)', anon);
      await check((await order('price_high')) === 'EADBC', 'sort price high→low', anon);
      await check((await order('ending')) === 'CBADE', 'sort ending soon = C(1h) B(3h) A(6h) D(12h) E(24h)', anon);
      await order('newest');
      // time filter
      await p.locator('#filter-time').selectOption('1');
      await sleep(250);
      titles = await feedTitles(anon);
      await check(titles.length === 1 && titles[0] === T.C.title, `time filter "within 1h" leaves only C (${titles.map((x) => x.split(' ')[1]).join('')})`, anon);
      await p.locator('#filter-time').selectOption('6');
      await sleep(250);
      await check((await feedTitles(anon)).map((x) => x.split(' ')[1]).sort().join('') === 'ABC', 'time filter "within 6h" leaves A, B, C', anon);
      await p.locator('#filter-time').selectOption('');
      // neighborhood picker
      await p.locator('.location-bar').click();
      await p.locator('#neighborhood-modal.active').waitFor({ timeout: 5000 });
      await p.locator('#neighborhood-search-input').fill('Лозенец');
      await p.locator('#neighborhood-list label', { hasText: /^Лозенец$/ }).first().click();
      await p.locator('#neighborhood-modal .btn-apply').click();
      await sleep(300);
      titles = await feedTitles(anon);
      await check(titles.length === 1 && titles[0] === T.A.title, `neighborhood "Лозенец" leaves only A (${titles.length})`, anon);
      await check(/Лозенец/.test(await p.locator('#location-bar-text').innerText()), 'location bar shows the chosen neighborhood', anon, 'minor');
      await shot(anon, 'filter-neighborhood');
      await p.locator('.location-bar').click();
      await p.locator('#neighborhood-modal .btn-clear').click();
      await p.locator('#neighborhood-modal .btn-apply').click();
      await sleep(300);
      await check((await feedTitles(anon)).length === 5, 'clearing neighborhoods restores all 5', anon);
      // search narrowing
      await searchFeed(anon, 'sofa');
      titles = await feedTitles(anon);
      await check(titles.includes(T.E.title) && !titles.includes(T.A.title), 'search "sofa" finds E and not A', anon);
      await searchFeed(anon, 'zzzz-no-such-task');
      await check((await p.locator('#tasks-grid .empty-state').count()) === 1, 'search with no match shows empty state', anon, 'minor');
      // detail + bid gating
      await searchFeed(anon, T.A.title);
      await p.locator('#tasks-grid .task-card', { hasText: T.A.title }).click();
      await p.locator('#view-detail.active').waitFor();
      await check(await p.locator('#detail-body .detail-photos img').count() === 1, 'anon sees the photo on A detail', anon, 'minor');
      await check(await p.locator('#bid-sticky').isVisible(), 'anon sees "Place a bid" on A', anon);
      await p.locator('#bid-sticky .place-bid-btn').click();
      await check(await p.locator('#auth-screen-wrapper.active').isVisible(), '"Place a bid" as anon opens the login modal', anon, 'blocker');
      await check(!(await p.locator('#bid-modal.active').count()), 'bid modal does NOT open for anon', anon);
      await shot(anon, 'anon-bid-login');
      await p.locator('#auth-screen-wrapper .auth-modal-close').click();
      // create as anon
      await p.locator('.desktop-sidebar .create-sidebar-btn').click();
      await p.locator('#view-create.active').waitFor();
      await p.locator('#create-guest-overlay').click(); // the overlay sits over the whole form
      await check(await p.locator('#auth-screen-wrapper.active').isVisible(), 'anon interacting with the create form gets the login modal', anon);
      await p.locator('#auth-screen-wrapper .auth-modal-close').click();
      // anon on protected nav
      await p.locator('.desktop-sidebar .sidebar-nav-item').nth(3).click();
      await check(await p.locator('#auth-screen-wrapper.active').isVisible(), 'anon clicking Wallet opens login modal', anon, 'minor');
      await p.locator('#auth-screen-wrapper .auth-modal-close').click();
      await p.locator('.desktop-sidebar .sidebar-nav-item').nth(0).click();
    });

    // ------------------------------------------------------------ 3. bid on A
    let bidAt = 0;
    await step('3 doer bids €35 on A; poster sees it live', async () => {
      await nav(poster, 'home');
      const pMark = await toastMark(poster);
      await openFromFeed(doer, T.A.title);
      await check(await doer.page.locator('#bid-sticky').isVisible(), 'doer sees "Place a bid" on A', doer);
      bidAt = Date.now();
      await placeBid(doer, T.A.title, { amount: 35, message: `I can do it today ${TAG}` });
      await doer.page.locator('#bids-section .bid-card').first().waitFor({ timeout: 8000 });
      const mine = await doer.page.locator('#bids-section').innerText();
      await check(/€35/.test(mine) && /Your bid/.test(mine), `doer sees own €35 bid on detail (${mine.replace(/\s+/g, ' ').slice(0, 120)})`, doer);
      await check(/Withdraw bid/.test(await detailActionsText(doer)), 'doer sees "Withdraw bid"', doer, 'minor');
      await check(!(await doer.page.locator('#bid-sticky').isVisible()), '"Place a bid" hidden after bidding', doer, 'minor');
      // poster: realtime
      const badge = await poll(() => notifBadgeVisible(poster), { timeout: 15000 });
      timings['realtime new_bid → poster badge'] = Date.now() - bidAt;
      await check(badge, 'poster bell badge appears without reload', poster, 'major', 'no-bell');
      const toast = await waitToast(poster, pMark, new RegExp(TAG), 3000);
      await check(toast && /Нова оферта/.test(toast.text), `poster gets a BG toast for the new bid (${toast && toast.text})`, poster, 'minor');
      if (!badge) {
        note(`poster realtime snapshot when the new_bid event did not arrive: ${JSON.stringify(await realtimeSnapshot(poster))}`);
        await poster.page.reload(); // what a user would do; keeps the rest of the flow testable
        await poster.page.locator('#header-user-btns').waitFor({ state: 'visible', timeout: 15000 });
        await poll(() => poster.page.evaluate(() => realtimeChannel && realtimeChannel.state === 'joined'), { timeout: 15000 });
        await check(await notifBadgeVisible(poster), 'after a reload the poster bell badge shows the new bid', poster, 'major');
      } else note(`poster realtime ok: ${JSON.stringify(await realtimeSnapshot(poster))}`);
      const items = await openNotifPanel(poster);
      await shot(poster, 'notif-panel-new-bid');
      const it = items.find((x) => x.text && x.text.includes(T.A.title));
      await check(it && it.unread && /Нова оферта/.test(it.text), `notification panel lists "Нова оферта за „${T.A.title}“" as unread (${JSON.stringify(items.slice(0, 3))})`, poster);
      await poster.page.locator('#notif-panel .notif-item', { hasText: T.A.title }).first().click();
      await poster.page.locator('#view-detail.active #detail-content h1', { hasText: T.A.title }).waitFor({ timeout: 8000 });
      const bidCard = poster.page.locator('#bids-section .bid-card', { hasText: `I can do it today ${TAG}` });
      await bidCard.waitFor({ timeout: 8000 });
      const bc = await bidCard.innerText();
      await check(/€35/.test(bc) && /Doer Etest/.test(bc), `poster sees doer's €35 bid with message (${bc.replace(/\s+/g, ' ')})`, poster);
      await check(!(await notifBadgeVisible(poster)), 'bell badge clears after opening the only unread notification', poster, 'minor');
      await shot(poster, 'detail-A-bid');
    });

    // ------------------------------------------------------------ 4. select + chat
    await step('4a poster selects the bid on A', async () => {
      const dMark = await toastMark(doer);
      const pMark = await toastMark(poster);
      const btn = poster.page.locator('#bids-section .select-bid-btn').first();
      await check(/Избери Doer/.test(await btn.innerText()), `select button reads "Избери Doer" (${await btn.innerText()})`, poster, 'cosmetic');
      const selAt = Date.now();
      await btn.click();
      await check(Boolean(await waitToast(poster, pMark, /Изпълнителят е избран/)), 'poster toast "Изпълнителят е избран!"', poster, 'minor');
      await poll(async () => /В изпълнение/.test(await detailStatusBadge(poster)), { timeout: 8000 });
      await check(/В изпълнение/.test(await detailStatusBadge(poster)), 'task A status → В изпълнение', poster);
      const acts = await detailActionsText(poster);
      await check(/Отвори чата/.test(acts) && /Маркирай като завършена/.test(acts), `poster actions: open chat + mark complete (${acts.replace(/\s+/g, ' ')})`, poster);
      const bidStatus = await poll(async () => { const t = (await poster.page.locator('#bids-section').textContent()) || ''; return /Избрана/.test(t) ? t : null; }, { timeout: 6000 });
      await check(Boolean(bidStatus), 'selected bid shows "Избрана"', poster, 'minor');
      // doer realtime
      const dBadge = await poll(() => notifBadgeVisible(doer), { timeout: 15000 });
      timings['realtime bid_selected → doer badge'] = Date.now() - selAt;
      await check(dBadge, 'doer bell badge appears on selection (no reload)', doer);
      if (!dBadge) note(`doer realtime snapshot: ${JSON.stringify(await realtimeSnapshot(doer))}`);
      const dt = await waitToast(doer, dMark, /picked/i, 8000);
      await check(Boolean(dt), `doer toast "You were picked for…" (${dt && dt.text})`, doer, 'minor');
      const dActs = await poll(async () => { const s = await detailActionsText(doer); return /Open chat/.test(s) ? s : null; }, { timeout: 10000 });
      await check(Boolean(dActs) && /Back out/.test(dActs), `doer's open detail refreshes to Open chat + Back out (${dActs})`, doer);
      await shot(doer, 'detail-A-selected');
      await expectWallet(poster, 65, 35, 'after selecting €35 bid');
      const tx = await poster.page.locator('#wallet-content .tx-item').allInnerTexts();
      await check(tx.some((x) => /Задържано/.test(x) && /35\.00/.test(x)), `wallet lists a held −€35.00 transaction (${JSON.stringify(tx)})`, poster, 'minor');
      await shot(poster, 'wallet-65-35');
    });

    await step('4b chat both ways + unread badge', async () => {
      // poster opens chat from task detail
      await openFromMyTasks(poster, T.A.title, 'posted');
      await poster.page.locator('#detail-actions button', { hasText: 'Отвори чата' }).click();
      await poster.page.locator('#chat-conversation.active .chat-input-bar input').waitFor({ timeout: 8000 });
      await check(/Doer Etest/.test(await poster.page.locator('#chat-conversation .chat-conv-header').innerText()), 'chat header shows the doer name', poster, 'minor');
      const m1 = `Hello from poster ${TAG}`;
      const sentAt = Date.now();
      await poster.page.locator('#chat-conversation .chat-input-bar input').fill(m1);
      await poster.page.locator('#chat-conversation .chat-input-bar input').press('Enter');
      await poster.page.locator('#chat-conversation .msg-bubble.sent', { hasText: m1 }).waitFor({ timeout: 8000 });
      pass('poster message appears in own chat');
      // doer is on task detail: unread badge
      const badgeText = await poll(async () => { const t = (await doer.page.locator('#msg-badge').textContent()) || ''; return t.trim() === '1' ? t : null; }, { timeout: 12000 });
      timings['realtime message → doer unread badge'] = Date.now() - sentAt;
      await check(Boolean(badgeText), 'doer unread count updates to 1 without reload (#msg-badge text)', doer);
      const badgeVisible = await doer.page.locator('#msg-badge').isVisible();
      const sidebarBadge = await doer.page.locator('.desktop-sidebar .msg-badge, .desktop-sidebar [class*="badge"]').count();
      if (!badgeVisible && sidebarBadge === 0) {
        await bug(doer, 'major', 'Desktop (≥1024px): no unread-message badge anywhere. #msg-badge lives only in .bottom-nav, which is display:none on desktop; the sidebar "Messages" item has no badge, so an unread message is invisible until the user opens Messages', 'desktop-no-unread-badge');
      } else pass('unread badge visible on desktop');
      // doer opens messages
      await nav(doer, 'messages');
      const item = doer.page.locator('#chat-list .chat-item', { hasText: T.A.title });
      await item.waitFor({ timeout: 8000 });
      await check(await item.locator('.unread-dot').count() === 1, 'chat list shows unread dot for A', doer, 'minor');
      await check((await item.innerText()).includes(m1), 'chat list preview shows last message', doer, 'minor');
      await shot(doer, 'chat-list-unread');
      await item.click();
      await doer.page.locator('#chat-conversation.active .msg-bubble.received', { hasText: m1 }).waitFor({ timeout: 8000 });
      pass('doer sees poster message in chat');
      const cleared = await poll(async () => { const vis = await doer.page.locator('#msg-badge').evaluate((e) => e.style.display !== 'none'); return !vis; }, { timeout: 8000 });
      await check(cleared, 'unread badge clears after opening the chat', doer);
      // doer replies → poster live
      const m2 = `Hi, on my way ${TAG}`;
      const rAt = Date.now();
      await doer.page.locator('#chat-conversation .chat-input-bar input').fill(m2);
      await doer.page.locator('#chat-conversation .send-btn').click();
      await doer.page.locator('#chat-conversation .msg-bubble.sent', { hasText: m2 }).waitFor({ timeout: 8000 });
      const live = await poll(() => poster.page.locator('#chat-conversation .msg-bubble.received', { hasText: m2 }).count(), { timeout: 12000 });
      timings['realtime message → open chat (poster)'] = Date.now() - rAt;
      await check(Boolean(live), 'poster sees doer reply live in the open chat', poster);
      // poster second message → doer live in open chat
      const m3 = `Great, see you ${TAG}`;
      await poster.page.locator('#chat-conversation .chat-input-bar input').fill(m3);
      await poster.page.locator('#chat-conversation .chat-input-bar input').press('Enter');
      const live2 = await poll(() => doer.page.locator('#chat-conversation .msg-bubble.received', { hasText: m3 }).count(), { timeout: 12000 });
      await check(Boolean(live2), 'doer sees poster second message live', doer);
      await sleep(1500);
      const stillBadge = await doer.page.locator('#msg-badge').evaluate((e) => e.style.display !== 'none' ? e.textContent : '');
      await check(!stillBadge, `no unread badge for a message read in the open chat (badge="${stillBadge}")`, doer, 'minor');
      await shot(poster, 'chat-poster');
      await shot(doer, 'chat-doer');
      // HTML in a message is shown as text, not rendered
      const xss = `<img src=x onerror="window.__xss=1"><b>bold</b> ${TAG}`;
      await poster.page.locator('#chat-conversation .chat-input-bar input').fill(xss);
      await poster.page.locator('#chat-conversation .chat-input-bar input').press('Enter');
      const shown = await poll(() => doer.page.locator('#chat-conversation .msg-bubble.received', { hasText: '<b>bold</b>' }).count(), { timeout: 10000 });
      const xssRan = await doer.page.evaluate(() => window.__xss === 1) || await poster.page.evaluate(() => window.__xss === 1);
      await check(Boolean(shown) && !xssRan, `HTML in chat is escaped and shown literally (shown=${shown}, executed=${xssRan})`, doer, 'blocker');
      // empty message must not send
      await doer.page.locator('#chat-conversation .chat-input-bar input').fill('   ');
      await doer.page.locator('#chat-conversation .send-btn').click();
      await sleep(500);
      await check((await doer.page.locator('#chat-conversation .msg-bubble').count()) === 4, 'whitespace-only message is not sent', doer, 'minor');
    });

    // ------------------------------------------------------------ 5. complete + rate
    await step('5a poster marks A complete; doer paid', async () => {
      await poster.page.locator('#chat-conversation .chat-task-ref').click();
      await poster.page.locator('#view-detail.active #detail-content h1', { hasText: T.A.title }).waitFor({ timeout: 8000 });
      const dMark = await toastMark(doer);
      const pMark = await toastMark(poster);
      await poster.page.locator('#detail-actions button', { hasText: 'Маркирай като завършена' }).click();
      await check(Boolean(await waitToast(poster, pMark, /завършена/)), 'poster toast "Задачата е маркирана като завършена!"', poster, 'minor');
      await poll(async () => /Завършена/.test(await detailStatusBadge(poster)), { timeout: 8000 });
      await check(/Завършена/.test(await detailStatusBadge(poster)), 'A status → Завършена', poster);
      const dt = await waitToast(doer, dMark, /marked complete/i, 12000);
      await check(Boolean(dt), `doer notified "…was marked complete" (${dt && dt.text})`, doer, 'minor');
      await expectWallet(doer, 35, 0, 'doer after completion');
      const tx = await doer.page.locator('#wallet-content .tx-item').allInnerTexts();
      await check(tx.some((x) => /Received/.test(x) && /\+€35\.00/.test(x)), `doer wallet lists "Received … +€35.00" (${JSON.stringify(tx)})`, doer);
      await shot(doer, 'wallet-doer-35');
      await expectWallet(poster, 65, 0, 'poster after completion');
      const ptx = await poster.page.locator('#wallet-content .tx-item').allInnerTexts();
      await check(ptx.some((x) => /Платено/.test(x) && /35\.00/.test(x)), `poster wallet lists "Платено … €35.00" (${JSON.stringify(ptx)})`, poster, 'minor');
    });

    await step('5b both rate each other; no double rating; profiles', async () => {
      // poster rates from detail
      await openFromMyTasks(poster, T.A.title, 'posted');
      const rateBtn = poster.page.locator('#detail-actions button', { hasText: 'Оцени' });
      await rateBtn.waitFor({ timeout: 8000 });
      await rateBtn.click();
      await poster.page.locator('#rating-modal.active').waitFor({ timeout: 5000 });
      await check(/Оценете Doer Etest/.test(await poster.page.locator('#rating-modal-title').innerText()), 'rating modal title "Оценете Doer Etest"', poster, 'minor');
      // submit without stars
      let mark = await toastMark(poster);
      await poster.page.locator('#btn-submit-rating').click();
      await check(Boolean(await waitToast(poster, mark, /звезди/, 4000)), 'submitting 0 stars shows "Изберете от 1 до 5 звезди"', poster, 'minor');
      await poster.page.locator('#star-input button').nth(4).click();
      await check((await poster.page.locator('#star-input button.on').count()) === 5, '5 stars highlighted', poster, 'minor');
      await poster.page.locator('#rating-comment').fill(`Great doer ${TAG}`);
      mark = await toastMark(poster);
      const dMark = await toastMark(doer);
      await poster.page.locator('#btn-submit-rating').click();
      await check(Boolean(await waitToast(poster, mark, /Благодарим/)), 'poster rating accepted', poster);
      const rated = await poll(async () => /Оценено/.test(await detailActionsText(poster)), { timeout: 8000 });
      await check(rated, 'detail shows "★ Оценено" and no Rate button', poster);
      await check(!(await poster.page.locator('#detail-actions button', { hasText: 'Оцени' }).count()), 'poster cannot open rating again from detail', poster);
      const dn = await waitToast(doer, dMark, /5★/, 12000);
      await check(Boolean(dn), `doer notified "You got 5★ for…" (${dn && dn.text})`, doer, 'minor');
      // doer rates from My bids
      await nav(doer, 'mytasks');
      await doer.page.locator('#view-mytasks .tab-btn').nth(1).click();
      const card = doer.page.locator('#bidding-tasks .my-task-card', { hasText: T.A.title });
      await card.waitFor({ timeout: 8000 });
      const aCard = await poll(async () => { const t = await cardText(card); return /Completed/.test(t) ? t : null; }, { timeout: 8000 });
      await check(Boolean(aCard), `doer My bids card for A shows Completed (${aCard || await cardText(card)})`, doer, 'minor');
      await card.locator('button', { hasText: 'Rate' }).click();
      await doer.page.locator('#rating-modal.active').waitFor({ timeout: 5000 });
      await check(/Rate Poster Etest/.test(await doer.page.locator('#rating-modal-title').innerText()), 'doer rating modal title "Rate Poster Etest"', doer, 'minor');
      await doer.page.locator('#star-input button').nth(3).click();
      await doer.page.locator('#rating-comment').fill(`Clear instructions ${TAG}`);
      mark = await toastMark(doer);
      await doer.page.locator('#btn-submit-rating').dblclick(); // double-submit attempt
      await check(Boolean(await waitToast(doer, mark, /Thanks for rating/)), 'doer rating accepted', doer);
      await sleep(1500);
      const dupToast = (await toastsSince(doer, mark)).find((x) => /already/i.test(x.text));
      await check(!dupToast, `double-click on submit does not produce a second request/error (${dupToast && dupToast.text})`, doer, 'minor');
      const ratedCard = await poll(async () => /Rated/.test(await cardText(card)), { timeout: 8000 });
      await check(ratedCard, 'doer My bids card shows "★ Rated"', doer);
      await check(!(await card.locator('button', { hasText: /^★ Rate$/ }).count()), 'doer cannot rate again from My bids', doer);
      const { data: ratingRows } = await admin.from('ratings').select('rater_id, score').in('rater_id', createdUserIds);
      await check((ratingRows || []).length === 2, `exactly 2 ratings stored for the pair (${JSON.stringify(ratingRows)})`, doer);
      await shot(doer, 'mybids-rated');
      // profiles
      await poster.page.locator('#header-user-btns .profile-avatar-sm').click();
      await poster.page.locator('#view-profile.active #profile-reviews .review-item').first().waitFor({ timeout: 8000 });
      const pStats = await poster.page.$$eval('#view-profile .trust-stat .stat-value', (e) => e.map((x) => x.textContent.trim()));
      const pRev = await poster.page.locator('#profile-reviews').innerText();
      await check(pStats[0] === '4.0', `poster profile rating 4.0 (${pStats})`, poster);
      await check(pStats[2] === '5', `poster profile "Публикувани" = 5 (${pStats})`, poster, 'minor');
      await check(/Doer Etest/.test(pRev) && /★★★★(?!★)/.test(pRev) && pRev.includes(`Clear instructions ${TAG}`) && /\(1\)/.test(pRev), `poster reviews list shows doer's 4★ review (${pRev.replace(/\s+/g, ' ')})`, poster);
      await shot(poster, 'profile-poster');
      await doer.page.locator('#header-user-btns .profile-avatar-sm').click();
      await doer.page.locator('#view-profile.active #profile-reviews .review-item').first().waitFor({ timeout: 8000 });
      const dStats = await doer.page.$$eval('#view-profile .trust-stat .stat-value', (e) => e.map((x) => x.textContent.trim()));
      const dRev = await doer.page.locator('#profile-reviews').innerText();
      await check(dStats[0] === '5.0' && dStats[1] === '1', `doer profile rating 5.0, tasks done 1 (${dStats})`, doer);
      await check(dRev.includes(`Great doer ${TAG}`) && /★★★★★/.test(dRev), 'doer reviews list shows poster 5★ review', doer);
      await shot(doer, 'profile-doer');
    });

    // ------------------------------------------------------------ 6. cancel B
    await step('6 poster cancels open task B (double tap); doer bid → not selected', async () => {
      await openFromFeed(doer, T.B.title);
      await doer.page.locator('#bid-sticky .place-bid-btn').click();
      await doer.page.locator('#bid-modal.active').waitFor();
      await check(!(await doer.page.locator('#bid-price-group').isVisible()), 'fixed-price task: bid modal hides the price field', doer, 'minor');
      await check(/Apply for €20/.test(await doer.page.locator('#bid-modal-title').innerText()), `fixed-price bid modal title "Apply for €20" (${await doer.page.locator('#bid-modal-title').innerText()})`, doer, 'minor');
      const mk = await toastMark(doer);
      await doer.page.locator('#bid-message-input').fill(`Fixed price ok ${TAG}`);
      await doer.page.locator('#btn-submit-bid').click();
      await check(Boolean(await waitToast(doer, mk, /Bid submitted/)), 'fixed-price bid accepted', doer);
      await doer.page.locator('#bids-section .bid-card').first().waitFor({ timeout: 8000 });
      await check(/€20/.test(await doer.page.locator('#bids-section').innerText()), 'fixed-price bid shows €20', doer, 'minor');
      await nav(doer, 'mytasks'); // doer waits on My Tasks
      await doer.page.locator('#view-mytasks .tab-btn').nth(1).click();

      await openFromMyTasks(poster, T.B.title, 'posted');
      await poster.page.locator('#bids-section .bid-card').first().waitFor({ timeout: 8000 });
      const cancelBtn = poster.page.locator('#detail-actions button', { hasText: 'Отмени задачата' });
      await settle(poster.page); await sleep(1200);
      const h = await cancelBtn.first().elementHandle();
      await h.click();
      const armed = (await h.textContent()) || '';
      await check(/Натиснете отново/.test(armed), `first tap arms the button ("${armed}")`, poster, 'minor');
      await shot(poster, 'cancel-armed');
      await sleep(500);
      const st = await poster.page.evaluate(() => currentTask && currentTask.status);
      await check(st === 'open', 'single tap does not cancel', poster);
      const pMark = await toastMark(poster);
      const dMark = await toastMark(doer);
      await h.click();
      await check(Boolean(await waitToast(poster, pMark, /Задачата е отменена/)), 'poster toast "Задачата е отменена"', poster, 'minor');
      await poll(async () => /Отменена/.test(await detailStatusBadge(poster)), { timeout: 8000 });
      await check(/Отменена/.test(await detailStatusBadge(poster)), 'B status → Отменена', poster);
      await check(!(await poster.page.locator('#detail-actions button', { hasText: 'Отмени' }).count()), 'no cancel button after cancelling', poster, 'minor');
      const tl = ((await poster.page.locator('#detail-body .info-card .value').first().textContent()) || '').trim();
      if (/\d/.test(tl)) await bug(poster, 'cosmetic', `Cancelled task still shows a running "Оставащо време" countdown ("${tl}") on its detail page (openTask renders timeLeft(bidding_ends_at) regardless of status)`, 'cancelled-countdown');
      await shot(poster, 'B-cancelled');
      const dn = await waitToast(doer, dMark, /cancelled/i, 12000);
      await check(Boolean(dn), `doer notified "…was cancelled" (${dn && dn.text})`, doer);
      // the doer's My bids
      await nav(doer, 'mytasks');
      await doer.page.locator('#view-mytasks .tab-btn').nth(1).click();
      const card = doer.page.locator('#bidding-tasks .my-task-card', { hasText: T.B.title });
      await card.waitFor({ timeout: 8000 });
      const txt = (await poll(async () => { const t = await cardText(card); return /Withdraw bid/.test(t) ? null : t; }, { timeout: 8000 })) || await cardText(card);
      await check(/Not selected|Cancelled/.test(txt) && !/Withdraw bid/.test(txt), `doer My bids: B shows Not selected/Cancelled, no withdraw (${txt})`, doer);
      if (/Not selected/.test(txt) && !/Cancelled/.test(txt)) note(`My bids shows "Not selected" for a task the poster cancelled (it reads as if someone else was picked) — "${txt}"`, await shot(doer, 'B-mybids-not-selected'));
      // B gone from feed
      await nav(anon, 'home'); await anon.page.reload(); await anon.page.locator('#tasks-grid .task-card, #tasks-grid .empty-state').first().waitFor();
      await searchFeed(anon, T.B.title);
      await check(!(await feedTitles(anon)).includes(T.B.title), 'cancelled B no longer in the public feed', anon, 'minor');
    });

    // ------------------------------------------------------------ 7. withdraw C
    await step('7 doer bids on C then withdraws from My Tasks', async () => {
      await openFromFeed(doer, T.C.title);
      // Slow network (2s on the bids read) to make the post-bid refresh observable.
      const slow = async (route) => { if (route.request().method() === 'GET') await sleep(2000); await route.continue(); };
      await doer.page.route(/\/rest\/v1\/bids\?select=\*/, slow);
      await placeBid(doer, T.C.title, { amount: 12, message: `Quick pickup ${TAG}` });
      await nav(doer, 'mytasks'); // the user moves on right after "Bid submitted!"
      await sleep(3500);
      const hijacked = await doer.page.locator('#view-detail.active').count();
      await doer.page.unroute(/\/rest\/v1\/bids\?select=\*/, slow);
      if (hijacked) await bug(doer, 'minor', 'Navigation hijack: after "Bid submitted!" the user clicked My Tasks, but ~2s later the still-running openTask() (called un-awaited from submitBid) switched the view back to the task detail (openTask ends with showView("detail") when detail is not active). Same race for the realtime-triggered openTask(). Reproduced with a 2s delay on the bids read (slow network)', 'nav-hijack');
      else pass('navigating away right after bidding is not overridden');
      await nav(doer, 'mytasks');
      await doer.page.locator('#view-mytasks .tab-btn').nth(1).click();
      const card = doer.page.locator('#bidding-tasks .my-task-card', { hasText: T.C.title });
      await card.waitFor({ timeout: 8000 });
      await check(/Pending/i.test(await cardText(card)), 'C card shows Pending', doer, 'minor');
      const mk = await toastMark(doer);
      const ct = await confirmTwice(doer, card.locator('button', { hasText: 'Withdraw bid' }), /Tap again/);
      await check(ct.armed, `first tap arms withdraw ("${ct.armedText}")`, doer, 'minor');
      await check(await doer.page.locator('#view-mytasks.active').count() === 1, 'tapping the withdraw button does not open the task card', doer, 'minor');
      await check(Boolean(await waitToast(doer, mk, /Bid withdrawn/)), 'toast "Bid withdrawn"', doer);
      const ok = await poll(async () => /Withdrawn/i.test(await cardText(doer.page.locator('#bidding-tasks .my-task-card', { hasText: T.C.title }))), { timeout: 8000 });
      await check(ok, 'My bids shows C as Withdrawn', doer);
      await shot(doer, 'C-withdrawn');
      // poster view of C
      await openFromMyTasks(poster, T.C.title, 'posted');
      const bs = await poster.page.locator('#bids-section').innerText();
      await check(!/Quick pickup/.test(bs), 'withdrawn bid not offered to the poster', poster);
      await check(/Все още няма оферти/.test(bs), `poster sees "no bids yet" on C after withdrawal (${bs.replace(/\s+/g, ' ')})`, poster, 'minor');
      // doer re-bid possibility
      await openFromFeed(doer, T.C.title);
      const sticky = await doer.page.locator('#bid-sticky').isVisible();
      note(`after withdrawing, the doer ${sticky ? 'CAN' : 'can NOT'} bid on C again (Place a bid ${sticky ? 'shown' : 'hidden'})`);
    });

    // ------------------------------------------------------------ 8. back out of D
    await step('8 escrow D: poster selects, doer backs out, refund', async () => {
      await openFromFeed(doer, T.D.title);
      await placeBid(doer, T.D.title, { amount: 20, message: `Laptop expert ${TAG}` });
      await openFromMyTasks(poster, T.D.title, 'posted');
      await poster.page.locator('#bids-section .select-bid-btn').first().waitFor({ timeout: 8000 });
      const dMark = await toastMark(doer);
      await poster.page.locator('#bids-section .select-bid-btn').first().click();
      await poll(async () => /В изпълнение/.test(await detailStatusBadge(poster)), { timeout: 8000 });
      await check(/В изпълнение/.test(await detailStatusBadge(poster)), 'D in progress', poster);
      await waitToast(doer, dMark, /picked/i, 12000);
      await expectWallet(poster, 45, 20, 'after selecting €20 on D');
      // doer opens D from the notification panel
      const items = await openNotifPanel(doer);
      await check(items.some((x) => x.text.includes(T.D.title) && /picked/.test(x.text)), 'doer notification for D selection present', doer, 'minor');
      await doer.page.locator('#notif-panel .notif-item', { hasText: T.D.title }).first().click();
      await doer.page.locator('#view-detail.active #detail-content h1', { hasText: T.D.title }).waitFor({ timeout: 8000 });
      const backBtn = doer.page.locator('#detail-actions button', { hasText: 'Back out' });
      const pMark = await toastMark(poster);
      const mk = await toastMark(doer);
      const ct = await confirmTwice(doer, backBtn, /Tap again/);
      await check(ct.armed, `first tap arms back out ("${ct.armedText}")`, doer, 'minor');
      await check(Boolean(await waitToast(doer, mk, /backed out/)), 'doer toast "You backed out of the task"', doer);
      await poll(async () => /Cancelled/.test(await detailStatusBadge(doer)), { timeout: 8000 });
      await check(/Cancelled/.test(await detailStatusBadge(doer)), `D shows Cancelled for doer (${await detailStatusBadge(doer)})`, doer, 'minor');
      const pn = await waitToast(poster, pMark, /се отказа/, 12000);
      await check(Boolean(pn), `poster notified "Изпълнителят се отказа от …" (${pn && pn.text})`, poster);
      await expectWallet(poster, 65, 0, 'after doer backed out of D (refund)');
      const tx = await poster.page.locator('#wallet-content .tx-item').allInnerTexts();
      await check(tx.some((x) => /Възстановено/.test(x) && /\+€20\.00/.test(x)), `poster wallet lists refund +€20.00 (${JSON.stringify(tx.slice(0, 3))})`, poster, 'minor');
      await shot(poster, 'wallet-refund');
      await openFromMyTasks(doer, T.D.title, 'bidding');
      await nav(doer, 'mytasks');
      await doer.page.locator('#view-mytasks .tab-btn').nth(1).click();
      const dc = await cardText(doer.page.locator('#bidding-tasks .my-task-card', { hasText: T.D.title }));
      note(`doer My bids card for D after backing out: "${dc}"`);
    });

    // ------------------------------------------------------------ 9. insufficient funds
    await step('9 insufficient funds on E', async () => {
      await openFromFeed(doer, T.E.title);
      await doer.page.locator('#bid-sticky .place-bid-btn').click();
      await doer.page.locator('#bid-modal.active').waitFor();
      await check(/Place your bid/.test(await doer.page.locator('#bid-modal-title').innerText()), 'EN bid modal title "Place your bid"', doer, 'minor');
      let vmk = await toastMark(doer);
      await doer.page.locator('#btn-submit-bid').click();
      await check(Boolean(await waitToast(doer, vmk, /valid price/, 4000)), 'bid with no price → "Please enter a valid price"', doer, 'minor');
      await doer.page.locator('#bid-price-input').fill('-5');
      vmk = await toastMark(doer);
      await doer.page.locator('#btn-submit-bid').click();
      await check(Boolean(await waitToast(doer, vmk, /valid price/, 4000)), 'negative bid rejected client-side', doer, 'minor');
      await doer.page.locator('#bid-price-input').fill('80');
      await doer.page.locator('#bid-message-input').fill(`Two people ${TAG}`);
      const mk = await toastMark(doer);
      await doer.page.locator('#btn-submit-bid').click();
      await check(Boolean(await waitToast(doer, mk, /Bid submitted/)), 'bid €80 on E accepted', doer);

      await openFromMyTasks(poster, T.E.title, 'posted');
      const sel = poster.page.locator('#bids-section .select-bid-btn').first();
      await sel.waitFor({ timeout: 8000 });
      const pMark = await toastMark(poster);
      await sel.click();
      const err = await poll(async () => (await toastsSince(poster, pMark))[0], { timeout: 8000 });
      await shot(poster, 'insufficient-funds');
      await check(err && /Нямате достатъчно средства/.test(err.text), `clear BG error toast (${err && err.text})`, poster, 'major');
      await check(err && !/insufficient_funds|err_/.test(err.text), 'error is not a raw key', poster, 'major');
      await sleep(800);
      await check(!(await detailStatusBadge(poster)), 'E stays open (no status badge)', poster);
      await check(await poster.page.locator('#bids-section .select-bid-btn').first().isEnabled(), 'select button re-enabled after error', poster, 'minor');
      const { data: e } = await admin.from('tasks').select('status').eq('title', T.E.title).single();
      await check(e && e.status === 'open', `DB: E still open (${e && e.status})`, poster);
      await expectWallet(poster, 65, 0, 'unchanged after failed select');
    });

    await step('9b wallet cap €5000 (doer, EN)', async () => {
      await nav(doer, 'wallet');
      let last = null;
      for (let i = 0; i < 10; i++) {
        await doer.page.locator('#wallet-content .add-funds-btn').click();
        await doer.page.locator('#topup-modal.active').waitFor({ timeout: 5000 });
        const mk = await toastMark(doer);
        await doer.page.locator('#topup-modal').getByRole('button', { name: '€500', exact: true }).click();
        last = await waitToast(doer, mk, /./, 8000);
        if (last && !/Added/.test(last.text)) break;
        await doer.page.locator('#topup-modal.active').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      }
      await check(last && /Wallet limit reached \(€5000\)/.test(last.text), `10th €500 top-up (would exceed €5000) → "Wallet limit reached (€5000)" (${last && last.text})`, doer, 'minor');
      if (await doer.page.locator('#topup-modal.active').count()) await doer.page.locator('#topup-modal .modal-close').click();
      const w = await poll(async () => { const v = await walletValues(doer); return v.avail === 4535 ? v : null; }, { timeout: 8000 }) || await walletValues(doer);
      await check(w.avail === 4535, `doer wallet = €35 + 9×€500 = €4535.00 (${JSON.stringify(w.raw)})`, doer, 'minor');
      await shot(doer, 'wallet-cap');
    });

    // ------------------------------------------------------------ 10. language
    await step('10 language audit (poster + doer, every view)', async () => {
      const P = poster;
      await nav(P, 'home');
      await searchFeed(P, TAG);
      await langAudit(P, 'home', WL);
      await openFromMyTasks(P, T.A.title, 'posted');
      await langAudit(P, 'detail-completed', WL);
      await openFromMyTasks(P, T.E.title, 'posted');
      await langAudit(P, 'detail-open-with-bid', WL);
      await nav(P, 'create');
      await P.page.locator('#create-title').fill(`${TAG} lang probe`);
      await P.page.locator('#create-desc').fill('probe');
      await P.page.locator('#create-cat').selectOption('other');
      await P.page.locator('#create-price').fill('10');
      await P.page.locator('#view-create .pay-method-card').nth(1).click();
      await P.page.locator('#view-create button.btn-primary.mt-12').click();
      await P.page.locator('#preview-card.show').waitFor();
      await langAudit(P, 'create-with-preview', WL.concat(['lang probe', 'probe']));
      await P.page.locator('#preview-card .btn-secondary').click();
      await nav(P, 'mytasks');
      await langAudit(P, 'mytasks-posted', WL);
      await nav(P, 'messages');
      await langAudit(P, 'messages-list', WL.concat(['Hello from poster', 'on my way', 'see you']));
      await P.page.locator('#chat-list .chat-item').first().click();
      await P.page.locator('#chat-conversation.active').waitFor();
      await langAudit(P, 'messages-chat', WL.concat(['Hello from poster', 'Hi, on my way', 'Great, see you']));
      await nav(P, 'wallet');
      await langAudit(P, 'wallet', WL);
      await langAudit(P, 'topup-modal', WL, {
        prep: () => P.page.locator('#wallet-content .add-funds-btn').click(),
        teardown: () => P.page.locator('#topup-modal .modal-close').click(),
      });
      await P.page.locator('#header-user-btns .profile-avatar-sm').click();
      await P.page.locator('#view-profile.active').waitFor();
      await langAudit(P, 'profile', WL.concat(['Clear instructions']));
      await langAudit(P, 'notifications-panel', WL, {
        prep: async () => { if (!(await P.page.locator('#notif-panel.open').count())) await P.page.locator('#notif-btn').click(); },
      });
      if (await P.page.locator('#notif-panel.open').count()) await P.page.locator('#notif-btn').click();
      await setLang(P, 'bg');
      const D = doer;
      await nav(D, 'mytasks');
      await D.page.locator('#view-mytasks .tab-btn').nth(1).click();
      await langAudit(D, 'mytasks-bids', WL);
      await setLang(D, 'en');
      // anon auth modal (sign-up tab)
      const A = anon;
      await langAudit(A, 'auth-signup', WL, {
        prep: async () => { await A.page.locator('#header-auth-btns .btn-header-signup').click(); await A.page.locator('#auth-screen-wrapper.active').waitFor(); },
        teardown: () => A.page.locator('#auth-screen-wrapper .auth-modal-close').click(),
      });
      await langAudit(A, 'auth-login', WL, {
        prep: async () => { await A.page.locator('#header-auth-btns .btn-header-login').click(); await A.page.locator('#auth-screen-wrapper.active').waitFor(); },
        teardown: () => A.page.locator('#auth-screen-wrapper .auth-modal-close').click(),
      });
      await A.page.locator('.desktop-sidebar .sidebar-nav-item').nth(0).click();
      await searchFeed(A, TAG);
      await langAudit(A, 'home-anon', WL);
      await A.page.locator('#tasks-grid .task-card').first().click();
      await A.page.locator('#view-detail.active').waitFor();
      await langAudit(A, 'detail-anon', WL);
      await setLang(A, 'bg');
      // toasts
      const allToasts = [];
      for (const a of [anon, poster, doer]) for (const x of await toastsSince(a, 0)) allToasts.push({ actor: a.name, ...x });
      const badToasts = allToasts.filter((x) => RAW_KEY_RE.test(x.text) || (x.lang === 'en' ? /[А-Яа-я]/.test(x.text.split('„')[0]) : /[A-Za-z]{4,}/.test(x.text.replace(new RegExp(`${TAG}[^“"]*`, 'g'), '').replace(/QT\d+/g, ''))));
      langFindings.push({ actor: 'all', view: 'toasts', lang: '-', rawKeys: [], wrong: badToasts.map((x) => `[${x.actor}/${x.lang}] ${x.text}`), all: allToasts.map((x) => `[${x.actor}/${x.lang}] ${x.text}`) });
    });

    // ------------------------------------------------------------ 11. mobile
    await step('11 mobile 390x844', async () => {
      const mp = await newActor('poster-m', MOBILE, { mobile: true });
      const md = await newActor('doer-m', MOBILE, { mobile: true });
      for (const a of [mp, md]) {
        await a.page.goto(BASE, { waitUntil: 'domcontentloaded' });
        await a.page.locator('#tasks-grid .task-card, #tasks-grid .empty-state').first().waitFor({ timeout: 15000 });
      }
      let o = await overflowReport(mp.page);
      await check(!o.hScroll, `mobile home (logged out) has no horizontal scroll (${JSON.stringify(o)})`, mp, 'major', 'm-home-hscroll');
      await mp.page.locator('#header-auth-btns .btn-header-login').click();
      await mp.page.locator('#auth-screen-wrapper.active').waitFor();
      const box = await mp.page.locator('#auth-screen-wrapper .auth-screen').boundingBox();
      await check(box && box.x >= 0 && box.x + box.width <= 390 + 1, `login modal fits 390px (${JSON.stringify(box)})`, mp, 'major');
      await shot(mp, 'm-login-modal');
      await mp.page.locator('#auth-screen-wrapper .auth-modal-close').click();
      await login(mp, posterUser);
      await setLang(md, 'en');
      await login(md, doerUser);
      for (const v of ['home', 'mytasks', 'create', 'messages', 'wallet']) {
        await nav(mp, v);
        await sleep(700);
        o = await overflowReport(mp.page);
        await check(!o.hScroll, `mobile ${v}: no horizontal scroll (${JSON.stringify(o)})`, mp, 'major', `m-${v}-hscroll`);
        const active = await mp.page.locator('.bottom-nav .nav-item.active').innerText();
        await check(active.trim().length > 0, `bottom nav marks ${v} active ("${active.trim()}")`, mp, 'minor');
      }
      await nav(mp, 'home');
      await shot(mp, 'm-home', { fullPage: false });
      // header crowding
      const hdr = await mp.page.evaluate(() => { const h = document.querySelector('.app-header'); const r = h.getBoundingClientRect(); return { h: r.height, sw: h.scrollWidth, cw: h.clientWidth }; });
      await check(hdr.sw <= hdr.cw + 1, `mobile header content fits (${JSON.stringify(hdr)})`, mp, 'minor');
      // profile
      await mp.page.locator('#header-user-btns .profile-avatar-sm').click();
      await mp.page.locator('#view-profile.active').waitFor();
      await sleep(700);
      o = await overflowReport(mp.page);
      await check(!o.hScroll, `mobile profile: no horizontal scroll (${JSON.stringify(o)})`, mp, 'major');
      await shot(mp, 'm-profile', { fullPage: true });
      // notifications panel
      await mp.page.locator('#notif-btn').click();
      await mp.page.locator('#notif-panel.open').waitFor();
      await settle(mp.page); await sleep(400);
      const nb = await mp.page.locator('#notif-panel').boundingBox();
      await check(nb && nb.x >= 0 && nb.x + nb.width <= 390 + 1 && nb.y + nb.height <= 844, `notifications panel fits the 390px screen (${JSON.stringify(nb)})`, mp, 'major', 'm-notif-panel');
      await shot(mp, 'm-notif-panel');
      await mp.page.locator('#notif-btn').click();
      // wallet + top-up modal
      await nav(mp, 'wallet');
      await mp.page.locator('#wallet-content .add-funds-btn').click();
      await mp.page.locator('#topup-modal.active').waitFor();
      await settle(mp.page); await sleep(400);
      const tb = await mp.page.locator('#topup-modal .modal').boundingBox();
      await check(tb && tb.x >= 0 && tb.x + tb.width <= 391 && tb.y >= 0 && tb.y + tb.height <= 845, `top-up modal fits (${JSON.stringify(tb)})`, mp, 'major', 'm-topup');
      await shot(mp, 'm-topup');
      await mp.page.locator('#topup-modal .modal-close').click();
      // create form on mobile → task F
      const F = { key: 'F', title: `${TAG} F walk the dog`, desc: `Thirty minute walk. ${TAG}`, category: 'pet-care', price: 10, bidding: 'price', pay: 'cash', duration: 3, neighborhood: 'Изток' };
      await nav(mp, 'create');
      const fields = ['#create-title', '#create-desc', '#create-cat', '#create-price', '#create-duration', '#create-neighborhood', '#create-address'];
      const narrow = [];
      for (const f of fields) { const b = await mp.page.locator(f).boundingBox(); if (!b || b.x < 0 || b.x + b.width > 391) narrow.push(`${f}:${JSON.stringify(b)}`); }
      await check(narrow.length === 0, `create form fields fit the screen (${narrow.join(' ')})`, mp, 'major', 'm-create');
      await shot(mp, 'm-create', { fullPage: true });
      await createTask(mp, F);
      pass('task F posted from the mobile create form');
      // doer mobile bids on F (reload: the feed is cached for 60s, see step 2c)
      await md.page.reload();
      await md.page.locator('#header-user-btns').waitFor({ state: 'visible', timeout: 15000 });
      await openFromFeed(md, F.title);
      o = await overflowReport(md.page);
      await check(!o.hScroll, `mobile detail: no horizontal scroll (${JSON.stringify(o)})`, md, 'major');
      await settle(md.page); await sleep(400);
      const sticky = await md.page.locator('#bid-sticky').boundingBox();
      const navBox = await md.page.locator('.bottom-nav').boundingBox();
      await check(sticky && navBox && sticky.y + sticky.height <= navBox.y + 1, `"Place a bid" bar is not hidden behind the bottom nav (sticky=${JSON.stringify(sticky)} nav=${JSON.stringify(navBox)})`, md, 'major', 'm-sticky');
      await shot(md, 'm-detail');
      await md.page.locator('#bid-sticky .place-bid-btn').click();
      await md.page.locator('#bid-modal.active').waitFor();
      await settle(md.page); await sleep(400);
      const bm = await md.page.locator('#bid-modal .modal').boundingBox();
      await check(bm && bm.x >= 0 && bm.x + bm.width <= 391 && bm.y >= 0 && bm.y + bm.height <= 845, `bid modal fits (${JSON.stringify(bm)})`, md, 'major');
      await md.page.locator('#bid-price-input').fill('9');
      await md.page.locator('#bid-message-input').fill(`Dog lover ${TAG}`);
      const subBox = await md.page.locator('#btn-submit-bid').boundingBox();
      await check(subBox && subBox.y + subBox.height <= 844, `submit bid button within viewport (${JSON.stringify(subBox)})`, md, 'major');
      await shot(md, 'm-bid-modal');
      const mk = await toastMark(md);
      await md.page.locator('#btn-submit-bid').click();
      await check(Boolean(await waitToast(md, mk, /Bid submitted/)), 'mobile bid submitted', md);
      // poster mobile selects
      await poll(() => notifBadgeVisible(mp), { timeout: 15000 });
      await openFromMyTasks(mp, F.title, 'posted');
      await mp.page.locator('#bids-section .select-bid-btn').first().click();
      await poll(async () => /В изпълнение/.test(await detailStatusBadge(mp)), { timeout: 8000 });
      // doer sends a message; poster (on detail) should see the bottom-nav badge
      await poll(() => notifBadgeVisible(md), { timeout: 15000 });
      await nav(md, 'messages');
      await md.page.locator('#chat-list .chat-item', { hasText: F.title }).click();
      await md.page.locator('#chat-conversation.active .chat-input-bar input').fill(`Leaving now ${TAG}`);
      await md.page.locator('#chat-conversation .send-btn').click();
      await md.page.locator('#chat-conversation .msg-bubble.sent').first().waitFor();
      const mb = await poll(async () => (await mp.page.locator('#msg-badge').isVisible()) && (await mp.page.locator('#msg-badge').textContent()), { timeout: 12000 });
      await check(Boolean(mb), `mobile: Messages bottom-nav badge appears (${mb})`, mp, 'major');
      await shot(mp, 'm-msg-badge');
      await nav(mp, 'messages');
      await mp.page.locator('#chat-list .chat-item', { hasText: F.title }).click();
      await mp.page.locator('#chat-conversation.active .msg-bubble.received').first().waitFor();
      o = await overflowReport(mp.page);
      await check(!o.hScroll, `mobile chat: no horizontal scroll (${JSON.stringify(o)})`, mp, 'major');
      const inputBox = await mp.page.locator('#chat-conversation .chat-input-bar').boundingBox();
      const navBox2 = await mp.page.locator('.bottom-nav').boundingBox();
      await check(inputBox && navBox2 && inputBox.y + inputBox.height <= navBox2.y + 1, `chat input not covered by bottom nav (input=${JSON.stringify(inputBox)} nav=${JSON.stringify(navBox2)})`, mp, 'major', 'm-chat-input');
      const cleared = await poll(async () => !(await mp.page.locator('#msg-badge').isVisible()), { timeout: 8000 });
      await check(cleared, 'mobile badge clears after opening chat', mp, 'minor');
      await shot(mp, 'm-chat');
      // rating modal on mobile
      await mp.page.locator('#chat-conversation .chat-task-ref').click();
      await mp.page.locator('#detail-actions button.btn-primary').click(); // mark complete
      await poll(async () => /Завършена/.test(await detailStatusBadge(mp)), { timeout: 8000 });
      await mp.page.locator('#detail-actions button', { hasText: 'Оцени' }).click();
      await mp.page.locator('#rating-modal.active').waitFor();
      await settle(mp.page); await sleep(400);
      const rb = await mp.page.locator('#rating-modal .modal').boundingBox();
      await check(rb && rb.x >= 0 && rb.x + rb.width <= 391 && rb.y >= 0 && rb.y + rb.height <= 845, `rating modal fits (${JSON.stringify(rb)})`, mp, 'major');
      await shot(mp, 'm-rating-modal');
      await mp.page.locator('#rating-modal .modal-close').click();
    });
  } finally {
    // ------------------------------------------------------------ logs + cleanup
    const logs = {};
    for (const a of Object.values(actors)) logs[a.name] = a.logs;
    try { if (browser) await browser.close(); } catch {}
    let removed; let clean;
    try {
      const ids = [...new Set([...createdUserIds, ...(await e2eUserIds())])];
      removed = await cleanup(ids);
      clean = await verifyClean(TAG);
    } catch (e) { removed = { error: e.message }; }
    const report = { run: RUN, tag: TAG, results, timings, langFindings, logs, cleanup: { removed, clean } };
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    const by = (k) => results.filter((r) => r.kind === k);
    log(`DONE pass=${by('pass').length} bug=${by('bug').length} fail=${by('fail').length} note=${by('note').length}`);
    for (const r of [...by('fail'), ...by('bug')]) log(`  ${r.kind.toUpperCase()}${r.severity ? '[' + r.severity + ']' : ''} (${r.step}) ${r.msg} ${r.shot || ''}`);
    log('cleanup', JSON.stringify(removed), JSON.stringify(clean));
    log('report', path.join(OUT, 'report.json'));
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

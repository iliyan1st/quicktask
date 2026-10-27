// QuickTask database security + workflow tests.
// Run: node --test   (from the project root)
//
// The browser talks to Supabase directly with the anon key, so RLS, column
// grants, triggers and SECURITY DEFINER RPCs are the backend. Every action
// under test is performed by a signed-in (or anonymous) client using the anon
// key. The service-role client is used only for setup, inspection and teardown.
//
// Everything this run creates belongs to throwaway users qa-<RUN>-*@quicktask.test
// and is removed in after(), FK-safe, even when tests fail.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------- env
const env = {};
for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const SB_URL = env.SUPABASE_URL;
const ANON_KEY = env.SUPABASE_ANON_KEY;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !ANON_KEY || !SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing in .env');

const CLIENT_OPTS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = createClient(SB_URL, SERVICE_KEY, CLIENT_OPTS); // setup / inspection / teardown only
const anon = createClient(SB_URL, ANON_KEY, CLIENT_OPTS);

const RUN = String(Date.now());
const BUCKET = 'task-photos';
const QA_EMAIL_RE = /^qa-\d+-[a-z0-9]+@quicktask\.test$/i;

const createdUserIds = [];
const storagePaths = new Set(); // every path any test tried to write, removed in teardown

// ---------------------------------------------------------------- helpers
const money = (x) => Math.round(Number(x) * 100) / 100;
const fmtErr = (e) => (e ? `${e.code ?? e.statusCode ?? e.status ?? ''} ${e.message}`.trim() : 'none');

/**
 * Assert a supabase call failed.
 * expected: undefined (any error), a string (exact message, e.g. a RAISE key) or a RegExp
 * matched against "<code> <message>".
 */
function expectErr(res, expected, label) {
  assert.ok(res.error, `${label}: expected failure${expected ? ` (${expected})` : ''} but the call succeeded; data=${JSON.stringify(res.data)?.slice(0, 300)}`);
  if (typeof expected === 'string') {
    assert.equal(res.error.message, expected, `${label}: wrong error, got "${fmtErr(res.error)}"`);
  } else if (expected instanceof RegExp) {
    assert.match(`${res.error.code ?? ''} ${res.error.message}`, expected, `${label}: wrong error, got "${fmtErr(res.error)}"`);
  }
}
function expectOk(res, label) {
  assert.ok(!res.error, `${label}: unexpected error "${fmtErr(res.error)}"`);
  return res.data;
}
const PRIV = /^42501 permission denied/; // missing table/column/function privilege
const DENIED = /^42501 /; // privilege or RLS check
const CHECK = /^23514 /; // CHECK constraint

async function makeUser(tag, username = `qa_${RUN}_${tag}`) {
  const email = `qa-${RUN}-${tag}@quicktask.test`;
  const password = `Qa-${crypto.randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: `QA ${tag.toUpperCase()}`, username },
  });
  if (error) throw new Error(`createUser ${tag}: ${error.message}`);
  createdUserIds.push(data.user.id);
  const db = createClient(SB_URL, ANON_KEY, CLIENT_OPTS);
  const { error: signErr } = await db.auth.signInWithPassword({ email, password });
  if (signErr) throw new Error(`signIn ${tag}: ${signErr.message}`);
  return { id: data.user.id, email, tag, db };
}

async function adminRow(table, id) {
  const { data, error } = await admin.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`admin read ${table}: ${error.message}`);
  return data;
}
const prof = (id) => adminRow('profiles', id);

async function adminRows(table, filters) {
  let q = admin.from(table).select('*');
  for (const [k, v] of Object.entries(filters)) q = v === null ? q.is(k, null) : q.eq(k, v);
  const { data, error } = await q;
  if (error) throw new Error(`admin read ${table}: ${error.message}`);
  return data;
}

let taskSeq = 0;
function taskRow(u, over = {}) {
  taskSeq += 1;
  return {
    poster_id: u.id, title: `QA ${RUN} task ${taskSeq}`, description: 'qa security test task',
    category: 'other', price: 50, bidding_type: 'price', payment_method: 'cash',
    bidding_duration_hours: 24, ...over,
  };
}
async function postTask(u, over = {}) {
  const res = await u.db.from('tasks').insert(taskRow(u, over)).select().single();
  return expectOk(res, `postTask by ${u.tag}`);
}
async function placeBid(u, taskId, amount, extra = {}) {
  const res = await u.db.from('bids').insert({ task_id: taskId, bidder_id: u.id, amount, message: 'qa bid', ...extra }).select().single();
  return expectOk(res, `bid by ${u.tag}`);
}
async function rpcOk(u, fn, args = {}) {
  const res = await u.db.rpc(fn, args);
  return expectOk(res, `${fn} by ${u.tag}`);
}
async function myProfile(u) {
  const data = await rpcOk(u, 'get_my_profile');
  return Array.isArray(data) ? data[0] : data;
}
async function wallet(id) {
  const p = await prof(id);
  return { bal: money(p.wallet_balance), held: money(p.wallet_held) };
}
async function topUpTo(u, target) {
  // Bring balance to at least `target` with demo_top_up (5..500 per call).
  let { bal } = await wallet(u.id);
  while (bal < target) {
    const amt = Math.min(500, Math.max(5, money(target - bal)));
    bal = money(await rpcOk(u, 'demo_top_up', { p_amount: amt }));
  }
  return bal;
}
async function notifs(userId, type, taskId) {
  let q = admin.from('notifications').select('*').eq('user_id', userId).eq('type', type);
  if (taskId) q = q.eq('data->>task_id', taskId);
  const { data, error } = await q;
  if (error) throw new Error(`admin notifications: ${error.message}`);
  return data;
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
async function upload(client, path, body = JPEG, opts = { contentType: 'image/jpeg' }) {
  storagePaths.add(path);
  return client.storage.from(BUCKET).upload(path, body, opts);
}
async function objectExists(path) {
  const slash = path.lastIndexOf('/');
  const folder = slash === -1 ? '' : path.slice(0, slash);
  const name = path.slice(slash + 1);
  const { data, error } = await admin.storage.from(BUCKET).list(folder, { limit: 1000, search: name });
  if (error) throw new Error(`admin storage list: ${error.message}`);
  return (data ?? []).some((o) => o.name === name);
}

// ---------------------------------------------------------------- teardown
async function cleanup(userIds) {
  const removed = {};
  if (userIds.length) {
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
      removed[table] = (removed[table] ?? 0) + (count ?? 0);
    };
    // FK-safe order: several FKs have no ON DELETE CASCADE.
    await del('transactions', (q) => q.or(`user_id.in.(${ids})${tIn}`));
    await del('ratings', (q) => q.or(`rater_id.in.(${ids}),rated_id.in.(${ids})${tIn}`));
    await del('messages', (q) => q.or(`sender_id.in.(${ids})${convIds.length ? `,conversation_id.in.(${convIds.join(',')})` : ''}`));
    await del('conversations', (q) => q.or(`poster_id.in.(${ids}),doer_id.in.(${ids})${tIn}`));
    await del('notifications', (q) => q.in('user_id', userIds));
    await del('bids', (q) => q.or(`bidder_id.in.(${ids})${tIn}`));
    await del('tasks', (q) => q.in('poster_id', userIds));

    for (const id of userIds) {
      const { data: objs } = await admin.storage.from(BUCKET).list(id, { limit: 1000 });
      for (const o of objs ?? []) storagePaths.add(`${id}/${o.name}`);
    }
  }
  // Root-level strays from this or earlier runs (only qa- names).
  const { data: rootObjs } = await admin.storage.from(BUCKET).list('', { limit: 1000 });
  for (const o of rootObjs ?? []) if (/^qa-\d+-/.test(o.name)) storagePaths.add(o.name);
  if (storagePaths.size) {
    const { data: gone, error } = await admin.storage.from(BUCKET).remove([...storagePaths]);
    if (error) throw new Error(`cleanup storage: ${error.message}`);
    removed.storage_objects = gone?.length ?? 0;
  }

  for (const id of userIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error && !/not.?found/i.test(error.message)) throw new Error(`cleanup deleteUser ${id}: ${error.message}`);
  }
  removed.users = userIds.length;
  return removed;
}

async function qaUserIds() {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  return data.users.filter((u) => QA_EMAIL_RE.test(u.email ?? '')).map((u) => u.id);
}

// ---------------------------------------------------------------- fixtures
let A; let B; let C; let H1; let H2;

before(async () => {
  [A, B, C, H1, H2] = [await makeUser('a'), await makeUser('b'), await makeUser('c'), await makeUser('h1'), await makeUser('h2')];
});

after(async () => {
  const ids = [...new Set([...createdUserIds, ...(await qaUserIds())])]; // also sweeps strays from crashed runs
  const removed = await cleanup(ids);
  const left = await qaUserIds();
  console.log(`# teardown removed ${JSON.stringify(removed)}; qa- users left: ${left.length}`);
});

// ================================================================ PROFILES
describe('profiles', () => {
  const PUBLIC_COLS = 'id,username,full_name,avatar_url,bio,trust_level,email_verified,phone_verified,tasks_completed,tasks_posted,rating_avg,rating_count,is_premium,created_at';
  const PRIVATE_COLS = ['email', 'phone', 'location', 'wallet_balance', 'wallet_held', 'payment_mode', 'latitude', 'longitude', 'updated_at'];

  test('anon and authenticated can read the public columns', async () => {
    const r1 = await anon.from('profiles').select(PUBLIC_COLS).eq('id', A.id);
    assert.equal(expectOk(r1, 'anon read').length, 1);
    const r2 = await B.db.from('profiles').select(PUBLIC_COLS).eq('id', A.id);
    assert.equal(expectOk(r2, 'B read A').length, 1);
  });

  for (const col of PRIVATE_COLS) {
    test(`private column "${col}" is unreadable by anon, other users and the owner (via table)`, async () => {
      expectErr(await anon.from('profiles').select(`id,${col}`).eq('id', A.id), PRIV, `anon reads A.${col}`);
      expectErr(await B.db.from('profiles').select(`id,${col}`).eq('id', A.id), PRIV, `B reads A.${col}`);
      expectErr(await A.db.from('profiles').select(`id,${col}`).eq('id', A.id), PRIV, `A reads own ${col}`);
    });
  }

  test('select * is refused (it would include private columns)', async () => {
    expectErr(await anon.from('profiles').select('*').limit(1), PRIV, 'anon select *');
    expectErr(await A.db.from('profiles').select('*').eq('id', A.id), PRIV, 'A select own *');
  });

  test('private columns cannot be used as a filter/sort oracle', async () => {
    expectErr(await B.db.from('profiles').select('id').eq('id', A.id).gte('wallet_balance', 0), PRIV, 'filter on wallet_balance');
    expectErr(await anon.from('profiles').select('id').ilike('email', '%@%').limit(1), PRIV, 'anon filter on email');
    expectErr(await B.db.from('profiles').select('id').order('phone').limit(1), PRIV, 'order by phone');
  });

  test('get_my_profile returns the caller\'s full row; anon is refused', async () => {
    const mineA = await myProfile(A);
    assert.equal(mineA.id, A.id);
    assert.equal(mineA.email, A.email);
    for (const k of ['wallet_balance', 'wallet_held', 'payment_mode', 'phone', 'location']) assert.ok(k in mineA, `get_my_profile missing ${k}`);
    const mineB = await myProfile(B);
    assert.equal(mineB.id, B.id, 'B gets B\'s row');
    const r = await anon.rpc('get_my_profile');
    assert.ok(r.error || r.data == null || (Array.isArray(r.data) && r.data.length === 0) || r.data.id == null,
      `anon got profile data: ${JSON.stringify(r.data)}`);
    expectErr(r, PRIV, 'anon get_my_profile');
  });

  test('owner can update username, full_name, avatar_url, phone, bio, location', async () => {
    const patch = {
      username: `qa_${RUN}_a_upd`, full_name: 'QA A Updated', avatar_url: 'https://example.com/a.png',
      phone: '+359888000000', bio: 'qa bio', location: 'Sofia',
    };
    expectOk(await A.db.from('profiles').update(patch).eq('id', A.id), 'A updates allowed columns');
    const p = await prof(A.id);
    for (const [k, v] of Object.entries(patch)) assert.equal(p[k], v, `${k} not updated`);
  });

  const FORBIDDEN = {
    wallet_balance: 9999, wallet_held: 9999, rating_avg: 5, rating_count: 999, tasks_completed: 999,
    tasks_posted: 999, is_premium: true, trust_level: 'premium', email_verified: 'toggle', phone_verified: true,
    email: 'evil@example.com', payment_mode: 'escrow',
  };
  for (const [col, val] of Object.entries(FORBIDDEN)) {
    test(`owner cannot update "${col}"`, async () => {
      const before0 = await prof(A.id);
      const value = val === 'toggle' ? !before0[col] : val;
      expectErr(await A.db.from('profiles').update({ [col]: value }).eq('id', A.id), PRIV, `A updates own ${col}`);
      const after0 = await prof(A.id);
      assert.deepEqual(after0[col], before0[col], `${col} changed from ${before0[col]} to ${after0[col]}`);
    });
  }

  test('updating someone else\'s row changes nothing', async () => {
    const before0 = await prof(B.id);
    await A.db.from('profiles').update({ bio: 'hacked by A', full_name: 'Hacked', location: 'Nowhere' }).eq('id', B.id);
    const after0 = await prof(B.id);
    assert.equal(after0.bio, before0.bio);
    assert.equal(after0.full_name, before0.full_name);
    assert.equal(after0.location, before0.location);
  });

  test('no client INSERT or DELETE on profiles', async () => {
    expectErr(await A.db.from('profiles').insert({ id: crypto.randomUUID(), username: `qa_${RUN}_x`, full_name: 'x' }), DENIED, 'insert');
    expectErr(await A.db.from('profiles').delete().eq('id', A.id), PRIV, 'delete own');
    assert.ok(await prof(A.id), 'A profile was deleted');
  });
});

// ================================================================ SIGNUP
describe('signup', () => {
  test('signup with an existing username succeeds and gets a numeric suffix', async () => {
    const taken = (await prof(B.id)).username;
    const D = await makeUser('d', taken);
    const p = await prof(D.id);
    assert.ok(p, 'profile row not created');
    assert.notEqual(p.username, taken);
    assert.match(p.username, new RegExp(`^${taken}\\d+$`), `unexpected username ${p.username}`);
  });
});

// ================================================================ TASKS
describe('tasks', () => {
  test('anon can read tasks; anon cannot insert', async () => {
    const t = await postTask(A);
    const r = await anon.from('tasks').select('id,title,poster_id,status').eq('id', t.id);
    assert.equal(expectOk(r, 'anon read').length, 1);
    expectErr(await anon.from('tasks').insert(taskRow(A)), DENIED, 'anon insert');
  });

  test('server forces poster_id, status, counters, selection fields and bidding_ends_at', async () => {
    const row = taskRow(A, { poster_id: B.id, bidding_ends_at: '2099-01-01T00:00:00Z', bidding_duration_hours: 2 });
    const res = await A.db.from('tasks').insert(row).select().single();
    const t = expectOk(res, 'insert with spoofed poster_id/bidding_ends_at');
    const db = await adminRow('tasks', t.id);
    assert.equal(db.poster_id, A.id, 'poster_id not forced to caller');
    assert.equal(db.status, 'open');
    assert.equal(db.bid_count, 0);
    assert.equal(db.selected_bid_id, null);
    assert.equal(db.selected_doer_id, null);
    assert.equal(db.completed_at, null);
    assert.equal(db.selection_ends_at, null);
    const span = Date.parse(db.bidding_ends_at) - Date.parse(db.created_at);
    assert.ok(Math.abs(span - 2 * 3600e3) < 2000, `bidding_ends_at - created_at = ${span}ms, expected 2h (client value ignored)`);
  });

  const SERVER_COLS = {
    status: 'completed', bid_count: 99, selected_doer_id: 'B', selected_bid_id: crypto.randomUUID(),
    completed_at: '2026-01-01T00:00:00Z', selection_ends_at: '2099-01-01T00:00:00Z',
  };
  for (const [col, val] of Object.entries(SERVER_COLS)) {
    test(`insert that sets "${col}" is rejected (no column privilege)`, async () => {
      const row = taskRow(A, { [col]: val === 'B' ? B.id : val });
      expectErr(await A.db.from('tasks').insert(row), PRIV, `insert ${col}`);
      assert.equal((await adminRows('tasks', { title: row.title })).length, 0, 'row was created');
    });
  }

  test('accepts boundary values (price 0.01/100000, title 3/120, duration 1/168, 5 own photos)', async () => {
    await postTask(A, { price: 0.01 });
    await postTask(A, { price: 100000 });
    await postTask(A, { title: 'abc' });
    await postTask(A, { title: 'x'.repeat(120) });
    await postTask(A, { bidding_duration_hours: 1 });
    await postTask(A, { bidding_duration_hours: 168 });
    await postTask(A, { photos: ['p1.jpg', 'p_2.jpeg', 'P-3.png', 'p4.webp', 'p5.jpg'].map((n) => `${A.id}/${n}`) });
  });

  const BAD = {
    'price 0': { price: 0 }, 'price -1': { price: -1 }, 'price 100000.01': { price: 100000.01 }, 'price 100001': { price: 100001 },
    'title 2 chars': { title: 'ab' }, 'title 121 chars': { title: 'x'.repeat(121) },
    'bidding_duration_hours 0': { bidding_duration_hours: 0 }, 'bidding_duration_hours 169': { bidding_duration_hours: 169 },
  };
  for (const [name, over] of Object.entries(BAD)) {
    test(`rejects ${name}`, async () => {
      const row = taskRow(A, over);
      expectErr(await A.db.from('tasks').insert(row), CHECK, name);
    });
  }

  test('rejects more than 5 photos', async () => {
    const photos = [1, 2, 3, 4, 5, 6].map((i) => `${A.id}/p${i}.jpg`);
    expectErr(await A.db.from('tasks').insert(taskRow(A, { photos })), CHECK, '6 photos');
  });

  // a/b are passed explicitly: test names are registered before the users exist.
  const badPhotos = (a = A, b = B) => ({
    'another user\'s folder': `${b.id}/x.jpg`,
    'dot-dot into another folder': `${a.id}/../${b.id}/x.jpg`,
    'dot-dot prefix': `../${a.id}/x.jpg`,
    'dot-dot to bucket root': `${a.id}/../x.jpg`,
    'absolute URL': `https://evil.example.com/${a.id}/x.jpg`,
    'leading slash': `/${a.id}/x.jpg`,
    'sub folder': `${a.id}/sub/x.jpg`,
    'bucket root': 'x.jpg',
    'gif extension': `${a.id}/x.gif`,
    'query string': `${a.id}/x.jpg?v=1`,
    'trailing newline': `${a.id}/x.jpg\n`,
    'uppercase uid': `${a.id.toUpperCase()}/x.jpg`,
    'empty file name': `${a.id}/.jpg`,
  });
  for (const name of Object.keys(badPhotos({ id: 'a' }, { id: 'b' }))) {
    test(`rejects photo path: ${name}`, async () => {
      const p = badPhotos()[name];
      const row = taskRow(A, { photos: [`${A.id}/ok.jpg`, p] });
      expectErr(await A.db.from('tasks').insert(row), 'invalid_photo', `photo ${JSON.stringify(p)}`);
    });
  }

  test('rejects a NULL photo entry (it does not match the required path pattern)', async () => {
    const row = taskRow(A, { photos: [`${A.id}/ok.jpg`, null] });
    const res = await A.db.from('tasks').insert(row).select('id,photos').maybeSingle();
    if (!res.error) {
      const stored = await adminRows('tasks', { title: row.title });
      assert.fail(`insert succeeded; stored photos=${JSON.stringify(stored[0]?.photos)}`);
    }
  });

  test('no client UPDATE or DELETE on tasks', async () => {
    const t = await postTask(A);
    expectErr(await A.db.from('tasks').update({ title: 'changed by poster' }).eq('id', t.id), PRIV, 'poster updates title');
    expectErr(await A.db.from('tasks').update({ status: 'completed' }).eq('id', t.id), PRIV, 'poster updates status');
    expectErr(await A.db.from('tasks').update({ price: 1 }).eq('id', t.id), PRIV, 'poster updates price');
    expectErr(await B.db.from('tasks').update({ title: 'changed by B' }).eq('id', t.id), PRIV, 'other user updates');
    expectErr(await A.db.from('tasks').delete().eq('id', t.id), PRIV, 'poster deletes');
    expectErr(await anon.from('tasks').delete().eq('id', t.id), PRIV, 'anon deletes');
    const db = await adminRow('tasks', t.id);
    assert.ok(db, 'task deleted');
    assert.equal(db.title, t.title);
    assert.equal(db.status, 'open');
    assert.equal(money(db.price), money(t.price));
  });
});

// ================================================================ BIDS
describe('bids', () => {
  let Tp; let Tf; let bidB; let bidC;

  before(async () => {
    Tp = await postTask(A, { bidding_type: 'price', price: 50 });
    Tf = await postTask(A, { bidding_type: 'fixed', price: 50 });
  });

  test('bidder_id is forced to the caller and status to pending', async () => {
    const res = await B.db.from('bids').insert({ task_id: Tp.id, bidder_id: C.id, amount: 30, message: 'spoof' }).select().single();
    bidB = expectOk(res, 'B bids with bidder_id=C');
    const db = await adminRow('bids', bidB.id);
    assert.equal(db.bidder_id, B.id, 'bidder_id not forced');
    assert.equal(db.status, 'pending');
    assert.equal(money(db.amount), 30);
  });

  test('insert that sets status is rejected (no column privilege)', async () => {
    expectErr(await C.db.from('bids').insert({ task_id: Tp.id, bidder_id: C.id, amount: 20, status: 'selected' }), PRIV, 'status on insert');
    assert.equal((await adminRows('bids', { task_id: Tp.id, bidder_id: C.id })).length, 0);
  });

  test('cannot bid on own task (own_task), even with a spoofed bidder_id', async () => {
    expectErr(await A.db.from('bids').insert({ task_id: Tp.id, bidder_id: A.id, amount: 10 }), 'own_task', 'own');
    expectErr(await A.db.from('bids').insert({ task_id: Tp.id, bidder_id: B.id, amount: 10 }), 'own_task', 'own, spoofed');
  });

  test('one bid per user per task', async () => {
    expectErr(await B.db.from('bids').insert({ task_id: Tp.id, bidder_id: B.id, amount: 25 }), /^23505 /, 'second bid');
    assert.equal((await adminRows('bids', { task_id: Tp.id, bidder_id: B.id })).length, 1);
  });

  test('fixed-price task forces amount = task price', async () => {
    const b = await placeBid(C, Tf.id, 1);
    assert.equal(money((await adminRow('bids', b.id)).amount), 50);
  });

  for (const [name, amount] of Object.entries({ null: null, zero: 0, negative: -5 })) {
    test(`price-bidding task rejects ${name} amount (invalid_amount)`, async () => {
      expectErr(await C.db.from('bids').insert({ task_id: Tp.id, bidder_id: C.id, amount }), 'invalid_amount', `amount ${amount}`);
    });
  }

  test('bid after bidding_ends_at is rejected (bidding_closed)', async () => {
    const t = await postTask(A);
    expectOk(await admin.from('tasks').update({ bidding_ends_at: new Date(Date.now() - 60e3).toISOString() }).eq('id', t.id), 'setup: move deadline');
    expectErr(await B.db.from('bids').insert({ task_id: t.id, bidder_id: B.id, amount: 10 }), 'bidding_closed', 'late bid');
  });

  test('bid on a cancelled task is rejected (bidding_closed)', async () => {
    const t = await postTask(A);
    await rpcOk(A, 'cancel_task', { p_task_id: t.id });
    expectErr(await B.db.from('bids').insert({ task_id: t.id, bidder_id: B.id, amount: 10 }), 'bidding_closed', 'bid on cancelled');
  });

  test('no client UPDATE or DELETE on bids', async () => {
    bidC = await placeBid(C, Tp.id, 40);
    expectErr(await B.db.from('bids').update({ amount: 1 }).eq('id', bidB.id), PRIV, 'bidder changes amount');
    expectErr(await B.db.from('bids').update({ status: 'withdrawn' }).eq('id', bidB.id), PRIV, 'bidder changes status');
    expectErr(await A.db.from('bids').update({ status: 'selected' }).eq('id', bidB.id), PRIV, 'poster changes status');
    expectErr(await B.db.from('bids').delete().eq('id', bidB.id), PRIV, 'bidder deletes');
    expectErr(await A.db.from('bids').delete().eq('id', bidC.id), PRIV, 'poster deletes');
    const db = await adminRow('bids', bidB.id);
    assert.equal(db.status, 'pending');
    assert.equal(money(db.amount), 30);
    assert.ok(await adminRow('bids', bidC.id));
  });

  test('bids are visible only to the bidder and the task poster', async () => {
    const asPoster = expectOk(await A.db.from('bids').select('id,bidder_id').eq('task_id', Tp.id), 'poster');
    assert.deepEqual(asPoster.map((b) => b.id).sort(), [bidB.id, bidC.id].sort());
    const asB = expectOk(await B.db.from('bids').select('id,bidder_id').eq('task_id', Tp.id), 'B');
    assert.deepEqual(asB.map((b) => b.id), [bidB.id], 'B sees other bids');
    const asC = expectOk(await C.db.from('bids').select('id').eq('id', bidB.id), 'C reads B bid');
    assert.equal(asC.length, 0, 'C can read B\'s bid');
    const asH = expectOk(await H1.db.from('bids').select('id').eq('task_id', Tp.id), 'outsider');
    assert.equal(asH.length, 0, 'outsider can read bids');
    const r = await anon.from('bids').select('id').eq('task_id', Tp.id);
    assert.ok(r.error || r.data.length === 0, `anon can read bids: ${JSON.stringify(r.data)}`);
  });

  test('withdraw_bid: only own pending bid; poster/others cannot; not twice', async () => {
    const Tw = await postTask(A);
    const bw = await placeBid(B, Tw.id, 15);
    expectErr(await C.db.rpc('withdraw_bid', { p_bid_id: bw.id }), 'cannot_withdraw', 'other user');
    expectErr(await A.db.rpc('withdraw_bid', { p_bid_id: bw.id }), 'cannot_withdraw', 'poster');
    assert.equal((await adminRow('bids', bw.id)).status, 'pending');
    await rpcOk(B, 'withdraw_bid', { p_bid_id: bw.id });
    assert.equal((await adminRow('bids', bw.id)).status, 'withdrawn');
    expectErr(await B.db.rpc('withdraw_bid', { p_bid_id: bw.id }), 'cannot_withdraw', 'twice');
    expectErr(await A.db.rpc('select_bid', { p_bid_id: bw.id }), 'bid_not_pending', 'select withdrawn bid');
  });
});

// ================================================================ ESCROW LIFECYCLE: select / complete / rate
describe('escrow lifecycle: select_bid, complete_task, rate_task', () => {
  let Te; let bB; let bC;

  before(async () => {
    Te = await postTask(A, { payment_method: 'escrow', bidding_type: 'price', price: 40 });
    bB = await placeBid(B, Te.id, 35);
    bC = await placeBid(C, Te.id, 38);
  });

  test('select_bid: only the task poster', async () => {
    expectErr(await B.db.rpc('select_bid', { p_bid_id: bB.id }), 'not_your_task', 'bidder selects own bid');
    expectErr(await C.db.rpc('select_bid', { p_bid_id: bB.id }), 'not_your_task', 'other bidder');
    expectErr(await H1.db.rpc('select_bid', { p_bid_id: bB.id }), 'not_your_task', 'outsider');
    assert.equal((await adminRow('tasks', Te.id)).status, 'open');
    assert.equal((await adminRow('bids', bB.id)).status, 'pending');
  });

  test('select_bid: insufficient_funds when balance < agreed amount; nothing changes', async () => {
    const w0 = await wallet(A.id);
    assert.ok(w0.bal < 35, `setup: A balance ${w0.bal}`);
    expectErr(await A.db.rpc('select_bid', { p_bid_id: bB.id }), 'insufficient_funds', 'balance 0');
    await topUpTo(A, 30); // still short of the 35 bid
    const w1 = await wallet(A.id);
    assert.ok(w1.bal < 35, `setup: A balance ${w1.bal}`);
    expectErr(await A.db.rpc('select_bid', { p_bid_id: bB.id }), 'insufficient_funds', `balance ${w1.bal}`);
    const w2 = await wallet(A.id);
    assert.deepEqual(w2, w1, 'wallet changed');
    assert.equal((await adminRows('transactions', { task_id: Te.id })).length, 0, 'transaction written');
    assert.equal((await adminRow('tasks', Te.id)).status, 'open');
    assert.equal((await adminRow('bids', bB.id)).status, 'pending');
  });

  test('select_bid: holds escrow, starts task, rejects others, opens chat, notifies', async () => {
    await topUpTo(A, 35);
    const w0 = await wallet(A.id);
    await rpcOk(A, 'select_bid', { p_bid_id: bB.id });
    const w1 = await wallet(A.id);
    assert.equal(w1.bal, money(w0.bal - 35), 'balance not reduced by 35');
    assert.equal(w1.held, money(w0.held + 35), 'held not increased by 35');
    const held = await adminRows('transactions', { task_id: Te.id, type: 'held' });
    assert.equal(held.length, 1);
    assert.equal(held[0].user_id, A.id);
    assert.equal(money(held[0].amount), 35);
    const t = await adminRow('tasks', Te.id);
    assert.equal(t.status, 'in_progress');
    assert.equal(t.selected_doer_id, B.id);
    assert.equal(t.selected_bid_id, bB.id);
    assert.equal((await adminRow('bids', bB.id)).status, 'selected');
    assert.equal((await adminRow('bids', bC.id)).status, 'rejected');
    const conv = await adminRows('conversations', { task_id: Te.id });
    assert.equal(conv.length, 1);
    assert.equal(conv[0].poster_id, A.id);
    assert.equal(conv[0].doer_id, B.id);
    assert.equal(conv[0].is_unlocked, true);
    assert.equal(money(conv[0].agreed_price), 35);
    assert.equal((await notifs(B.id, 'bid_selected', Te.id)).length, 1, 'doer not notified');
    assert.equal((await notifs(C.id, 'bid_rejected', Te.id)).length, 1, 'rejected bidder not notified');
  });

  test('select_bid: cannot select again once in progress', async () => {
    const w0 = await wallet(A.id);
    expectErr(await A.db.rpc('select_bid', { p_bid_id: bC.id }), 'task_not_open', 'select other bid');
    expectErr(await A.db.rpc('select_bid', { p_bid_id: bB.id }), 'task_not_open', 'select same bid');
    assert.deepEqual(await wallet(A.id), w0);
    assert.equal((await adminRows('transactions', { task_id: Te.id, type: 'held' })).length, 1);
  });

  test('in progress: no new bids, no withdrawing decided bids', async () => {
    expectErr(await H1.db.from('bids').insert({ task_id: Te.id, bidder_id: H1.id, amount: 10 }), 'bidding_closed', 'new bid');
    expectErr(await B.db.rpc('withdraw_bid', { p_bid_id: bB.id }), 'cannot_withdraw', 'selected bid');
    expectErr(await C.db.rpc('withdraw_bid', { p_bid_id: bC.id }), 'cannot_withdraw', 'rejected bid');
  });

  test('cancel_task: poster and outsiders cannot cancel an in-progress task', async () => {
    expectErr(await A.db.rpc('cancel_task', { p_task_id: Te.id }), 'cannot_cancel', 'poster');
    expectErr(await C.db.rpc('cancel_task', { p_task_id: Te.id }), 'cannot_cancel', 'rejected bidder');
    expectErr(await H1.db.rpc('cancel_task', { p_task_id: Te.id }), 'cannot_cancel', 'outsider');
    assert.equal((await adminRow('tasks', Te.id)).status, 'in_progress');
  });

  test('rate_task: not allowed before completion', async () => {
    expectErr(await A.db.rpc('rate_task', { p_task_id: Te.id, p_score: 5 }), 'task_not_completed', 'in progress');
  });

  test('complete_task: only the poster', async () => {
    expectErr(await B.db.rpc('complete_task', { p_task_id: Te.id }), 'not_your_task', 'doer');
    expectErr(await C.db.rpc('complete_task', { p_task_id: Te.id }), 'not_your_task', 'other');
    assert.equal((await adminRow('tasks', Te.id)).status, 'in_progress');
  });

  test('complete_task: only in_progress tasks', async () => {
    const open = await postTask(A);
    expectErr(await A.db.rpc('complete_task', { p_task_id: open.id }), 'task_not_in_progress', 'open task');
  });

  test('complete_task: releases escrow to the doer and counts the completion', async () => {
    const a0 = await wallet(A.id); const b0 = await wallet(B.id);
    const bp0 = await prof(B.id);
    await rpcOk(A, 'complete_task', { p_task_id: Te.id });
    const a1 = await wallet(A.id); const b1 = await wallet(B.id);
    assert.equal(a1.held, money(a0.held - 35), 'poster held');
    assert.equal(a1.bal, a0.bal, 'poster balance should not change');
    assert.equal(b1.bal, money(b0.bal + 35), 'doer balance');
    assert.equal((await prof(B.id)).tasks_completed, bp0.tasks_completed + 1, 'doer tasks_completed');
    const t = await adminRow('tasks', Te.id);
    assert.equal(t.status, 'completed');
    assert.ok(t.completed_at);
    const rel = await adminRows('transactions', { task_id: Te.id, type: 'released' });
    const rec = await adminRows('transactions', { task_id: Te.id, type: 'received' });
    assert.equal(rel.length, 1); assert.equal(rel[0].user_id, A.id); assert.equal(money(rel[0].amount), 35);
    assert.equal(rec.length, 1); assert.equal(rec[0].user_id, B.id); assert.equal(money(rec[0].amount), 35);
  });

  test('complete_task: cannot run twice', async () => {
    const a0 = await wallet(A.id); const b0 = await wallet(B.id);
    const tc0 = (await prof(B.id)).tasks_completed;
    expectErr(await A.db.rpc('complete_task', { p_task_id: Te.id }), 'task_not_in_progress', 'second complete');
    assert.deepEqual(await wallet(A.id), a0);
    assert.deepEqual(await wallet(B.id), b0);
    assert.equal((await prof(B.id)).tasks_completed, tc0);
    assert.equal((await adminRows('transactions', { task_id: Te.id, type: 'received' })).length, 1);
  });

  test('rate_task: only poster or selected doer', async () => {
    expectErr(await C.db.rpc('rate_task', { p_task_id: Te.id, p_score: 1 }), 'not_a_participant', 'rejected bidder');
    expectErr(await H1.db.rpc('rate_task', { p_task_id: Te.id, p_score: 1 }), 'not_a_participant', 'outsider');
  });

  test('rate_task: score must be 1..5', async () => {
    for (const s of [0, 6, -1, null]) {
      expectErr(await A.db.rpc('rate_task', { p_task_id: Te.id, p_score: s }), 'invalid_score', `score ${s}`);
    }
    assert.equal((await adminRows('ratings', { task_id: Te.id })).length, 0);
  });

  test('rate_task: each party rates the other; rating_avg/rating_count update', async () => {
    const b0 = await prof(B.id); const a0 = await prof(A.id);
    await rpcOk(A, 'rate_task', { p_task_id: Te.id, p_score: 4, p_comment: 'good job' });
    await rpcOk(B, 'rate_task', { p_task_id: Te.id, p_score: 5 });
    const rs = await adminRows('ratings', { task_id: Te.id });
    const byA = rs.find((r) => r.rater_id === A.id); const byB = rs.find((r) => r.rater_id === B.id);
    assert.equal(byA?.rated_id, B.id); assert.equal(byA?.score, 4);
    assert.equal(byB?.rated_id, A.id); assert.equal(byB?.score, 5);
    const b1 = await prof(B.id); const a1 = await prof(A.id);
    assert.equal(b1.rating_count, b0.rating_count + 1);
    assert.equal(a1.rating_count, a0.rating_count + 1);
    assert.equal(money(b1.rating_avg), 4);
    assert.equal(money(a1.rating_avg), 5);
  });

  test('rate_task: once per task per rater (already_rated)', async () => {
    const b0 = await prof(B.id);
    expectErr(await A.db.rpc('rate_task', { p_task_id: Te.id, p_score: 1 }), 'already_rated', 'poster again');
    expectErr(await B.db.rpc('rate_task', { p_task_id: Te.id, p_score: 1 }), 'already_rated', 'doer again');
    const b1 = await prof(B.id);
    assert.equal(b1.rating_count, b0.rating_count);
    assert.equal(money(b1.rating_avg), money(b0.rating_avg));
    assert.equal((await adminRows('ratings', { task_id: Te.id })).length, 2);
  });
});

// ================================================================ CANCEL
describe('cancel_task', () => {
  test('bidders and outsiders cannot cancel an open task', async () => {
    const t = await postTask(A);
    await placeBid(B, t.id, 10);
    expectErr(await B.db.rpc('cancel_task', { p_task_id: t.id }), 'cannot_cancel', 'bidder');
    expectErr(await H1.db.rpc('cancel_task', { p_task_id: t.id }), 'cannot_cancel', 'outsider');
    assert.equal((await adminRow('tasks', t.id)).status, 'open');
  });

  test('poster cancels an open task: pending bids rejected and bidders notified; not twice', async () => {
    const t = await postTask(A);
    const b1 = await placeBid(B, t.id, 10);
    const b2 = await placeBid(C, t.id, 12);
    await rpcOk(A, 'cancel_task', { p_task_id: t.id });
    assert.equal((await adminRow('tasks', t.id)).status, 'cancelled');
    assert.equal((await adminRow('bids', b1.id)).status, 'rejected');
    assert.equal((await adminRow('bids', b2.id)).status, 'rejected');
    assert.equal((await notifs(B.id, 'task_cancelled', t.id)).length, 1);
    assert.equal((await notifs(C.id, 'task_cancelled', t.id)).length, 1);
    expectErr(await A.db.rpc('cancel_task', { p_task_id: t.id }), 'cannot_cancel', 'second cancel');
  });

  test('in progress: only the selected doer may cancel; held escrow refunded to poster; not twice', async () => {
    const t = await postTask(A, { payment_method: 'escrow', price: 20 });
    const b = await placeBid(B, t.id, 20);
    await topUpTo(A, 20);
    await rpcOk(A, 'select_bid', { p_bid_id: b.id });
    expectErr(await A.db.rpc('cancel_task', { p_task_id: t.id }), 'cannot_cancel', 'poster cancels in_progress');
    expectErr(await C.db.rpc('cancel_task', { p_task_id: t.id }), 'cannot_cancel', 'outsider cancels in_progress');
    assert.equal((await adminRow('tasks', t.id)).status, 'in_progress');

    const a0 = await wallet(A.id);
    await rpcOk(B, 'cancel_task', { p_task_id: t.id });
    const a1 = await wallet(A.id);
    assert.equal(a1.bal, money(a0.bal + 20), 'poster balance not refunded');
    assert.equal(a1.held, money(a0.held - 20), 'poster held not reduced');
    const refunds = await adminRows('transactions', { task_id: t.id, type: 'refund' });
    assert.equal(refunds.length, 1); assert.equal(refunds[0].user_id, A.id); assert.equal(money(refunds[0].amount), 20);
    assert.equal((await adminRow('tasks', t.id)).status, 'cancelled');

    expectErr(await B.db.rpc('cancel_task', { p_task_id: t.id }), 'cannot_cancel', 'doer cancels twice');
    assert.deepEqual(await wallet(A.id), a1);
    assert.equal((await adminRows('transactions', { task_id: t.id, type: 'refund' })).length, 1);
  });
});

// ================================================================ CRON-DRIVEN STATES (selecting / expired)
// expire_tasks() moves tasks to 'selecting'/'expired'; the service role puts a
// task into that state here (setup), then the client actions are tested.
describe('selecting and expired tasks', () => {
  async function taskInState(status, extra = {}) {
    const t = await postTask(A);
    const bB = await placeBid(B, t.id, 10);
    const bC = await placeBid(C, t.id, 12);
    const past = new Date(Date.now() - 60e3).toISOString();
    const patch = { status, bidding_ends_at: past, ...extra };
    expectOk(await admin.from('tasks').update(patch).eq('id', t.id), `setup: task -> ${status}`);
    return { t, bB, bC };
  }
  const later = () => new Date(Date.now() + 3 * 3600e3).toISOString();

  test('selecting: no new bids; bidder may withdraw; poster may select', async () => {
    const { t, bB, bC } = await taskInState('selecting', { selection_ends_at: later() });
    expectErr(await H1.db.from('bids').insert({ task_id: t.id, bidder_id: H1.id, amount: 5 }), 'bidding_closed', 'new bid');
    await rpcOk(C, 'withdraw_bid', { p_bid_id: bC.id });
    assert.equal((await adminRow('bids', bC.id)).status, 'withdrawn');
    await rpcOk(A, 'select_bid', { p_bid_id: bB.id });
    const db = await adminRow('tasks', t.id);
    assert.equal(db.status, 'in_progress'); assert.equal(db.selected_doer_id, B.id);
  });

  test('selecting: poster may cancel; pending bids rejected', async () => {
    const { t, bB, bC } = await taskInState('selecting', { selection_ends_at: later() });
    expectErr(await B.db.rpc('cancel_task', { p_task_id: t.id }), 'cannot_cancel', 'bidder');
    await rpcOk(A, 'cancel_task', { p_task_id: t.id });
    assert.equal((await adminRow('tasks', t.id)).status, 'cancelled');
    assert.equal((await adminRow('bids', bB.id)).status, 'rejected');
    assert.equal((await adminRow('bids', bC.id)).status, 'rejected');
  });

  test('expired: cannot select, withdraw, cancel or complete', async () => {
    const { t, bB } = await taskInState('expired');
    expectErr(await A.db.rpc('select_bid', { p_bid_id: bB.id }), 'task_not_open', 'select');
    expectErr(await B.db.rpc('withdraw_bid', { p_bid_id: bB.id }), 'cannot_withdraw', 'withdraw');
    expectErr(await A.db.rpc('cancel_task', { p_task_id: t.id }), 'cannot_cancel', 'cancel');
    expectErr(await A.db.rpc('complete_task', { p_task_id: t.id }), 'task_not_in_progress', 'complete');
    assert.equal((await adminRow('tasks', t.id)).status, 'expired');
    assert.equal((await adminRow('bids', bB.id)).status, 'pending');
  });
});

// ================================================================ DEMO TOP-UP
describe('demo_top_up', () => {
  test('rejects amounts outside 5..500', async () => {
    const w0 = await wallet(C.id);
    for (const a of [4.99, 500.01, 0, -10, null]) {
      expectErr(await C.db.rpc('demo_top_up', { p_amount: a }), 'invalid_amount', `amount ${a}`);
    }
    assert.deepEqual(await wallet(C.id), w0);
    assert.equal((await adminRows('transactions', { user_id: C.id, type: 'deposit' })).length, 0);
  });

  test('adds credits, returns the balance and writes a deposit transaction', async () => {
    const w0 = await wallet(C.id);
    const ret = await rpcOk(C, 'demo_top_up', { p_amount: 5 });
    assert.equal(money(ret), money(w0.bal + 5));
    assert.equal((await wallet(C.id)).bal, money(w0.bal + 5));
    const deps = await adminRows('transactions', { user_id: C.id, type: 'deposit' });
    assert.equal(deps.length, 1); assert.equal(money(deps[0].amount), 5);
  });

  test('balance is capped at 5000 (wallet_limit)', async () => {
    let bal = (await wallet(C.id)).bal;
    while (money(bal + 500) <= 5000) bal = money(await rpcOk(C, 'demo_top_up', { p_amount: 500 }));
    if (money(5000 - bal) >= 5) bal = money(await rpcOk(C, 'demo_top_up', { p_amount: money(5000 - bal) }));
    const deps0 = (await adminRows('transactions', { user_id: C.id, type: 'deposit' })).length;
    expectErr(await C.db.rpc('demo_top_up', { p_amount: 5 }), 'wallet_limit', 'over cap');
    const w = await wallet(C.id);
    assert.ok(w.bal <= 5000, `balance ${w.bal} over cap`);
    assert.equal(w.bal, bal);
    assert.equal((await adminRows('transactions', { user_id: C.id, type: 'deposit' })).length, deps0);
  });
});

// ================================================================ RPC PRIVILEGES
describe('rpc privileges', () => {
  const someId = crypto.randomUUID();
  const RPCS = {
    get_my_profile: {}, select_bid: { p_bid_id: someId }, complete_task: { p_task_id: someId },
    cancel_task: { p_task_id: someId }, withdraw_bid: { p_bid_id: someId },
    rate_task: { p_task_id: someId, p_score: 5 }, demo_top_up: { p_amount: 10 },
  };
  for (const [fn, args] of Object.entries(RPCS)) {
    test(`anon cannot call ${fn}`, async () => {
      expectErr(await anon.rpc(fn, args), PRIV, `anon ${fn}`);
    });
  }

  const internal = () => ({
    expire_tasks: {},
    qt_notify: { p_user: B.id, p_type: 'qa', p_title: `qa-injected-${RUN}`, p_data: {} },
    increment_tasks_posted: { user_id: A.id },
    get_user_stats: { p_user_id: A.id },
  });
  for (const fn of ['expire_tasks', 'qt_notify', 'increment_tasks_posted', 'get_user_stats']) {
    test(`internal function ${fn} is not callable by authenticated or anon`, async () => {
      const posted0 = (await prof(A.id)).tasks_posted;
      const args = internal()[fn];
      expectErr(await A.db.rpc(fn, args), PRIV, `authenticated ${fn}`);
      expectErr(await anon.rpc(fn, args), PRIV, `anon ${fn}`);
      assert.equal((await prof(A.id)).tasks_posted, posted0, 'tasks_posted changed');
      assert.equal((await adminRows('notifications', { title: `qa-injected-${RUN}` })).length, 0, 'notification injected');
    });
  }
});

// ================================================================ CONVERSATIONS / MESSAGES
describe('conversations and messages', () => {
  let Tm; let conv; let locked; let msgA;

  before(async () => {
    Tm = await postTask(A, { payment_method: 'cash', price: 10 });
    const b = await placeBid(B, Tm.id, 10);
    await rpcOk(A, 'select_bid', { p_bid_id: b.id });
    [conv] = await adminRows('conversations', { task_id: Tm.id });
    // A locked conversation can only exist via the server; create one for the test.
    const Tl = await postTask(A);
    const r = await admin.from('conversations').insert({ task_id: Tl.id, poster_id: A.id, doer_id: C.id, is_unlocked: false }).select().single();
    locked = expectOk(r, 'setup: locked conversation');
  });

  test('select_bid created an unlocked conversation', () => {
    assert.ok(conv, 'no conversation');
    assert.equal(conv.is_unlocked, true);
  });

  test('only participants can read a conversation', async () => {
    assert.equal(expectOk(await A.db.from('conversations').select('id').eq('id', conv.id), 'A').length, 1);
    assert.equal(expectOk(await B.db.from('conversations').select('id').eq('id', conv.id), 'B').length, 1);
    assert.equal(expectOk(await C.db.from('conversations').select('id').eq('id', conv.id), 'C').length, 0, 'outsider reads conversation');
    const r = await anon.from('conversations').select('id').eq('id', conv.id);
    assert.ok(r.error || r.data.length === 0, 'anon reads conversation');
  });

  test('no client INSERT on conversations', async () => {
    const n0 = (await adminRows('conversations', { poster_id: A.id })).length;
    // combinations that don't exist yet, so a unique-key error can't mask the result
    expectErr(await C.db.from('conversations').insert({ task_id: Tm.id, poster_id: A.id, doer_id: C.id, is_unlocked: true }), DENIED, 'bidder inserts');
    expectErr(await A.db.from('conversations').insert({ task_id: locked.task_id, poster_id: A.id, doer_id: B.id, is_unlocked: true }), DENIED, 'poster inserts');
    assert.equal((await adminRows('conversations', { poster_id: A.id })).length, n0);
  });

  test('no client UPDATE or DELETE on conversations', async () => {
    expectErr(await A.db.from('conversations').update({ is_unlocked: false }).eq('id', conv.id), PRIV, 'poster locks');
    expectErr(await B.db.from('conversations').update({ agreed_price: 1 }).eq('id', conv.id), PRIV, 'doer changes price');
    expectErr(await C.db.from('conversations').update({ is_unlocked: true }).eq('id', locked.id), PRIV, 'doer unlocks locked conv');
    expectErr(await A.db.from('conversations').delete().eq('id', conv.id), PRIV, 'poster deletes');
    const c = await adminRow('conversations', conv.id);
    assert.equal(c.is_unlocked, true); assert.equal(money(c.agreed_price), 10);
    assert.equal((await adminRow('conversations', locked.id)).is_unlocked, false);
  });

  test('participant can send a message as themselves', async () => {
    const r = await A.db.from('messages').insert({ conversation_id: conv.id, sender_id: A.id, content: 'hello from A' }).select().single();
    msgA = expectOk(r, 'A sends');
    assert.equal(msgA.is_read, false);
  });

  test('cannot send as someone else', async () => {
    expectErr(await A.db.from('messages').insert({ conversation_id: conv.id, sender_id: B.id, content: 'forged' }), DENIED, 'A as B');
    assert.equal((await adminRows('messages', { conversation_id: conv.id, content: 'forged' })).length, 0);
  });

  test('non-participant cannot send', async () => {
    expectErr(await C.db.from('messages').insert({ conversation_id: conv.id, sender_id: C.id, content: 'intruder' }), DENIED, 'C sends');
    assert.equal((await adminRows('messages', { conversation_id: conv.id, content: 'intruder' })).length, 0);
  });

  test('cannot set is_read on insert', async () => {
    expectErr(await B.db.from('messages').insert({ conversation_id: conv.id, sender_id: B.id, content: 'pre-read', is_read: true }), PRIV, 'is_read on insert');
  });

  test('cannot send into a locked conversation', async () => {
    expectErr(await A.db.from('messages').insert({ conversation_id: locked.id, sender_id: A.id, content: 'locked' }), DENIED, 'poster');
    expectErr(await C.db.from('messages').insert({ conversation_id: locked.id, sender_id: C.id, content: 'locked' }), DENIED, 'doer');
    assert.equal((await adminRows('messages', { conversation_id: locked.id })).length, 0);
  });

  test('content must be 1..2000 chars', async () => {
    expectErr(await A.db.from('messages').insert({ conversation_id: conv.id, sender_id: A.id, content: '' }), CHECK, 'empty');
    expectErr(await A.db.from('messages').insert({ conversation_id: conv.id, sender_id: A.id, content: 'x'.repeat(2001) }), CHECK, '2001');
    expectOk(await A.db.from('messages').insert({ conversation_id: conv.id, sender_id: A.id, content: 'y'.repeat(2000) }), '2000 chars');
  });

  test('cannot edit or delete message content', async () => {
    expectErr(await A.db.from('messages').update({ content: 'edited' }).eq('id', msgA.id), PRIV, 'sender edits');
    expectErr(await B.db.from('messages').update({ content: 'edited' }).eq('id', msgA.id), PRIV, 'recipient edits');
    expectErr(await A.db.from('messages').update({ sender_id: B.id }).eq('id', msgA.id), PRIV, 'sender changes sender_id');
    expectErr(await A.db.from('messages').delete().eq('id', msgA.id), PRIV, 'sender deletes');
    const m = await adminRow('messages', msgA.id);
    assert.equal(m.content, 'hello from A'); assert.equal(m.sender_id, A.id);
  });

  test('sender and outsiders cannot mark a message read', async () => {
    await A.db.from('messages').update({ is_read: true }).eq('id', msgA.id);
    assert.equal((await adminRow('messages', msgA.id)).is_read, false, 'sender marked own message read');
    await C.db.from('messages').update({ is_read: true }).eq('id', msgA.id);
    assert.equal((await adminRow('messages', msgA.id)).is_read, false, 'outsider marked message read');
  });

  test('recipient can mark a message read', async () => {
    expectOk(await B.db.from('messages').update({ is_read: true }).eq('id', msgA.id), 'recipient marks read');
    assert.equal((await adminRow('messages', msgA.id)).is_read, true);
  });

  test('non-participants cannot read messages', async () => {
    assert.ok(expectOk(await B.db.from('messages').select('id').eq('conversation_id', conv.id), 'B').length >= 1);
    assert.equal(expectOk(await C.db.from('messages').select('id').eq('conversation_id', conv.id), 'C').length, 0, 'outsider reads messages');
    assert.equal(expectOk(await C.db.from('messages').select('id').eq('id', msgA.id), 'C by id').length, 0);
    const r = await anon.from('messages').select('id').eq('conversation_id', conv.id);
    assert.ok(r.error || r.data.length === 0, 'anon reads messages');
  });
});

// ================================================================ RATINGS / TRANSACTIONS / NOTIFICATIONS
describe('ratings, transactions, notifications', () => {
  test('no direct client INSERT on ratings', async () => {
    const t = (await adminRows('tasks', { poster_id: A.id, status: 'completed' }))[0];
    const taskId = t?.id ?? crypto.randomUUID();
    const n0 = (await adminRows('ratings', { rated_id: B.id })).length;
    expectErr(await A.db.from('ratings').insert({ task_id: taskId, rater_id: A.id, rated_id: B.id, score: 1 }), DENIED, 'A inserts rating');
    expectErr(await C.db.from('ratings').insert({ task_id: taskId, rater_id: C.id, rated_id: B.id, score: 1 }), DENIED, 'C inserts rating');
    assert.equal((await adminRows('ratings', { rated_id: B.id })).length, n0);
  });

  test('no direct client INSERT on transactions', async () => {
    const w0 = await wallet(A.id);
    const n0 = (await adminRows('transactions', { user_id: A.id })).length;
    expectErr(await A.db.from('transactions').insert({ user_id: A.id, type: 'deposit', amount: 1000 }), DENIED, 'own');
    expectErr(await A.db.from('transactions').insert({ user_id: B.id, type: 'received', amount: 1000 }), DENIED, 'for B');
    assert.equal((await adminRows('transactions', { user_id: A.id })).length, n0);
    assert.deepEqual(await wallet(A.id), w0);
  });

  test('transactions readable only by owner', async () => {
    const own = expectOk(await A.db.from('transactions').select('id,user_id'), 'A own');
    assert.ok(own.length >= 1, 'A sees none of own transactions');
    assert.ok(own.every((r) => r.user_id === A.id), 'A sees other users\' transactions');
    assert.equal(expectOk(await C.db.from('transactions').select('id').eq('user_id', A.id), 'C reads A').length, 0);
    const r = await anon.from('transactions').select('id').limit(5);
    assert.ok(r.error || r.data.length === 0, 'anon reads transactions');
  });

  test('notifications readable only by owner', async () => {
    const own = expectOk(await A.db.from('notifications').select('id,user_id'), 'A own');
    assert.ok(own.length >= 1);
    assert.ok(own.every((n) => n.user_id === A.id), 'A sees other users\' notifications');
    assert.equal(expectOk(await B.db.from('notifications').select('id').eq('user_id', A.id), 'B reads A').length, 0);
    const r = await anon.from('notifications').select('id').limit(5);
    assert.ok(r.error || r.data.length === 0, 'anon reads notifications');
  });

  test('client cannot insert notifications', async () => {
    expectErr(await A.db.from('notifications').insert({ user_id: B.id, type: 'qa', title: `qa-fake-${RUN}` }), DENIED, 'for B');
    expectErr(await A.db.from('notifications').insert({ user_id: A.id, type: 'qa', title: `qa-fake-${RUN}` }), DENIED, 'for self');
    assert.equal((await adminRows('notifications', { title: `qa-fake-${RUN}` })).length, 0);
  });

  test('owner can mark own notification read but change nothing else', async () => {
    const [n] = await adminRows('notifications', { user_id: A.id, is_read: false });
    assert.ok(n, 'setup: A has an unread notification');
    expectOk(await A.db.from('notifications').update({ is_read: true }).eq('id', n.id), 'mark read');
    assert.equal((await adminRow('notifications', n.id)).is_read, true);
    expectErr(await A.db.from('notifications').update({ title: 'changed' }).eq('id', n.id), PRIV, 'title');
    expectErr(await A.db.from('notifications').update({ user_id: B.id }).eq('id', n.id), PRIV, 'user_id');
    expectErr(await A.db.from('notifications').update({ data: { x: 1 } }).eq('id', n.id), PRIV, 'data');
    const after0 = await adminRow('notifications', n.id);
    assert.equal(after0.title, n.title); assert.equal(after0.user_id, A.id);
  });

  test('cannot mark or delete another user\'s notifications', async () => {
    const [n] = await adminRows('notifications', { user_id: A.id, is_read: false });
    assert.ok(n, 'setup: A has another unread notification');
    await B.db.from('notifications').update({ is_read: true }).eq('id', n.id);
    assert.equal((await adminRow('notifications', n.id)).is_read, false, 'B marked A\'s notification');
    expectErr(await B.db.from('notifications').delete().eq('id', n.id), PRIV, 'B deletes');
    assert.ok(await adminRow('notifications', n.id));
  });
});

// ================================================================ STORAGE
describe('storage: task-photos bucket', () => {
  test('signed-in user can upload an image into own folder', async () => {
    const path = `${A.id}/qa-${RUN}-own.jpg`;
    expectOk(await upload(A.db, path), 'upload own');
    assert.ok(await objectExists(path));
  });

  test('cannot upload into another user\'s folder', async () => {
    const path = `${B.id}/qa-${RUN}-intrude.jpg`;
    expectErr(await upload(A.db, path), undefined, 'A into B folder');
    assert.equal(await objectExists(path), false, 'object was created');
  });

  test('cannot upload into the bucket root', async () => {
    const path = `qa-${RUN}-root.jpg`;
    expectErr(await upload(A.db, path), undefined, 'root');
    assert.equal(await objectExists(path), false, 'object was created');
  });

  for (const [ext, type] of [['txt', 'text/plain'], ['html', 'text/html'], ['svg', 'image/svg+xml'], ['pdf', 'application/pdf']]) {
    test(`rejects non-image mime type ${type}`, async () => {
      const path = `${A.id}/qa-${RUN}-bad.${ext}`;
      expectErr(await upload(A.db, path, Buffer.from('<b>qa</b>'), { contentType: type }), undefined, type);
      assert.equal(await objectExists(path), false, 'object was created');
    });
  }

  test('anon cannot upload', async () => {
    const path = `${A.id}/qa-${RUN}-anon.jpg`;
    expectErr(await upload(anon, path), undefined, 'anon');
    assert.equal(await objectExists(path), false);
  });

  test('cannot move or copy an own file into another user\'s folder or the root', async () => {
    const src = `${A.id}/qa-${RUN}-src.jpg`;
    expectOk(await upload(A.db, src), 'upload source');
    const targets = [`${B.id}/qa-${RUN}-moved.jpg`, `${B.id}/qa-${RUN}-copied.jpg`, `qa-${RUN}-copied-root.jpg`];
    targets.forEach((p) => storagePaths.add(p));
    expectErr(await A.db.storage.from(BUCKET).move(src, targets[0]), undefined, 'move into B folder');
    expectErr(await A.db.storage.from(BUCKET).copy(src, targets[1]), undefined, 'copy into B folder');
    expectErr(await A.db.storage.from(BUCKET).copy(src, targets[2]), undefined, 'copy into root');
    for (const p of targets) assert.equal(await objectExists(p), false, `${p} was created`);
    assert.ok(await objectExists(src), 'source vanished');
  });

  test('cannot overwrite or delete another user\'s file', async () => {
    const path = `${B.id}/qa-${RUN}-b.jpg`;
    expectOk(await upload(B.db, path), 'B uploads own');
    expectErr(await upload(A.db, path, JPEG, { contentType: 'image/jpeg', upsert: true }), undefined, 'A overwrites B file');
    await A.db.storage.from(BUCKET).remove([path]);
    assert.ok(await objectExists(path), 'A deleted B\'s file');
  });
});

// ================================================================ HAPPY PATH
describe('happy path: escrow task end to end', () => {
  let task; let theBid; let conv;
  const bal = async (u) => { const p = await myProfile(u); return { bal: money(p.wallet_balance), held: money(p.wallet_held) }; };
  const check = async (u, exp, label) => {
    assert.deepEqual(await bal(u), exp, `${label} (via get_my_profile)`);
    assert.deepEqual(await wallet(u.id), exp, `${label} (db)`);
  };

  test('1. poster tops up 100', async () => {
    await check(H1, { bal: 0, held: 0 }, 'H1 start');
    assert.equal(money(await rpcOk(H1, 'demo_top_up', { p_amount: 100 })), 100);
    await check(H1, { bal: 100, held: 0 }, 'H1 after top-up');
    await check(H2, { bal: 0, held: 0 }, 'H2 start');
  });

  test('2. poster posts an escrow task, price 40', async () => {
    task = await postTask(H1, { payment_method: 'escrow', bidding_type: 'price', price: 40, title: `QA ${RUN} happy path` });
    assert.equal(task.status, 'open');
    assert.equal(task.poster_id, H1.id);
    await check(H1, { bal: 100, held: 0 }, 'H1 after posting');
  });

  test('3. doer bids 35', async () => {
    theBid = await placeBid(H2, task.id, 35);
    assert.equal(theBid.status, 'pending');
    assert.equal(money(theBid.amount), 35);
    await check(H1, { bal: 100, held: 0 }, 'H1 after bid');
  });

  test('4. poster selects the bid: 35 held', async () => {
    await rpcOk(H1, 'select_bid', { p_bid_id: theBid.id });
    await check(H1, { bal: 65, held: 35 }, 'H1 after select');
    await check(H2, { bal: 0, held: 0 }, 'H2 after select');
    const t = await adminRow('tasks', task.id);
    assert.equal(t.status, 'in_progress'); assert.equal(t.selected_doer_id, H2.id);
  });

  test('5. they exchange messages', async () => {
    const cs = expectOk(await H2.db.from('conversations').select('*').eq('task_id', task.id), 'H2 reads conversation');
    assert.equal(cs.length, 1);
    conv = cs[0];
    assert.equal(conv.is_unlocked, true);
    const m1 = expectOk(await H1.db.from('messages').insert({ conversation_id: conv.id, sender_id: H1.id, content: 'Hi, when can you start?' }).select().single(), 'H1 sends');
    expectOk(await H2.db.from('messages').insert({ conversation_id: conv.id, sender_id: H2.id, content: 'Tomorrow morning.' }).select().single(), 'H2 replies');
    expectOk(await H2.db.from('messages').update({ is_read: true }).eq('id', m1.id), 'H2 reads');
    const seen1 = expectOk(await H1.db.from('messages').select('content,sender_id,is_read').eq('conversation_id', conv.id).order('created_at'), 'H1 lists');
    const seen2 = expectOk(await H2.db.from('messages').select('content,sender_id,is_read').eq('conversation_id', conv.id).order('created_at'), 'H2 lists');
    assert.equal(seen1.length, 2); assert.equal(seen2.length, 2);
    assert.equal(seen1[0].is_read, true);
  });

  test('6. poster completes: 35 released to doer', async () => {
    await rpcOk(H1, 'complete_task', { p_task_id: task.id });
    await check(H1, { bal: 65, held: 0 }, 'H1 after complete');
    await check(H2, { bal: 35, held: 0 }, 'H2 after complete');
    assert.equal((await prof(H2.id)).tasks_completed, 1);
    const h1tx = expectOk(await H1.db.from('transactions').select('type,amount').order('created_at'), 'H1 txns');
    const h2tx = expectOk(await H2.db.from('transactions').select('type,amount').order('created_at'), 'H2 txns');
    assert.deepEqual(h1tx.map((t) => `${t.type}:${money(t.amount)}`).sort(), ['deposit:100', 'held:35', 'released:35'].sort());
    assert.deepEqual(h2tx.map((t) => `${t.type}:${money(t.amount)}`), ['received:35']);
  });

  test('7. both rate each other', async () => {
    await rpcOk(H1, 'rate_task', { p_task_id: task.id, p_score: 5, p_comment: 'Great work' });
    await rpcOk(H2, 'rate_task', { p_task_id: task.id, p_score: 4, p_comment: 'Clear instructions' });
    const p1 = await prof(H1.id); const p2 = await prof(H2.id);
    assert.equal(p2.rating_count, 1); assert.equal(money(p2.rating_avg), 5);
    assert.equal(p1.rating_count, 1); assert.equal(money(p1.rating_avg), 4);
    await check(H1, { bal: 65, held: 0 }, 'H1 final');
    await check(H2, { bal: 35, held: 0 }, 'H2 final');
  });
});

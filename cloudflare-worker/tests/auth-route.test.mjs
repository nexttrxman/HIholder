/**
 * Tests de ruta de /auth con Supabase mockeado.
 *
 * Run with: node --test tests/auth-route.test.mjs
 *
 * Los tests de lib.js no alcanzan: el bug de produccion del deploy 3.6 fue un
 * `claimState` fuera de scope DENTRO de handleAuth (ReferenceError -> 500
 * "Internal server error" en cada login). Solo se caza ejercitando el handler
 * completo contra un REST fake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker.js';
import { CONFIG } from '../lib.js';

const BOT_TOKEN = '123456789:TESTTOKENTESTTOKENTESTTOKEN';
const ENV = {
  BOT_TOKEN,
  SUPA_URL: 'https://fake.supabase.co',
  SUPA_SERVICE_KEY: 'fake-key',
};

/** Firma un initData exactamente como lo hace Telegram (igual que auth.test). */
async function signInitData(fields, botToken = BOT_TOKEN) {
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const enc = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    'raw', enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const secret = await crypto.subtle.sign('HMAC', secretKey, enc.encode(botToken));
  const dataKey = await crypto.subtle.importKey(
    'raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', dataKey, enc.encode(dataCheckString));
  const hash = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');

  const qs = new URLSearchParams(fields);
  qs.set('hash', hash);
  return qs.toString();
}

const TG_ID = '777000111';
const initData = () => signInitData({
  query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
  user: JSON.stringify({ id: Number(TG_ID), first_name: 'Ana', username: 'ana' }),
  auth_date: String(Math.floor(Date.now() / 1000)),
  chat_type: 'private',
  chat_instance: '888',
});

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * REST fake minimo: GET filtra por los `eq.` de la querystring, PATCH aplica
 * el body y guarda la llamada, POST registra el insert.
 */
function fakeSupabase(rows) {
  const calls = [];
  const state = { ...rows };

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;

    if (u.pathname.includes('/rpc/')) return json({ ok: true });

    if (method === 'GET') {
      let out = [...(state[table] || [])];
      for (const [key, value] of u.searchParams.entries()) {
        if (key === 'order' || key === 'limit' || key === 'select') continue;
        const want = String(value).replace(/^eq\./, '');
        out = out.filter((r) => String(r[key]) === want);
      }
      if (u.searchParams.get('order') === 'created_at.desc') {
        out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      }
      const limit = Number(u.searchParams.get('limit'));
      if (limit) out = out.slice(0, limit);
      return json(out);
    }

    if (method === 'PATCH') {
      calls.push({ table, body });
      const updated = [];
      for (const row of state[table] || []) {
        const match = [...u.searchParams.entries()].every(([k, v]) => String(row[k]) === String(v).replace(/^eq\./, ''));
        if (match) { Object.assign(row, body); updated.push(row); }
      }
      return json(updated);
    }

    // POST (insert)
    calls.push({ table, body, insert: true });
    state[table] = [...(state[table] || []), body];
    return json([body]);
  };

  return { fetchImpl, calls, state };
}

const postAuth = async (fake) => {
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl;
  try {
    const res = await worker.fetch(
      new Request('https://api.test/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: await initData() }),
      }),
      ENV
    );
    return { status: res.status, body: await res.json() };
  } finally {
    globalThis.fetch = original;
  }
};

const user = () => ({ telegram_id: TG_ID, uid: `TK${TG_ID}`, username: 'ana' });
const wallet = () => ({ user_id: TG_ID, usdt_balance: '1.00', trx_balance: '1.00', ton_balance: '0', keep_balance: '0' });

test('/auth con claim vencido: 200, ciclo en cooldown 8 h y claim forfeited (bug del 3.6)', async () => {
  const now = Date.now();
  const fake = fakeSupabase({
    users: [user()],
    internal_wallets: [wallet()],
    hold_cycles: [{
      id: 'cyc-1', user_id: TG_ID, status: 'active', holds_completed: 3,
      created_at: new Date(now - 3600000).toISOString(),
      ends_at: new Date(now + 5 * 3600000).toISOString(),
    }],
    claims: [{
      claim_id: 'CLM_OLD', user_id: TG_ID, cycle_id: 'cyc-1', status: 'pending',
      total_prize: '0.60', ton_fee: '0.05',
      expires_at: new Date(now - 5 * 60000).toISOString(),
    }],
    referrals: [],
  });

  const { status, body } = await postAuth(fake);

  assert.equal(status, 200, 'el ReferenceError de claimState devolvía 500 acá');
  assert.equal(body.ok, true);
  assert.equal(body.pending_claim, null, 'el claim vencido no se ofrece');
  assert.equal(body.cycle.holds_completed, 3, 'los holds se quedan en 3/3');

  const claimPatch = fake.calls.find((c) => c.table === 'claims');
  assert.equal(claimPatch.body.status, 'expired_unclaimed');

  const cyclePatch = fake.calls.find((c) => c.table === 'hold_cycles');
  assert.equal(cyclePatch.body.status, 'expired');
  const hours = (new Date(cyclePatch.body.ends_at).getTime() - now) / 3600000;
  assert.ok(hours > 7.9 && hours <= 8.01, `cooldown debe ser 8 h, dio ${hours}`);

  const endsAt = new Date(body.cycle.ends_at).getTime();
  assert.ok(endsAt > now + 7.9 * 3600000, 'la respuesta refleja el cooldown');
  assert.equal(body.cycle.remaining_holds, 0);
});

test('/auth con claim vivo: lo devuelve y no toca nada', async () => {
  const now = Date.now();
  const fake = fakeSupabase({
    users: [user()],
    internal_wallets: [wallet()],
    hold_cycles: [{
      id: 'cyc-1', user_id: TG_ID, status: 'active', holds_completed: 3,
      created_at: new Date(now - 3600000).toISOString(),
      ends_at: new Date(now + 5 * 3600000).toISOString(),
    }],
    claims: [{
      claim_id: 'CLM_LIVE', user_id: TG_ID, cycle_id: 'cyc-1', status: 'pending',
      total_prize: '0.60', ton_fee: '0.05',
      expires_at: new Date(now + 10 * 60000).toISOString(),
    }],
    referrals: [],
  });

  const { status, body } = await postAuth(fake);

  assert.equal(status, 200);
  assert.equal(body.pending_claim.claim_id, 'CLM_LIVE');
  assert.equal(fake.calls.length, 0, 'un claim vivo no se parcha');
});

test('/auth sin ciclos: crea usuario, wallet y ciclo nuevos', async () => {
  const fake = fakeSupabase({ referrals: [] });

  const { status, body } = await postAuth(fake);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.user.trx_balance, CONFIG.SIGNUP_TRX_BONUS);
  assert.equal(body.cycle.holds_completed, 0);
  assert.equal(body.cycle.remaining_holds, CONFIG.MAX_HOLDS_PER_CYCLE);
  assert.ok(fake.calls.some((c) => c.table === 'internal_wallets' && c.insert));
});

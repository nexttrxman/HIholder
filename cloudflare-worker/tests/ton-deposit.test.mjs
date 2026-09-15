/**
 * TON MEMO deposit helpers and cron route regression tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker, { runTonDepositSweep } from '../worker.js';
import {
  CONFIG,
  decodeTonComment,
  generateDepositCode,
  isValidDepositCode,
} from '../lib.js';

const ENV = {
  SUPA_URL: 'https://fake.supabase.co',
  SUPA_SERVICE_KEY: 'service-key',
  TON_API_KEY: 'ton-key',
};

function tx({
  hash,
  comment,
  valueNano = 100_000_000,
  source = '0:sender',
  destination = CONFIG.TREASURY_WALLET,
  utime = 1_700_000_000,
}) {
  const payload = Buffer.concat([
    Buffer.alloc(4, 0),
    Buffer.from(comment, 'utf8'),
  ]).toString('base64');
  return {
    transaction_id: { hash },
    utime,
    in_msg: {
      source,
      destination,
      value: String(valueNano),
      msg_data: { text: payload },
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('deposit codes are uppercase DEP plus six characters', () => {
  const code = generateDepositCode();
  assert.match(code, /^DEP:[A-Z0-9]{6}$/);
  assert.equal(isValidDepositCode(code), true);
  assert.equal(isValidDepositCode('DEP:abc123'), false);
  assert.equal(isValidDepositCode('CLAIM:ABC'), false);
});

test('scheduled sweep credits a matching code, stores unmatched evidence, and skips CLAIM comments', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'toncenter.com') {
      return json({
        ok: true,
        result: [
          tx({ hash: 'hash-claim', comment: 'CLAIM:CLM_1' }),
          tx({ hash: 'hash-match', comment: 'DEP:ABC234', valueNano: 250_000_000 }),
          tx({ hash: 'hash-no-code', comment: 'DEP:WRONG1' }),
          tx({ hash: 'hash-outbound', comment: 'DEP:ABC234', destination: '0:someone-else' }),
          tx({ hash: 'hash-empty', comment: '' }),
        ],
      });
    }

    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (parsed.pathname.endsWith('/deposit_codes')) {
      return parsed.searchParams.get('code') === 'eq.DEP:ABC234'
        ? json([{ user_id: 'user-1', code: 'DEP:ABC234' }])
        : json([]);
    }
    if (parsed.pathname.endsWith('/unmatched_deposits')) {
      if (init.method === 'GET') return json([]);
      return json([JSON.parse(init.body)]);
    }
    if (parsed.pathname.endsWith('/rpc/credit_ton_deposit')) {
      return json({ ok: true, already_credited: false });
    }
    throw new Error(`unexpected fake request ${url}`);
  };

  try {
    const result = await runTonDepositSweep(ENV);
    assert.deepEqual(result, {
      scanned: 4,
      credited: 1,
      unmatched: 2,
      skipped_claims: 1,
      errors: 0,
    });

    const rpc = calls.find((c) => c.url.includes('/rpc/credit_ton_deposit'));
    assert.equal(rpc.body.p_user_id, 'user-1');
    assert.equal(rpc.body.p_comment, 'DEP:ABC234');
    assert.equal(rpc.body.p_amount, 0.25);

    const unmatched = calls.filter((c) => c.url.endsWith('/unmatched_deposits?on_conflict=tx_hash'));
    assert.equal(unmatched.length, 2);
    assert.equal(unmatched.some((c) => c.body.tx_hash === 'hash-claim'), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('POST /verify-deposit was removed', async () => {
  const response = await worker.fetch(new Request('https://api.example/verify-deposit', {
    method: 'POST',
    body: '{}',
  }), ENV);
  assert.equal(response.status, 404);
});

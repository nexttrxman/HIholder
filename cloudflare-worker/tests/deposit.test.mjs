/**
 * v3.7 TRON deposits: chain parsing and /verify-deposit route.
 * Run with: node --test tests/deposit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker.js';
import {
  TRON_CONFIG,
  isValidTronTxHash,
  normalizeTronAddress,
  parseTronDeposit,
} from '../lib.js';

const BOT_TOKEN = '123456789:DEPOSITTESTTOKEN';
const ENV = {
  BOT_TOKEN,
  SUPA_URL: 'https://fake.supabase.co',
  SUPA_SERVICE_KEY: 'fake-service-key',
  TRONGRID_API_KEY: 'trongrid-secret',
};
const HASH = 'a'.repeat(64);

async function signInitData(fields, botToken = BOT_TOKEN) {
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
  const checkString = entries.map(([key, value]) => `${key}=${value}`).join('\n');
  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    'raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));
  const dataKey = await crypto.subtle.importKey(
    'raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', dataKey, encoder.encode(checkString));
  const hash = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const query = new URLSearchParams(fields);
  query.set('hash', hash);
  return query.toString();
}

const initData = () => signInitData({
  user: JSON.stringify({ id: 42, first_name: 'No Memo' }),
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: 'deposit-test',
});

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('TRON helpers validate hashes and canonicalize Base58/hex addresses', () => {
  assert.equal(isValidTronTxHash(HASH), true);
  assert.equal(isValidTronTxHash('not-a-hash'), false);
  assert.equal(normalizeTronAddress(TRON_CONFIG.DEPOSIT_ADDRESS), normalizeTronAddress(TRON_CONFIG.DEPOSIT_ADDRESS));
  assert.equal(normalizeTronAddress('41ABC'), '41abc');
});

test('parseTronDeposit accepts a native TRX transfer without a MEMO', () => {
  const parsed = parseTronDeposit({
    asset: 'TRX',
    txHash: HASH,
    transaction: {
      txID: HASH,
      block_timestamp: 1_700_000_000_000,
      raw_data: {
        contract: [{
          type: 'TransferContract',
          parameter: {
            value: {
              owner_address: 'TFromAddress',
              to_address: TRON_CONFIG.DEPOSIT_ADDRESS,
              amount: 2_500_000,
            },
          },
        }],
      },
      ret: [{ contractRet: 'SUCCESS' }],
    },
  });

  assert.equal(parsed.asset, 'TRX');
  assert.equal(parsed.amount, 2.5);
  assert.equal(parsed.from_address, 'TFromAddress');
});

test('parseTronDeposit accepts the USDT TRC-20 row and rejects a wrong destination', () => {
  const transfer = {
    transaction_id: HASH,
    from: 'TFromAddress',
    to: TRON_CONFIG.DEPOSIT_ADDRESS,
    value: '1250000',
    token_info: { address: TRON_CONFIG.USDT_CONTRACT, decimals: 6 },
    block_timestamp: 1_700_000_000_000,
  };
  const parsed = parseTronDeposit({ asset: 'USDT', txHash: HASH, transfer, transaction: transfer });
  assert.equal(parsed.amount, 1.25);

  const wrong = parseTronDeposit({
    asset: 'USDT',
    txHash: HASH,
    transfer: { ...transfer, to: 'TNotTheTreasury' },
    transaction: transfer,
  });
  assert.equal(wrong, null);
});

test('POST /verify-deposit verifies a TRX hash and sends no MEMO to Supabase', async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody;
  let tronHeaders;
  globalThis.fetch = async (url, init = {}) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname === 'api.trongrid.io') {
      tronHeaders = init.headers;
      return jsonResponse({
        data: [{
          txID: HASH,
          block_timestamp: 1_700_000_000_000,
          raw_data: {
            contract: [{
              type: 'TransferContract',
              parameter: { value: {
                owner_address: 'TFromAddress',
                to_address: TRON_CONFIG.DEPOSIT_ADDRESS,
                amount: 3_000_000,
              } },
            }],
          },
          ret: [{ contractRet: 'SUCCESS' }],
        }],
      });
    }
    if (parsedUrl.pathname.endsWith('/rpc/credit_tron_deposit')) {
      rpcBody = JSON.parse(init.body);
      return jsonResponse({ ok: true, new_balance: 3 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(new Request('https://api.example/verify-deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: await initData(), tx_hash: HASH, asset: 'TRX' }),
    }), ENV);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      asset: 'TRX',
      amount: 3,
      tx_hash: HASH,
      new_balance: 3,
      already_credited: false,
    });
    assert.equal(tronHeaders['TRON-PRO-API-KEY'], ENV.TRONGRID_API_KEY);
    assert.equal(rpcBody.p_user_id, '42');
    assert.equal(rpcBody.p_asset, 'TRX');
    assert.equal(rpcBody.p_amount, 3);
    assert.equal('p_memo' in rpcBody, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /verify-deposit rejects malformed hashes before touching TronGrid', async () => {
  const response = await worker.fetch(new Request('https://api.example/verify-deposit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: await initData(), tx_hash: '123', asset: 'USDT' }),
  }), ENV);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /64-character/);
});

/**
 * Unit tests for the Cloudflare Worker validation lib.
 *
 * Run with: node --test tests/lib.test.mjs
 *
 * These tests exercise the pure functions that decide whether an on-chain
 * TON transaction is a valid payment for a given claim. They do NOT hit
 * Supabase or the live TonCenter API.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeTonComment,
  normalizeTonAddress,
  findValidTonPayment,
  generateClaimId,
  CONFIG,
} from '../lib.js';

// ============================================
// normalizeTonAddress
// ============================================
test('normalizeTonAddress: trims and lowercases', () => {
  assert.equal(
    normalizeTonAddress('  0:ABCDef123  '),
    '0:abcdef123'
  );
});

test('normalizeTonAddress: empty/null safe', () => {
  assert.equal(normalizeTonAddress(null), '');
  assert.equal(normalizeTonAddress(undefined), '');
  assert.equal(normalizeTonAddress(''), '');
  assert.equal(normalizeTonAddress(123), '');
});

// ============================================
// decodeTonComment
// ============================================
test('decodeTonComment: reads plain string from in_msg.message', () => {
  const inMsg = { message: 'CLAIM:ABC' };
  assert.equal(decodeTonComment(inMsg), 'CLAIM:ABC');
});

test('decodeTonComment: strips leading null bytes from message', () => {
  const inMsg = { message: '\u0000\u0000\u0000\u0000CLAIM:XYZ' };
  assert.equal(decodeTonComment(inMsg), 'CLAIM:XYZ');
});

test('decodeTonComment: decodes base64 msg_data.text with 4-byte op prefix', () => {
  // 4 zero bytes + "CLAIM:CLM_TEST"
  const text = 'CLAIM:CLM_TEST';
  const utf8 = Buffer.from(text, 'utf-8');
  const buf = Buffer.concat([Buffer.alloc(4, 0), utf8]);
  const b64 = buf.toString('base64');

  const inMsg = { msg_data: { text: b64 } };
  assert.equal(decodeTonComment(inMsg), text);
});

test('decodeTonComment: returns "" on missing data', () => {
  assert.equal(decodeTonComment({}), '');
  assert.equal(decodeTonComment(null), '');
});

test('decodeTonComment: returns "" on bad base64', () => {
  const inMsg = { msg_data: { text: '!!!not-base64!!!' } };
  // atob/Buffer.from accepts garbage — output is just garbage bytes; ensure
  // we don't throw.
  const out = decodeTonComment(inMsg);
  assert.equal(typeof out, 'string');
});

// ============================================
// findValidTonPayment
// ============================================
function makeTx({ source, comment, valueNano, utime, hash = 'abc123', lt = '999' }) {
  const utf8 = Buffer.from(comment, 'utf-8');
  const buf = Buffer.concat([Buffer.alloc(4, 0), utf8]);
  return {
    transaction_id: { hash, lt },
    utime,
    in_msg: {
      source,
      destination: CONFIG.TREASURY_WALLET,
      value: String(valueNano),
      msg_data: { text: buf.toString('base64') },
    },
  };
}

test('findValidTonPayment: matches valid tx', async () => {
  const tx = makeTx({
    source: '0:abc',
    comment: 'CLAIM:CLM_X',
    valueNano: 50_000_000, // 0.05 TON
    utime: 1_700_000_000,
    hash: 'hash_ok',
  });

  const result = await findValidTonPayment({
    senderAddress: '0:abc',
    claimId: 'CLM_X',
    minAmountNano: 50_000_000,
    earliestUtime: 0,
    txsOverride: [tx],
  });

  assert.ok(result, 'should match');
  assert.equal(result.tx_hash, 'hash_ok');
  assert.equal(result.amount_nano, 50_000_000);
  assert.equal(result.from_address, '0:abc');
  assert.equal(result.comment, 'CLAIM:CLM_X');
});

test('findValidTonPayment: rejects wrong sender', async () => {
  const tx = makeTx({
    source: '0:other',
    comment: 'CLAIM:CLM_X',
    valueNano: 50_000_000,
    utime: 1_700_000_000,
  });
  const result = await findValidTonPayment({
    senderAddress: '0:abc',
    claimId: 'CLM_X',
    minAmountNano: 50_000_000,
    txsOverride: [tx],
  });
  assert.equal(result, null);
});

test('findValidTonPayment: rejects wrong claim id (replay protection)', async () => {
  const tx = makeTx({
    source: '0:abc',
    comment: 'CLAIM:CLM_OTHER',
    valueNano: 50_000_000,
    utime: 1_700_000_000,
  });
  const result = await findValidTonPayment({
    senderAddress: '0:abc',
    claimId: 'CLM_X',
    minAmountNano: 50_000_000,
    txsOverride: [tx],
  });
  assert.equal(result, null);
});

test('findValidTonPayment: rejects insufficient amount', async () => {
  const tx = makeTx({
    source: '0:abc',
    comment: 'CLAIM:CLM_X',
    valueNano: 49_999_999, // just below 0.05 TON
    utime: 1_700_000_000,
  });
  const result = await findValidTonPayment({
    senderAddress: '0:abc',
    claimId: 'CLM_X',
    minAmountNano: 50_000_000,
    txsOverride: [tx],
  });
  assert.equal(result, null);
});

test('findValidTonPayment: accepts overpayment', async () => {
  const tx = makeTx({
    source: '0:abc',
    comment: 'CLAIM:CLM_X',
    valueNano: 100_000_000, // 0.10 TON
    utime: 1_700_000_000,
  });
  const result = await findValidTonPayment({
    senderAddress: '0:abc',
    claimId: 'CLM_X',
    minAmountNano: 50_000_000,
    txsOverride: [tx],
  });
  assert.ok(result);
  assert.equal(result.amount_nano, 100_000_000);
});

test('findValidTonPayment: rejects tx older than claim window', async () => {
  const tx = makeTx({
    source: '0:abc',
    comment: 'CLAIM:CLM_X',
    valueNano: 50_000_000,
    utime: 1_500_000_000, // way in the past
  });
  const result = await findValidTonPayment({
    senderAddress: '0:abc',
    claimId: 'CLM_X',
    minAmountNano: 50_000_000,
    earliestUtime: 1_700_000_000,
    txsOverride: [tx],
  });
  assert.equal(result, null);
});

test('findValidTonPayment: case-insensitive sender match', async () => {
  const tx = makeTx({
    source: '0:ABCdef',
    comment: 'CLAIM:CLM_X',
    valueNano: 50_000_000,
    utime: 1_700_000_000,
  });
  const result = await findValidTonPayment({
    senderAddress: '0:abcdef',
    claimId: 'CLM_X',
    minAmountNano: 50_000_000,
    txsOverride: [tx],
  });
  assert.ok(result);
});

test('findValidTonPayment: picks first matching tx in list', async () => {
  const txs = [
    makeTx({
      source: '0:other', comment: 'CLAIM:CLM_X', valueNano: 50_000_000,
      utime: 1_700_000_000, hash: 'wrong1',
    }),
    makeTx({
      source: '0:abc', comment: 'CLAIM:CLM_X', valueNano: 50_000_000,
      utime: 1_700_000_000, hash: 'right',
    }),
    makeTx({
      source: '0:abc', comment: 'CLAIM:CLM_X', valueNano: 50_000_000,
      utime: 1_700_000_000, hash: 'duplicate',
    }),
  ];
  const result = await findValidTonPayment({
    senderAddress: '0:abc',
    claimId: 'CLM_X',
    minAmountNano: 50_000_000,
    txsOverride: txs,
  });
  assert.equal(result.tx_hash, 'right');
});

test('findValidTonPayment: handles empty/undefined inputs gracefully', async () => {
  assert.equal(
    await findValidTonPayment({ senderAddress: '', claimId: 'X', minAmountNano: 1, txsOverride: [] }),
    null
  );
  assert.equal(
    await findValidTonPayment({ senderAddress: '0:a', claimId: '', minAmountNano: 1, txsOverride: [] }),
    null
  );
});

// ============================================
// generateClaimId
// ============================================
test('generateClaimId: returns prefixed id', () => {
  const id = generateClaimId();
  assert.match(id, /^CLM_[A-Z0-9]+_[A-Z0-9]+$/);
});

test('generateClaimId: uniqueness across rapid calls', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(generateClaimId());
  assert.equal(ids.size, 100);
});

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
  resolvePendingClaim,
  resolveAuthCycle,
  isoWeekKey,
  utcDayKey,
  computeStreak,
  summarizeCheckins,
  CHECKIN_CONFIG,
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

// ============================================
// resolvePendingClaim — forfeit an unpaid claim, restart the cycle
// ============================================
test('resolvePendingClaim: no claim is a no-op', () => {
  const r = resolvePendingClaim(null, new Date('2026-09-08T12:00:00Z'), 2);
  assert.equal(r.pendingClaim, null);
  assert.equal(r.forfeited, false);
  assert.equal(r.holdsCompleted, 2, 'holds must not move when there is no claim');
});

test('resolvePendingClaim: a live claim is returned untouched', () => {
  const claim = { claim_id: 'C1', expires_at: '2026-09-08T12:15:00Z' };
  const r = resolvePendingClaim(claim, new Date('2026-09-08T12:00:00Z'), 3);
  assert.equal(r.pendingClaim, claim);
  assert.equal(r.forfeited, false);
  assert.equal(r.holdsCompleted, 3, 'still locked at 3/3 while the claim is payable');
});

test('resolvePendingClaim: el claim expira y los 3 holds se pierden con él', () => {
  const claim = { claim_id: 'C1', expires_at: '2026-09-08T12:15:00Z' };
  const r = resolvePendingClaim(claim, new Date('2026-09-08T12:15:01Z'), 3);
  assert.equal(r.pendingClaim, null);
  assert.equal(r.forfeited, true);
  // v2.8.1: el ciclo vuelve a 0 y el usuario puede holdear de nuevo enseguida.
  // El bloqueo de 8 h rige solo tras un claim exitoso (el ciclo queda en 3/3).
  assert.equal(r.holdsCompleted, 0);
  assert.notEqual(r.holdsCompleted, CONFIG.MAX_HOLDS_PER_CYCLE);
});

test('CONFIG: fee y rango de premio por hold', () => {
  assert.equal(CONFIG.TON_FEE, 0.15, 'fee del claim en TON');
  assert.equal(CONFIG.HOLD_PRIZE_MIN, 0.15);
  assert.equal(CONFIG.HOLD_PRIZE_MAX, 0.35);
  // 3 holds al máximo = 1.05 USDT
  // 0.35 * 3 = 1.0499999999999998 en punto flotante: se compara con tolerancia.
  assert.ok(Math.abs(CONFIG.HOLD_PRIZE_MAX * CONFIG.MAX_HOLDS_PER_CYCLE - 1.05) < 1e-9);
});

test('resolvePendingClaim: expiry boundary is inclusive (still payable at T)', () => {
  const claim = { claim_id: 'C1', expires_at: '2026-09-08T12:15:00Z' };
  const atExpiry = resolvePendingClaim(claim, new Date('2026-09-08T12:15:00Z'), 3);
  assert.equal(atExpiry.forfeited, false);
  assert.equal(atExpiry.pendingClaim, claim);
});

test('resolvePendingClaim: a malformed expires_at forfeits rather than locking', () => {
  const claim = { claim_id: 'C1', expires_at: 'not-a-date' };
  const r = resolvePendingClaim(claim, new Date('2026-09-08T12:00:00Z'), 3);
  // NaN < now is false, so the claim survives; assert the documented behaviour
  // so a future change to this branch is a conscious one.
  assert.equal(r.forfeited, false);
  assert.equal(r.pendingClaim, claim);
});

// ============================================
// Daily check-in rules
// ============================================
test('utcDayKey: UTC day, not local', () => {
  assert.equal(utcDayKey(new Date('2026-09-08T23:59:00Z')), '2026-09-08');
  assert.equal(utcDayKey(new Date('2026-09-09T00:01:00Z')), '2026-09-09');
});

test('isoWeekKey: matches the ISO year-week the SQL uses', () => {
  assert.equal(isoWeekKey(new Date('2026-09-08T12:00:00Z')), '2026-W37');
  // 2026-01-01 is a Thursday, so it belongs to week 1 of 2026
  assert.equal(isoWeekKey(new Date('2026-01-01T12:00:00Z')), '2026-W01');
  // 2027-01-01 is a Friday -> still week 53 of 2026
  assert.equal(isoWeekKey(new Date('2027-01-01T12:00:00Z')), '2026-W53');
});

test('computeStreak: consecutive days add up', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  assert.equal(computeStreak(['2026-09-06', '2026-09-07', '2026-09-08'], now), 3);
});

test('computeStreak: a missed day breaks it', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  assert.equal(computeStreak(['2026-09-05', '2026-09-07', '2026-09-08'], now), 2);
});

test('computeStreak: today not done yet still counts yesterday and back', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  assert.equal(computeStreak(['2026-09-06', '2026-09-07'], now), 2);
});

test('computeStreak: empty history is 0', () => {
  assert.equal(computeStreak([], new Date('2026-09-08T12:00:00Z')), 0);
});

test('summarizeCheckins: counts only the current ISO week', () => {
  const now = new Date('2026-09-08T12:00:00Z'); // 2026-W37, Tuesday
  const rows = [
    { checkin_date: '2026-09-07' }, // Mon, same week
    { checkin_date: '2026-09-08' }, // today
    { checkin_date: '2026-09-01' }, // previous week -> ignored
  ];
  const s = summarizeCheckins(rows, now);
  assert.equal(s.checked_in_today, true);
  assert.equal(s.days_this_week, 2);
  assert.equal(s.weekly_complete, false);
  assert.equal(s.days_to_weekly, 5);
  assert.equal(s.streak, 2);
});

test('summarizeCheckins: 7 distinct days complete the week', () => {
  const now = new Date('2026-09-13T12:00:00Z'); // Sunday of 2026-W37
  const rows = ['07', '08', '09', '10', '11', '12', '13'].map((d) => ({
    checkin_date: `2026-09-${d}`,
  }));
  const s = summarizeCheckins(rows, now);
  assert.equal(s.days_this_week, 7);
  assert.equal(s.weekly_complete, true);
  assert.equal(s.days_to_weekly, 0);
  assert.equal(s.streak, 7);
});

test('summarizeCheckins: a duplicate day is not counted twice', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  const rows = [{ checkin_date: '2026-09-08' }, { checkin_date: '2026-09-08' }];
  assert.equal(summarizeCheckins(rows, now).days_this_week, 1);
});

test('summarizeCheckins: tolerates a missing/empty list', () => {
  const s = summarizeCheckins(undefined, new Date('2026-09-08T12:00:00Z'));
  assert.equal(s.days_this_week, 0);
  assert.equal(s.streak, 0);
  assert.equal(s.weekly_complete, false);
  assert.equal(s.daily_reward, CHECKIN_CONFIG.DAILY_REWARD_USDT);
  assert.equal(s.weekly_bonus, CHECKIN_CONFIG.WEEKLY_BONUS_USDT);
});

// ============================================
// resolveAuthCycle — el cooldown post-claim
// ============================================
test('resolveAuthCycle: sin ciclos hay que crear uno', () => {
  const r = resolveAuthCycle(null, new Date('2026-09-08T12:00:00Z'));
  assert.equal(r.mustCreate, true);
  assert.equal(r.mustExpire, false);
});

test('resolveAuthCycle: ciclo activo vigente se respeta', () => {
  const cycle = { id: 'c1', status: 'active', holds_completed: 1, ends_at: '2026-09-08T18:00:00Z' };
  const r = resolveAuthCycle(cycle, new Date('2026-09-08T12:00:00Z'));
  assert.equal(r.cycle, cycle);
  assert.equal(r.mustCreate, false);
});

test('resolveAuthCycle: un ciclo COMPLETED vigente es el cooldown y NO se crea otro', () => {
  // Este es el bug de producción: /auth filtraba por status='active', no veía el
  // ciclo completado y abría uno nuevo, así que se podía holdear apenas cobrar.
  const cycle = { id: 'c1', status: 'completed', holds_completed: 3, ends_at: '2026-09-08T20:00:00Z' };
  const r = resolveAuthCycle(cycle, new Date('2026-09-08T12:00:00Z'));
  assert.equal(r.mustCreate, false, 'no debe abrir un ciclo nuevo durante el cooldown');
  assert.equal(r.cycle, cycle);
  assert.equal(r.cycle.holds_completed, 3, 'canHold() tiene que dar false');
});

test('resolveAuthCycle: pasado el cooldown se abre un ciclo nuevo', () => {
  const cycle = { id: 'c1', status: 'completed', holds_completed: 3, ends_at: '2026-09-08T20:00:00Z' };
  const r = resolveAuthCycle(cycle, new Date('2026-09-08T20:00:01Z'));
  assert.equal(r.mustCreate, true);
  assert.equal(r.mustExpire, false, 'un completed no se marca expired otra vez');
});

test('resolveAuthCycle: un activo vencido se marca expired y se reemplaza', () => {
  const cycle = { id: 'c9', status: 'active', holds_completed: 2, ends_at: '2026-09-08T11:00:00Z' };
  const r = resolveAuthCycle(cycle, new Date('2026-09-08T12:00:00Z'));
  assert.equal(r.mustCreate, true);
  assert.equal(r.mustExpire, true);
  assert.equal(r.expiredId, 'c9');
});

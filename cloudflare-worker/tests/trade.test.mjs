/**
 * Unit tests for the simulated spot-trade maths.
 *
 * Run with: node --test tests/trade.test.mjs
 *
 * These exercise the pure helpers only — no Supabase, no exchange HTTP.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRADE_CONFIG,
  validateTradeRequest,
  calcOpenTrade,
  calcCloseTrade,
  calcUnrealizedPnl,
  isPriceWithinTolerance,
  fetchMarkPrice,
  pairSymbols,
  priceFromPercent,
  validateLevels,
  checkLevelTrigger,
  previewLevelPnl,
} from '../lib.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ============================================
// validateTradeRequest
// ============================================
test('validateTradeRequest: accepts a supported pair with enough balance', () => {
  const res = validateTradeRequest({ pair: 'TONUSDT', amount: 50, balance: 100 });
  assert.equal(res.ok, true);
  assert.equal(res.amount, 50);
});

test('validateTradeRequest: rejects unknown pair', () => {
  const res = validateTradeRequest({ pair: 'SCAMUSDT', amount: 10, balance: 100 });
  assert.equal(res.ok, false);
  assert.match(res.error, /Unsupported pair/);
});

test('validateTradeRequest: rejects non-positive / NaN amounts', () => {
  for (const amount of [0, -5, NaN, 'abc']) {
    const res = validateTradeRequest({ pair: 'BTCUSDT', amount, balance: 100 });
    assert.equal(res.ok, false, `expected rejection for amount=${amount}`);
  }
});

test('validateTradeRequest: enforces minimum notional', () => {
  const res = validateTradeRequest({
    pair: 'ETHUSDT',
    amount: TRADE_CONFIG.MIN_NOTIONAL - 0.01,
    balance: 100,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /Minimum order size/);
});

test('validateTradeRequest: enforces maximum notional', () => {
  const res = validateTradeRequest({
    pair: 'ETHUSDT',
    amount: TRADE_CONFIG.MAX_NOTIONAL + 1,
    balance: TRADE_CONFIG.MAX_NOTIONAL * 2,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /Maximum order size/);
});

test('validateTradeRequest: balance must cover notional + fee', () => {
  const amount = 50;
  const fee = amount * TRADE_CONFIG.FEE_RATE;

  const exact = validateTradeRequest({ pair: 'TONUSDT', amount, balance: amount + fee });
  assert.equal(exact.ok, true, 'exact balance should be accepted');

  const short = validateTradeRequest({ pair: 'TONUSDT', amount, balance: amount + fee - 0.01 });
  assert.equal(short.ok, false);
  assert.match(short.error, /Insufficient USDT balance/);
});

test('validateTradeRequest: treats missing balance as zero', () => {
  const res = validateTradeRequest({ pair: 'TONUSDT', amount: 10 });
  assert.equal(res.ok, false);
  assert.match(res.error, /Insufficient USDT balance/);
});

// ============================================
// calcOpenTrade
// ============================================
test('calcOpenTrade: qty, fee and total debit', () => {
  const res = calcOpenTrade({ amount: 100, price: 2.5 });
  assert.equal(res.ok, true);
  assert.ok(close(res.qty, 40), `qty=${res.qty}`);
  assert.ok(close(res.fee, 0.1), `fee=${res.fee}`);
  assert.ok(close(res.totalDebit, 100.1), `totalDebit=${res.totalDebit}`);
});

test('calcOpenTrade: rejects bad inputs', () => {
  assert.equal(calcOpenTrade({ amount: 0, price: 2 }).ok, false);
  assert.equal(calcOpenTrade({ amount: 10, price: 0 }).ok, false);
  assert.equal(calcOpenTrade({ amount: -1, price: 2 }).ok, false);
  assert.equal(calcOpenTrade({ amount: 'x', price: 2 }).ok, false);
});

// ============================================
// calcCloseTrade
// ============================================
test('calcCloseTrade: profitable exit is net of both fees', () => {
  // Bought 40 units at 2.5 (100 USDT + 0.1 fee), selling at 3.0
  const res = calcCloseTrade({ qty: 40, entryPrice: 2.5, exitPrice: 3 });
  assert.equal(res.ok, true);
  assert.ok(close(res.costBasis, 100));
  assert.ok(close(res.proceeds, 120));
  assert.ok(close(res.fee, 0.12)); // 0.1% of 120
  assert.ok(close(res.credit, 119.88));
  // 119.88 credit - 100 cost - 0.1 open fee = 19.78
  assert.ok(close(res.pnl, 19.78), `pnl=${res.pnl}`);
  assert.ok(res.pnl > 0);
  assert.ok(close(res.pnlPct, 19.78 / 100.1));
});

test('calcCloseTrade: losing exit returns negative pnl', () => {
  const res = calcCloseTrade({ qty: 40, entryPrice: 2.5, exitPrice: 2 });
  assert.ok(close(res.proceeds, 80));
  assert.ok(close(res.credit, 79.92));
  assert.ok(close(res.pnl, 79.92 - 100 - 0.1));
  assert.ok(res.pnl < 0);
});

test('calcCloseTrade: flat price still loses the two fees', () => {
  const res = calcCloseTrade({ qty: 40, entryPrice: 2.5, exitPrice: 2.5 });
  assert.ok(close(res.pnl, 100 - 0.1 - 100 - 0.1));
  assert.ok(res.pnl < 0, 'round trip must cost the fees');
});

test('calcCloseTrade: rejects bad inputs', () => {
  assert.equal(calcCloseTrade({ qty: 0, entryPrice: 1, exitPrice: 1 }).ok, false);
  assert.equal(calcCloseTrade({ qty: 1, entryPrice: 0, exitPrice: 1 }).ok, false);
  assert.equal(calcCloseTrade({ qty: 1, entryPrice: 1, exitPrice: -2 }).ok, false);
});

// ============================================
// calcUnrealizedPnl
// ============================================
test('calcUnrealizedPnl: marks position to market', () => {
  const res = calcUnrealizedPnl({ qty: 40, entryPrice: 2.5, markPrice: 3 });
  assert.equal(res.ok, true);
  assert.ok(close(res.value, 120));
  assert.ok(close(res.unrealized, 20));
  assert.ok(close(res.unrealizedPct, 0.2));
});

test('calcUnrealizedPnl: negative when underwater', () => {
  const res = calcUnrealizedPnl({ qty: 40, entryPrice: 2.5, markPrice: 1 });
  assert.ok(close(res.unrealized, -60));
  assert.ok(res.unrealizedPct < 0);
});

test('calcUnrealizedPnl: rejects bad inputs', () => {
  assert.equal(calcUnrealizedPnl({ qty: 0, entryPrice: 1, markPrice: 1 }).ok, false);
  assert.equal(calcUnrealizedPnl({ qty: 1, entryPrice: 1, markPrice: 0 }).ok, false);
});

// ============================================
// isPriceWithinTolerance
// ============================================
test('isPriceWithinTolerance: accepts small drift, rejects spoofed fills', () => {
  // default tolerance is 2%
  assert.equal(isPriceWithinTolerance(100.5, 100), true); // +0.5%
  assert.equal(isPriceWithinTolerance(99.5, 100), true); // -0.5%
  assert.equal(isPriceWithinTolerance(103, 100), false); // +3%
  assert.equal(isPriceWithinTolerance(97, 100), false); // -3%
  assert.equal(isPriceWithinTolerance(1, 100), false);
});

test('isPriceWithinTolerance: honours a custom tolerance', () => {
  assert.equal(isPriceWithinTolerance(105, 100, 0.1), true); // 5% within 10%
  assert.equal(isPriceWithinTolerance(111, 100, 0.1), false); // 11% outside 10%
});

test('isPriceWithinTolerance: invalid client price is rejected', () => {
  assert.equal(isPriceWithinTolerance(0, 100), false);
  assert.equal(isPriceWithinTolerance(NaN, 100), false);
});

test('isPriceWithinTolerance: missing mark price trusts the client', () => {
  assert.equal(isPriceWithinTolerance(123, null), true);
  assert.equal(isPriceWithinTolerance(123, 0), true);
});

// ============================================
// TON -> GRAM: tickers de mercado por par
// ============================================
// Toncoin se renombró a Gram el 15/06/2026. ALLOWED_PAIRS y trade_positions
// siguen usando TONUSDT (cambiarlo dejaría huérfanas las posiciones abiertas),
// pero el ticker de mercado puede ser el nuevo o el viejo según el exchange.
test('pairSymbols: TONUSDT prueba GRAMUSDT primero y los pares sin alias usan su propio símbolo', () => {
  assert.deepEqual(pairSymbols('TONUSDT'), ['GRAMUSDT', 'TONUSDT']);
  assert.deepEqual(pairSymbols('BTCUSDT'), ['BTCUSDT']);
});

test('fetchMarkPrice: usa el ticker nuevo cuando el exchange ya migró', async () => {
  const asked = [];
  const price = await fetchMarkPrice('TONUSDT', {
    fetchImpl: async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({ price: '1.4100' }) };
    },
  });
  assert.equal(price, 1.41);
  assert.equal(asked.length, 1);
  assert.ok(asked[0].includes('symbol=GRAMUSDT'), asked[0]);
});

test('fetchMarkPrice: cae al ticker viejo si el nuevo todavía no existe', async () => {
  const asked = [];
  const price = await fetchMarkPrice('TONUSDT', {
    fetchImpl: async (url) => {
      asked.push(url);
      if (url.includes('GRAMUSDT')) return { ok: false };
      return { ok: true, json: async () => ({ price: '3.4120' }) };
    },
  });
  assert.equal(price, 3.412);
  assert.deepEqual(asked.map((u) => (u.includes('GRAMUSDT') ? 'GRAM' : 'TON')), ['GRAM', 'TON']);
});

test('fetchMarkPrice: un ticker que revienta no impide probar el siguiente', async () => {
  const price = await fetchMarkPrice('TONUSDT', {
    fetchImpl: async (url) => {
      if (url.includes('GRAMUSDT')) throw new Error('network down');
      return { ok: true, json: async () => ({ price: '3.4120' }) };
    },
  });
  assert.equal(price, 3.412);
});

// ============================================
// fetchMarkPrice (injected fetch)
// ============================================
test('fetchMarkPrice: parses the exchange ticker', async () => {
  const price = await fetchMarkPrice('TONUSDT', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ symbol: 'TONUSDT', price: '3.4120' }) }),
  });
  assert.equal(price, 3.412);
});

test('fetchMarkPrice: returns null on HTTP error or bad payload', async () => {
  assert.equal(await fetchMarkPrice('TONUSDT', { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(
    await fetchMarkPrice('TONUSDT', { fetchImpl: async () => ({ ok: true, json: async () => ({ price: 'nope' }) }) }),
    null
  );
  assert.equal(
    await fetchMarkPrice('TONUSDT', {
      fetchImpl: async () => {
        throw new Error('network down');
      },
    }),
    null
  );
  // Y si todos los tickers del par fallan, sigue siendo null (no un precio viejo).
  assert.equal(
    await fetchMarkPrice('BTCUSDT', { fetchImpl: async () => ({ ok: false }) }),
    null
  );
});

// ============================================
// ORDER LIMITS: Take Profit / Stop Loss
// ============================================
test('priceFromPercent: moves a reference price by a percentage', () => {
  assert.ok(close(priceFromPercent(100, 0.05), 105));
  assert.ok(close(priceFromPercent(100, -0.03), 97));
  assert.equal(priceFromPercent(0, 0.05), null);
  assert.equal(priceFromPercent(100, 'x'), null);
});

test('validateLevels: both levels optional', () => {
  const res = validateLevels({ entryPrice: 100 });
  assert.equal(res.ok, true);
  assert.equal(res.takeProfit, null);
  assert.equal(res.stopLoss, null);
});

test('validateLevels: accepts a valid long bracket', () => {
  const res = validateLevels({ entryPrice: 100, takeProfit: 110, stopLoss: 95 });
  assert.equal(res.ok, true);
  assert.equal(res.takeProfit, 110);
  assert.equal(res.stopLoss, 95);
});

test('validateLevels: Take Profit must sit above entry', () => {
  assert.match(validateLevels({ entryPrice: 100, takeProfit: 100 }).error, /above the entry/);
  assert.match(validateLevels({ entryPrice: 100, takeProfit: 90 }).error, /above the entry/);
});

test('validateLevels: Stop Loss must sit below entry', () => {
  assert.match(validateLevels({ entryPrice: 100, stopLoss: 100 }).error, /below the entry/);
  assert.match(validateLevels({ entryPrice: 100, stopLoss: 120 }).error, /below the entry/);
});

test('validateLevels: an inverted bracket is rejected', () => {
  // sl >= entry is caught first: tp > entry > sl would mean sl < tp anyway.
  assert.match(validateLevels({ entryPrice: 100, takeProfit: 105, stopLoss: 106 }).error, /below the entry/);
});

test('validateLevels: rejects garbage input', () => {
  assert.match(validateLevels({ entryPrice: 100, takeProfit: 'abc' }).error, /positive price/);
  assert.match(validateLevels({ entryPrice: 100, stopLoss: -5 }).error, /positive price/);
  assert.equal(validateLevels({ entryPrice: 0 }).ok, false);
});

test('checkLevelTrigger: fires the Stop Loss first on a gap down', () => {
  assert.equal(checkLevelTrigger({ entryPrice: 100, markPrice: 94, takeProfit: 110, stopLoss: 95 }), 'sl');
  assert.equal(checkLevelTrigger({ entryPrice: 100, markPrice: 95, stopLoss: 95 }), 'sl');
  assert.equal(checkLevelTrigger({ entryPrice: 100, markPrice: 96, stopLoss: 95 }), null);
});

test('checkLevelTrigger: fires the Take Profit when reached', () => {
  assert.equal(checkLevelTrigger({ entryPrice: 100, markPrice: 110, takeProfit: 110, stopLoss: 95 }), 'tp');
  assert.equal(checkLevelTrigger({ entryPrice: 100, markPrice: 109.9, takeProfit: 110 }), null);
});

test('checkLevelTrigger: no levels, no trigger', () => {
  assert.equal(checkLevelTrigger({ entryPrice: 100, markPrice: 50 }), null);
  assert.equal(checkLevelTrigger({ entryPrice: 100, markPrice: 0, stopLoss: 95 }), null);
});

test('previewLevelPnl: prices the level net of fees', () => {
  const res = previewLevelPnl({ qty: 1, entryPrice: 100, targetPrice: 95 });
  assert.equal(res.ok, true);
  assert.ok(res.pnl < 0, 'a stop loss below entry must be a loss');
  const expected = calcCloseTrade({ qty: 1, entryPrice: 100, exitPrice: 95 });
  assert.ok(close(res.pnl, expected.pnl));
});

/**
 * Trade maths shared with the Cloudflare Worker.
 *
 * The canonical, unit-tested implementation lives in
 * `/cloudflare-worker/lib.js` (see tests/trade.test.mjs). This mirror keeps the
 * frontend self-contained so the order form can preview the exact same numbers
 * the worker will book. Keep both files in sync.
 */

export const TRADE_CONFIG = {
  QUOTE_ASSET: 'USDT',
  FEE_RATE: 0.001, // 0.1% per side, simulated exchange fee
  MIN_NOTIONAL: 1, // USDT
  MAX_NOTIONAL: 100000, // USDT
  ALLOWED_PAIRS: ['TONUSDT', 'BTCUSDT', 'ETHUSDT', 'TRXUSDT', 'DOGEUSDT'],
};

/** Quick percentage chips shown in the order form. */
export const AMOUNT_PRESETS = [0.25, 0.5, 0.75, 1];

/**
 * @returns {{ok:true, amount:number}|{ok:false, error:string}}
 */
export function validateTradeRequest({ pair, amount, balance }) {
  const notional = Number(amount);

  if (!pair || !TRADE_CONFIG.ALLOWED_PAIRS.includes(pair)) {
    return { ok: false, error: 'Unsupported market' };
  }
  if (!Number.isFinite(notional) || notional <= 0) {
    return { ok: false, error: 'Enter an amount to buy' };
  }
  if (notional < TRADE_CONFIG.MIN_NOTIONAL) {
    return { ok: false, error: `Minimum order size is ${TRADE_CONFIG.MIN_NOTIONAL} USDT` };
  }
  if (notional > TRADE_CONFIG.MAX_NOTIONAL) {
    return { ok: false, error: `Maximum order size is ${TRADE_CONFIG.MAX_NOTIONAL} USDT` };
  }

  const available = Number(balance) || 0;
  const fee = notional * TRADE_CONFIG.FEE_RATE;
  if (notional + fee > available + 1e-9) {
    return { ok: false, error: 'Insufficient USDT balance' };
  }

  return { ok: true, amount: notional };
}

/** Size a buy: quantity received, fee charged, total USDT debited. */
export function calcOpenTrade({ amount, price }) {
  const notional = Number(amount);
  const px = Number(price);

  if (!Number.isFinite(notional) || notional <= 0) return { ok: false, error: 'Invalid amount' };
  if (!Number.isFinite(px) || px <= 0) return { ok: false, error: 'Invalid price' };

  const fee = notional * TRADE_CONFIG.FEE_RATE;
  return { ok: true, qty: notional / px, fee, totalDebit: notional + fee };
}

/** Value a closing sell, net of the open-side fee (cost basis). */
export function calcCloseTrade({ qty, entryPrice, exitPrice }) {
  const size = Number(qty);
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);

  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: 'Invalid quantity' };
  if (!Number.isFinite(entry) || entry <= 0) return { ok: false, error: 'Invalid entry price' };
  if (!Number.isFinite(exit) || exit <= 0) return { ok: false, error: 'Invalid exit price' };

  const costBasis = size * entry;
  const openFee = costBasis * TRADE_CONFIG.FEE_RATE;
  const proceeds = size * exit;
  const fee = proceeds * TRADE_CONFIG.FEE_RATE;
  const credit = proceeds - fee;
  const pnl = credit - costBasis - openFee;

  return {
    ok: true,
    costBasis,
    openFee,
    proceeds,
    fee,
    credit,
    pnl,
    pnlPct: pnl / (costBasis + openFee),
  };
}

/** Mark an open position to market (before the close-side fee). */
export function calcUnrealizedPnl({ qty, entryPrice, markPrice }) {
  const size = Number(qty);
  const entry = Number(entryPrice);
  const mark = Number(markPrice);

  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: 'Invalid quantity' };
  if (!Number.isFinite(entry) || entry <= 0) return { ok: false, error: 'Invalid entry price' };
  if (!Number.isFinite(mark) || mark <= 0) return { ok: false, error: 'Invalid mark price' };

  const costBasis = size * entry;
  const unrealized = size * (mark - entry);

  return { ok: true, costBasis, value: size * mark, unrealized, unrealizedPct: unrealized / costBasis };
}

/** Percentage chips offered next to the TP/SL inputs. */
export const LEVEL_PRESETS = {
  takeProfit: [0.03, 0.05, 0.1], // +3%, +5%, +10%
  stopLoss: [0.02, 0.03, 0.05], // -2%, -3%, -5%
};

/** Price a given percentage away from a reference price. */
export function priceFromPercent(referencePrice, percent) {
  const ref = Number(referencePrice);
  const pct = Number(percent);
  if (!Number.isFinite(ref) || ref <= 0) return null;
  if (!Number.isFinite(pct)) return null;
  const next = ref * (1 + pct);
  return next > 0 ? next : null;
}

/**
 * Validate a Take Profit / Stop Loss bracket for a LONG position.
 * Both are optional; when present they must sit on the right side of the entry.
 */
export function validateLevels({ entryPrice, takeProfit = null, stopLoss = null }) {
  const entry = Number(entryPrice);
  if (!Number.isFinite(entry) || entry <= 0) return { ok: false, error: 'Invalid entry price' };

  const normalize = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const tp = normalize(takeProfit);
  const sl = normalize(stopLoss);

  if (takeProfit !== null && takeProfit !== undefined && takeProfit !== '' && tp === null) {
    return { ok: false, error: 'Take Profit must be a positive price' };
  }
  if (stopLoss !== null && stopLoss !== undefined && stopLoss !== '' && sl === null) {
    return { ok: false, error: 'Stop Loss must be a positive price' };
  }
  if (tp !== null && tp <= entry) {
    return { ok: false, error: 'Take Profit must be above the entry price' };
  }
  if (sl !== null && sl >= entry) {
    // Also covers an inverted bracket: tp > entry > sl implies sl < tp.
    return { ok: false, error: 'Stop Loss must be below the entry price' };
  }

  return { ok: true, takeProfit: tp, stopLoss: sl };
}

/** Which limit does the mark price hit first? 'tp' | 'sl' | null */
export function checkLevelTrigger({ entryPrice, markPrice, takeProfit = null, stopLoss = null }) {
  const entry = Number(entryPrice);
  const mark = Number(markPrice);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(mark) || mark <= 0) return null;

  const sl = Number(stopLoss);
  const tp = Number(takeProfit);

  if (Number.isFinite(sl) && sl > 0 && mark <= sl) return 'sl';
  if (Number.isFinite(tp) && tp > 0 && mark >= tp) return 'tp';
  return null;
}

/** Expected PnL if a level is reached, net of both fees. */
export function previewLevelPnl({ qty, entryPrice, targetPrice }) {
  const res = calcCloseTrade({ qty, entryPrice, exitPrice: targetPrice });
  if (!res.ok) return res;
  return { ok: true, pnl: res.pnl, pnlPct: res.pnlPct, credit: res.credit };
}

// ============================================
// FORMATTERS
// ============================================
export function formatPrice(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

export function formatQty(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (Math.abs(n) < 0.0001) return n.toExponential(2);
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

/**
 * Activo de la wallet interna que se puede vender en cada par. Espejo de
 * PAIR_WALLET_ASSET en cloudflare-worker/lib.js.
 */
export const PAIR_WALLET_ASSET = {
  TRXUSDT: 'TRX',
  TONUSDT: 'TON',
};

export const walletAssetForPair = (pair) => PAIR_WALLET_ASSET[pair] || null;

/**
 * Venta de saldo interno a USDT. Espejo de sell_wallet_asset() en schema.sql.
 *
 * No usa calcCloseTrade a propósito: ahí el PnL se mide contra un precio de
 * entrada del book, y un bonus de referidos no tiene precio de entrada. Acá el
 * activo entra entero como proceeds menos la fee de un lado.
 */
export function calcWalletSale({ amount, price }) {
  const qty = Number(amount);
  const mark = Number(price);

  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: 'Invalid quantity' };
  if (!Number.isFinite(mark) || mark <= 0) return { ok: false, error: 'Invalid price' };

  const proceeds = qty * mark;
  const fee = proceeds * TRADE_CONFIG.FEE_RATE;

  return { ok: true, proceeds, fee, credit: proceeds - fee };
}

export function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.00%';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

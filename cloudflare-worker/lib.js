/**
 * TronKeeper Worker - Pure helpers (testable in isolation)
 *
 * No Cloudflare bindings used here. Everything is dependency-injected so the
 * functions are unit-testable under Node.js.
 */

export const CONFIG = {
  TREASURY_WALLET: 'UQCydneDGeAcamdCFS6e13Z2xoxwA5DsLkFONRdp-cavw-Th',
  CLAIM_EXPIRY_MINUTES: 15,
  CYCLE_DURATION_HOURS: 8,
  MAX_HOLDS_PER_CYCLE: 3,
  TON_FEE: 0.05, // TON per claim
  TONCENTER_BASE: 'https://toncenter.com/api/v2',
  // Un initData de Telegram se acepta durante 24 h. La Mini App manda uno
  // fresco en cada apertura, así que un usuario real nunca queda afuera.
  AUTH_MAX_AGE_SECONDS: 24 * 60 * 60,
};

// ============================================
// JSON RESPONSE
// ============================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ============================================
// CLAIM ID
// ============================================
export function generateClaimId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `CLM_${timestamp}_${random}`.toUpperCase();
}

// ============================================
// TELEGRAM initData VALIDATION (HMAC-SHA256)
// ============================================
export async function validateInitData(initData, botToken, options = {}) {
  if (!initData || !botToken) return null;

  const {
    now = Date.now(),
    maxAgeSeconds = CONFIG.AUTH_MAX_AGE_SECONDS,
  } = options;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const sortedParams = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      'raw', encoder.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const secretKeyHash = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));

    const dataKey = await crypto.subtle.importKey(
      'raw', secretKeyHash,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', dataKey, encoder.encode(sortedParams));

    const calculatedHash = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    if (calculatedHash !== hash) return null;

    // Freshness: sin esto, un initData capturado sirve para siempre. La firma
    // demuestra que el payload viene de Telegram, pero no que sea reciente; el
    // que lo intercepte podría hacerse pasar por ese usuario indefinidamente.
    // auth_date son segundos unix que Telegram incluye siempre.
    const authDateRaw = params.get('auth_date');
    const authDateSec = Number(authDateRaw);
    if (!authDateRaw || !Number.isFinite(authDateSec)) return null;
    const ageSeconds = now / 1000 - authDateSec;
    if (ageSeconds > maxAgeSeconds) return null;

    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch (e) {
    console.error('initData validation error:', e);
    return null;
  }
}

/**
 * Parte BOT_TOKEN en una lista de tokens.
 *
 * La app puede publicarse bajo varios bots (mirror): el bot definitivo y uno de
 * pruebas apuntando al mismo backend. Telegram firma el initData con el token
 * del bot desde el que se abrió la Mini App, así que el Worker necesita poder
 * verificar contra más de uno. Se aceptan varios tokens separados por coma,
 * espacio o salto de línea; también un array.
 *
 * @param {string|string[]} value
 * @returns {string[]} tokens sin vacíos ni duplicados, en el orden dado
 */
export function parseBotTokens(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const token = String(item ?? '').trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * Valida un initData contra varios tokens de bot y devuelve el usuario del
 * primero que firme. Devuelve null si ninguno cierra.
 *
 * No debilita la verificación: el HMAC igual tiene que cerrar contra alguno de
 * los tokens configurados. Lo que cambia es cuántos bots de confianza hay.
 *
 * @param {string} initData
 * @param {string|string[]} botTokens
 * @param {{now?: number, maxAgeSeconds?: number}} [options]
 * @returns {Promise<object|null>}
 */
export async function validateInitDataAny(initData, botTokens, options = {}) {
  if (!initData) return null;
  for (const token of parseBotTokens(botTokens)) {
    const user = await validateInitData(initData, token, options);
    if (user) return user;
  }
  return null;
}

// ============================================
// TON ADDRESS NORMALIZATION
// ============================================
/**
 * Normalize a TON address for equality comparison.
 *
 * TON addresses come in multiple formats:
 *   - Raw: "0:abc123..."  (workchain:hexHash, lowercase)
 *   - User-friendly: "EQ..." / "UQ..." / "kQ..." / "0Q..." (base64 with checksum)
 *
 * TonConnect always returns raw "0:hex" lowercase.
 * TonCenter v2 in_msg.source is also raw "0:hex" lowercase.
 *
 * To be defensive, we normalize:
 *   - Trim whitespace
 *   - Lowercase
 *   - For raw "wc:hex", keep as-is (already canonical)
 *   - For friendly "EQ.../UQ...", we cannot decode without TonWeb. We return
 *     the lowercased friendly form. Direct equality between raw and friendly
 *     will NOT match — but TonConnect + TonCenter both deliver raw, so this
 *     is fine for our flow.
 */
export function normalizeTonAddress(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.trim().toLowerCase();
}

// ============================================
// TON COMMENT DECODING
// ============================================
/**
 * Extract the text comment from a TonCenter v2 in_msg object.
 *
 * TonCenter returns either:
 *   in_msg.message: "CLAIM:CLM_XXX"  (sometimes plain string)
 *   in_msg.msg_data.text: "Q0xBSU06Q0xN..."  (base64 of UTF-8 bytes prefixed
 *     with the 4-byte op code 0x00000000 for text comments)
 *
 * The reference Telegram-style text comment payload starts with 4 zero bytes
 * (the op code for "text comment"). When TonCenter returns msg_data.text it
 * may include that prefix; we strip leading zero bytes to be safe.
 */
export function decodeTonComment(inMsg) {
  if (!inMsg) return '';

  // Direct message field (some TonCenter versions decode it for us)
  if (typeof inMsg.message === 'string' && inMsg.message.length > 0) {
    return inMsg.message.replace(/^\0+/, '');
  }

  // msg_data.text is base64 of the message body cells. For a simple text
  // comment, after base64-decode we get: 4 bytes opcode (0x00000000) + utf8.
  const b64 = inMsg.msg_data?.text || inMsg.msg_data?.body;
  if (!b64) return '';

  try {
    // Cross-runtime base64 decode (atob exists in CF Workers and modern Node)
    let bin;
    if (typeof atob === 'function') {
      bin = atob(b64);
    } else {
      bin = Buffer.from(b64, 'base64').toString('binary');
    }

    // Strip leading null bytes (text-comment opcode)
    let start = 0;
    while (start < bin.length && bin.charCodeAt(start) === 0) start++;

    // Convert remaining bytes to UTF-8 string
    const bytes = new Uint8Array(bin.length - start);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = bin.charCodeAt(start + i);
    }
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(bytes);
    }
    return Buffer.from(bytes).toString('utf-8');
  } catch (e) {
    console.error('decodeTonComment error:', e);
    return '';
  }
}

// ============================================
// TON CENTER - Fetch treasury transactions
// ============================================
export async function fetchTreasuryTransactions({
  treasury,
  tonApiKey,
  limit = 30,
  fetchImpl = fetch,
}) {
  const params = new URLSearchParams({
    address: treasury,
    limit: String(limit),
    archival: 'true',
  });
  if (tonApiKey) params.set('api_key', tonApiKey);

  const url = `${CONFIG.TONCENTER_BASE}/getTransactions?${params.toString()}`;
  const res = await fetchImpl(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`TonCenter HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`TonCenter error: ${data.error || 'unknown'}`);
  }
  return Array.isArray(data.result) ? data.result : [];
}

// ============================================
// FIND VALID TON PAYMENT
// ============================================
/**
 * Search the treasury's recent inbound transactions for one matching:
 *   - in_msg.source == senderAddress (normalized)
 *   - decoded comment == "CLAIM:<claimId>"
 *   - in_msg.value (nanoTON) >= minAmountNano
 *   - tx.utime >= earliestUtime (defends against replaying old txs)
 *
 * Returns { tx_hash, from_address, amount_nano, comment, utime } or null.
 */
export async function findValidTonPayment({
  treasury = CONFIG.TREASURY_WALLET,
  tonApiKey,
  senderAddress,
  claimId,
  minAmountNano,
  earliestUtime = 0,
  fetchImpl = fetch,
  // Test hook: allows injecting a tx list directly to bypass HTTP
  txsOverride = null,
}) {
  const expectedSender = normalizeTonAddress(senderAddress);
  const expectedComment = `CLAIM:${claimId}`;

  if (!expectedSender || !claimId) return null;

  const txs = txsOverride
    ? txsOverride
    : await fetchTreasuryTransactions({ treasury, tonApiKey, limit: 30, fetchImpl });

  for (const tx of txs) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;

    const source = normalizeTonAddress(inMsg.source);
    if (source !== expectedSender) continue;

    const comment = decodeTonComment(inMsg);
    if (comment !== expectedComment) continue;

    const value = parseInt(inMsg.value || '0', 10);
    if (!Number.isFinite(value) || value < minAmountNano) continue;

    const utime = parseInt(tx.utime || '0', 10);
    if (utime < earliestUtime) continue;

    const txHash =
      tx.transaction_id?.hash ||
      `${tx.transaction_id?.lt || 'unknown'}_${utime}`;

    return {
      tx_hash: txHash,
      from_address: inMsg.source,
      amount_nano: value,
      comment,
      utime,
    };
  }

  return null;
}

// ============================================
// TRADE (simulated spot) - pure helpers
// ============================================
/**
 * Simulated spot trading on top of the internal USDT balance.
 * Everything here is deterministic and dependency-free so the maths can be
 * unit-tested under Node.js (`node --test tests/trade.test.mjs`).
 *
 * The same constants/math are mirrored in frontend/src/lib/trade.js so the UI
 * can show an accurate preview before the worker confirms the fill.
 */
export const TRADE_CONFIG = {
  QUOTE_ASSET: 'USDT',
  FEE_RATE: 0.001, // 0.1% per side, simulated exchange fee
  MIN_NOTIONAL: 1, // USDT
  MAX_NOTIONAL: 100000, // USDT
  PRICE_TOLERANCE: 0.02, // client price must be within 2% of the mark price
  BINANCE_TICKER_URL: 'https://api.binance.com/api/v3/ticker/price',
  ALLOWED_PAIRS: ['TONUSDT', 'BTCUSDT', 'ETHUSDT', 'TRXUSDT', 'DOGEUSDT'],
};

/**
 * Validate an incoming buy order against the user's USDT balance.
 * @returns {{ok:true, amount:number}|{ok:false, error:string}}
 */
export function validateTradeRequest({ pair, amount, balance }) {
  const notional = Number(amount);

  if (!pair || !TRADE_CONFIG.ALLOWED_PAIRS.includes(pair)) {
    return { ok: false, error: `Unsupported pair. Allowed: ${TRADE_CONFIG.ALLOWED_PAIRS.join(', ')}` };
  }
  if (!Number.isFinite(notional) || notional <= 0) {
    return { ok: false, error: 'Amount must be a positive number' };
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

/**
 * Size a buy order: qty bought, fee charged and total USDT debited.
 * @returns {{ok:true, qty:number, fee:number, totalDebit:number}|{ok:false, error:string}}
 */
export function calcOpenTrade({ amount, price }) {
  const notional = Number(amount);
  const px = Number(price);

  if (!Number.isFinite(notional) || notional <= 0) {
    return { ok: false, error: 'Invalid amount' };
  }
  if (!Number.isFinite(px) || px <= 0) {
    return { ok: false, error: 'Invalid price' };
  }

  const fee = notional * TRADE_CONFIG.FEE_RATE;
  return {
    ok: true,
    qty: notional / px,
    fee,
    totalDebit: notional + fee,
  };
}

/**
 * Value a closing sell: proceeds, fee, net USDT credited and realized PnL.
 * The open-side fee is part of the cost basis, so PnL is net of both fees.
 */
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
  const pnlPct = pnl / (costBasis + openFee);

  return { ok: true, costBasis, openFee, proceeds, fee, credit, pnl, pnlPct };
}

/**
 * Mark-to-market an open position (before fees on the close side).
 */
export function calcUnrealizedPnl({ qty, entryPrice, markPrice }) {
  const size = Number(qty);
  const entry = Number(entryPrice);
  const mark = Number(markPrice);

  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: 'Invalid quantity' };
  if (!Number.isFinite(entry) || entry <= 0) return { ok: false, error: 'Invalid entry price' };
  if (!Number.isFinite(mark) || mark <= 0) return { ok: false, error: 'Invalid mark price' };

  const costBasis = size * entry;
  const unrealized = size * (mark - entry);
  return {
    ok: true,
    costBasis,
    value: size * mark,
    unrealized,
    unrealizedPct: unrealized / costBasis,
  };
}

/**
 * Sanity-check a client-supplied price against the exchange mark price.
 * Used by the worker to refuse obviously spoofed fills while still allowing a
 * few hundred ms of drift between the chart and the order.
 */
export function isPriceWithinTolerance(clientPrice, markPrice, tolerance = TRADE_CONFIG.PRICE_TOLERANCE) {
  const client = Number(clientPrice);
  const mark = Number(markPrice);
  if (!Number.isFinite(client) || client <= 0) return false;
  if (!Number.isFinite(mark) || mark <= 0) return true; // no mark available -> trust client
  return Math.abs(client - mark) / mark <= tolerance;
}

/**
 * Fetch the current mark price for a pair.
 * @returns {Promise<number|null>} null when the exchange is unreachable
 */
export async function fetchMarkPrice(pair, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(
      `${TRADE_CONFIG.BINANCE_TICKER_URL}?symbol=${encodeURIComponent(pair)}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const price = Number(data?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (e) {
    return null;
  }
}

// ============================================
// ORDER LIMITS (Take Profit / Stop Loss) - pure helpers
// ============================================
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
 * Validate Take Profit / Stop Loss levels for a LONG position.
 * Both are optional; when present they must sit on the correct side of entry.
 * @returns {{ok:true, takeProfit:number|null, stopLoss:number|null}|{ok:false, error:string}}
 */
export function validateLevels({ entryPrice, takeProfit = null, stopLoss = null }) {
  const entry = Number(entryPrice);
  if (!Number.isFinite(entry) || entry <= 0) {
    return { ok: false, error: 'Invalid entry price' };
  }

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
    // Note: this also covers an inverted bracket — tp > entry > sl implies sl < tp.
    return { ok: false, error: 'Stop Loss must be below the entry price' };
  }

  return { ok: true, takeProfit: tp, stopLoss: sl };
}

/**
 * Which limit does the current mark price hit first?
 * @returns {'tp'|'sl'|null}
 */
export function checkLevelTrigger({ entryPrice, markPrice, takeProfit = null, stopLoss = null }) {
  const entry = Number(entryPrice);
  const mark = Number(markPrice);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(mark) || mark <= 0) return null;

  const sl = Number(stopLoss);
  const tp = Number(takeProfit);

  // Stop Loss wins on a gap down that crosses both.
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
// CLAIM LIFECYCLE
// ============================================

/**
 * A claim that ran out of time unpaid is forfeited, and the cycle restarts at
 * zero holds so the user can play again. Without the restart /hold keeps
 * refusing (holds_completed is already at MAX_HOLDS_PER_CYCLE) and the button
 * is dead until the 8h window ends.
 *
 * @param {{expires_at: string}|null|undefined} pendingClaim
 * @param {Date} [now]
 * @returns {{pendingClaim: object|null, forfeited: boolean, holdsCompleted: number}}
 *          holdsCompleted is what the cycle must report after this decision.
 */
export function resolvePendingClaim(pendingClaim, now = new Date(), currentHolds = 0) {
  if (!pendingClaim) {
    return { pendingClaim: null, forfeited: false, holdsCompleted: currentHolds };
  }
  const expired = new Date(pendingClaim.expires_at).getTime() < now.getTime();
  if (!expired) {
    return { pendingClaim, forfeited: false, holdsCompleted: currentHolds };
  }
  return { pendingClaim: null, forfeited: true, holdsCompleted: 0 };
}

// ============================================
// DAILY CHECK-IN
// ============================================

export const CHECKIN_CONFIG = {
  DAILY_REWARD_USDT: 0.05,
  WEEKLY_BONUS_USDT: 0.5,
  DAYS_FOR_WEEKLY: 7,
};

const MS_PER_DAY = 86400000;

/** 'YYYY-MM-DD' in UTC — the same granularity the checkins table stores. */
export function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * ISO-8601 week key, e.g. '2026-W37'. Matches the SQL
 * to_char(now() AT TIME ZONE 'UTC', 'IYYY-"W"IW') so the worker and the
 * database agree on which week a check-in belongs to.
 */
export function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday of this week decides the ISO year.
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / MS_PER_DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * A streak continues only from the immediately previous UTC day; any gap
 * restarts it at 1.
 *
 * @param {string[]} dayKeys  'YYYY-MM-DD' strings, any order
 * @param {Date} [now]
 * @returns {number}
 */
export function computeStreak(dayKeys, now = new Date()) {
  const set = new Set(dayKeys);
  let streak = 0;
  let cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Today may or may not be done yet; start counting from today and walk back.
  for (;;) {
    if (!set.has(utcDayKey(cursor))) {
      // today not done yet is fine — the streak so far still counts
      if (streak === 0 && utcDayKey(cursor) === utcDayKey(now)) {
        cursor = new Date(cursor.getTime() - MS_PER_DAY);
        continue;
      }
      break;
    }
    streak += 1;
    cursor = new Date(cursor.getTime() - MS_PER_DAY);
  }
  return streak;
}

/**
 * Read-side status for the Missions card.
 *
 * @param {{checkin_date: string, week_key?: string}[]} rows
 * @param {Date} [now]
 */
export function summarizeCheckins(rows, now = new Date()) {
  const list = Array.isArray(rows) ? rows : [];
  const today = utcDayKey(now);
  const week = isoWeekKey(now);

  const dayKeys = list.map((r) => String(r.checkin_date).slice(0, 10));
  const thisWeek = list.filter(
    (r) => (r.week_key ? r.week_key : isoWeekKey(new Date(`${String(r.checkin_date).slice(0, 10)}T00:00:00Z`))) === week
  );

  const daysThisWeek = new Set(thisWeek.map((r) => String(r.checkin_date).slice(0, 10))).size;
  const checkedInToday = dayKeys.includes(today);

  return {
    checked_in_today: checkedInToday,
    streak: computeStreak(dayKeys, now),
    days_this_week: daysThisWeek,
    days_for_weekly: CHECKIN_CONFIG.DAYS_FOR_WEEKLY,
    days_to_weekly: Math.max(0, CHECKIN_CONFIG.DAYS_FOR_WEEKLY - daysThisWeek),
    weekly_complete: daysThisWeek >= CHECKIN_CONFIG.DAYS_FOR_WEEKLY,
    daily_reward: CHECKIN_CONFIG.DAILY_REWARD_USDT,
    weekly_bonus: CHECKIN_CONFIG.WEEKLY_BONUS_USDT,
  };
}

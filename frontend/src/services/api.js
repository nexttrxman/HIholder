/**
 * TronKeeper API Service - TON Claims System
 * 
 * Architecture: Telegram Mini App -> Cloudflare Worker -> Supabase
 */

/**
 * Le saca las barras finales a una URL base.
 *
 * `apiCall` concatena `${WORKER_URL}${endpoint}` con endpoints que ya empiezan
 * en '/', así que un VITE_WORKER_URL terminado en '/' produce '//auth'. El
 * Worker matchea el pathname exacto (switch sobre url.pathname), por lo que
 * eso cae al 404 `{"error":"Not found"}` mientras /health sigue respondiendo
 * bien. Error facilísimo de cometer al pegar la variable en el dashboard.
 *
 * @param {string} url
 * @returns {string}
 */
export const normalizeBaseUrl = (url) => String(url ?? '').replace(/\/+$/, '');

/**
 * Mensaje de error cuando falta VITE_WORKER_URL. Exportado para que
 * describeApiError lo muestre tal cual, sin el prefijo "Backend error:".
 */
export const MISSING_WORKER_URL =
  'VITE_WORKER_URL is not configured. Set it in Cloudflare Pages -> Settings -> Variables (Production) and redeploy.';

/**
 * Sin esto, un VITE_WORKER_URL ausente caía en un fallback hardcodeado a
 * tkworker.tkexchange.workers.dev: un Worker distinto del que se está
 * configurando. La app "funcionaba" contra el backend equivocado y devolvía
 * Invalid initData o Not found sin ninguna pista de cuál era el problema.
 * Es mejor fallar fuerte y decir qué variable falta.
 *
 * @param {string} url
 * @returns {string}
 */
export const requireWorkerUrl = (url) => {
  if (!url) throw new Error(MISSING_WORKER_URL);
  return url;
};

const WORKER_URL = normalizeBaseUrl(import.meta.env.VITE_WORKER_URL);

export const TELEGRAM_BOT_URL = import.meta.env.VITE_TELEGRAM_BOT_URL || 'https://t.me/TKcex_bot';
const TELEGRAM_APP_NAME = (import.meta.env.VITE_TELEGRAM_APP_NAME || '').trim();

/**
 * Arma el link de referido.
 *
 * Con VITE_TELEGRAM_APP_NAME usa la forma startapp
 * (t.me/<bot>/<app>?startapp=<uid>), que es la única que hace que Telegram
 * incluya start_param en el initData de la Mini App. Sin ese parámetro el
 * Worker no tiene forma de saber quién trajo al usuario y el referido no se
 * registra. La forma vieja ?start=<uid> le pasa el valor al BOT, no a la app.
 *
 * @param {string} uid
 * @returns {string}
 */
/**
 * 'startapp' abre la Mini App con start_param y el referido se registra.
 * 'start' abre el chat del bot: el parámetro le llega al bot, NO a la Web App,
 * así que el referido nunca se registra. Se necesita VITE_TELEGRAM_APP_NAME
 * (el nombre del Web App creado con /newapp en BotFather) en el build de Pages.
 */
export const REFERRAL_LINK_MODE = TELEGRAM_APP_NAME ? 'startapp' : 'start';

export const buildReferralLink = (uid, { botUrl = TELEGRAM_BOT_URL, appName = TELEGRAM_APP_NAME } = {}) => {
  const base = String(botUrl || '').replace(/\/+$/, '');
  const param = encodeURIComponent(uid);
  return appName
    ? `${base}/${encodeURIComponent(appName)}?startapp=${param}`
    : `${base}?start=${param}`;
};
const DEPOSIT_ADDRESS = import.meta.env.VITE_DEPOSIT_ADDRESS || 'TNjqVzo47ndAvH241njkMLKbda3G6FPgVs';
const TREASURY_WALLET = 'UQCydneDGeAcamdCFS6e13Z2xoxwA5DsLkFONRdp-cavw-Th';

import {
  CHECKIN_CONFIG,
  utcDayKey,
  isoWeekKey,
  summarizeCheckins,
} from '@/lib/checkin';

// Dev mode detection
const IS_DEV = typeof window !== 'undefined' && !window.Telegram?.WebApp?.initData;

// ============================================
// DEV MODE MOCK STATE
// ============================================
// Without Telegram initData (browser / preview) there is no backend, so the
// simulated trade panel needs a spendable demo balance. It is persisted to
// localStorage so reloads keep the trades consistent.
const MOCK_START_BALANCE = 250;

// Fee de retiro en TRX, igual para USDT y para TRX. Espejo de
// CONFIG.WITHDRAWAL_FEE_TRX en cloudflare-worker/lib.js: el Worker es la fuente
// de verdad y es el que lo cobra; esto existe para mostrarlo antes de confirmar.
export const WITHDRAWAL_FEE_TRX = 5.5;

// TRX con los que arranca todo usuario EN PRODUCCIÓN. Espejo de
// CONFIG.SIGNUP_TRX_BONUS en cloudflare-worker/lib.js: el Worker crea la wallet
// con ese valor. El mock de abajo usa otro número a propósito.
export const SIGNUP_TRX_BONUS = 1;

// Envío interno entre usuarios: la opción se muestra pero todavía no está
// habilitada (no hay endpoint en el Worker).
export const INTERNAL_TRANSFER_ENABLED = false;
const MOCK_BALANCE_KEY = 'tk_mock_usdt_balance';

function readMockBalance() {
  if (typeof window === 'undefined') return MOCK_START_BALANCE;
  try {
    const stored = Number(window.localStorage.getItem(MOCK_BALANCE_KEY));
    return Number.isFinite(stored) && stored >= 0 ? stored : MOCK_START_BALANCE;
  } catch (e) {
    return MOCK_START_BALANCE;
  }
}

function writeMockBalance(value) {
  try {
    window.localStorage.setItem(MOCK_BALANCE_KEY, String(value));
  } catch (e) {
    /* storage unavailable (private mode) - ignore */
  }
}

/** Dev-only: restore the demo wallet + cycle (used by tests and to restart the demo). */
export const resetMockWallet = () => {
  MOCK_USER.usdt_balance = MOCK_START_BALANCE;
  // El mock NO usa SIGNUP_TRX_BONUS: es un sandbox para probar la UI y ya arranca
    // con 250 USDT, que tampoco es un valor de producción. Con 1 TRX el flujo de
    // venta no pasaría MIN_NOTIONAL (1 USDT) y no se podría ejercitar.
    MOCK_USER.trx_balance = 5.0;
  MOCK_CYCLE.holds_completed = 0;
  MOCK_CYCLE.remaining_holds = MAX_HOLDS_PER_CYCLE_MOCK;
  MOCK_PENDING_CLAIM = null;
  writeMockBalance(MOCK_START_BALANCE);
};

/** Dev-only: mirror an internal USDT movement into the mock balance. */
export const applyLocalBalanceDelta = (delta) => {
  const next = Math.max(0, (MOCK_USER.usdt_balance || 0) + Number(delta || 0));
  MOCK_USER.usdt_balance = next;
  writeMockBalance(next);
  return next;
};

const MOCK_USER = {
  uid: 'TK_DEV_12345',
  usdt_balance: readMockBalance(),
  trx_balance: 5.00,
  ton_balance: 0,
  total_refs: 3,
  trx_refs: 6.00,
};

const MAX_HOLDS_PER_CYCLE_MOCK = 3;

const MOCK_CYCLE = {
  id: 'mock_cycle_1',
  holds_completed: 0,
  ends_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
  remaining_holds: MAX_HOLDS_PER_CYCLE_MOCK,
};

/** Claim awaiting payment, or null. Mirrors the worker's `claims` row. */
let MOCK_PENDING_CLAIM = null;

const CYCLE_HOURS_MOCK = 8;

/**
 * Espeja /auth: si la ventana del ciclo ya pasó se abre una nueva a 0 holds.
 * Mientras no haya pasado, el ciclo se devuelve tal cual —incluido el
 * 'completed' con 3 holds que deja el cooldown posterior al claim.
 */
const rollMockCycle = () => {
  if (new Date(MOCK_CYCLE.ends_at) >= new Date()) return MOCK_CYCLE;
  MOCK_CYCLE.holds_completed = 0;
  MOCK_CYCLE.remaining_holds = MAX_HOLDS_PER_CYCLE_MOCK;
  MOCK_CYCLE.ends_at = new Date(Date.now() + CYCLE_HOURS_MOCK * 60 * 60 * 1000).toISOString();
  return MOCK_CYCLE;
};

/**
 * Dev-only: the claim the user still has to pay for, or null.
 *
 * An unclaimed claim that ran out of time is forfeited and the cycle restarts
 * at zero holds, so the button is playable again instead of staying locked at
 * 3/3 until the 8h window ends. Same rule the worker applies in /auth.
 */
const resolveMockPendingClaim = () => {
  if (!MOCK_PENDING_CLAIM) return null;
  if (new Date(MOCK_PENDING_CLAIM.expires_at) >= new Date()) return MOCK_PENDING_CLAIM;

  MOCK_PENDING_CLAIM = null;
  // v2.8.1: el claim vencido se pierde y los 3 holds con él, igual que en el
  // worker. El ciclo vuelve a 0 y se puede holdear de nuevo sin esperar 8 h.
  MOCK_CYCLE.holds_completed = 0;
  MOCK_CYCLE.remaining_holds = MAX_HOLDS_PER_CYCLE_MOCK;
  return null;
};

/**
 * Claim de dev/preview. El total es 3 holds de 0.25; el fee sale de TON_CONFIG
 * para no duplicar el valor.
 */
const makeMockClaim = () => ({
  claim_id: `CLM_DEV_${Date.now()}`,
  total_prize: 0.75,
  ton_fee: TON_CONFIG.fee,
  expires_at: new Date(Date.now() + TON_CONFIG.claim_expiry_minutes * 60 * 1000).toISOString(),
  treasury_wallet: TREASURY_WALLET,
});

// ============================================
// TELEGRAM HELPERS
// ============================================
const getTelegram = () => {
  if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
    return window.Telegram.WebApp;
  }
  return null;
};

const getInitData = () => {
  const tg = getTelegram();
  return tg?.initData || null;
};

export const getTelegramUser = () => {
  const tg = getTelegram();
  return tg?.initDataUnsafe?.user || null;
};

export const initTelegram = () => {
  const tg = getTelegram();
  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor('#06131a');
    if (tg.setBackgroundColor) tg.setBackgroundColor('#06131a');
  }
};

export const hapticFeedback = (type = 'impact') => {
  const tg = getTelegram();
  if (tg?.HapticFeedback) {
    switch (type) {
      case 'impact': tg.HapticFeedback.impactOccurred('medium'); break;
      case 'success': tg.HapticFeedback.notificationOccurred('success'); break;
      case 'error': tg.HapticFeedback.notificationOccurred('error'); break;
      case 'warning': tg.HapticFeedback.notificationOccurred('warning'); break;
      default: tg.HapticFeedback.impactOccurred('light');
    }
  }
};

export const shareReferralLink = (uid) => {
  const tg = getTelegram();
  const link = buildReferralLink(uid);
  const text = '🎁 Join TronKeeper and earn rewards! Hold to earn daily.';
  
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  } else {
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`, '_blank');
  }
};

// ============================================
// API HELPERS
// ============================================
const apiCall = async (endpoint, body = {}) => {
  const initData = getInitData();
  
  if (IS_DEV || !initData) {
    console.warn(`[DEV MODE] ${endpoint}`);
    return null;
  }

  const base = requireWorkerUrl(WORKER_URL);

  const response = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, ...body }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `Request failed: ${response.status}`);
  }

  return response.json();
};

/**
 * Convierte un fallo de la llamada al Worker en un mensaje mostrable.
 *
 * Antes el catch de WalletContext ponía siempre "Failed to connect. Please try
 * again." y no había forma de distinguir un Worker sin deployar de un initData
 * rechazado con 401: las dos cosas pintaban la misma pantalla. Dentro de
 * Telegram no hay consola a mano, así que la causa tiene que verse en la UI.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeApiError(err) {
  const message = err?.message ? String(err.message) : String(err);
  // Un error de configuración ya viene redactado para el usuario.
  if (message === MISSING_WORKER_URL) return message;
  // fetch lanza TypeError cuando ni siquiera llega al servidor: DNS, red,
  // URL inexistente o WORKER_URL mal configurado.
  if (err instanceof TypeError || /fetch|network|load failed|failed to fetch/i.test(message)) {
    const where = WORKER_URL ? ` at ${WORKER_URL}` : '';
    return `Cannot reach the backend${where}. Check that the Worker is deployed and that VITE_WORKER_URL points to it.`;
  }
  return `Backend error: ${message}`;
}

// ============================================
// AUTH
// ============================================
export const authUser = async () => {
  try {
    const result = await apiCall('/auth');
    if (result) return result;
    
    // Dev mode fallback
    return {
      ok: true,
      user: MOCK_USER,
      cycle: rollMockCycle(),
      pending_claim: resolveMockPendingClaim(),
      treasury_wallet: TREASURY_WALLET,
    };
  } catch (error) {
    console.error('Auth error:', error);
    if (IS_DEV) {
      return {
        ok: true,
        user: MOCK_USER,
        cycle: rollMockCycle(),
        pending_claim: resolveMockPendingClaim(),
        treasury_wallet: TREASURY_WALLET,
      };
    }
    throw error;
  }
};

// ============================================
// HOLD - Register hold and get claim if 3rd
// ============================================
export const registerHold = async (prize) => {
  try {
    const result = await apiCall('/hold', { prize });
    if (result) return result;
    
    // Dev mode
    MOCK_CYCLE.holds_completed++;
    MOCK_CYCLE.remaining_holds--;
    
    const isThird = MOCK_CYCLE.holds_completed === MAX_HOLDS_PER_CYCLE_MOCK;

    if (isThird) {
      MOCK_PENDING_CLAIM = makeMockClaim();
    }

    return {
      ok: true,
      hold_number: MOCK_CYCLE.holds_completed,
      remaining_holds: MOCK_CYCLE.remaining_holds,
      cycle_complete: isThird,
      claim: isThird ? MOCK_PENDING_CLAIM : null,
    };
  } catch (error) {
    console.error('Hold error:', error);
    throw error;
  }
};

// ============================================
// GET CLAIM - Check pending claim status
// ============================================
export const getClaim = async () => {
  try {
    const result = await apiCall('/get-claim');
    if (result) return result;

    // Dev/preview: espeja al worker, y el worker NO regenera (v2.8.1). Un claim
    // vencido se pierde junto con sus 3 holds; hay que volver a hacerlos.
    resolveMockPendingClaim();
    return { ok: true, claim: MOCK_PENDING_CLAIM };
  } catch (error) {
    console.error('Get claim error:', error);
    throw error;
  }
};

// ============================================
// VERIFY PAYMENT - After TON transfer
// ============================================
// Backend verifies the TX on-chain via TonCenter using sender_address +
// claim_id. The frontend never supplies the tx_hash.
export const verifyPayment = async (claimId, senderAddress) => {
  try {
    const result = await apiCall('/verify-payment', {
      claim_id: claimId,
      sender_address: senderAddress,
    });
    if (result) return result;

    // Dev mode
    MOCK_USER.usdt_balance += 0.15;
    MOCK_PENDING_CLAIM = null;
    // Claim cobrado: el ciclo queda completo y bloqueado 8 h, igual que en el
    // worker (credit_claim mueve ends_at a NOW() + cooldown).
    MOCK_CYCLE.holds_completed = MAX_HOLDS_PER_CYCLE_MOCK;
    MOCK_CYCLE.remaining_holds = 0;
    MOCK_CYCLE.ends_at = new Date(Date.now() + CYCLE_HOURS_MOCK * 60 * 60 * 1000).toISOString();

    return {
      ok: true,
      credited: 0.15,
      new_balance: MOCK_USER.usdt_balance,
    };
  } catch (error) {
    console.error('Verify payment error:', error);
    throw error;
  }
};

// ============================================
// WITHDRAW (existing flow - TRON withdrawals)
// ============================================
export const requestWithdraw = async ({ asset, amount, toAddress }) => {
  try {
    const result = await apiCall('/withdraw', { asset, amount, toAddress });
    if (result) return result;
    
    // Dev mode
    return {
      ok: true,
      status: 'pending',
      txId: `dev_${Date.now()}`,
      message: 'Dev mode - withdrawal simulated',
    };
  } catch (error) {
    console.error('Withdraw error:', error);
    throw error;
  }
};

// ============================================
// TRADE - simulated spot trading
// ============================================
// Returns `null` in dev mode so the caller can execute the order locally.
export const placeTrade = async ({ pair, amount, price, takeProfit = null, stopLoss = null }) => {
  const result = await apiCall('/trade', {
    pair,
    amount,
    price,
    take_profit: takeProfit,
    stop_loss: stopLoss,
  });
  return result || null;
};

export const setTradeLevels = async ({ positionId, takeProfit = null, stopLoss = null }) => {
  const result = await apiCall('/trade/levels', {
    position_id: positionId,
    take_profit: takeProfit,
    stop_loss: stopLoss,
  });
  return result || null;
};

export const closeTradePosition = async ({ positionId, price }) => {
  const result = await apiCall('/trade/close', { position_id: positionId, price });
  return result || null;
};

/**
 * Vende saldo TRX/TON de la wallet interna a USDT.
 * Devuelve `null` en modo dev para que el TradeContext lo ejecute localmente.
 */
export const sellWalletAsset = async ({ asset, amount, price }) => {
  const result = await apiCall('/trade/sell-asset', { asset, amount, price });
  return result || null;
};

export const getPositions = async () => {
  const result = await apiCall('/positions');
  return result || null;
};

// ============================================
// TRANSACTIONS
// ============================================
export const getTransactions = async () => {
  try {
    const result = await apiCall('/transactions');
    if (result) return result;
    return { ok: true, transactions: [] };
  } catch (error) {
    console.error('Transactions error:', error);
    return { ok: true, transactions: [] };
  }
};

// ============================================
// REFERRALS
// ============================================
export const getReferralPool = async () => {
  try {
    const result = await apiCall('/referrals');
    if (result) return result;
    return {
      ok: true,
      pool: { total_pool: 50000, remaining: 42000, your_earnings: 6.00 }
    };
  } catch (error) {
    console.error('Referrals error:', error);
    return {
      ok: true,
      pool: { total_pool: 50000, remaining: 42000, your_earnings: 0 }
    };
  }
};

// ============================================
// CONSTANTS
// ============================================
export const DEPOSIT_INFO = {
  network: 'TRON (TRC-20)',
  address: DEPOSIT_ADDRESS,
};

export const TON_CONFIG = {
  treasury_wallet: TREASURY_WALLET,
  fee: 0.15,
  claim_expiry_minutes: 15,
};

// ============================================
// DAILY CHECK-IN
// ============================================
const CHECKIN_KEY = 'tk_checkins_v1';
const CHECKIN_WEEKLY_KEY = 'tk_checkin_weekly_paid_v1';

const readMockCheckins = () => {
  try {
    const raw = window.localStorage.getItem(CHECKIN_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
};

const writeMockCheckins = (rows) => {
  try {
    window.localStorage.setItem(CHECKIN_KEY, JSON.stringify(rows));
  } catch (e) {
    /* storage unavailable */
  }
};

/** @returns {Promise<{ok:boolean, checked_in_today:boolean, streak:number, days_this_week:number, weekly_complete:boolean}>} */
export const checkinStatus = async () => {
  try {
    const result = await apiCall('/checkin/status');
    if (result) return result;

    return {
      ok: true,
      ...summarizeCheckins(readMockCheckins().map((d) => ({ checkin_date: d }))),
    };
  } catch (error) {
    console.error('Check-in status error:', error);
    if (IS_DEV) {
      return {
        ok: true,
        ...summarizeCheckins(readMockCheckins().map((d) => ({ checkin_date: d }))),
      };
    }
    throw error;
  }
};

/**
 * Performs today's check-in. Credits the daily reward and, on the 7th day of
 * the ISO week, the weekly bonus (once per week).
 */
export const dailyCheckin = async () => {
  try {
    const result = await apiCall('/checkin');
    if (result) return result;

    const days = readMockCheckins();
    const today = utcDayKey();
    const asRows = (list) => list.map((d) => ({ checkin_date: d }));

    if (days.includes(today)) {
      return { ok: false, error: 'already_checked_in', ...summarizeCheckins(asRows(days)) };
    }

    days.push(today);
    writeMockCheckins(days);

    const summary = summarizeCheckins(asRows(days));
    const week = isoWeekKey();

    // weekly bonus: 7 days in the ISO week, paid at most once per week
    let weeklyPaid = 0;
    let paidWeek = null;
    try {
      paidWeek = window.localStorage.getItem(CHECKIN_WEEKLY_KEY);
    } catch (e) {
      paidWeek = null;
    }
    if (summary.weekly_complete && paidWeek !== week) {
      weeklyPaid = CHECKIN_CONFIG.WEEKLY_BONUS_USDT;
      try {
        window.localStorage.setItem(CHECKIN_WEEKLY_KEY, week);
      } catch (e) {
        /* ignore */
      }
    }

    const credited = CHECKIN_CONFIG.DAILY_REWARD_USDT + weeklyPaid;
    const newBalance = applyLocalBalanceDelta(credited);

    return {
      ok: true,
      ...summary,
      weekly_bonus: weeklyPaid,
      credited,
      new_balance: newBalance,
    };
  } catch (error) {
    console.error('Check-in error:', error);
    throw error;
  }
};

/** Dev-only: forget the demo check-in history (tests and "restart demo"). */
export const resetMockCheckins = () => {
  try {
    window.localStorage.removeItem(CHECKIN_KEY);
    window.localStorage.removeItem(CHECKIN_WEEKLY_KEY);
  } catch (e) {
    /* ignore */
  }
};

export default {
  authUser,
  registerHold,
  getClaim,
  verifyPayment,
  describeApiError,
  placeTrade,
  sellWalletAsset,
  closeTradePosition,
  setTradeLevels,
  getPositions,
  applyLocalBalanceDelta,
  resetMockWallet,
  checkinStatus,
  dailyCheckin,
  resetMockCheckins,
  getTransactions,
  getReferralPool,
  getTelegramUser,
  initTelegram,
  hapticFeedback,
  shareReferralLink,
  DEPOSIT_INFO,
  TON_CONFIG,
};

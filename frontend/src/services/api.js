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

// Montos mínimos de retiro. Espejo de withdrawal_config en supabase/schema.sql,
// que es la fuente de verdad: request_withdrawal() los hace cumplir del lado del
// servidor y esto solo existe para avisar antes de que el usuario confirme.
// Si se cambian allá, se cambian acá.
export const MIN_WITHDRAW_USDT = 10;
export const MIN_WITHDRAW_TRX = 10;

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
  MOCK_USER.keep_balance = 0;
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
  keep_balance: 0,
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
  // v3.6: igual que el worker, el claim vencido sin firmar se pierde y los 3
  // holds con él. El ciclo vuelve a 0 y se puede holdear de nuevo enseguida;
  // el bloqueo de 8 h rige solo tras un claim cobrado.
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
  } else if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    // Fuera de Telegram (pruebas en el navegador del celular) no hay
    // HapticFeedback: navigator.vibrate es el equivalente de la web.
    if (type === 'success') navigator.vibrate([30, 40, 30]);
    else if (type === 'error') navigator.vibrate(120);
    else navigator.vibrate(35);
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

/**
 * v3.4 (story): comparte una FOTO del bot a la historia del usuario.
 *
 * Telegram no permite verificar que alguien publico una historia, asi que
 * estas misiones son de aprobacion manual en el servidor. Aca solo abrimos el
 * editor de historias con la foto del bot precargada (Bot API 7.8+,
 * WebApp.shareToStory). La imagen vive en /share-story.jpg y debe ser una URL
 * HTTPS publica porque Telegram la descarga. El caption es el share_text de la
 * mision y, para usuarios Premium, se pega un sticker de link con su referido
 * (al resto se les ignora en silencio). En clientes viejos o navegador sin
 * shareToStory, cae a compartir link+texto.
 */
export const SHARE_STORY_IMAGE = '/share-story.jpg';

export const shareToStory = (uid, caption) => {
  const tg = getTelegram();
  const link = buildReferralLink(uid);

  if (typeof tg?.shareToStory === 'function') {
    const mediaUrl = new URL(SHARE_STORY_IMAGE, window.location.origin).href;
    tg.shareToStory(mediaUrl, {
      text: caption || '',
      // Solo Premium: sticker de link con el referido (ignorado al resto).
      widget_link: { url: link, name: 'TronKeeper' },
    });
    return true;
  }

  // Fallback: clientes < 7.8 o navegador -> selector de link+texto.
  const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(caption || '')}`;
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(url);
  } else {
    window.open(url, '_blank');
  }
  return false;
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

    // Dev mode: mismo gate que el worker (v3.5).
    rollMockCycle();
    if (resolveMockPendingClaim()) {
      throw new Error('You have a pending claim. Claim it to keep playing!');
    }
    if (MOCK_CYCLE.remaining_holds <= 0 && new Date(MOCK_CYCLE.ends_at) > new Date()) {
      throw new Error('Cooldown active after your last claim.');
    }
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
    // v3.3: el claim semanal (CLMW_DEV_*) paga 1.5 USDT + 2000 KEEP fijos.
    // OJO al prefijo: los claims de HOLD del mock tambien empiezan 'CLM_DEV_'.
    if (String(claimId).startsWith('CLMW_DEV_')) {
      const wc = readMockWeeklyClaim();
      const prize = Number(wc?.total_prize ?? CHECKIN_CONFIG.WEEKLY_BONUS_USDT);
      const keep = Number(wc?.keep_bonus ?? CHECKIN_CONFIG.WEEKLY_KEEP);
      MOCK_USER.usdt_balance += prize;
      MOCK_USER.keep_balance = (MOCK_USER.keep_balance || 0) + keep;
      try {
        const raw = window.localStorage.getItem(WEEKLY_CLAIM_KEY);
        if (raw) {
          const c = JSON.parse(raw);
          c.status = 'credited';
          window.localStorage.setItem(WEEKLY_CLAIM_KEY, JSON.stringify(c));
        }
      } catch (e) {
        /* ignore */
      }
      return {
        ok: true,
        credited: prize,
        new_balance: MOCK_USER.usdt_balance,
        keep_credited: keep,
        keep_balance: MOCK_USER.keep_balance,
      };
    }
    MOCK_USER.usdt_balance += 0.15;
    // Bonus KEEP del claim (v3.2): mismo sorteo que el SQL, 500–2500.
    const mockKeep = 500 + Math.floor(Math.random() * 2001);
    MOCK_USER.keep_balance = (MOCK_USER.keep_balance || 0) + mockKeep;
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
      keep_credited: mockKeep,
      keep_balance: MOCK_USER.keep_balance,
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
// TRON DEPOSITS (v3.7) — no MEMO required
// ============================================
// The Worker verifies the transaction against TronGrid. The frontend only
// sends the hash and selected asset; it never sends an amount to credit.
export const verifyDeposit = async ({ txHash, asset = 'USDT' }) => {
  const result = await apiCall('/verify-deposit', {
    tx_hash: String(txHash || '').trim(),
    asset: String(asset || 'USDT').toUpperCase(),
  });
  if (result) return result;

  // There is no safe local simulation for a chain deposit: a browser preview
  // must not invent balance. Open the Mini App in Telegram with a deployed
  // Worker to verify the real transaction.
  return {
    ok: false,
    error: 'Deposit verification is available in the Telegram Mini App after the Worker is deployed.',
  };
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

// ============================================
// $KEEP (v3.2) — token propio
// ============================================
// Rangos de recompensa en KEEP. Los montos reales los sortea el SQL; esto es
// solo para mostrarlos (debe coincidir con KEEP_CONFIG en worker/lib.js).
export const KEEP_REWARDS = {
  mission: { min: 500, max: 1200 },
  checkin: { min: 500, max: 500 }, // v3.3: 500 KEEP fijos por dia
  weekly: 2000,                    // v3.3: fijos, con el claim semanal
  claim: { min: 500, max: 2500 },
};

/**
 * Compra KEEP con USDT interno al precio manejado por el proyecto.
 * Devuelve `null` en modo dev para que el TradeContext lo ejecute localmente.
 */
export const buyKeep = async ({ amount, price }) => {
  const result = await apiCall('/trade/buy-keep', { amount, price });
  return result || null;
};

/**
 * Precio y velas de un par manejado (KEEP). GET publico del Worker: el precio
 * no vive en un exchange, vive en managed_prices. `null` si no hay Worker
 * configurado, para que market.js caiga al generador sintético.
 */
export const getManagedMarket = async (pair, interval = '1h', limit = 60) => {
  if (!WORKER_URL) return null;
  const base = normalizeBaseUrl(WORKER_URL);
  const qs = new URLSearchParams({ pair, interval, limit: String(limit) });
  const res = await fetch(`${base}/price?${qs.toString()}`);
  if (!res.ok) throw new Error(`Price request failed: ${res.status}`);
  return res.json();
};

export const getPositions = async () => {
  const result = await apiCall('/positions');
  return result || null;
};

// ============================================
// TRANSACTIONS
// ============================================
// ============================================
// SOCIAL MISSIONS (v3.1)
// ============================================
// La lista y el verify viven en el Worker: el es quien pregunta a Telegram si
// el usuario esta en el canal/grupo (getChatMember), nunca el cliente.
export const getSocialMissions = async () => {
  try {
    const result = await apiCall('/missions', {});
    if (result) return result;
    // Dev mode: sin Worker no hay misiones que mostrar.
    return { ok: true, missions: [], completed: [] };
  } catch (error) {
    console.error('Social missions error:', error);
    return { ok: true, missions: [], completed: [] };
  }
};

export const verifySocialMission = async (missionId) => {
  try {
    const result = await apiCall('/verify-mission', { missionId });
    if (result) return result;
    // Dev mode: simula el cobro para poder probar la UI.
    return { ok: true, reward: 0.4, dev: true };
  } catch (error) {
    console.error('Verify mission error:', error);
    throw error;
  }
};

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
  // v3.3: minimo exhibido en la pantalla de deposito (el acreditado es manual).
  minimum: '5 TRX or 1 USDT',
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
const WEEKLY_CLAIM_KEY = 'tk_weekly_claim_v1';

// v3.3 (dev): el premio semanal ya no se acredita solo; es un claim que se
// cobra pagando 0.15 TON via TonConnect. Sin Worker lo simulamos aca.
const readMockWeeklyClaim = () => {
  try {
    const raw = window.localStorage.getItem(WEEKLY_CLAIM_KEY);
    const c = raw ? JSON.parse(raw) : null;
    if (!c || c.week !== isoWeekKey() || c.status !== 'pending') return null;
    return c;
  } catch (e) {
    return null;
  }
};

const ensureMockWeeklyClaim = (week) => {
  const existing = readMockWeeklyClaim();
  if (existing) return existing;
  // Expira al fin de la semana ISO: proximo lunes 00:00 UTC (igual que el SQL).
  const monday = new Date();
  const day = monday.getUTCDay() || 7;
  monday.setUTCDate(monday.getUTCDate() + (8 - day));
  monday.setUTCHours(0, 0, 0, 0);
  const c = {
    week,
    status: 'pending',
    claim_id: `CLMW_DEV_${week}`,
    expires_at: monday.toISOString(),
    total_prize: CHECKIN_CONFIG.WEEKLY_BONUS_USDT,
    ton_fee: 0.15,
    keep_bonus: CHECKIN_CONFIG.WEEKLY_KEEP,
  };
  try {
    window.localStorage.setItem(WEEKLY_CLAIM_KEY, JSON.stringify(c));
  } catch (e) {
    /* ignore */
  }
  return c;
};

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
      weekly_claim: readMockWeeklyClaim(),
    };
  } catch (error) {
    console.error('Check-in status error:', error);
    if (IS_DEV) {
      return {
        ok: true,
        ...summarizeCheckins(readMockCheckins().map((d) => ({ checkin_date: d }))),
        weekly_claim: readMockWeeklyClaim(),
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

    // v3.3: diario FIJO 0.15 USDT + 500 KEEP. El premio semanal ya no se
    // acredita directo: al completar los 7 dias se abre un claim semanal que
    // se cobra pagando 0.15 TON via TonConnect (en dev queda en localStorage).
    const credited = CHECKIN_CONFIG.DAILY_REWARD_USDT;
    const newBalance = applyLocalBalanceDelta(credited);
    const keepDaily = CHECKIN_CONFIG.DAILY_KEEP;
    MOCK_USER.keep_balance = (MOCK_USER.keep_balance || 0) + keepDaily;

    const weeklyClaim = summary.weekly_complete ? ensureMockWeeklyClaim(week) : null;

    return {
      ok: true,
      ...summary,
      weekly_bonus: 0,
      credited,
      new_balance: newBalance,
      keep_reward: keepDaily,
      keep_weekly: 0,
      keep_balance: MOCK_USER.keep_balance,
      weekly_claim_id: weeklyClaim?.claim_id || null,
      weekly_claim_expires: weeklyClaim?.expires_at || null,
      weekly_claim: weeklyClaim,
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
    window.localStorage.removeItem(WEEKLY_CLAIM_KEY);
  } catch (e) {
    /* ignore */
  }
};

// ============================================
// ADMIN (v3.3) — colas de aprobacion desde /admin
// ============================================
// No usa initData: el admin entra desde un navegador comun y autentica con el
// secreto ADMIN_TOKEN del Worker via header x-admin-token.
export const adminCall = async (path, token, body = {}) => {
  const base = requireWorkerUrl(WORKER_URL);
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `Admin request failed (${response.status})`);
  }
  return data;
};

export const adminListMissionRequests = (token) => adminCall('/admin/missions/list', token);
export const adminApproveMission = (token, userId, missionId) =>
  adminCall('/admin/missions/approve', token, { user_id: userId, mission_id: missionId });
export const adminRejectMission = (token, userId, missionId) =>
  adminCall('/admin/missions/reject', token, { user_id: userId, mission_id: missionId });
export const adminListWithdrawals = (token) => adminCall('/admin/withdrawals/list', token);
export const adminResolveWithdrawal = (token, requestId, status, txId = null, note = null) =>
  adminCall('/admin/withdrawals/resolve', token, {
    request_id: requestId, status, tx_id: txId, note,
  });

export default {
  authUser,
  registerHold,
  getClaim,
  verifyPayment,
  verifyDeposit,
  describeApiError,
  placeTrade,
  sellWalletAsset,
  buyKeep,
  getManagedMarket,
  KEEP_REWARDS,
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
  shareToStory,
  SHARE_STORY_IMAGE,
  DEPOSIT_INFO,
  TON_CONFIG,
};

/**
 * TronKeeper API Service
 * Adapter layer for backend communication
 * 
 * Architecture: Telegram Mini App -> Cloudflare Worker -> Supabase
 * Auth: Telegram initData (validated in Worker)
 */

// Configuration from environment
const WORKER_URL = process.env.REACT_APP_WORKER_URL || 'https://shiny-surf-110c.tkexchange.workers.dev';
const TELEGRAM_BOT_URL = process.env.REACT_APP_TELEGRAM_BOT_URL || 'https://t.me/TKcex_bot';
const DEPOSIT_ADDRESS = process.env.REACT_APP_DEPOSIT_ADDRESS || 'TNjqVzo47ndAvH241njkMLKbda3G6FPgVs';

/**
 * Get Telegram WebApp instance
 */
const getTelegram = () => {
  if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
    return window.Telegram.WebApp;
  }
  return null;
};

/**
 * Get Telegram initData for authentication
 */
const getInitData = () => {
  const tg = getTelegram();
  if (tg?.initData) {
    return tg.initData;
  }
  return null;
};

/**
 * Get user info from Telegram
 */
export const getTelegramUser = () => {
  const tg = getTelegram();
  if (tg?.initDataUnsafe?.user) {
    return tg.initDataUnsafe.user;
  }
  return null;
};

/**
 * Initialize Telegram WebApp
 */
export const initTelegram = () => {
  const tg = getTelegram();
  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) {
      tg.setHeaderColor('#050505');
    }
    if (tg.setBackgroundColor) {
      tg.setBackgroundColor('#050505');
    }
  }
};

/**
 * Trigger haptic feedback
 */
export const hapticFeedback = (type = 'impact') => {
  const tg = getTelegram();
  if (tg?.HapticFeedback) {
    switch (type) {
      case 'impact':
        tg.HapticFeedback.impactOccurred('medium');
        break;
      case 'success':
        tg.HapticFeedback.notificationOccurred('success');
        break;
      case 'error':
        tg.HapticFeedback.notificationOccurred('error');
        break;
      case 'warning':
        tg.HapticFeedback.notificationOccurred('warning');
        break;
      default:
        tg.HapticFeedback.impactOccurred('light');
    }
  }
};

/**
 * Share referral link via Telegram
 */
export const shareReferralLink = (uid) => {
  const tg = getTelegram();
  const link = `${TELEGRAM_BOT_URL}?start=${uid}`;
  const text = '🎁 Join TronKeeper and earn TRX & USDT rewards! Hold to earn daily.';
  
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  } else {
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`, '_blank');
  }
};

/**
 * API call wrapper with error handling
 */
const apiCall = async (endpoint, body = {}) => {
  const initData = getInitData();
  
  if (!initData) {
    throw new Error('No Telegram initData available. Open in Telegram.');
  }

  const response = await fetch(`${WORKER_URL}${endpoint}`, {
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
 * Authenticate user and load data
 * Endpoint: POST /auth
 * Body: { initData }
 * Response: { ok, user: { uid, usdt_balance, trx_balance, wins, holds_count, holds_reset_at, total_refs, trx_refs } }
 */
export const authUser = async () => {
  try {
    const result = await apiCall('/auth');
    return result;
  } catch (error) {
    console.error('Auth error:', error);
    throw error;
  }
};

/**
 * Claim hold reward
 * Endpoint: POST /claim
 * Body: { initData, prize }
 * Response: { ok, total, wins, holdsCount }
 */
export const claimReward = async (prize) => {
  try {
    const result = await apiCall('/claim', { prize });
    return result;
  } catch (error) {
    console.error('Claim error:', error);
    throw error;
  }
};

/**
 * Get transaction history
 * Endpoint: POST /transactions
 * Body: { initData, limit?, offset?, type? }
 * Response: { ok, transactions: [...] }
 */
export const getTransactions = async (options = {}) => {
  try {
    const result = await apiCall('/transactions', options);
    return result;
  } catch (error) {
    console.error('Transactions error:', error);
    throw error;
  }
};

/**
 * Get referral pool stats
 * Endpoint: POST /referrals
 * Body: { initData }
 * Response: { ok, pool: { total_pool, remaining, your_earnings }, referrals: [...] }
 */
export const getReferralPool = async () => {
  try {
    const result = await apiCall('/referrals');
    return result;
  } catch (error) {
    console.error('Referrals error:', error);
    throw error;
  }
};

/**
 * Request withdrawal
 * Endpoint: POST /withdraw
 * Body: { initData, asset, amount, toAddress }
 * Response: { ok, status, txId, message }
 */
export const requestWithdraw = async ({ asset, amount, toAddress }) => {
  try {
    const result = await apiCall('/withdraw', { asset, amount, toAddress });
    return result;
  } catch (error) {
    console.error('Withdraw error:', error);
    throw error;
  }
};

/**
 * Deposit address and memo for the wallet
 */
export const DEPOSIT_INFO = {
  network: 'TRON (TRC-20)',
  address: DEPOSIT_ADDRESS,
};

export default {
  authUser,
  claimReward,
  getTransactions,
  getReferralPool,
  requestWithdraw,
  getTelegramUser,
  initTelegram,
  hapticFeedback,
  shareReferralLink,
  DEPOSIT_INFO,
};

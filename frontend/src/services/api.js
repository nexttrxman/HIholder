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

// Development mode: true when not in Telegram
const IS_DEV = typeof window !== 'undefined' && !window.Telegram?.WebApp?.initData;

// Mock data for development/preview (outside Telegram)
const MOCK_USER = {
  uid: 'TK_DEV_12345',
  usdt_balance: 12.50,
  trx_balance: 24.50,
  total_earned: 12.50,
  wins: 45,
  holds_count: 0,
  holds_reset_at: null,
  total_refs: 8,
  trx_refs: 16.00,
};

const MOCK_TRANSACTIONS = [
  { id: 'tx_1', type: 'reward', asset: 'USDT', amount: 0.05, status: 'confirmed', timestamp: Date.now() - 3600000, description: 'Hold to Earn' },
  { id: 'tx_2', type: 'deposit', asset: 'USDT', amount: 50, status: 'confirmed', timestamp: Date.now() - 86400000, description: 'Deposit' },
  { id: 'tx_3', type: 'referral', asset: 'TRX', amount: 2, status: 'confirmed', timestamp: Date.now() - 172800000, description: 'Referral bonus' },
];

const MOCK_POOL = { total_pool: 50000, remaining: 38450, your_earnings: 16.00 };

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
 * Falls back to mock data in development mode
 */
const apiCall = async (endpoint, body = {}) => {
  const initData = getInitData();
  
  // Development mode: return mock data
  if (IS_DEV || !initData) {
    console.warn(`[DEV MODE] ${endpoint} - Using mock data (not in Telegram)`);
    return null; // Signal to use mock
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
 */
export const authUser = async () => {
  try {
    const result = await apiCall('/auth');
    if (result) return result;
    // Dev mode fallback
    return { ok: true, user: MOCK_USER };
  } catch (error) {
    console.error('Auth error:', error);
    if (IS_DEV) return { ok: true, user: MOCK_USER };
    throw error;
  }
};

/**
 * Claim hold reward
 */
export const claimReward = async (prize) => {
  try {
    const result = await apiCall('/claim', { prize });
    if (result) return result;
    // Dev mode fallback
    MOCK_USER.total_earned += prize;
    MOCK_USER.usdt_balance += prize;
    MOCK_USER.wins += 1;
    MOCK_USER.holds_count += 1;
    return { ok: true, total: MOCK_USER.total_earned, wins: MOCK_USER.wins, holdsCount: MOCK_USER.holds_count };
  } catch (error) {
    console.error('Claim error:', error);
    throw error;
  }
};

/**
 * Get transaction history
 */
export const getTransactions = async (options = {}) => {
  try {
    const result = await apiCall('/transactions', options);
    if (result) return result;
    // Dev mode fallback
    return { ok: true, transactions: MOCK_TRANSACTIONS };
  } catch (error) {
    console.error('Transactions error:', error);
    if (IS_DEV) return { ok: true, transactions: MOCK_TRANSACTIONS };
    throw error;
  }
};

/**
 * Get referral pool stats
 */
export const getReferralPool = async () => {
  try {
    const result = await apiCall('/referrals');
    if (result) return result;
    // Dev mode fallback
    return { ok: true, pool: MOCK_POOL };
  } catch (error) {
    console.error('Referrals error:', error);
    if (IS_DEV) return { ok: true, pool: MOCK_POOL };
    throw error;
  }
};

/**
 * Request withdrawal
 */
export const requestWithdraw = async ({ asset, amount, toAddress }) => {
  try {
    const result = await apiCall('/withdraw', { asset, amount, toAddress });
    if (result) return result;
    // Dev mode fallback
    return { ok: true, status: 'pending', txId: `dev_${Date.now()}`, message: 'Dev mode - withdrawal simulated' };
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

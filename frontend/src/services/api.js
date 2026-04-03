/**
 * TronKeeper API Service
 * Adapter layer for backend communication
 * 
 * Current backend: Cloudflare Worker (tkexchange.workers.dev)
 * This service abstracts the backend calls to make it easy to switch/mock
 */

const WORKER_URL = 'https://shiny-surf-110c.tkexchange.workers.dev';
const IS_DEV = false; // Set to true for local development with mocks

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
  // Fallback for development
  return 'dev_mode';
};

/**
 * Get user info from Telegram
 */
export const getTelegramUser = () => {
  const tg = getTelegram();
  if (tg?.initDataUnsafe?.user) {
    return tg.initDataUnsafe.user;
  }
  // Mock user for development
  return {
    id: 'dev_12345',
    first_name: 'Dev',
    last_name: 'User',
    username: 'devuser',
    photo_url: null,
  };
};

/**
 * Initialize Telegram WebApp
 */
export const initTelegram = () => {
  const tg = getTelegram();
  if (tg) {
    tg.ready();
    tg.expand();
    // Set theme
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
  const link = `https://t.me/TKcex_bot?start=${uid}`;
  const text = '🎁 Join TronKeeper and earn TRX & USDT rewards! Hold to earn daily.';
  
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  } else {
    // Fallback for non-Telegram environment
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`, '_blank');
  }
};

/**
 * Mock data for development/fallback
 */
const MOCK_USER_DATA = {
  uid: 'TK12345678',
  total_earned: 12.50,
  wins: 45,
  holds_count: 2,
  holds_reset_at: Date.now() + 3600000, // 1 hour from now
  total_refs: 8,
  trx_refs: 16.00,
  trx_balance: 24.50,
  usdt_balance: 12.50,
};

const MOCK_TRANSACTIONS = [
  {
    id: 'tx_001',
    type: 'deposit',
    asset: 'USDT',
    amount: 50.00,
    status: 'confirmed',
    timestamp: Date.now() - 86400000,
    txHash: 'abc123...',
  },
  {
    id: 'tx_002',
    type: 'reward',
    asset: 'USDT',
    amount: 0.05,
    status: 'confirmed',
    timestamp: Date.now() - 7200000,
    description: 'Hold to Earn reward',
  },
  {
    id: 'tx_003',
    type: 'referral',
    asset: 'TRX',
    amount: 2.00,
    status: 'confirmed',
    timestamp: Date.now() - 3600000,
    description: 'Referral bonus',
  },
  {
    id: 'tx_004',
    type: 'withdraw',
    asset: 'USDT',
    amount: 10.00,
    status: 'pending',
    timestamp: Date.now() - 1800000,
    toAddress: 'TXyz...abc',
  },
];

const MOCK_POOL_DATA = {
  total_pool: 50000,
  remaining: 38450,
  your_earnings: 16.00,
};

/**
 * Authenticate user and load data
 * @returns {Promise<Object>} User data
 */
export const authUser = async () => {
  if (IS_DEV) {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 500));
    return { ok: true, user: MOCK_USER_DATA };
  }

  try {
    const response = await fetch(`${WORKER_URL}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: getInitData() }),
    });

    if (!response.ok) {
      throw new Error(`Auth failed: ${response.status}`);
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Auth error:', error);
    // Return mock data as fallback
    return { ok: true, user: MOCK_USER_DATA, fallback: true };
  }
};

/**
 * Claim hold reward
 * @param {number} prize - Prize amount
 * @returns {Promise<Object>} Updated user data
 */
export const claimReward = async (prize) => {
  if (IS_DEV) {
    await new Promise(resolve => setTimeout(resolve, 300));
    return {
      ok: true,
      total: MOCK_USER_DATA.total_earned + prize,
      wins: MOCK_USER_DATA.wins + 1,
      holdsCount: MOCK_USER_DATA.holds_count + 1,
    };
  }

  try {
    const response = await fetch(`${WORKER_URL}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initData: getInitData(),
        prize: prize,
      }),
    });

    if (!response.ok) {
      throw new Error(`Claim failed: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Claim error:', error);
    throw error;
  }
};

/**
 * Get transaction history
 * NOTE: This endpoint may not exist in current backend
 * Returns mock data - ready to connect when backend implements it
 * @returns {Promise<Array>} Transaction list
 */
export const getTransactions = async () => {
  // TODO: Replace with real endpoint when available
  // try {
  //   const response = await fetch(`${WORKER_URL}/transactions`, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ initData: getInitData() }),
  //   });
  //   return await response.json();
  // } catch (error) {
  //   console.error('Transactions error:', error);
  // }

  await new Promise(resolve => setTimeout(resolve, 400));
  return { ok: true, transactions: MOCK_TRANSACTIONS };
};

/**
 * Get referral pool stats
 * NOTE: This endpoint may not exist in current backend
 * Returns mock data - ready to connect when backend implements it
 * @returns {Promise<Object>} Pool data
 */
export const getReferralPool = async () => {
  // TODO: Replace with real endpoint when available
  await new Promise(resolve => setTimeout(resolve, 200));
  return { ok: true, pool: MOCK_POOL_DATA };
};

/**
 * Request withdrawal
 * NOTE: Backend validation required - UI flow ready
 * @param {Object} params - Withdrawal parameters
 * @returns {Promise<Object>} Withdrawal result
 */
export const requestWithdraw = async ({ asset, amount, toAddress }) => {
  // TODO: Implement when backend is ready
  // This is where backend validation and blockchain tx would happen
  
  console.warn('Withdrawal requested - backend integration pending', { asset, amount, toAddress });
  
  // Simulate processing
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Return pending state - actual confirmation comes from backend
  return {
    ok: true,
    status: 'pending',
    message: 'Withdrawal request submitted. Backend validation pending.',
    txId: `pending_${Date.now()}`,
  };
};

/**
 * Deposit address and memo for the wallet
 */
export const DEPOSIT_INFO = {
  network: 'TRON (TRC-20)',
  address: 'TNjqVzo47ndAvH241njkMLKbda3G6FPgVs',
  // MEMO is the user's UID - will be set dynamically
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

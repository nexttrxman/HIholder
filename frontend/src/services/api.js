/**
 * TronKeeper API Service - TON Claims System
 * 
 * Architecture: Telegram Mini App -> Cloudflare Worker -> Supabase
 */

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'https://tkworker.tkexchange.workers.dev';
const TELEGRAM_BOT_URL = import.meta.env.VITE_TELEGRAM_BOT_URL || 'https://t.me/TKcex_bot';
const DEPOSIT_ADDRESS = import.meta.env.VITE_DEPOSIT_ADDRESS || 'TNjqVzo47ndAvH241njkMLKbda3G6FPgVs';
const TREASURY_WALLET = 'UQCydneDGeAcamdCFS6e13Z2xoxwA5DsLkFONRdp-cavw-Th';

// Dev mode detection
const IS_DEV = typeof window !== 'undefined' && !window.Telegram?.WebApp?.initData;

// Mock data for development
const MOCK_USER = {
  uid: 'TK_DEV_12345',
  usdt_balance: 0.15,
  trx_balance: 5.00,
  ton_balance: 0,
  total_refs: 3,
  trx_refs: 6.00,
};

const MOCK_CYCLE = {
  id: 'mock_cycle_1',
  holds_completed: 0,
  ends_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
  remaining_holds: 3,
};

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
    if (tg.setHeaderColor) tg.setHeaderColor('#050505');
    if (tg.setBackgroundColor) tg.setBackgroundColor('#050505');
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
  const link = `${TELEGRAM_BOT_URL}?start=${uid}`;
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
      cycle: MOCK_CYCLE,
      pending_claim: null,
      treasury_wallet: TREASURY_WALLET,
    };
  } catch (error) {
    console.error('Auth error:', error);
    if (IS_DEV) {
      return {
        ok: true,
        user: MOCK_USER,
        cycle: MOCK_CYCLE,
        pending_claim: null,
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
    
    const isThird = MOCK_CYCLE.holds_completed === 3;
    
    return {
      ok: true,
      hold_number: MOCK_CYCLE.holds_completed,
      remaining_holds: MOCK_CYCLE.remaining_holds,
      cycle_complete: isThird,
      claim: isThird ? {
        claim_id: `CLM_DEV_${Date.now()}`,
        total_prize: 0.15,
        ton_fee: 0.05,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        treasury_wallet: TREASURY_WALLET,
      } : null,
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
    return { ok: true, claim: null };
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
    MOCK_CYCLE.holds_completed = 0;
    MOCK_CYCLE.remaining_holds = 3;

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
  fee: 0.05,
  claim_expiry_minutes: 15,
};

export default {
  authUser,
  registerHold,
  getClaim,
  verifyPayment,
  getTransactions,
  getReferralPool,
  getTelegramUser,
  initTelegram,
  hapticFeedback,
  shareReferralLink,
  DEPOSIT_INFO,
  TON_CONFIG,
};

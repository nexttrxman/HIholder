import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  authUser,
  claimReward,
  getTransactions,
  getReferralPool,
  getTelegramUser,
  initTelegram,
  DEPOSIT_INFO,
} from '@/services/api';

const WalletContext = createContext(null);

// Hold configuration
const HOLD_DURATION = 3000; // 3 seconds
const MAX_HOLDS_PER_CYCLE = 3;
const HOLD_RESET_HOURS = 6;

export function WalletProvider({ children }) {
  // User state
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Balances
  const [usdtBalance, setUsdtBalance] = useState(0);
  const [trxBalance, setTrxBalance] = useState(0);

  // Hold to Earn state
  const [totalEarned, setTotalEarned] = useState(0);
  const [wins, setWins] = useState(0);
  const [holdsCount, setHoldsCount] = useState(0);
  const [holdsResetAt, setHoldsResetAt] = useState(null);
  const [lastPrize, setLastPrize] = useState(null);

  // Referral state
  const [totalRefs, setTotalRefs] = useState(0);
  const [trxFromRefs, setTrxFromRefs] = useState(0);
  const [referralPool, setReferralPool] = useState({
    total: 50000,
    remaining: 50000,
  });

  // Transactions
  const [transactions, setTransactions] = useState([]);
  const [loadingTransactions, setLoadingTransactions] = useState(false);

  // User identification
  const [uid, setUid] = useState(null);

  /**
   * Initialize app and load user data
   */
  const loadUserData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Initialize Telegram
      initTelegram();

      // Get Telegram user info
      const tgUser = getTelegramUser();
      setUser(tgUser);
      setUid(tgUser?.id?.toString() || 'guest');

      // Auth and get user data from backend
      const result = await authUser();

      if (result.ok && result.user) {
        const userData = result.user;
        setTotalEarned(userData.total_earned || 0);
        setWins(userData.wins || 0);
        setHoldsCount(userData.holds_count || 0);
        setHoldsResetAt(userData.holds_reset_at || null);
        setTotalRefs(userData.total_refs || 0);
        setTrxFromRefs(userData.trx_refs || 0);
        setTrxBalance(userData.trx_balance || 0);
        setUsdtBalance(userData.usdt_balance || userData.total_earned || 0);

        // Set UID from backend if available
        if (userData.uid) {
          setUid(userData.uid);
        }
      }

      // Load referral pool data
      const poolResult = await getReferralPool();
      if (poolResult.ok && poolResult.pool) {
        setReferralPool({
          total: poolResult.pool.total_pool,
          remaining: poolResult.pool.remaining,
        });
      }
    } catch (err) {
      console.error('Failed to load user data:', err);
      setError('Failed to connect. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Refresh user data
   */
  const refreshData = useCallback(async () => {
    try {
      const result = await authUser();
      if (result.ok && result.user) {
        const userData = result.user;
        setTotalEarned(userData.total_earned || 0);
        setWins(userData.wins || 0);
        setHoldsCount(userData.holds_count || 0);
        setHoldsResetAt(userData.holds_reset_at || null);
        setTotalRefs(userData.total_refs || 0);
        setTrxFromRefs(userData.trx_refs || 0);
        setTrxBalance(userData.trx_balance || 0);
        setUsdtBalance(userData.usdt_balance || userData.total_earned || 0);
      }
    } catch (err) {
      console.error('Failed to refresh data:', err);
    }
  }, []);

  /**
   * Load transaction history
   */
  const loadTransactions = useCallback(async () => {
    setLoadingTransactions(true);
    try {
      const result = await getTransactions();
      if (result.ok && result.transactions) {
        setTransactions(result.transactions);
      }
    } catch (err) {
      console.error('Failed to load transactions:', err);
    } finally {
      setLoadingTransactions(false);
    }
  }, []);

  /**
   * Claim a hold reward
   */
  const claim = useCallback(async (prize) => {
    try {
      const result = await claimReward(prize);
      if (result.ok) {
        setTotalEarned(result.total || totalEarned + prize);
        setWins(result.wins || wins + 1);
        setHoldsCount(result.holdsCount || holdsCount + 1);
        setUsdtBalance(result.total || usdtBalance + prize);
        setLastPrize(prize);
        return { success: true };
      }
      return { success: false, error: 'Claim failed' };
    } catch (err) {
      console.error('Claim error:', err);
      return { success: false, error: err.message };
    }
  }, [totalEarned, wins, holdsCount, usdtBalance]);

  /**
   * Check if holds are available
   */
  const canHold = useCallback(() => {
    if (holdsCount >= MAX_HOLDS_PER_CYCLE) {
      if (holdsResetAt && Date.now() < holdsResetAt) {
        return false;
      }
      // Reset if time has passed
      setHoldsCount(0);
    }
    return true;
  }, [holdsCount, holdsResetAt]);

  /**
   * Get remaining holds
   */
  const remainingHolds = MAX_HOLDS_PER_CYCLE - holdsCount;

  /**
   * Get time until holds reset
   */
  const getResetTime = useCallback(() => {
    if (!holdsResetAt) return null;
    const diff = holdsResetAt - Date.now();
    if (diff <= 0) return null;
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  }, [holdsResetAt]);

  /**
   * Get referral link
   */
  const telegramBotUrl = import.meta.env.VITE_TELEGRAM_BOT_URL || 'https://t.me/TKcex_bot';
  const referralLink = `${telegramBotUrl}?start=${uid}`;

  /**
   * Get deposit info with user's memo
   */
  const depositInfo = {
    ...DEPOSIT_INFO,
    memo: uid || 'loading...',
  };

  // Initial load
  useEffect(() => {
    loadUserData();
  }, [loadUserData]);

  const value = {
    // User
    user,
    uid,
    loading,
    error,

    // Balances
    usdtBalance,
    trxBalance,

    // Hold to Earn
    totalEarned,
    wins,
    holdsCount,
    remainingHolds,
    canHold,
    getResetTime,
    claim,
    lastPrize,
    HOLD_DURATION,
    MAX_HOLDS_PER_CYCLE,

    // Referrals
    totalRefs,
    trxFromRefs,
    referralPool,
    referralLink,

    // Transactions
    transactions,
    loadingTransactions,
    loadTransactions,

    // Deposit
    depositInfo,

    // Actions
    refreshData,
    loadUserData,
  };

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}

export default WalletContext;

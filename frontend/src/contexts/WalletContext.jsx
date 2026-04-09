import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
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

// Helper: normaliza cualquier valor de fecha a timestamp ms (number)
const toTimestamp = (val) => {
  if (!val) return null;
  if (typeof val === 'number') return val;
  const ms = new Date(val).getTime();
  return isNaN(ms) ? null : ms;
};

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
  // Siempre guardado como timestamp ms (number) o null
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
   * Aplica datos de usuario al estado del contexto
   */
  const applyUserData = useCallback((userData) => {
    setTotalEarned(userData.total_earned || 0);
    setWins(userData.wins || 0);
    setHoldsCount(userData.holds_count || 0);
    // Normalizar a timestamp ms siempre
    setHoldsResetAt(toTimestamp(userData.holds_reset_at));
    setTotalRefs(userData.total_refs || 0);
    setTrxFromRefs(userData.trx_refs || 0);
    setTrxBalance(userData.trx_balance || 0);
    setUsdtBalance(userData.usdt_balance || userData.total_earned || 0);
    if (userData.uid) setUid(userData.uid);
  }, []);

  /**
   * Initialize app and load user data
   */
  const loadUserData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      initTelegram();

      const tgUser = getTelegramUser();
      setUser(tgUser);
      setUid(tgUser?.id?.toString() || 'guest');

      const result = await authUser();
      if (result.ok && result.user) {
        applyUserData(result.user);
      }

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
  }, [applyUserData]);

  /**
   * Refresh user data — expuesto para HoldButton y otros componentes
   */
  const refreshUser = useCallback(async () => {
    try {
      const result = await authUser();
      if (result.ok && result.user) {
        applyUserData(result.user);
      }
      return result;
    } catch (err) {
      console.error('Failed to refresh user:', err);
    }
  }, [applyUserData]);

  // Alias para compatibilidad con código viejo que usa refreshData
  const refreshData = refreshUser;

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
   * Claim a hold reward — el prize viene del servidor vía HoldButton
   */
  const claim = useCallback(async (prize) => {
    try {
      const result = await claimReward(prize);
      if (result.ok) {
        setTotalEarned(result.total ?? (totalEarned + (prize || 0)));
        setWins(result.wins ?? (wins + 1));
        setHoldsCount(result.holdsCount ?? (holdsCount + 1));
        setUsdtBalance(result.total ?? (usdtBalance + (prize || 0)));
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
   * remainingHolds — REACTIVO con useMemo
   * Cuando holdsResetAt ya pasó, trata holdsCount como 0
   */
  const remainingHolds = useMemo(() => {
    const resetExpired = holdsResetAt ? Date.now() >= holdsResetAt : true;
    const effectiveCount = (holdsCount >= MAX_HOLDS_PER_CYCLE && resetExpired)
      ? 0
      : holdsCount;
    return Math.max(MAX_HOLDS_PER_CYCLE - effectiveCount, 0);
  }, [holdsCount, holdsResetAt]);

  /**
   * canHold — devuelve true si el usuario puede hacer hold ahora mismo
   */
  const canHold = useCallback(() => {
    if (holdsCount < MAX_HOLDS_PER_CYCLE) return true;
    if (!holdsResetAt) return false;
    return Date.now() >= holdsResetAt;
  }, [holdsCount, holdsResetAt]);

  /**
   * getResetTime — string "Xh Ym" o null si no hay reset pendiente
   */
  const getResetTime = useCallback(() => {
    if (!holdsResetAt) return null;
    const diff = holdsResetAt - Date.now();
    if (diff <= 0) return null;
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  }, [holdsResetAt]);

  const telegramBotUrl = import.meta.env.VITE_TELEGRAM_BOT_URL || 'https://t.me/TKcex_bot';
  const referralLink = `${telegramBotUrl}?start=${uid}`;

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
    setUser,
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
    refreshUser,
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

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import {
  authUser,
  registerHold,
  getClaim,
  verifyPayment,
  getTransactions,
  getReferralPool,
  getTelegramUser,
  initTelegram,
  applyLocalBalanceDelta,
  describeApiError,
  DEPOSIT_INFO,
  TON_CONFIG,
} from '@/services/api';

const WalletContext = createContext(null);

const HOLD_DURATION = 3000; // 3 seconds to hold
const MAX_HOLDS_PER_CYCLE = 3;

// Trades executed without a backend (dev/preview) live here so History keeps
// showing them after a reload.
const LOCAL_TX_KEY = 'tk_local_tx_v1';
const LOCAL_TX_LIMIT = 60;

function readLocalTransactions() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_TX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeLocalTransactions(list) {
  try {
    window.localStorage.setItem(LOCAL_TX_KEY, JSON.stringify(list));
  } catch (e) {
    /* storage unavailable - ignore */
  }
}

export function WalletProvider({ children }) {
  // User state
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Balances (internal wallet)
  const [usdtBalance, setUsdtBalance] = useState(0);
  const [trxBalance, setTrxBalance] = useState(0);
  const [tonBalance, setTonBalance] = useState(0);

  // Cycle state
  const [cycle, setCycle] = useState(null);
  const [holdsCompleted, setHoldsCompleted] = useState(0);
  const [remainingHolds, setRemainingHolds] = useState(3);
  const [cycleEndsAt, setCycleEndsAt] = useState(null);

  // Claim state
  const [pendingClaim, setPendingClaim] = useState(null);
  const [claimExpiresAt, setClaimExpiresAt] = useState(null);
  const [lastPrize, setLastPrize] = useState(null);

  // Referral state
  const [totalRefs, setTotalRefs] = useState(0);
  const [trxFromRefs, setTrxFromRefs] = useState(0);
  const [referralPool, setReferralPool] = useState({ total: 50000, remaining: 50000 });

  // Transactions
  const [serverTransactions, setTransactions] = useState([]);
  const [localTransactions, setLocalTransactions] = useState(readLocalTransactions);
  const [loadingTransactions, setLoadingTransactions] = useState(false);

  // Backend ledger + locally executed trades (dev mode), newest first.
  const transactions = useMemo(
    () =>
      [...localTransactions, ...serverTransactions].sort(
        (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
      ),
    [localTransactions, serverTransactions]
  );

  // User identification
  const [uid, setUid] = useState(null);

  /**
   * Load user data and cycle info
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

      if (result.ok) {
        const { user: userData, cycle: cycleData, pending_claim } = result;
        
        // Set balances
        setUsdtBalance(userData.usdt_balance || 0);
        setTrxBalance(userData.trx_balance || 0);
        setTonBalance(userData.ton_balance || 0);
        setTotalRefs(userData.total_refs || 0);
        setTrxFromRefs(userData.trx_refs || 0);
        
        if (userData.uid) setUid(userData.uid);

        // Set cycle
        if (cycleData) {
          setCycle(cycleData);
          setHoldsCompleted(cycleData.holds_completed || 0);
          setRemainingHolds(cycleData.remaining_holds ?? (MAX_HOLDS_PER_CYCLE - cycleData.holds_completed));
          setCycleEndsAt(cycleData.ends_at);
        }

        // Set pending claim
        if (pending_claim) {
          setPendingClaim(pending_claim);
          setClaimExpiresAt(pending_claim.expires_at);
        }
      }

      // Load referral pool
      const poolResult = await getReferralPool();
      if (poolResult.ok && poolResult.pool) {
        setReferralPool({
          total: poolResult.pool.total_pool,
          remaining: poolResult.pool.remaining,
        });
        if (poolResult.pool.your_earnings) {
          setTrxFromRefs(poolResult.pool.your_earnings);
        }
      }
    } catch (err) {
      console.error('Failed to load user data:', err);
      setError(describeApiError(err));
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
      if (result.ok) {
        const { user: userData, cycle: cycleData, pending_claim } = result;
        
        setUsdtBalance(userData.usdt_balance || 0);
        setTrxBalance(userData.trx_balance || 0);
        setTonBalance(userData.ton_balance || 0);
        
        if (cycleData) {
          setCycle(cycleData);
          setHoldsCompleted(cycleData.holds_completed || 0);
          setRemainingHolds(cycleData.remaining_holds ?? (MAX_HOLDS_PER_CYCLE - cycleData.holds_completed));
          setCycleEndsAt(cycleData.ends_at);
        }

        setPendingClaim(pending_claim || null);
        setClaimExpiresAt(pending_claim?.expires_at || null);
      }
    } catch (err) {
      console.error('Failed to refresh data:', err);
    }
  }, []);

  /**
   * Register a hold
   */
  const doHold = useCallback(async (prize) => {
    try {
      const result = await registerHold(prize);
      
      if (result.ok) {
        setHoldsCompleted(result.hold_number);
        setRemainingHolds(result.remaining_holds);
        setLastPrize(prize);

        // If cycle complete, set pending claim
        if (result.cycle_complete && result.claim) {
          setPendingClaim(result.claim);
          setClaimExpiresAt(result.claim.expires_at);
        }

        return { success: true, claim: result.claim };
      }
      
      return { success: false, error: result.error || 'Hold failed' };
    } catch (err) {
      console.error('Hold error:', err);
      return { success: false, error: err.message };
    }
  }, []);

  /**
   * Verify TON payment and credit claim
   * @param {string} claimId
   * @param {string} senderAddress - TonConnect wallet address (raw "0:hex")
   * @returns {Promise<{success:boolean, credited?:number, error?:string, pending?:boolean}>}
   */
  const verifyClaim = useCallback(async (claimId, senderAddress) => {
    try {
      const result = await verifyPayment(claimId, senderAddress);

      if (result.ok) {
        setUsdtBalance(result.new_balance ?? (usdtBalance + (result.credited || 0)));
        setPendingClaim(null);
        setClaimExpiresAt(null);
        setHoldsCompleted(0);
        setRemainingHolds(MAX_HOLDS_PER_CYCLE);
        await refreshData();
        return { success: true, credited: result.credited };
      }

      // Backend says payment not on chain yet — caller should retry.
      if (result.pending) {
        return { success: false, pending: true, error: result.error };
      }

      return { success: false, error: result.error };
    } catch (err) {
      console.error('Verify claim error:', err);
      return { success: false, error: err.message };
    }
  }, [usdtBalance, refreshData]);

  /**
   * Apply an internal USDT movement (trading) to the cached balance.
   * Also mirrors it into the dev-mode mock so reloads stay consistent.
   */
  const applyUsdtDelta = useCallback((delta) => {
    const amount = Number(delta) || 0;
    setUsdtBalance((prev) => Math.max(0, prev + amount));
    applyLocalBalanceDelta(amount);
  }, []);

  /**
   * Apply an internal movement on any wallet asset (used when selling the
   * TRX/TON balance into USDT from the Trade panel).
   */
  const applyAssetDelta = useCallback((asset, delta) => {
    const amount = Number(delta) || 0;
    if (asset === 'TRX') setTrxBalance((prev) => Math.max(0, prev + amount));
    else if (asset === 'TON') setTonBalance((prev) => Math.max(0, prev + amount));
    else applyUsdtDelta(amount);
  }, [applyUsdtDelta]);

  /**
   * Prepend a locally executed trade to the activity feed.
   */
  const pushLocalTransaction = useCallback((tx) => {
    setLocalTransactions((prev) => {
      const next = [tx, ...prev].slice(0, LOCAL_TX_LIMIT);
      writeLocalTransactions(next);
      return next;
    });
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
   * Check if can hold
   */
  const canHold = useCallback(() => {
    // Can't hold if there's a pending claim
    if (pendingClaim) return false;
    // Can't hold if all 3 completed
    if (holdsCompleted >= MAX_HOLDS_PER_CYCLE) return false;
    return true;
  }, [pendingClaim, holdsCompleted]);

  /**
   * Get time until cycle ends
   */
  const getCycleResetTime = useCallback(() => {
    if (!cycleEndsAt) return null;
    const diff = new Date(cycleEndsAt) - new Date();
    if (diff <= 0) return null;
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  }, [cycleEndsAt]);

  /**
   * Get seconds until claim expires
   */
  const getClaimSecondsRemaining = useCallback(() => {
    if (!claimExpiresAt) return 0;
    const diff = new Date(claimExpiresAt) - new Date();
    return Math.max(0, Math.floor(diff / 1000));
  }, [claimExpiresAt]);

  /**
   * Referral link
   */
  const telegramBotUrl = import.meta.env.VITE_TELEGRAM_BOT_URL || 'https://t.me/TKcex_bot';
  const referralLink = `${telegramBotUrl}?start=${uid}`;

  /**
   * Deposit info with memo
   */
  const depositInfo = {
    ...DEPOSIT_INFO,
    memo: uid || 'loading...',
  };

  // Initial load
  useEffect(() => {
    loadUserData();
  }, [loadUserData]);

  // Check claim expiry
  useEffect(() => {
    if (!claimExpiresAt) return;
    
    const checkExpiry = () => {
      const remaining = getClaimSecondsRemaining();
      if (remaining <= 0) {
        setPendingClaim(null);
        setClaimExpiresAt(null);
        // The reward went unclaimed, so it is forfeited and the cycle restarts
        // at zero holds. Without this the button stays locked at 3/3 (canHold
        // is false) until the 8h window ends.
        setHoldsCompleted(0);
        setRemainingHolds(MAX_HOLDS_PER_CYCLE);
        refreshData();
      }
    };

    const interval = setInterval(checkExpiry, 1000);
    return () => clearInterval(interval);
  }, [claimExpiresAt, getClaimSecondsRemaining, refreshData]);

  const value = {
    // User
    user,
    uid,
    loading,
    error,

    // Balances
    usdtBalance,
    trxBalance,
    tonBalance,

    // Hold/Cycle
    holdsCompleted,
    remainingHolds,
    canHold,
    doHold,
    getCycleResetTime,
    lastPrize,
    HOLD_DURATION,
    MAX_HOLDS_PER_CYCLE,

    // Claim
    pendingClaim,
    claimExpiresAt,
    getClaimSecondsRemaining,
    verifyClaim,
    treasuryWallet: TON_CONFIG.treasury_wallet,
    tonFee: TON_CONFIG.fee,

    // Referrals
    totalRefs,
    trxFromRefs,
    referralPool,
    referralLink,

    // Transactions
    transactions,
    serverTransactions,
    localTransactions,
    loadingTransactions,
    loadTransactions,
    pushLocalTransaction,

    // Balance mutations (used by the Trade panel)
    applyUsdtDelta,
    applyAssetDelta,

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

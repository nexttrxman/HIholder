import { Header } from '@/components/layout/Header';
import { HoldButton } from '@/components/earn/HoldButton';
import { HoldSection } from '@/components/earn/HoldSection';
import { useWallet } from '@/contexts/WalletContext';
import { ArrowDownLeft, ArrowUpRight, Gift, Clock, Wallet } from 'lucide-react';
import { motion } from 'framer-motion';

export function HomePage({ onNavigate, onOpenWithdraw, onClaimReady, onOpenClaim }) {
  const { 
    transactions, 
    usdtBalance, 
    trxBalance,
    pendingClaim,
    getClaimSecondsRemaining,
    holdsCompleted,
    remainingHolds,
    totalRefs,
  } = useWallet();

  const recentTx = transactions.slice(0, 3);
  const claimSeconds = getClaimSecondsRemaining();

  const formatClaimTime = (secs) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="pb-4" data-testid="home-page">
      <Header />

      {/* Quick Actions */}
      <div className="px-4 py-3">
        <div className="flex gap-3">
          <motion.button
            onClick={() => onNavigate('wallet')}
            data-testid="quick-deposit"
            className="flex-1 py-3 rounded-2xl bg-brand-green/10 border border-brand-green/20 flex items-center justify-center gap-2 text-brand-green font-semibold active:scale-95 transition-all"
            whileTap={{ scale: 0.95 }}
          >
            <ArrowDownLeft className="w-4 h-4" />
            Deposit
          </motion.button>
          <motion.button
            onClick={onOpenWithdraw}
            data-testid="quick-withdraw"
            className="flex-1 py-3 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center gap-2 text-white/80 font-semibold active:scale-95 transition-all"
            whileTap={{ scale: 0.95 }}
          >
            <ArrowUpRight className="w-4 h-4" />
            Withdraw
          </motion.button>
        </div>
      </div>

      {/* Pending Claim Banner */}
      {pendingClaim && claimSeconds > 0 && (
        <motion.div
          className="mx-4 mb-4"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <button
            onClick={onOpenClaim}
            className="w-full p-4 rounded-2xl bg-gradient-to-r from-brand-green/20 to-yellow-500/20 border border-brand-green/30 flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-brand-green/20 flex items-center justify-center">
                <Gift className="w-6 h-6 text-brand-green" />
              </div>
              <div className="text-left">
                <p className="font-semibold text-white">Reward Ready!</p>
                <p className="text-sm text-brand-green font-bold">${pendingClaim.total_prize.toFixed(2)} USDT</p>
              </div>
            </div>
            <div className="text-right">
              <div className="flex items-center gap-1 text-yellow-500">
                <Clock className="w-4 h-4" />
                <span className="font-mono font-bold">{formatClaimTime(claimSeconds)}</span>
              </div>
              <p className="text-xs text-white/40">Tap to claim</p>
            </div>
          </button>
        </motion.div>
      )}

      {/* Hold to Earn Section */}
      <div className="px-4 py-4">
        <HoldButton onClaimReady={onClaimReady} />
      </div>

      {/* Stats Row */}
      <div className="px-4 py-2">
        <div className="flex justify-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-brand-green/10 flex items-center justify-center">
              <Wallet className="w-4 h-4 text-brand-green" />
            </div>
            <div>
              <p className="text-xs text-white/40">Balance</p>
              <p className="text-sm font-semibold text-white">${usdtBalance.toFixed(2)}</p>
            </div>
          </div>
          
          <div className="w-px h-10 bg-white/10" />
          
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-brand-red/10 flex items-center justify-center">
              <Gift className="w-4 h-4 text-brand-red" />
            </div>
            <div>
              <p className="text-xs text-white/40">Invites</p>
              <p className="text-sm font-semibold text-white">{totalRefs}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Activity */}
      {recentTx.length > 0 && (
        <div className="px-4 mt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white/70">Recent Activity</h3>
            <button 
              onClick={() => onNavigate('history')}
              className="text-xs text-brand-green hover:underline"
            >
              View all
            </button>
          </div>
          <div className="space-y-2">
            {recentTx.map((tx) => (
              <motion.div
                key={tx.id}
                className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/5"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  tx.type === 'withdraw' ? 'bg-brand-red/10' : 'bg-brand-green/10'
                }`}>
                  {tx.type === 'withdraw' ? (
                    <ArrowUpRight className="w-4 h-4 text-brand-red" />
                  ) : (
                    <ArrowDownLeft className="w-4 h-4 text-brand-green" />
                  )}
                </div>
                <div className="flex-1">
                  <p className="text-sm text-white capitalize">{tx.type}</p>
                  <p className="text-xs text-white/40">
                    {new Date(tx.timestamp).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <p className={`text-sm font-semibold ${
                  tx.type === 'withdraw' ? 'text-brand-red' : 'text-brand-green'
                }`}>
                  {tx.type === 'withdraw' ? '-' : '+'}
                  {tx.asset === 'USDT' ? '$' : ''}{tx.amount.toFixed(2)}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default HomePage;

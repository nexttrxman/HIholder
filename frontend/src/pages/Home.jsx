import { Header } from '@/components/layout/Header';
import { HoldButton } from '@/components/earn/HoldButton';
import { HoldSection } from '@/components/earn/HoldSection';
import { useWallet } from '@/contexts/WalletContext';
import { useTrade } from '@/contexts/TradeContext';
import { ArrowDownLeft, ArrowUpRight, Gift, Clock, Wallet, TrendingUp, TrendingDown } from 'lucide-react';
import { motion } from 'framer-motion';

const ACTIVITY_STYLE = {
  deposit: { icon: ArrowDownLeft, tone: 'text-brand-green', bg: 'bg-brand-green/10', sign: '+' },
  reward: { icon: Gift, tone: 'text-brand-green', bg: 'bg-brand-green/10', sign: '+' },
  referral: { icon: Gift, tone: 'text-brand-green', bg: 'bg-brand-green/10', sign: '+' },
  buy: { icon: TrendingUp, tone: 'text-brand-green', bg: 'bg-brand-green/10', sign: '-' },
  sell: { icon: TrendingDown, tone: 'text-brand-red', bg: 'bg-brand-red/10', sign: '+' },
  withdraw: { icon: ArrowUpRight, tone: 'text-brand-red', bg: 'bg-brand-red/10', sign: '-' },
};

export function HomePage({ onNavigate, onClaimReady, onOpenClaim }) {
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
  const { positionsValue } = useTrade();

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

      {/* Pending Claim Banner */}
      {pendingClaim && claimSeconds > 0 && (
        <motion.div
          className="mx-4 mb-4"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <button
            onClick={onOpenClaim}
            className="w-full p-4 rounded-2xl glass-card !border-brand-gold/25 flex items-center justify-between shadow-glow-gold"
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
              <div className="flex items-center gap-1 text-brand-gold">
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
              {positionsValue > 0 && (
                <p className="text-[10px] text-brand-green">${positionsValue.toFixed(2)} in trades</p>
              )}
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
              onClick={() => onNavigate('wallet', 'activity')}
              className="text-xs text-brand-green hover:underline"
            >
              View all
            </button>
          </div>
          <div className="space-y-2">
            {recentTx.map((tx) => {
              const style = ACTIVITY_STYLE[tx.type] || ACTIVITY_STYLE.deposit;
              const Icon = style.icon;
              return (
                <motion.div
                  key={tx.id}
                  className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/5"
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${style.bg}`}>
                    <Icon className={`w-4 h-4 ${style.tone}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white capitalize">{tx.type}</p>
                    <p className="text-xs text-white/40 truncate">
                      {tx.description
                        || new Date(tx.timestamp).toLocaleDateString('en-US', {
                             month: 'short',
                             day: 'numeric',
                             hour: '2-digit',
                             minute: '2-digit',
                           })}
                    </p>
                  </div>
                  <p className={`text-sm font-semibold ${style.tone}`}>
                    {style.sign}
                    {tx.asset === 'USDT' ? '$' : ''}{tx.amount.toFixed(2)}
                  </p>
                </motion.div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default HomePage;

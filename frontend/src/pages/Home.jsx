import { Header } from '@/components/layout/Header';
import { HoldSection } from '@/components/earn/HoldSection';
import { useWallet } from '@/contexts/WalletContext';
import { ArrowDownLeft, ArrowUpRight, Clock } from 'lucide-react';
import { motion } from 'framer-motion';

export function HomePage({ onNavigate, onOpenWithdraw }) {
  const { transactions, usdtBalance, trxBalance } = useWallet();

  // Get last 3 transactions
  const recentTx = transactions.slice(0, 3);

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

      {/* Hold to Earn Section */}
      <HoldSection />

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

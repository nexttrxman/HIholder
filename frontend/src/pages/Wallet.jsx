import { useEffect, useState } from 'react';
import { useWallet } from '@/contexts/WalletContext';
import { useTrade } from '@/contexts/TradeContext';
import { BalanceCard } from '@/components/wallet/BalanceCard';
import { DepositInfo } from '@/components/wallet/DepositInfo';
import { TransactionList } from '@/components/transactions/TransactionList';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Wallet as WalletIcon, History as HistoryIcon } from 'lucide-react';
import { formatUsd } from '@/lib/trade';

const TETHER_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMzkuNDMgMjk1LjI3Ij48cGF0aCBmaWxsPSIjNTBBRjk1IiBkPSJNNjIuMTUgMS40NWwtNjIuMTUgMTE4LjIgNzIuMDMgNDAuNTRoMTk1LjI4bDcyLjA0LTQwLjU0TDI3Ny4xOSAxLjQ1SDYyLjE1eiIvPjxwYXRoIGZpbGw9IiNGRkYiIGQ9Ik0xOTEuMTkgMTQ0LjhjLTMuMTkuMjctMTkuNzYgMS40Ny0yMS41NSAxLjQ3cy0xOC4zNi0xLjItMjEuNTUtMS40N2MtNDIuNTEtMy41NS03NC40Ny0xNC45OS03NC40Ny0yOC43NXMzMS45Ni0yNS4yIDc0LjQ3LTI4Ljc1djQ1Ljc1YzMuMjMuMjMgMTguNTMgMS40NSAyMS42OCAxLjQ1czE4LjIzLTEuMjggMjEuNDItMS40NXYtNDUuNzVjNDIuNDYgMy41NSA3NC4zOCAxNS4wMiA3NC4zOCAyOC43NXMtMzEuOTIgMjUuMi03NC4zOCAyOC43NXptMC02MS41OHYtNDAuNTRoNTcuNzl2LTI4LjQ5aC0xNTguNnYyOC40OWg1Ny43OXY0MC41NGMtNDguMjUgNC4yLTg0LjQ5IDE4Ljg2LTg0LjQ5IDM2LjNzMzYuMjQgMzIuMTIgODQuNDkgMzYuMzJ2MTE1LjQ2aDQzLjAydi0xMTUuNDZjNDguMTgtNC4yIDg0LjM1LTE4Ljg1IDg0LjM1LTM2LjMycy0zNi4xNy0zMi4xMi04NC4zNS0zNi4zMnoiLz48L3N2Zz4=';
const TRX_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHBhdGggZmlsbD0iI0VGMDAyNyIgZD0iTTE2IDBjOC44MzcgMCAxNiA3LjE2MyAxNiAxNnMtNy4xNjMgMTYtMTYgMTZTMCAyNC44MzcgMCAxNiA3LjE2MyAwIDE2IDB6Ii8+PHBhdGggZmlsbD0iI0ZGRiIgZD0iTTIxLjkzMiA5LjkxM0w3Ljc1IDcuNjg3bDcuMDk5IDE3LjU4NiA5LjcwNi0xMi42MzgtMi42MjMtMi43MjJ6bS0uNzM0IDMuMjU2bC01LjY5MyA3LjM5NC00LjcxLTExLjY3NyA5LjM2NiAxLjUzNi0uOTYzIDIuNzQ3eiIvPjwvc3ZnPg==';

const SECTIONS = [
  { id: 'balance', label: 'Balance', icon: WalletIcon },
  { id: 'activity', label: 'Activity', icon: HistoryIcon },
];

/**
 * Wallet + History in one screen. The old standalone History tab now lives in
 * the "Activity" section here.
 */
export function WalletPage({ onOpenWithdraw, initialSection = 'balance' }) {
  const { usdtBalance, trxBalance } = useWallet();
  const { positionsValue, unrealizedPnl, positions } = useTrade();
  const [section, setSection] = useState(initialSection);
  const [showDeposit, setShowDeposit] = useState(false);

  // Deep link: Home -> "View all" opens the activity feed.
  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  const portfolioValue = usdtBalance + positionsValue;

  return (
    <div className="px-4 py-4 pb-8" data-testid="wallet-page">
      {/* Page Header */}
      <div className="mb-4">
        <h1 className="font-display text-2xl font-bold text-white">Wallet</h1>
        <p className="text-sm text-white/50 mt-1">Balances, trading and full history</p>
      </div>

      {/* Section switch */}
      <div
        className="flex gap-1 p-1 rounded-2xl bg-white/[0.04] border border-white/[0.06] mb-5"
        data-testid="wallet-sections"
      >
        {SECTIONS.map(({ id, label, icon: Icon }) => {
          const active = section === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              data-testid={`wallet-section-${id}`}
              className={`relative flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                active ? 'text-black' : 'text-white/50 hover:text-white/80'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="wallet-section-pill"
                  className="absolute inset-0 rounded-xl bg-white"
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                />
              )}
              <span className="relative flex items-center gap-2">
                <Icon className="w-4 h-4" />
                {label}
              </span>
            </button>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        {section === 'balance' ? (
          <motion.div
            key="balance"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
          >
            {/* Total Balance Hero */}
            <motion.div
              className="glass-card rounded-3xl p-6 mb-5 text-center"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              data-testid="wallet-total-balance"
            >
              <p className="text-xs text-white/40 uppercase tracking-wider mb-2">Total Balance</p>
              <div className="flex items-baseline justify-center gap-1">
                <span className="text-4xl font-bold text-white font-display tabular-nums">
                  ${usdtBalance.toFixed(2)}
                </span>
                <span className="text-lg text-brand-green">USDT</span>
              </div>
              <p className="text-sm text-white/40 mt-2">+ {trxBalance.toFixed(2)} TRX</p>

              {positionsValue > 0 && (
                <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-center justify-center gap-2 text-xs">
                  <span className="text-white/40">{positions.length} open position{positions.length > 1 ? 's' : ''}</span>
                  <span className="w-1 h-1 rounded-full bg-white/20" />
                  <span className="text-white/70">{formatUsd(positionsValue)}</span>
                  <span className={unrealizedPnl >= 0 ? 'text-brand-green' : 'text-brand-red'}>
                    {unrealizedPnl >= 0 ? '+' : ''}
                    {formatUsd(unrealizedPnl)}
                  </span>
                </div>
              )}
            </motion.div>

            {/* Balance Cards */}
            <div className="space-y-3 mb-5">
              <BalanceCard
                asset="USDT"
                amount={usdtBalance}
                label="Tether USD"
                icon={TETHER_ICON}
                onWithdraw={() => onOpenWithdraw('USDT')}
              />
              <BalanceCard
                asset="TRX"
                amount={trxBalance}
                label="TRON"
                icon={TRX_ICON}
                onWithdraw={() => onOpenWithdraw('TRX')}
              />
            </div>

            {/* Deposit Section Toggle */}
            <button
              onClick={() => setShowDeposit(!showDeposit)}
              data-testid="toggle-deposit"
              className="w-full flex items-center justify-between p-4 rounded-xl bg-white/5 border border-white/10 mb-3"
            >
              <span className="font-semibold text-white">Deposit Information</span>
              {showDeposit ? (
                <ChevronUp className="w-5 h-5 text-white/40" />
              ) : (
                <ChevronDown className="w-5 h-5 text-white/40" />
              )}
            </button>

            <AnimatePresence>
              {showDeposit && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <DepositInfo />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        ) : (
          <motion.div
            key="activity"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            data-testid="wallet-activity"
          >
            <TransactionList />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default WalletPage;

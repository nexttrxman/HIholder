import { useEffect, useState } from 'react';
import { useWallet } from '@/contexts/WalletContext';
import { useTrade } from '@/contexts/TradeContext';
import { BalanceCard } from '@/components/wallet/BalanceCard';
import { DepositInfo } from '@/components/wallet/DepositInfo';
import { TransactionList } from '@/components/transactions/TransactionList';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Wallet as WalletIcon, History as HistoryIcon } from 'lucide-react';
import { formatUsd } from '@/lib/trade';
import { UsdtIcon, TrxIcon } from '@/components/wallet/AssetIcons';

const SECTIONS = [
  { id: 'balance', label: 'Balance', icon: WalletIcon },
  { id: 'activity', label: 'Activity', icon: HistoryIcon },
];

/**
 * Panel de retiro por activo. Vive al pie de la página para que depósito y
 * retiro estén en la misma pantalla; abre el WithdrawModal existente en vez de
 * duplicar sus 395 líneas de validación.
 */
function WithdrawPanel({ asset, label, amount, icon, onWithdraw }) {
  return (
    <div
      className="glass-card rounded-2xl p-4 flex items-center gap-3"
      data-testid={`withdraw-panel-${asset.toLowerCase()}`}
    >
      <div
        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
          asset === 'USDT' ? 'bg-brand-green/10' : 'bg-brand-red/10'
        }`}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="sys-label truncate">{label}</p>
        <p className="text-sm font-semibold text-white tabular-nums">
          {asset === 'USDT' ? '$' : ''}
          {amount.toFixed(2)}
          {asset !== 'USDT' && <span className="text-white/40 ml-1">TRX</span>}
        </p>
      </div>
      <button
        onClick={onWithdraw}
        data-testid={`withdraw-open-${asset.toLowerCase()}`}
        className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-sm font-medium text-white/80 hover:bg-white/10 active:scale-95 transition-all shrink-0"
      >
        Withdraw
      </button>
    </div>
  );
}

/**
 * Wallet + History in one screen. The old standalone History tab now lives in
 * the "Activity" section here.
 */
export function WalletPage({ onOpenWithdraw, initialSection = 'balance' }) {
  const { usdtBalance, trxBalance } = useWallet();
  const { positionsValue, unrealizedPnl, positions } = useTrade();
  const [section, setSection] = useState(initialSection);
  const [showDeposit, setShowDeposit] = useState(true);

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
              <p className="sys-label mb-2">Total Balance</p>
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

            {/* Balance Cards */}
            <div className="space-y-3 mb-5">
              <BalanceCard
                asset="USDT"
                amount={usdtBalance}
                label="Tether USD"
                icon={<UsdtIcon className="w-6 h-6" />}
                onWithdraw={() => onOpenWithdraw('USDT')}
              />
              <BalanceCard
                asset="TRX"
                amount={trxBalance}
                label="TRON"
                icon={<TrxIcon className="w-6 h-6" />}
                onWithdraw={() => onOpenWithdraw('TRX')}
              />
            </div>

            {/* Withdrawal */}
            <p className="sys-label mb-2">Withdrawal</p>
            <div className="space-y-3" data-testid="withdraw-panels">
              <WithdrawPanel
                asset="USDT"
                label="Tether USD"
                amount={usdtBalance}
                icon={<UsdtIcon className="w-5 h-5" />}
                onWithdraw={() => onOpenWithdraw('USDT')}
              />
              <WithdrawPanel
                asset="TRX"
                label="TRON"
                amount={trxBalance}
                icon={<TrxIcon className="w-5 h-5" />}
                onWithdraw={() => onOpenWithdraw('TRX')}
              />
            </div>
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

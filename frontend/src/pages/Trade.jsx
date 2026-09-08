import { useWallet } from '@/contexts/WalletContext';
import { useTrade } from '@/contexts/TradeContext';
import { TradePanel } from '@/components/trade/TradePanel';
import { motion } from 'framer-motion';
import { Wallet as WalletIcon, Briefcase, TrendingUp } from 'lucide-react';
import { formatUsd } from '@/lib/trade';

/**
 * Standalone Trade tab (middle of the bottom nav).
 * The chart and the order form used to live inside Home and Wallet.
 */
export function TradePage() {
  const { usdtBalance } = useWallet();
  const { positions, positionsValue, unrealizedPnl, realizedPnl } = useTrade();

  const stats = [
    {
      id: 'cash',
      icon: WalletIcon,
      label: 'Cash',
      value: formatUsd(usdtBalance),
      tone: 'text-white',
    },
    {
      id: 'exposure',
      icon: Briefcase,
      label: positions.length === 1 ? '1 position' : `${positions.length} positions`,
      value: formatUsd(positionsValue),
      tone: 'text-white',
    },
    {
      id: 'pnl',
      icon: TrendingUp,
      label: 'PnL',
      value: `${unrealizedPnl >= 0 ? '+' : ''}${formatUsd(unrealizedPnl + realizedPnl)}`,
      tone: unrealizedPnl + realizedPnl >= 0 ? 'text-brand-green' : 'text-brand-red',
    },
  ];

  return (
    <div className="px-4 py-4 pb-8" data-testid="trade-page">
      {/* Page Header */}
      <div className="mb-4">
        <h1 className="font-display text-2xl font-bold text-white">Trade</h1>
        <p className="text-sm text-white/50 mt-1">Practise with real prices and demo funds</p>
      </div>

      {/* Portfolio strip */}
      <div className="flex gap-2 mb-4" data-testid="trade-stats">
        {stats.map(({ id, icon: Icon, label, value, tone }) => (
          <motion.div
            key={id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex-1 rounded-2xl glass-card px-3 py-2.5"
          >
            <div className="flex items-center gap-1.5 mb-1">
              <Icon className="w-3 h-3 text-white/35" />
              <span className="sys-label">{label}</span>
            </div>
            <p className={`text-sm font-bold tabular-nums ${tone}`} data-testid={`trade-stat-${id}`}>
              {value}
            </p>
          </motion.div>
        ))}
      </div>

      <TradePanel variant="full" />
    </div>
  );
}

export default TradePage;

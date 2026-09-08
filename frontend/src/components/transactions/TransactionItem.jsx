import {
  ArrowDownLeft,
  ArrowUpRight,
  Gift,
  Trophy,
  Clock,
  CheckCircle,
  XCircle,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { motion } from 'framer-motion';

// Static class strings on purpose: Tailwind cannot generate `bg-${x}/10`.
const typeConfig = {
  deposit: { icon: ArrowDownLeft, bg: 'bg-brand-teal/10', text: 'text-brand-teal', label: 'Deposit' },
  withdraw: { icon: ArrowUpRight, bg: 'bg-brand-red/10', text: 'text-brand-red', label: 'Withdrawal' },
  reward: { icon: Trophy, bg: 'bg-brand-gold/10', text: 'text-brand-gold', label: 'Reward' },
  referral: { icon: Gift, bg: 'bg-brand-blue/10', text: 'text-brand-blue', label: 'Referral Bonus' },
  buy: { icon: TrendingUp, bg: 'bg-brand-blue/10', text: 'text-brand-blue', label: 'Trade Buy' },
  sell: { icon: TrendingDown, bg: 'bg-brand-gold/10', text: 'text-brand-gold', label: 'Trade Sell' },
};

const statusConfig = {
  confirmed: { icon: CheckCircle, text: 'text-brand-teal', label: 'Confirmed' },
  pending: { icon: Clock, text: 'text-brand-gold', label: 'Pending' },
  failed: { icon: XCircle, text: 'text-brand-red', label: 'Failed' },
};

export function TransactionItem({ transaction, index = 0 }) {
  const { type, asset, amount, status, timestamp, description, txHash, toAddress } = transaction;

  const typeInfo = typeConfig[type] || typeConfig.deposit;
  const statusInfo = statusConfig[status] || statusConfig.pending;
  const TypeIcon = typeInfo.icon;
  const StatusIcon = statusInfo.icon;

  // A buy spends USDT, a sell returns it.
  const isOutgoing = type === 'withdraw' || type === 'buy';
  const formattedDate = new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <motion.div
      className="flex items-center gap-3 p-4 rounded-2xl bg-white/[0.025] border border-white/[0.06] hover:bg-white/[0.045] transition-colors"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.3) }}
      data-testid={`transaction-${transaction.id}`}
    >
      {/* Icon */}
      <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${typeInfo.bg}`}>
        <TypeIcon className={`w-5 h-5 ${typeInfo.text}`} />
      </div>

      {/* Details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-white text-sm">{typeInfo.label}</span>
          <div className={`flex items-center gap-1 text-xs ${statusInfo.text}`}>
            <StatusIcon className="w-3 h-3" />
            <span>{statusInfo.label}</span>
          </div>
        </div>
        <p className="font-mono text-[10px] text-ink-dim mt-0.5 truncate">
          {description || (txHash ? `Tx: ${txHash.slice(0, 10)}...` : toAddress ? `To: ${toAddress.slice(0, 8)}...` : formattedDate)}
        </p>
      </div>

      {/* Amount */}
      <div className="text-right flex-shrink-0">
        <p className={`sys-value text-sm font-medium ${isOutgoing ? 'text-brand-red' : 'text-brand-mint'}`}>
          {isOutgoing ? '-' : '+'}
          {asset === 'USDT' ? '$' : ''}
          {Number(amount).toFixed(2)}
        </p>
        <p className="font-mono text-[10px] uppercase tracking-wider text-ink-dim/70">{asset}</p>
      </div>
    </motion.div>
  );
}

export default TransactionItem;

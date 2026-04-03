import { ArrowDownLeft, ArrowUpRight, Gift, Trophy, Clock, CheckCircle, XCircle } from 'lucide-react';
import { motion } from 'framer-motion';

const typeConfig = {
  deposit: {
    icon: ArrowDownLeft,
    color: 'brand-green',
    label: 'Deposit',
  },
  withdraw: {
    icon: ArrowUpRight,
    color: 'brand-red',
    label: 'Withdraw',
  },
  reward: {
    icon: Trophy,
    color: 'brand-green',
    label: 'Reward',
  },
  referral: {
    icon: Gift,
    color: 'brand-green',
    label: 'Referral Bonus',
  },
};

const statusConfig = {
  confirmed: {
    icon: CheckCircle,
    color: 'brand-green',
    label: 'Confirmed',
  },
  pending: {
    icon: Clock,
    color: 'yellow-500',
    label: 'Pending',
  },
  failed: {
    icon: XCircle,
    color: 'brand-red',
    label: 'Failed',
  },
};

export function TransactionItem({ transaction, index = 0 }) {
  const { type, asset, amount, status, timestamp, description, txHash, toAddress } = transaction;
  
  const typeInfo = typeConfig[type] || typeConfig.deposit;
  const statusInfo = statusConfig[status] || statusConfig.pending;
  const TypeIcon = typeInfo.icon;
  const StatusIcon = statusInfo.icon;

  const isOutgoing = type === 'withdraw';
  const formattedDate = new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <motion.div
      className="flex items-center gap-3 p-4 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-colors"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      data-testid={`transaction-${transaction.id}`}
    >
      {/* Icon */}
      <div className={`w-10 h-10 rounded-full bg-${typeInfo.color}/10 flex items-center justify-center flex-shrink-0`}>
        <TypeIcon className={`w-5 h-5 text-${typeInfo.color}`} />
      </div>

      {/* Details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-white text-sm">{typeInfo.label}</span>
          <div className={`flex items-center gap-1 text-xs text-${statusInfo.color}`}>
            <StatusIcon className="w-3 h-3" />
            <span>{statusInfo.label}</span>
          </div>
        </div>
        <p className="text-xs text-white/40 mt-0.5 truncate">
          {description || (toAddress ? `To: ${toAddress.slice(0, 8)}...` : formattedDate)}
        </p>
      </div>

      {/* Amount */}
      <div className="text-right flex-shrink-0">
        <p className={`font-semibold ${isOutgoing ? 'text-brand-red' : 'text-brand-green'}`}>
          {isOutgoing ? '-' : '+'}{asset === 'USDT' ? '$' : ''}{amount.toFixed(2)}
        </p>
        <p className="text-xs text-white/30">{asset}</p>
      </div>
    </motion.div>
  );
}

export default TransactionItem;

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
  Coins,
  CalendarCheck,
} from 'lucide-react';
import { motion } from 'framer-motion';

// Static class strings on purpose: Tailwind cannot generate `bg-${x}/10`.
//
// El historial mezcla DOS vocabularios y por eso esto está indexado por los dos:
//   * El servidor manda `wallet_ledger.operation` tal cual: 'withdrawal',
//     'fee_deduction', 'signup_bonus', 'checkin_daily', ... (la lista completa
//     está en la CHECK wallet_ledger_operation_check de supabase/schema.sql).
//   * Las entradas optimistas locales mandan el nombre de la UI: 'reward',
//     'buy', 'sell' (CheckInCard y TradeContext).
//
// Antes había seis claves con los nombres de la UI solamente, así que TODO lo
// que venía del servidor caía en el fallback `deposit`: un retiro de 2000 USDT
// se mostraba como "Deposit" y en verde.
const typeConfig = {
  // --- operaciones del ledger ---
  deposit:        { icon: ArrowDownLeft, bg: 'bg-brand-teal/10',  text: 'text-brand-teal',  label: 'Deposit' },
  withdrawal:     { icon: ArrowUpRight,  bg: 'bg-brand-red/10',   text: 'text-brand-red',   label: 'Withdrawal' },
  fee_deduction:  { icon: Coins,         bg: 'bg-brand-red/10',   text: 'text-brand-red',   label: 'Network Fee' },
  claim_credit:   { icon: Trophy,        bg: 'bg-brand-gold/10',  text: 'text-brand-gold',  label: 'Reward' },
  referral_bonus: { icon: Gift,          bg: 'bg-brand-blue/10',  text: 'text-brand-blue',  label: 'Referral Bonus' },
  signup_bonus:   { icon: Gift,          bg: 'bg-brand-gold/10',  text: 'text-brand-gold',  label: 'Welcome Bonus' },
  checkin_daily:  { icon: CalendarCheck, bg: 'bg-brand-gold/10',  text: 'text-brand-gold',  label: 'Daily Check-In' },
  checkin_weekly: { icon: CalendarCheck, bg: 'bg-brand-gold/10',  text: 'text-brand-gold',  label: 'Weekly bonus' },
  trade_buy:      { icon: TrendingUp,    bg: 'bg-brand-blue/10',  text: 'text-brand-blue',  label: 'Trade Buy' },
  trade_sell:     { icon: TrendingDown,  bg: 'bg-brand-gold/10',  text: 'text-brand-gold',  label: 'Trade Sell' },

  // --- nombres de la UI (entradas locales) ---
  reward:   { icon: Trophy,       bg: 'bg-brand-gold/10', text: 'text-brand-gold', label: 'Reward' },
  referral: { icon: Gift,         bg: 'bg-brand-blue/10', text: 'text-brand-blue', label: 'Referral Bonus' },
  buy:      { icon: TrendingUp,   bg: 'bg-brand-blue/10', text: 'text-brand-blue', label: 'Trade Buy' },
  sell:     { icon: TrendingDown, bg: 'bg-brand-gold/10', text: 'text-brand-gold', label: 'Trade Sell' },
  withdraw: { icon: ArrowUpRight, bg: 'bg-brand-red/10',  text: 'text-brand-red',  label: 'Withdrawal' },
};

// Tipos que gastan saldo cuando el monto viene SIN signo (entradas locales).
// El ledger del servidor ya firma sus montos, así que para esas filas manda el
// número; esto solo cubre las locales y las viejas guardadas en localStorage.
const OUTGOING_TYPES = new Set(['withdraw', 'withdrawal', 'fee_deduction', 'buy', 'trade_buy']);

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

  // El signo sale del número cuando viene firmado y del tipo cuando no.
  // Antes el signo salía SOLO del tipo: un retiro (monto -2000, tipo
  // 'withdrawal' que no estaba en la tabla) quedaba como entrada y se
  // renderizaba "+$-2000.00" — el '+' del componente más el '-' del monto.
  const value = Number(amount);
  const isOutgoing = value < 0 || OUTGOING_TYPES.has(type);
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
        <p
          className={`sys-value text-sm font-medium ${isOutgoing ? 'text-brand-red' : 'text-brand-mint'}`}
          data-testid={`transaction-${transaction.id}-amount`}
        >
          {isOutgoing ? '-' : '+'}
          {asset === 'USDT' ? '$' : ''}
          {Math.abs(value).toFixed(2)}
        </p>
        <p className="font-mono text-[10px] uppercase tracking-wider text-ink-dim/70">{asset}</p>
      </div>
    </motion.div>
  );
}

export default TransactionItem;

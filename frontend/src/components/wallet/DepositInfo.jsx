import { AlertTriangle, Copy, Info } from 'lucide-react';
import { CopyButton } from '@/components/shared/CopyButton';
import { useWallet } from '@/contexts/WalletContext';
import { motion } from 'framer-motion';

export function DepositInfo({ onClose }) {
  const { depositInfo } = useWallet();

  return (
    <motion.div
      className="glass-card rounded-2xl p-5"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      data-testid="deposit-info"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-lg font-semibold text-white">Deposit</h3>
        <span className="text-xs px-2 py-1 rounded-full bg-brand-green/10 text-brand-green border border-brand-green/20">
          {depositInfo.network}
        </span>
      </div>

      {/* Warning */}
      <div className="flex gap-3 p-3 rounded-xl bg-brand-red/10 border border-brand-red/20 mb-4">
        <AlertTriangle className="w-5 h-5 text-brand-red flex-shrink-0 mt-0.5" />
        <div className="text-xs text-white/70">
          <p className="font-semibold text-brand-red mb-1">Important</p>
          <p>Only send TRX or USDT (TRC-20) to this address. Include your MEMO to identify your deposit.</p>
        </div>
      </div>

      {/* Address */}
      <div className="mb-4">
        <label className="text-xs text-white/40 uppercase tracking-wider mb-2 block">
          Deposit Address
        </label>
        <div className="flex items-center gap-2 p-3 rounded-xl bg-white/5 border border-white/10">
          <code className="text-xs text-brand-green flex-1 break-all font-mono">
            {depositInfo.address}
          </code>
          <CopyButton text={depositInfo.address} label="" className="!p-2 !px-2" />
        </div>
      </div>

      {/* MEMO - Highlighted */}
      <div className="p-4 rounded-xl bg-gradient-to-r from-brand-green/10 to-transparent border border-brand-green/20">
        <div className="flex items-center gap-2 mb-2">
          <Info className="w-4 h-4 text-brand-green" />
          <label className="text-xs text-brand-green uppercase tracking-wider font-semibold">
            Your MEMO (Required)
          </label>
        </div>
        <div className="flex items-center gap-2">
          <code className="text-xl font-bold text-white font-mono flex-1" data-testid="deposit-memo">
            {depositInfo.memo}
          </code>
          <CopyButton text={depositInfo.memo} label="Copy" data-testid="copy-memo-btn" />
        </div>
        <p className="text-xs text-white/50 mt-2">
          Without the MEMO, your deposit cannot be credited to your account.
        </p>
      </div>

      {onClose && (
        <button
          onClick={onClose}
          className="w-full mt-4 py-3 rounded-xl bg-white/5 border border-white/10 text-sm font-medium text-white/60 hover:bg-white/10 active:scale-95 transition-all"
        >
          Close
        </button>
      )}
    </motion.div>
  );
}

export default DepositInfo;

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, Search } from 'lucide-react';
import { CopyButton } from '@/components/shared/CopyButton';
import { useWallet } from '@/contexts/WalletContext';
import { motion } from 'framer-motion';

const DEPOSIT_ASSETS = ['USDT', 'TRX'];

export function DepositInfo({ onClose }) {
  const { depositInfo, verifyDeposit } = useWallet();
  const [asset, setAsset] = useState('USDT');
  const [txHash, setTxHash] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const handleVerify = async (event) => {
    event.preventDefault();
    const hash = txHash.trim();
    if (!hash) {
      setFeedback({ ok: false, text: 'Paste the TRON transaction hash first.' });
      return;
    }

    setVerifying(true);
    setFeedback(null);
    const result = await verifyDeposit({ txHash: hash, asset });
    setVerifying(false);

    if (result?.ok) {
      const amount = Number(result.amount);
      const amountText = Number.isFinite(amount) ? ` ${amount} ${result.asset || asset}` : '';
      setFeedback({
        ok: true,
        text: result.already_credited
          ? 'This transaction was already credited to your wallet.'
          : `Deposit verified.${amountText} was added to your balance.`,
      });
      setTxHash('');
    } else {
      setFeedback({
        ok: false,
        text: result?.error || 'Deposit not found yet. Wait for confirmation and retry.',
      });
    }
  };

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
          <p>
            Only send TRX or USDT (TRC-20) to this address. A MEMO is optional;
            if you leave it empty, verify the transfer below with its transaction hash.
          </p>
        </div>
      </div>

      {/* Address */}
      <div className="mb-4">
        <label className="sys-label mb-2 block">Deposit Address</label>
        <div className="flex items-center gap-2 p-3 rounded-xl bg-white/5 border border-white/10">
          <code className="text-xs text-brand-green flex-1 break-all font-mono">
            {depositInfo.address}
          </code>
          <CopyButton text={depositInfo.address} label="" className="!p-2 !px-2" />
        </div>
      </div>

      {/* MEMO — optional for the automatic tx-hash verifier */}
      <div className="p-4 rounded-xl bg-gradient-to-r from-brand-green/10 to-transparent border border-brand-green/20">
        <div className="flex items-center gap-2 mb-2">
          <Info className="w-4 h-4 text-brand-green" />
          <label className="text-xs text-brand-green uppercase tracking-wider font-semibold">
            Your MEMO (Optional)
          </label>
        </div>
        <div className="flex items-center gap-2">
          <code className="text-xl font-bold text-white font-mono flex-1" data-testid="deposit-memo">
            {depositInfo.memo}
          </code>
          <CopyButton text={depositInfo.memo} label="Copy" data-testid="copy-memo-btn" />
        </div>
        <p className="text-xs text-white/50 mt-2">
          You can include it for the legacy flow, or send without a MEMO and paste the tx hash below.
        </p>
      </div>

      {/* v3.7: manual proof for transfers sent without a MEMO */}
      <form onSubmit={handleVerify} className="mt-4 p-4 rounded-xl bg-white/[0.03] border border-white/[0.07]" data-testid="deposit-verifier">
        <div className="flex items-center gap-2 mb-1">
          <Search className="w-4 h-4 text-brand-gold" />
          <h4 className="text-sm font-semibold text-white">Verify a deposit without MEMO</h4>
        </div>
        <p className="text-xs text-white/45 leading-relaxed mb-3">
          Paste the confirmed TRON transaction hash. The Worker checks the chain and credits the exact amount.
        </p>

        <div className="flex gap-2 mb-3" role="group" aria-label="Deposit asset">
          {DEPOSIT_ASSETS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setAsset(option)}
              data-testid={`deposit-asset-${option.toLowerCase()}`}
              className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-colors ${
                asset === option
                  ? 'bg-brand-green/15 border-brand-green/40 text-brand-green'
                  : 'bg-white/[0.03] border-white/[0.08] text-white/45 hover:text-white/75'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <input
          value={txHash}
          onChange={(event) => setTxHash(event.target.value)}
          inputMode="text"
          autoComplete="off"
          spellCheck="false"
          placeholder="64-character transaction hash"
          aria-label="TRON transaction hash"
          data-testid="deposit-tx-hash"
          className="w-full rounded-xl bg-black/20 border border-white/10 px-3 py-2.5 text-xs text-white font-mono placeholder:text-white/25 outline-none focus:border-brand-green/50"
        />

        <button
          type="submit"
          disabled={verifying || !txHash.trim()}
          data-testid="verify-deposit-btn"
          className="w-full mt-3 flex items-center justify-center gap-2 rounded-xl bg-brand-green/15 border border-brand-green/30 py-2.5 text-sm font-semibold text-brand-green disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand-green/25 active:scale-[.98] transition-all"
        >
          {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {verifying ? 'Checking TronGrid…' : 'Verify deposit'}
        </button>

        {feedback && (
          <div
            role="status"
            data-testid="deposit-verification-feedback"
            className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
              feedback.ok
                ? 'bg-brand-green/10 text-brand-green'
                : 'bg-brand-red/10 text-brand-red'
            }`}
          >
            {feedback.ok && <CheckCircle2 className="w-4 h-4 flex-shrink-0" />}
            <span>{feedback.text}</span>
          </div>
        )}
      </form>

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

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useWallet } from '@/contexts/WalletContext';
import { useTrade } from '@/contexts/TradeContext';
import { useTelegram } from '@/hooks/useTelegram';
import {
  AMOUNT_PRESETS,
  TRADE_CONFIG,
  calcOpenTrade,
  formatPrice,
  formatQty,
  formatUsd,
  validateTradeRequest,
} from '@/lib/trade';

/**
 * Buy form for the Trade panel: spend internal USDT on the selected market.
 */
export function OrderForm({ pair, price }) {
  const { usdtBalance } = useWallet();
  const { openTrade, busy, error, clearError } = useTrade();
  const { vibrate } = useTelegram();

  const [amount, setAmount] = useState('');
  const [result, setResult] = useState(null);

  // Reset the field when the user switches market.
  useEffect(() => {
    setAmount('');
    setResult(null);
  }, [pair.id]);

  const numericAmount = Number(amount);
  const fill = useMemo(() => {
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || !price) return null;
    const res = calcOpenTrade({ amount: numericAmount, price });
    return res.ok ? res : null;
  }, [numericAmount, price]);

  const validation = useMemo(
    () => validateTradeRequest({ pair: pair.id, amount: numericAmount, balance: usdtBalance }),
    [pair.id, numericAmount, usdtBalance]
  );

  const showValidation = amount !== '' && !validation.ok;

  const applyPreset = (fraction) => {
    const budget = (usdtBalance * fraction) / (1 + TRADE_CONFIG.FEE_RATE);
    setAmount(budget > 0 ? budget.toFixed(2) : '');
    clearError();
  };

  const handleSubmit = async () => {
    if (!fill || busy) return;
    if (!validation.ok) {
      vibrate('error');
      return;
    }

    vibrate('impact');
    const res = await openTrade({ pair: pair.id, amountUsdt: numericAmount, price });

    if (res.ok) {
      vibrate('success');
      setResult({ qty: res.position.qty, pair: pair.base });
      setAmount('');
      setTimeout(() => setResult(null), 2600);
    } else {
      vibrate('error');
    }
  };

  return (
    <div className="mt-4" data-testid="trade-order-form">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">Buy {pair.base}</span>
        <span className="text-[10px] text-white/40">
          Fee {(TRADE_CONFIG.FEE_RATE * 100).toFixed(2)}%
        </span>
      </div>

      <div className="flex items-center gap-2 rounded-2xl bg-white/[0.04] border border-white/[0.08] px-4 py-3 focus-within:border-brand-green/40 transition-colors">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={amount}
          placeholder="0.00"
          onChange={(e) => {
            setAmount(e.target.value);
            clearError();
          }}
          data-testid="trade-amount-input"
          className="flex-1 min-w-0 bg-transparent text-xl font-semibold text-white outline-none placeholder:text-white/25 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="text-xs font-semibold text-brand-green">USDT</span>
      </div>

      <div className="flex items-center justify-between mt-1.5 text-[11px]" data-testid="trade-available-balance">
        <span className="text-white/35">Available</span>
        <span className="font-mono text-white/60">{formatUsd(usdtBalance)} USDT</span>
      </div>

      <div className="flex gap-2 mt-2">
        {AMOUNT_PRESETS.map((fraction) => (
          <button
            key={fraction}
            type="button"
            onClick={() => applyPreset(fraction)}
            data-testid={`trade-preset-${Math.round(fraction * 100)}`}
            className="flex-1 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-[11px] font-semibold text-white/60 hover:bg-white/[0.08] hover:text-white active:scale-95 transition-all"
          >
            {fraction === 1 ? 'MAX' : `${fraction * 100}%`}
          </button>
        ))}
      </div>

      {/* Fill preview */}
      {fill && (
        <div className="mt-3 space-y-1.5 text-xs">
          <div className="flex justify-between">
            <span className="text-white/40">You receive</span>
            <span className="font-semibold text-white" data-testid="trade-preview-qty">
              {formatQty(fill.qty, pair.qtyDecimals)} {pair.base}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/40">Entry price</span>
            <span className="font-mono text-white/70">{formatPrice(price, pair.priceDecimals)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/40">Fee</span>
            <span className="font-mono text-white/70">{formatUsd(fill.fee)}</span>
          </div>
          <div className="flex justify-between pt-1 border-t border-white/5">
            <span className="text-white/40">Total debit</span>
            <span className="font-semibold text-white">{formatUsd(fill.totalDebit)}</span>
          </div>
        </div>
      )}

      <AnimatePresence>
        {(showValidation || error) && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-3 flex items-center gap-2 text-xs text-brand-red"
          >
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{error || validation.error}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        onClick={handleSubmit}
        disabled={busy || !fill || !validation.ok}
        whileTap={{ scale: 0.97 }}
        data-testid="trade-buy-submit"
        className="mt-4 w-full py-3.5 rounded-2xl bg-brand-green text-black font-bold tracking-tight flex items-center justify-center gap-2 disabled:opacity-35 disabled:cursor-not-allowed transition-opacity active:scale-[0.98]"
      >
        {busy ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Sending order...
          </>
        ) : (
          `Buy ${pair.base}`
        )}
      </motion.button>

      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mt-3 flex items-center gap-2 rounded-xl bg-brand-green/10 border border-brand-green/25 px-3 py-2.5 text-xs text-brand-green"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>
              Bought {formatQty(result.qty, 4)} {result.pair} — position opened
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default OrderForm;

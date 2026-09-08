import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, CheckCircle2, AlertTriangle, ChevronDown, Target, ShieldAlert } from 'lucide-react';
import { useWallet } from '@/contexts/WalletContext';
import { useTrade } from '@/contexts/TradeContext';
import { useTelegram } from '@/hooks/useTelegram';
import {
  AMOUNT_PRESETS,
  LEVEL_PRESETS,
  TRADE_CONFIG,
  calcOpenTrade,
  formatPercent,
  formatPrice,
  formatQty,
  formatUsd,
  priceFromPercent,
  previewLevelPnl,
  validateLevels,
  validateTradeRequest,
} from '@/lib/trade';

/**
 * Buy form for the Trade panel: spend internal USDT on the selected market,
 * optionally attaching a Take Profit / Stop Loss bracket to the order.
 */
export function OrderForm({ pair, price }) {
  const { usdtBalance } = useWallet();
  const { openTrade, busy, error, clearError } = useTrade();
  const { vibrate } = useTelegram();

  const [amount, setAmount] = useState('');
  const [limitsOn, setLimitsOn] = useState(false);
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [result, setResult] = useState(null);

  // Reset the fields when the user switches market.
  useEffect(() => {
    setAmount('');
    setTp('');
    setSl('');
    setResult(null);
  }, [pair.id]);

  const numericAmount = Number(amount);
  const fill = useMemo(() => {
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || !price) return null;
    const res = calcOpenTrade({ amount: numericAmount, price });
    return res.ok ? res : null;
  }, [numericAmount, price]);

  const sizeValidation = useMemo(
    () => validateTradeRequest({ pair: pair.id, amount: numericAmount, balance: usdtBalance }),
    [pair.id, numericAmount, usdtBalance]
  );

  const levels = useMemo(
    () =>
      validateLevels({
        entryPrice: price,
        takeProfit: limitsOn ? tp : null,
        stopLoss: limitsOn ? sl : null,
      }),
    [price, limitsOn, tp, sl]
  );

  const orderError = !sizeValidation.ok ? sizeValidation.error : !levels.ok ? levels.error : null;
  const showValidation = (amount !== '' || (limitsOn && (tp !== '' || sl !== ''))) && !!orderError;

  const applyPreset = (fraction) => {
    const budget = (usdtBalance * fraction) / (1 + TRADE_CONFIG.FEE_RATE);
    setAmount(budget > 0 ? budget.toFixed(2) : '');
    clearError();
  };

  const toggleLimits = () => {
    vibrate('light');
    setLimitsOn((prev) => {
      const next = !prev;
      if (next && price) {
        // Sensible defaults: +5% take profit, -3% stop loss.
        setTp((v) => v || String(priceFromPercent(price, 0.05).toFixed(pair.priceDecimals)));
        setSl((v) => v || String(priceFromPercent(price, -0.03).toFixed(pair.priceDecimals)));
      }
      return next;
    });
    clearError();
  };

  const applyLevelPreset = (kind, percent) => {
    if (!price) return;
    const next = priceFromPercent(price, kind === 'takeProfit' ? percent : -percent);
    if (!next) return;
    if (kind === 'takeProfit') setTp(next.toFixed(pair.priceDecimals));
    else setSl(next.toFixed(pair.priceDecimals));
    clearError();
  };

  const tpPreview = useMemo(() => {
    if (!fill || !levels.ok || !levels.takeProfit) return null;
    return previewLevelPnl({ qty: fill.qty, entryPrice: price, targetPrice: levels.takeProfit });
  }, [fill, levels, price]);

  const slPreview = useMemo(() => {
    if (!fill || !levels.ok || !levels.stopLoss) return null;
    return previewLevelPnl({ qty: fill.qty, entryPrice: price, targetPrice: levels.stopLoss });
  }, [fill, levels, price]);

  const canSubmit = !!fill && sizeValidation.ok && levels.ok && !busy;

  const handleSubmit = async () => {
    if (!canSubmit) {
      vibrate('error');
      return;
    }

    vibrate('impact');
    const res = await openTrade({
      pair: pair.id,
      amountUsdt: numericAmount,
      price,
      takeProfit: limitsOn ? levels.takeProfit : null,
      stopLoss: limitsOn ? levels.stopLoss : null,
    });

    if (res.ok) {
      vibrate('success');
      setResult({
        qty: res.position.qty,
        base: pair.base,
        bracketed: limitsOn && (levels.takeProfit || levels.stopLoss),
      });
      setAmount('');
      setTp('');
      setSl('');
      setTimeout(() => setResult(null), 2800);
    } else {
      vibrate('error');
    }
  };

  return (
    <div className="mt-4" data-testid="trade-order-form">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-white/40">Buy {pair.base}</span>
        <span className="text-[10px] text-white/40">Fee {(TRADE_CONFIG.FEE_RATE * 100).toFixed(2)}%</span>
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

      {/* ============================================
          ORDER LIMITS - Take Profit / Stop Loss
          ============================================ */}
      <button
        type="button"
        onClick={toggleLimits}
        data-testid="trade-limits-toggle"
        aria-expanded={limitsOn}
        className="w-full mt-4 flex items-center justify-between rounded-2xl bg-white/[0.03] border border-white/[0.06] px-3.5 py-2.5 active:scale-[0.99] transition-all"
      >
        <span className="flex items-center gap-2">
          <Target className="w-3.5 h-3.5 text-brand-green" />
          <span className="text-xs font-semibold text-white/80">Order limits</span>
          <span className="text-[10px] text-white/30">TP / SL · optional</span>
        </span>
        <span className="flex items-center gap-2">
          {limitsOn && (
            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-brand-green/15 text-brand-green">
              On
            </span>
          )}
          <ChevronDown
            className={`w-4 h-4 text-white/40 transition-transform ${limitsOn ? 'rotate-180' : ''}`}
          />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {limitsOn && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            data-testid="trade-limits"
          >
            {/* Take Profit */}
            <div className="mt-2 rounded-2xl bg-brand-green/[0.05] border border-brand-green/15 px-3.5 py-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold text-brand-green">
                  <Target className="w-3 h-3" /> Take Profit
                </span>
                {tpPreview?.ok && (
                  <span className="text-[11px] font-mono text-brand-green" data-testid="tp-preview">
                    {tpPreview.pnl >= 0 ? '+' : ''}
                    {formatUsd(tpPreview.pnl)} · {formatPercent(tpPreview.pnlPct * 100)}
                  </span>
                )}
              </div>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={tp}
                placeholder={price ? formatPrice(priceFromPercent(price, 0.05), pair.priceDecimals) : '0.00'}
                onChange={(e) => {
                  setTp(e.target.value);
                  clearError();
                }}
                data-testid="tp-input"
                className="mt-2 w-full rounded-xl bg-black/30 border border-white/[0.06] px-3 py-2 font-mono text-sm text-white outline-none focus:border-brand-green/40 placeholder:text-white/20 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <div className="flex gap-1.5 mt-2">
                {LEVEL_PRESETS.takeProfit.map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => applyLevelPreset('takeProfit', pct)}
                    data-testid={`tp-preset-${Math.round(pct * 100)}`}
                    className="flex-1 py-1 rounded-md bg-brand-green/10 text-[10px] font-bold text-brand-green/80 hover:bg-brand-green/20 active:scale-95 transition-all"
                  >
                    +{pct * 100}%
                  </button>
                ))}
              </div>
            </div>

            {/* Stop Loss */}
            <div className="mt-2 rounded-2xl bg-brand-red/[0.05] border border-brand-red/15 px-3.5 py-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold text-brand-red">
                  <ShieldAlert className="w-3 h-3" /> Stop Loss
                </span>
                {slPreview?.ok && (
                  <span className="text-[11px] font-mono text-brand-red" data-testid="sl-preview">
                    {slPreview.pnl >= 0 ? '+' : ''}
                    {formatUsd(slPreview.pnl)} · {formatPercent(slPreview.pnlPct * 100)}
                  </span>
                )}
              </div>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={sl}
                placeholder={price ? formatPrice(priceFromPercent(price, -0.03), pair.priceDecimals) : '0.00'}
                onChange={(e) => {
                  setSl(e.target.value);
                  clearError();
                }}
                data-testid="sl-input"
                className="mt-2 w-full rounded-xl bg-black/30 border border-white/[0.06] px-3 py-2 font-mono text-sm text-white outline-none focus:border-brand-red/40 placeholder:text-white/20 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <div className="flex gap-1.5 mt-2">
                {LEVEL_PRESETS.stopLoss.map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => applyLevelPreset('stopLoss', pct)}
                    data-testid={`sl-preset-${Math.round(pct * 100)}`}
                    className="flex-1 py-1 rounded-md bg-brand-red/10 text-[10px] font-bold text-brand-red/80 hover:bg-brand-red/20 active:scale-95 transition-all"
                  >
                    -{pct * 100}%
                  </button>
                ))}
              </div>
            </div>

            <p className="mt-2 text-[10px] leading-relaxed text-white/30">
              The position closes automatically when the price reaches either level. Prices are
              checked every few seconds, so a fast move can fill slightly past the level.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(showValidation || error) && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-3 flex items-center gap-2 text-xs text-brand-red"
          >
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{error || orderError}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
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
              Bought {formatQty(result.qty, 4)} {result.base}
              {result.bracketed ? ' — TP/SL armed' : ' — position opened'}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default OrderForm;

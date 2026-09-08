import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, CheckCircle2, AlertTriangle, ChevronDown, Target, ShieldAlert, TrendingDown } from 'lucide-react';
import { useWallet } from '@/contexts/WalletContext';
import { useTrade } from '@/contexts/TradeContext';
import { useTelegram } from '@/hooks/useTelegram';
import {
  AMOUNT_PRESETS,
  LEVEL_PRESETS,
  TRADE_CONFIG,
  calcCloseTrade,
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
 * Order form for the Trade panel.
 *
 * BUY  spends internal USDT on the selected market and can attach a
 *      Take Profit / Stop Loss bracket.
 * SELL closes the open position in that market at the current price. The
 *      simulator is long-only spot, so there is nothing to short: selling is
 *      always exiting a position you already hold.
 */
export function OrderForm({ pair, price }) {
  const { usdtBalance } = useWallet();
  const { openTrade, closeTrade, positions, busy, error, clearError } = useTrade();
  const { vibrate } = useTelegram();

  const [side, setSide] = useState('buy');
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
    setSide('buy');
  }, [pair.id]);

  const isSell = side === 'sell';

  // The position this SELL would close (long-only: one open position per pair).
  const position = useMemo(
    () => positions.find((p) => p.pair === pair.id && p.status !== 'closed') || null,
    [positions, pair.id]
  );

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

  // ---- SELL side ----------------------------------------------------------
  // The simulator is long-only spot and `close_trade` exits the whole
  // position, so a SELL is always a full market close. There is deliberately
  // no quantity field here: a partial amount would promise something the
  // backend does not do.
  const sellQty = position ? Number(position.qty) : 0;

  const sellFill = useMemo(() => {
    if (!position || !price || !(sellQty > 0)) return null;
    const res = calcCloseTrade({
      qty: sellQty,
      entryPrice: position.entry_price,
      exitPrice: price,
    });
    return res.ok ? res : null;
  }, [position, price, sellQty]);

  const canSubmit = isSell ? !!sellFill && !busy : !!fill && sizeValidation.ok && levels.ok && !busy;

  const handleSubmit = async () => {
    if (!canSubmit) {
      vibrate('error');
      return;
    }

    vibrate('impact');

    if (isSell) {
      const res = await closeTrade(position.id, price, 'manual');
      if (res.ok) {
        vibrate('success');
        setResult({
          sold: true,
          qty: sellQty,
          base: pair.base,
          credit: sellFill.credit,
          pnl: res.pnl,
        });
        setTimeout(() => setResult(null), 2800);
      } else {
        vibrate('error');
      }
      return;
    }

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
        sold: false,
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
      {/* Buy / Sell */}
      <div
        className="flex gap-1 p-1 rounded-2xl bg-white/[0.04] border border-white/[0.08] mb-3"
        data-testid="trade-side-toggle"
      >
        {[
          { id: 'buy', label: 'Buy', on: 'bg-brand-teal text-black shadow-glow-teal' },
          { id: 'sell', label: 'Sell', on: 'bg-brand-red text-black shadow-[0_0_18px_rgba(255,107,122,0.35)]' },
        ].map(({ id, label, on }) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setSide(id);
              setAmount('');
              setResult(null);
              clearError();
            }}
            data-testid={`trade-side-${id}`}
            aria-pressed={side === id}
            className={`flex-1 py-2 rounded-xl text-xs font-bold uppercase tracking-[0.08em] transition-all active:scale-[0.98] ${
              side === id ? on : 'text-white/45 hover:text-white/70'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between mb-2">
        <span className={`sys-label ${isSell ? '!text-brand-red' : ''}`}>
          {isSell ? 'Sell' : 'Buy'} {pair.base}
        </span>
        <span className="text-[10px] text-white/40">Fee {(TRADE_CONFIG.FEE_RATE * 100).toFixed(2)}%</span>
      </div>

      {!isSell && (
      <>
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
        <span className={`text-xs font-semibold ${isSell ? 'text-brand-red' : 'text-brand-green'}`}>
          {isSell ? pair.base : 'USDT'}
        </span>
      </div>

      <div className="flex items-center justify-between mt-1.5 text-[11px]" data-testid="trade-available-balance">
        <span className="text-white/35">Available</span>
        <span className="font-mono text-white/60" data-testid="trade-available-value">
          {formatUsd(usdtBalance)} USDT
        </span>
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
      </>
      )}

      {/* SELL: what is about to be sold, read-only */}
      {isSell && position && (
        <div
          className="flex items-center justify-between gap-2 rounded-2xl bg-brand-red/[0.07] border border-brand-red/25 px-4 py-3"
          data-testid="trade-sell-amount"
        >
          <span className="sys-label !text-brand-red/80">Selling all</span>
          <span className="font-mono text-sm font-semibold text-white tabular-nums">
            {formatQty(sellQty, pair.qtyDecimals)} {pair.base}
          </span>
        </div>
      )}

      {/* Sell preview */}
      {isSell && sellFill && (
        <div className="mt-3 space-y-1.5 text-xs" data-testid="trade-sell-preview">
          <div className="flex justify-between">
            <span className="text-white/40">You receive</span>
            <span className="font-semibold text-white">{formatUsd(sellFill.credit)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/40">Exit price</span>
            <span className="font-mono text-white/70">{formatPrice(price, pair.priceDecimals)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/40">Realised PnL</span>
            <span
              className={`font-mono font-semibold ${sellFill.pnl >= 0 ? 'text-brand-teal' : 'text-brand-red'}`}
              data-testid="trade-sell-pnl"
            >
              {sellFill.pnl >= 0 ? '+' : ''}
              {formatUsd(sellFill.pnl)} ({formatPercent(sellFill.pnlPct)})
            </span>
          </div>
        </div>
      )}

      {isSell && !position && (
        <p className="mt-3 flex items-center gap-2 text-[11px] text-white/45" data-testid="trade-sell-empty">
          <TrendingDown className="w-3.5 h-3.5 text-brand-red/70" />
          Nothing to sell yet — open a {pair.base} position first.
        </p>
      )}

      {/* Fill preview */}
      {!isSell && fill && (
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
          ORDER LIMITS - Take Profit / Stop Loss (buy only)
          ============================================ */}
      {!isSell && (
      <>
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
      </>
      )}

      <AnimatePresence>
        {((!isSell && showValidation) || error) && (
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
        data-side={side}
        className={`mt-4 w-full py-3.5 rounded-2xl text-black font-bold tracking-tight flex items-center justify-center gap-2 disabled:opacity-35 disabled:cursor-not-allowed transition-opacity active:scale-[0.98] ${
          isSell ? 'bg-brand-red shadow-[0_0_24px_rgba(255,107,122,0.3)]' : 'bg-brand-green shadow-glow-teal'
        }`}
      >
        {busy ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Sending order...
          </>
        ) : isSell ? (
          <>
            <TrendingDown className="w-4 h-4" />
            {`Sell ${pair.base}`}
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
            className={`mt-3 flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs border ${
              result.sold
                ? 'bg-brand-red/10 border-brand-red/25 text-brand-red'
                : 'bg-brand-green/10 border-brand-green/25 text-brand-green'
            }`}
            data-testid="trade-order-result"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>
              {result.sold ? (
                <>
                  Sold {formatQty(result.qty, pair.qtyDecimals)} {result.base} — credited {formatUsd(result.credit)}
                  {typeof result.pnl === 'number'
                    ? ` · PnL ${result.pnl >= 0 ? '+' : ''}${formatUsd(result.pnl)}`
                    : ''}
                </>
              ) : (
                <>
                  Bought {formatQty(result.qty, pair.qtyDecimals)} {result.base}
                  {result.bracketed ? ' — TP/SL armed' : ' — position opened'}
                </>
              )}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default OrderForm;

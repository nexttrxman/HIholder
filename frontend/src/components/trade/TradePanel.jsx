import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, ChevronDown, ChevronUp, CandlestickChart, Info } from 'lucide-react';
import { useMarketData } from '@/hooks/useMarketData';
import { useTelegram } from '@/hooks/useTelegram';
import { PAIRS, TIMEFRAMES, getPair, getTimeframe } from '@/services/market';
import { formatPercent, formatPrice, formatUsd } from '@/lib/trade';
import { CandleChart } from './CandleChart';
import { OrderForm } from './OrderForm';
import { PositionsList } from './PositionsList';

/**
 * Trade panel: live chart + buy with the internal USDT balance.
 *
 * @param {'compact'|'full'} variant compact = embedded strip (Home), full = whole section (Wallet)
 */
export function TradePanel({ variant = 'full', className = '' }) {
  const [pairId, setPairId] = useState(PAIRS[0].id);
  const [timeframeId, setTimeframeId] = useState('1h');
  const [formOpen, setFormOpen] = useState(variant === 'full');

  const { vibrate } = useTelegram();
  const { candles, mode, loading, lastPrice, changePercent, high24h, low24h, refresh } = useMarketData(
    pairId,
    timeframeId,
    { candleCount: variant === 'full' ? 70 : 50 }
  );

  const pair = getPair(pairId);
  const timeframe = getTimeframe(timeframeId);
  const up = changePercent >= 0;
  const accent = up ? 'text-brand-green' : 'text-brand-red';

  return (
    <section
      className={`backdrop-blur-xl bg-white/[0.03] border border-white/[0.06] rounded-3xl p-4 overflow-hidden ${className}`}
      data-testid="trade-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <CandlestickChart className="w-4 h-4 text-brand-green" />
          <h3 className="font-display text-sm font-semibold text-white">Trade</h3>
          <span
            className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${
              mode === 'live'
                ? 'bg-brand-green/10 text-brand-green border border-brand-green/20'
                : 'bg-yellow-500/10 text-yellow-500 border border-yellow-500/20'
            }`}
            data-testid="trade-data-mode"
          >
            {mode === 'live' ? 'Live' : 'Sim data'}
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            vibrate('light');
            refresh();
          }}
          data-testid="trade-refresh"
          className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/5 active:scale-90 transition-all"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Market selector */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none" data-testid="trade-pair-selector">
        {PAIRS.map((p) => {
          const active = p.id === pairId;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                vibrate('light');
                setPairId(p.id);
              }}
              data-testid={`pair-${p.id}`}
              className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all active:scale-95 ${
                active
                  ? 'bg-white text-black'
                  : 'bg-white/[0.04] border border-white/[0.06] text-white/55 hover:bg-white/[0.08]'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Price */}
      <div className="flex items-end justify-between mt-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-white/35 mb-1">{pair.label}</p>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-2xl font-bold text-white tabular-nums" data-testid="trade-last-price">
              {formatPrice(lastPrice, pair.priceDecimals)}
            </span>
            <span className={`text-xs font-bold flex items-center gap-1 ${accent}`} data-testid="trade-change">
              {formatPercent(changePercent)}
            </span>
          </div>
        </div>

        {variant === 'full' && high24h && (
          <div className="text-right text-[10px] text-white/35 font-mono leading-relaxed">
            <p>
              24h H <span className="text-white/60">{formatPrice(high24h, pair.priceDecimals)}</span>
            </p>
            <p>
              24h L <span className="text-white/60">{formatPrice(low24h, pair.priceDecimals)}</span>
            </p>
          </div>
        )}
      </div>

      {/* Timeframes */}
      <div className="flex gap-1 mt-3 mb-1" data-testid="trade-timeframes">
        {TIMEFRAMES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              vibrate('light');
              setTimeframeId(t.id);
            }}
            data-testid={`tf-${t.id}`}
            className={`flex-1 py-1 rounded-md text-[10px] font-bold transition-all active:scale-95 ${
              t.id === timeframeId ? 'bg-white/10 text-white' : 'text-white/35 hover:text-white/60'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Chart */}
      <CandleChart
        candles={candles}
        pair={pair}
        timeframe={timeframe}
        height={variant === 'full' ? 220 : 168}
        className="mt-1"
      />

      {/* Order form toggle (compact variant keeps the strip short) */}
      {variant === 'compact' && (
        <button
          type="button"
          onClick={() => setFormOpen((v) => !v)}
          data-testid="trade-form-toggle"
          className="w-full mt-2 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] text-xs font-semibold text-white/70 hover:bg-white/[0.08] active:scale-95 transition-all"
        >
          Buy {pair.base} with USDT
          {formOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      )}

      <AnimatePresence initial={false}>
        {formOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <OrderForm pair={pair} price={lastPrice} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Positions */}
      <PositionsList
        livePair={pairId}
        livePrice={lastPrice}
        compact={variant === 'compact'}
        limit={variant === 'compact' ? 2 : null}
      />

      {/* Educational note */}
      <div className="mt-4 flex items-start gap-2 rounded-xl bg-white/[0.02] border border-white/[0.05] px-3 py-2.5">
        <Info className="w-3.5 h-3.5 text-white/30 flex-shrink-0 mt-0.5" />
        <p className="text-[10px] leading-relaxed text-white/35">
          Practice trading with your demo USDT. Prices follow the real market; orders settle
          instantly against your internal balance — no funds leave the app.
        </p>
      </div>
    </section>
  );
}

export default TradePanel;

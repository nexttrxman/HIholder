import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Check, Search } from 'lucide-react';
import { PAIRS, fetch24h } from '@/services/market';
import { formatPercent, formatPrice } from '@/lib/trade';
import { useTelegram } from '@/hooks/useTelegram';

const CACHE_TTL_MS = 30000;
let tickerCache = { at: 0, data: {} };

/**
 * Market picker: a single button that opens a small menu instead of a row of
 * chips, so the pair list can show prices without crowding the panel.
 */
export function PairSelector({ pairId, onChange }) {
  const { vibrate } = useTelegram();
  const [open, setOpen] = useState(false);
  const [tickers, setTickers] = useState(tickerCache.data);
  const wrapRef = useRef(null);

  const selected = PAIRS.find((p) => p.id === pairId) || PAIRS[0];
  const selectedTicker = tickers[selected.id];

  // Close when tapping outside the menu.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Pull a snapshot of every market the first time the menu opens.
  useEffect(() => {
    if (!open) return undefined;
    if (Date.now() - tickerCache.at < CACHE_TTL_MS) {
      setTickers(tickerCache.data);
      return undefined;
    }

    let active = true;
    (async () => {
      const entries = await Promise.all(
        PAIRS.map(async (pair) => {
          try {
            return [pair.id, await fetch24h(pair.id)];
          } catch (e) {
            return [pair.id, null];
          }
        })
      );
      if (!active) return;
      const data = Object.fromEntries(entries);
      tickerCache = { at: Date.now(), data };
      setTickers(data);
    })();

    return () => {
      active = false;
    };
  }, [open]);

  const handleSelect = (id) => {
    vibrate('light');
    onChange(id);
    setOpen(false);
  };

  return (
    <div className="relative" ref={wrapRef} data-testid="pair-selector">
      <button
        type="button"
        onClick={() => {
          vibrate('light');
          setOpen((v) => !v);
        }}
        data-testid="pair-selector-trigger"
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 rounded-2xl bg-white/[0.05] border border-white/[0.08] px-3.5 py-3 hover:bg-white/[0.08] active:scale-[0.99] transition-all"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-black flex-shrink-0"
            style={{ background: selected.color }}
          >
            {selected.base.slice(0, 3)}
          </span>
          <div className="text-left min-w-0">
            <p className="text-sm font-semibold text-white leading-tight">{selected.label}</p>
            <p className="text-[10px] text-white/40 leading-tight">
              {selectedTicker
                ? `${formatPrice(selectedTicker.price, selected.priceDecimals)} · ${formatPercent(selectedTicker.changePercent)}`
                : 'Tap to change market'}
            </p>
          </div>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-white/50 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 rounded-2xl border border-white/10 bg-[#0b0b0f]/95 backdrop-blur-2xl shadow-[0_16px_40px_rgba(0,0,0,0.6)] overflow-hidden"
            data-testid="pair-selector-menu"
          >
            <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-white/[0.06]">
              <Search className="w-3.5 h-3.5 text-white/30" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-white/35">Markets</span>
            </div>

            <div className="max-h-64 overflow-y-auto py-1">
              {PAIRS.map((pair) => {
                const ticker = tickers[pair.id];
                const active = pair.id === pairId;
                const up = (ticker?.changePercent ?? 0) >= 0;

                return (
                  <button
                    key={pair.id}
                    type="button"
                    onClick={() => handleSelect(pair.id)}
                    data-testid={`pair-option-${pair.id}`}
                    className={`w-full flex items-center justify-between gap-2 px-3.5 py-2.5 transition-colors ${
                      active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-black flex-shrink-0"
                        style={{ background: pair.color }}
                      >
                        {pair.base.slice(0, 3)}
                      </span>
                      <div className="text-left">
                        <p className="text-sm font-semibold text-white leading-tight">{pair.label}</p>
                        <p className="text-[10px] text-white/35 leading-tight">{pair.base}</p>
                      </div>
                    </div>

                    <div className="text-right">
                      {ticker ? (
                        <>
                          <p className="text-xs font-mono text-white/80 leading-tight">
                            {formatPrice(ticker.price, pair.priceDecimals)}
                          </p>
                          <p
                            className={`text-[10px] font-mono leading-tight ${up ? 'text-brand-green' : 'text-brand-red'}`}
                          >
                            {formatPercent(ticker.changePercent)}
                          </p>
                        </>
                      ) : (
                        <span className="text-[10px] text-white/25">—</span>
                      )}
                      {active && <Check className="w-3 h-3 text-brand-green ml-auto mt-1" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default PairSelector;

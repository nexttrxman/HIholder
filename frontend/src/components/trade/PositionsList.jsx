import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { TrendingUp, TrendingDown, Loader2, Briefcase, Target, ShieldAlert, Pencil, Trash2 } from 'lucide-react';
import { useTrade } from '@/contexts/TradeContext';
import { getPair } from '@/services/market';
import { calcUnrealizedPnl, formatPercent, formatPrice, formatQty, formatUsd } from '@/lib/trade';
import { useTelegram } from '@/hooks/useTelegram';

const CONFIRM_WINDOW_MS = 3000;

/**
 * Open positions with live PnL and editable Take Profit / Stop Loss levels.
 * Uses the freshest price available for the pair currently on screen, otherwise
 * the context's mark-price poller.
 */
export function PositionsList({ limit = null, livePair = null, livePrice = null, compact = false }) {
  const { positions, realizedPnl, busy, closeTrade, updateLevels, clearError } = useTrade();
  const [levelsError, setLevelsError] = useState(null);
  const { vibrate } = useTelegram();
  const [confirmId, setConfirmId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [tpDraft, setTpDraft] = useState('');
  const [slDraft, setSlDraft] = useState('');

  useEffect(() => {
    if (!confirmId) return undefined;
    const timer = setTimeout(() => setConfirmId(null), CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [confirmId]);

  const rows = (limit ? positions.slice(0, limit) : positions).map((p) => {
    const mark = livePair === p.pair && livePrice ? livePrice : p.mark_price;
    const live = calcUnrealizedPnl({ qty: p.qty, entryPrice: p.entry_price, markPrice: mark });
    return {
      ...p,
      mark_price: mark,
      unrealized_pnl: live.ok ? live.unrealized : p.unrealized_pnl,
      unrealized_pct: live.ok ? live.unrealizedPct : p.unrealized_pct,
      value: live.ok ? live.value : p.value,
    };
  });

  const handleClose = async (position) => {
    if (String(confirmId) !== String(position.id)) {
      vibrate('impact');
      setConfirmId(position.id);
      return;
    }
    setConfirmId(null);
    const res = await closeTrade(position.id, position.mark_price);
    vibrate(res.ok ? 'success' : 'error');
  };

  const startEditing = (position) => {
    vibrate('light');
    setLevelsError(null);
    setEditingId(position.id);
    setTpDraft(position.take_profit ? String(position.take_profit) : '');
    setSlDraft(position.stop_loss ? String(position.stop_loss) : '');
  };

  const saveLevels = async (position) => {
    const res = await updateLevels(position.id, { takeProfit: tpDraft, stopLoss: slDraft });
    vibrate(res.ok ? 'success' : 'error');
    if (res.ok) {
      setLevelsError(null);
      setEditingId(null);
    } else {
      setLevelsError(res.error);
    }
  };

  if (positions.length === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-dashed border-white/10 px-4 py-5 text-center" data-testid="positions-empty">
        <Briefcase className="w-5 h-5 text-white/25 mx-auto mb-2" />
        <p className="text-xs text-white/40">No open positions</p>
        <p className="text-[11px] text-white/25 mt-1">Buy above to start practising with demo USDT</p>
      </div>
    );
  }

  return (
    <div className="mt-4" data-testid="positions-list">
      <div className="flex items-center justify-between mb-2">
        <span className="sys-label">
          Positions · {positions.length}
        </span>
        <span className="text-[11px] text-white/40">
          Realized{' '}
          <span className={realizedPnl >= 0 ? 'text-brand-green' : 'text-brand-red'}>
            {formatUsd(realizedPnl)}
          </span>
        </span>
      </div>

      <div className="space-y-2">
        <AnimatePresence initial={false}>
          {rows.map((p) => {
            const pair = getPair(p.pair);
            const up = p.unrealized_pnl >= 0;
            const isConfirming = String(confirmId) === String(p.id);
            const isEditing = String(editingId) === String(p.id);
            const hasLevels = !!p.take_profit || !!p.stop_loss;

            return (
              <motion.div
                key={p.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.18 }}
                className="rounded-2xl bg-white/[0.03] border border-white/[0.06] px-3.5 py-3"
                data-testid={`position-${p.pair}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ background: pair.color }} />
                      <span className="text-sm font-semibold text-white">{pair.label}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-green/10 text-brand-green font-bold">
                        LONG
                      </span>
                    </div>
                    <p className="text-[11px] text-white/40 mt-1 font-mono">
                      {formatQty(p.qty, pair.qtyDecimals)} {pair.base} @ {formatPrice(p.entry_price, pair.priceDecimals)}
                    </p>
                  </div>

                  <div className="text-right">
                    <p className={`text-sm font-bold flex items-center justify-end gap-1 ${up ? 'text-brand-green' : 'text-brand-red'}`}>
                      {up ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                      {formatUsd(p.unrealized_pnl)}
                    </p>
                    <p className={`text-[11px] font-mono ${up ? 'text-brand-green/70' : 'text-brand-red/70'}`}>
                      {formatPercent(p.unrealized_pct * 100)}
                    </p>
                  </div>
                </div>

                {/* TP / SL */}
                {!compact && (
                  <div className="mt-2.5 pt-2.5 border-t border-white/[0.05]">
                    {isEditing ? (
                      <div className="space-y-2" data-testid="levels-editor">
                        <div className="flex items-center gap-2">
                          <Target className="w-3 h-3 text-brand-green flex-shrink-0" />
                          <input
                            type="number"
                            inputMode="decimal"
                            step="any"
                            value={tpDraft}
                            placeholder="Take Profit"
                            onChange={(e) => {
                              setTpDraft(e.target.value);
                              setLevelsError(null);
                            }}
                            data-testid="levels-tp-input"
                            className="flex-1 min-w-0 rounded-lg bg-black/30 border border-white/[0.06] px-2.5 py-1.5 font-mono text-[11px] text-white outline-none focus:border-brand-green/40 placeholder:text-white/25 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <ShieldAlert className="w-3 h-3 text-brand-red flex-shrink-0" />
                          <input
                            type="number"
                            inputMode="decimal"
                            step="any"
                            value={slDraft}
                            placeholder="Stop Loss"
                            onChange={(e) => {
                              setSlDraft(e.target.value);
                              setLevelsError(null);
                            }}
                            data-testid="levels-sl-input"
                            className="flex-1 min-w-0 rounded-lg bg-black/30 border border-white/[0.06] px-2.5 py-1.5 font-mono text-[11px] text-white outline-none focus:border-brand-red/40 placeholder:text-white/25 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        </div>
                        {levelsError && (
                          <p className="text-[10px] text-brand-red">{levelsError}</p>
                        )}
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => saveLevels(p)}
                            disabled={busy}
                            data-testid="levels-save"
                            className="flex-1 py-1.5 rounded-lg bg-white text-black text-[11px] font-bold active:scale-95 disabled:opacity-50 transition-all"
                          >
                            Save limits
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            disabled={busy}
                            className="px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] font-semibold text-white/60 active:scale-95 disabled:opacity-50 transition-all"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              const res = await updateLevels(p.id, { takeProfit: null, stopLoss: null });
                              vibrate(res.ok ? 'success' : 'error');
                              if (res.ok) {
                                setLevelsError(null);
                                setEditingId(null);
                              } else {
                                setLevelsError(res.error);
                              }
                            }}
                            disabled={busy}
                            data-testid="levels-remove"
                            className="px-3 py-1.5 rounded-lg bg-brand-red/10 border border-brand-red/20 text-brand-red active:scale-95 disabled:opacity-50 transition-all"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {p.take_profit ? (
                            <span
                              className="flex items-center gap-1 px-2 py-1 rounded-md bg-brand-green/10 border border-brand-green/20 text-[10px] font-mono text-brand-green"
                              data-testid="position-tp"
                            >
                              <Target className="w-2.5 h-2.5" />
                              TP {formatPrice(p.take_profit, pair.priceDecimals)}
                            </span>
                          ) : null}
                          {p.stop_loss ? (
                            <span
                              className="flex items-center gap-1 px-2 py-1 rounded-md bg-brand-red/10 border border-brand-red/20 text-[10px] font-mono text-brand-red"
                              data-testid="position-sl"
                            >
                              <ShieldAlert className="w-2.5 h-2.5" />
                              SL {formatPrice(p.stop_loss, pair.priceDecimals)}
                            </span>
                          ) : null}
                          {!hasLevels && <span className="text-[10px] text-white/25">No limits set</span>}
                        </div>

                        <button
                          type="button"
                          onClick={() => startEditing(p)}
                          disabled={busy}
                          data-testid="levels-edit"
                          className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/[0.05] border border-white/[0.08] text-[10px] font-semibold text-white/60 hover:text-white active:scale-95 disabled:opacity-50 transition-all"
                        >
                          <Pencil className="w-2.5 h-2.5" />
                          {hasLevels ? 'Edit' : 'Add TP/SL'}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {!compact && (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="text-[11px] text-white/40 font-mono">
                      Mark {formatPrice(p.mark_price, pair.priceDecimals)} · Value {formatUsd(p.value)}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleClose(p)}
                      disabled={busy}
                      data-testid={`close-position-${p.pair}`}
                      className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all active:scale-95 disabled:opacity-50 ${
                        isConfirming
                          ? 'bg-brand-red text-white'
                          : 'bg-white/[0.06] border border-white/10 text-white/70 hover:bg-white/[0.1]'
                      }`}
                    >
                      {busy ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : isConfirming ? (
                        'Confirm close'
                      ) : (
                        'Close'
                      )}
                    </button>
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default PositionsList;

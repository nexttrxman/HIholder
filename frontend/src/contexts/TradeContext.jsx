import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  closeTradePosition,
  getPositions,
  placeTrade,
  sellWalletAsset as apiSellWalletAsset,
  setTradeLevels,
} from '@/services/api';
import { useWallet } from '@/contexts/WalletContext';
import { fetch24h, getPair } from '@/services/market';
import {
  calcCloseTrade,
  calcOpenTrade,
  calcWalletSale,
  calcUnrealizedPnl,
  checkLevelTrigger,
  validateLevels,
  validateTradeRequest,
} from '@/lib/trade';
import { computePortfolio } from '@/lib/portfolio';

const TradeContext = createContext(null);

const POSITIONS_KEY = 'tk_positions_v1';
const REALIZED_KEY = 'tk_realized_v1';
const DEFAULT_MARK_POLL_MS = 10000;
const TRIGGER_BANNER_MS = 6000;

function readJson(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* storage unavailable - ignore */
  }
}

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function TradeProvider({ children, markPollMs = DEFAULT_MARK_POLL_MS }) {
  const {
    usdtBalance,
    applyUsdtDelta,
    applyAssetDelta,
    pushLocalTransaction,
    refreshData,
  } = useWallet();

  const [positions, setPositions] = useState([]);
  const [realizedPnl, setRealizedPnl] = useState(0);
  const [marks, setMarks] = useState({});
  const [source, setSource] = useState('local'); // 'backend' | 'local'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [lastTrigger, setLastTrigger] = useState(null);

  const balanceRef = useRef(usdtBalance);
  balanceRef.current = usdtBalance;

  // ============================================
  // LOAD
  // ============================================
  const load = useCallback(async () => {
    try {
      const res = await getPositions();
      if (res && res.ok) {
        setSource('backend');
        setPositions(Array.isArray(res.positions) ? res.positions : []);
        setRealizedPnl(Number(res.realized_pnl) || 0);
        return;
      }
    } catch (err) {
      console.warn('positions unavailable, running the trade panel locally:', err?.message);
    }

    setSource('local');
    setPositions(readJson(POSITIONS_KEY, []));
    setRealizedPnl(Number(readJson(REALIZED_KEY, 0)) || 0);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ============================================
  // MARK PRICES for open positions (any pair)
  // ============================================
  const openPairsKey = useMemo(
    () => [...new Set(positions.filter((p) => p.status === 'open').map((p) => p.pair))].join('|'),
    [positions]
  );

  useEffect(() => {
    const pairs = openPairsKey ? openPairsKey.split('|') : [];
    if (pairs.length === 0) {
      setMarks({});
      return undefined;
    }

    let active = true;

    const loadMarks = async () => {
      const entries = await Promise.all(
        pairs.map(async (pair) => {
          try {
            const tick = await fetch24h(pair);
            return [pair, tick.price];
          } catch (e) {
            return [pair, null];
          }
        })
      );
      if (!active) return;
      setMarks((prev) => {
        const next = { ...prev };
        for (const [pair, price] of entries) {
          if (price) next[pair] = price;
        }
        return next;
      });
    };

    loadMarks();
    const interval = setInterval(loadMarks, markPollMs);
    return () => {
      active = false;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPairsKey, markPollMs]);

  const persistLocal = useCallback((nextPositions, nextRealized) => {
    writeJson(POSITIONS_KEY, nextPositions);
    writeJson(REALIZED_KEY, nextRealized);
  }, []);

  // ============================================
  // OPEN
  // ============================================
  const openTrade = useCallback(
    async ({ pair, amountUsdt, price, takeProfit = null, stopLoss = null }) => {
      const validation = validateTradeRequest({ pair, amount: amountUsdt, balance: balanceRef.current });
      if (!validation.ok) {
        setError(validation.error);
        return { ok: false, error: validation.error };
      }

      const fill = calcOpenTrade({ amount: validation.amount, price });
      if (!fill.ok) {
        setError(fill.error);
        return { ok: false, error: fill.error };
      }

      const levels = validateLevels({ entryPrice: price, takeProfit, stopLoss });
      if (!levels.ok) {
        setError(levels.error);
        return { ok: false, error: levels.error };
      }

      setBusy(true);
      setError(null);

      try {
        if (source === 'backend') {
          const res = await placeTrade({
            pair,
            amount: validation.amount,
            price,
            takeProfit: levels.takeProfit,
            stopLoss: levels.stopLoss,
          });
          if (!res || !res.ok) {
            const message = res?.error || 'Order rejected';
            setError(message);
            return { ok: false, error: message };
          }
          setPositions((prev) => [res.position, ...prev]);
          await refreshData();
          return { ok: true, position: res.position };
        }

        // Local (dev / offline) execution against the demo balance.
        const fillPrice = Number(price);
        const position = {
          id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          pair,
          qty: fill.qty,
          entry_price: fillPrice,
          cost_basis: validation.amount,
          fee_paid: fill.fee,
          take_profit: levels.takeProfit,
          stop_loss: levels.stopLoss,
          status: 'open',
          opened_at: new Date().toISOString(),
        };

        const next = [position, ...positions];
        setPositions(next);
        persistLocal(next, realizedPnl);
        applyUsdtDelta(-fill.totalDebit);

        const pairMeta = getPair(pair);
        pushLocalTransaction({
          id: position.id,
          type: 'buy',
          asset: 'USDT',
          amount: fill.totalDebit,
          status: 'confirmed',
          timestamp: Date.now(),
          description: `Buy ${pairMeta.base} @ ${fillPrice}`,
        });

        return { ok: true, position };
      } catch (err) {
        const message = err?.message || 'Order failed';
        setError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(false);
      }
    },
    [source, positions, realizedPnl, persistLocal, applyUsdtDelta, pushLocalTransaction, refreshData]
  );

  // ============================================
  // CLOSE
  // ============================================
  const closeTrade = useCallback(
    async (positionId, price, reason = 'manual') => {
      const position = positions.find((p) => String(p.id) === String(positionId));
      if (!position) return { ok: false, error: 'Position not found' };

      const exitPrice = Number(price) || Number(marks[position.pair]) || Number(position.entry_price);
      const result = calcCloseTrade({
        qty: position.qty,
        entryPrice: position.entry_price,
        exitPrice,
      });
      if (!result.ok) {
        setError(result.error);
        return { ok: false, error: result.error };
      }

      setBusy(true);
      setError(null);

      try {
        if (source === 'backend') {
          const res = await closeTradePosition({ positionId, price: exitPrice });
          if (!res || !res.ok) {
            const message = res?.error || 'Close rejected';
            setError(message);
            return { ok: false, error: message };
          }
          setPositions((prev) => prev.filter((p) => String(p.id) !== String(positionId)));
          setRealizedPnl((prev) => prev + (Number(res.pnl) || 0));
          await refreshData();
          return { ok: true, pnl: Number(res.pnl) || 0 };
        }

        const next = positions.filter((p) => String(p.id) !== String(positionId));
        const nextRealized = realizedPnl + result.pnl;
        setPositions(next);
        setRealizedPnl(nextRealized);
        persistLocal(next, nextRealized);
        applyUsdtDelta(result.credit);

        const pairMeta = getPair(position.pair);
        const suffix = reason === 'tp' ? ' · Take Profit' : reason === 'sl' ? ' · Stop Loss' : '';
        pushLocalTransaction({
          id: `${position.id}_close`,
          type: 'sell',
          asset: 'USDT',
          amount: result.credit,
          status: 'confirmed',
          timestamp: Date.now(),
          description: `Sell ${pairMeta.base} @ ${exitPrice} · PnL ${result.pnl >= 0 ? '+' : ''}${result.pnl.toFixed(2)} USDT${suffix}`,
        });

        return { ok: true, pnl: result.pnl };
      } catch (err) {
        const message = err?.message || 'Close failed';
        setError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(false);
      }
    },
    [positions, marks, source, realizedPnl, persistLocal, applyUsdtDelta, pushLocalTransaction, refreshData]
  );

  // ============================================
  // SELL WALLET ASSET (TRX/TON -> USDT)
  // ============================================
  /**
   * Vende saldo de la wallet interna, no una posición abierta. Es lo que permite
   * usar el bonus de referidos en TRX: antes se veía en la wallet pero el único
   * SELL del panel cerraba posiciones del book simulado.
   */
  const sellWalletAsset = useCallback(
    async ({ asset, amount, price }) => {
      const qty = Number(amount);
      const mark = Number(price);

      if (asset !== 'TRX' && asset !== 'TON') {
        const message = 'Only TRX or TON can be sold from the wallet';
        setError(message);
        return { ok: false, error: message };
      }
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(mark) || mark <= 0) {
        const message = 'Invalid sale';
        setError(message);
        return { ok: false, error: message };
      }

      // Misma matemática que sell_wallet_asset(): proceeds menos la fee de un
      // lado. Sin PnL, porque un bonus de referidos no tiene precio de entrada.
      const fill = calcWalletSale({ amount: qty, price: mark });
      if (!fill.ok) {
        setError(fill.error);
        return { ok: false, error: fill.error };
      }

      setBusy(true);
      setError(null);

      try {
        if (source === 'backend') {
          const res = await apiSellWalletAsset({ asset, amount: qty, price: mark });
          if (!res || !res.ok) {
            const message = res?.error || 'Sale rejected';
            setError(message);
            return { ok: false, error: message };
          }
          await refreshData();
          return { ok: true, credit: Number(res.credited) || 0, fee: Number(res.fee) || 0 };
        }

        applyAssetDelta(asset, -qty);
        applyUsdtDelta(fill.credit);
        pushLocalTransaction({
          id: `walletsale_${asset}_${Date.now()}`,
          type: 'sell',
          asset: 'USDT',
          amount: fill.credit,
          status: 'confirmed',
          timestamp: Date.now(),
          description: `Sell ${qty} ${asset} from wallet @ ${mark}`,
        });

        return { ok: true, credit: fill.credit, fee: fill.fee };
      } catch (err) {
        const message = err?.message || 'Sale failed';
        setError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(false);
      }
    },
    [source, applyAssetDelta, applyUsdtDelta, pushLocalTransaction, refreshData]
  );

  // ============================================
  // EDIT LIMITS
  // ============================================
  const updateLevels = useCallback(
    async (positionId, { takeProfit = null, stopLoss = null }) => {
      const position = positions.find((p) => String(p.id) === String(positionId));
      if (!position) return { ok: false, error: 'Position not found' };

      const levels = validateLevels({
        entryPrice: position.entry_price,
        takeProfit,
        stopLoss,
      });
      // Errors here belong to the levels editor, not to the order form.
      if (!levels.ok) {
        return { ok: false, error: levels.error };
      }

      setBusy(true);

      try {
        if (source === 'backend') {
          const res = await setTradeLevels({
            positionId,
            takeProfit: levels.takeProfit,
            stopLoss: levels.stopLoss,
          });
          if (!res || !res.ok) {
            const message = res?.error || 'Update rejected';
            setError(message);
            return { ok: false, error: message };
          }
        }

        const next = positions.map((p) =>
          String(p.id) === String(positionId)
            ? { ...p, take_profit: levels.takeProfit, stop_loss: levels.stopLoss }
            : p
        );
        setPositions(next);
        if (source === 'local') persistLocal(next, realizedPnl);
        return { ok: true, takeProfit: levels.takeProfit, stopLoss: levels.stopLoss };
      } catch (err) {
        return { ok: false, error: err?.message || 'Update failed' };
      } finally {
        setBusy(false);
      }
    },
    [positions, source, realizedPnl, persistLocal]
  );

  // ============================================
  // LIMIT MONITOR - auto close on TP / SL
  // ============================================
  const closeTradeRef = useRef(closeTrade);
  closeTradeRef.current = closeTrade;
  const triggeredRef = useRef(new Set());

  useEffect(() => {
    positions.forEach((position) => {
      if (position.status !== 'open') return;
      const tp = toNumberOrNull(position.take_profit);
      const sl = toNumberOrNull(position.stop_loss);
      if (!tp && !sl) return;

      const id = String(position.id);
      if (triggeredRef.current.has(id)) return;

      const mark = marks[position.pair];
      if (!mark) return;

      const hit = checkLevelTrigger({
        entryPrice: position.entry_price,
        markPrice: mark,
        takeProfit: tp,
        stopLoss: sl,
      });
      if (!hit) return;

      triggeredRef.current.add(id);
      (async () => {
        const res = await closeTradeRef.current(id, mark, hit);
        if (res.ok) {
          setLastTrigger({ pair: position.pair, kind: hit, pnl: res.pnl, at: Date.now() });
        } else {
          triggeredRef.current.delete(id);
        }
      })();
    });
  }, [positions, marks]);

  useEffect(() => {
    if (!lastTrigger) return undefined;
    const timer = setTimeout(() => setLastTrigger(null), TRIGGER_BANNER_MS);
    return () => clearTimeout(timer);
  }, [lastTrigger]);

  // ============================================
  // DERIVED
  // ============================================
  const markFor = useCallback((pair, fallback) => marks[pair] ?? fallback ?? null, [marks]);

  const enrichedPositions = useMemo(
    () =>
      positions.map((p) => {
        const mark = markFor(p.pair, p.mark_price ?? p.entry_price);
        const live = calcUnrealizedPnl({
          qty: p.qty,
          entryPrice: p.entry_price,
          markPrice: mark || p.entry_price,
        });
        return {
          ...p,
          take_profit: toNumberOrNull(p.take_profit),
          stop_loss: toNumberOrNull(p.stop_loss),
          mark_price: mark || p.entry_price,
          value: live.ok ? live.value : Number(p.qty) * Number(p.entry_price),
          unrealized_pnl: live.ok ? live.unrealized : 0,
          unrealized_pct: live.ok ? live.unrealizedPct : 0,
        };
      }),
    [positions, markFor]
  );

  const openPositions = useMemo(
    () => enrichedPositions.filter((p) => p.status === 'open'),
    [enrichedPositions]
  );

  const positionsValue = useMemo(
    () => openPositions.reduce((sum, p) => sum + (p.value || 0), 0),
    [openPositions]
  );

  const unrealizedPnl = useMemo(
    () => openPositions.reduce((sum, p) => sum + (p.unrealized_pnl || 0), 0),
    [openPositions]
  );

  /**
   * Total = saldo USDT libre + posiciones abiertas a mercado (que arrastran su
   * PnL). Se calcula acá porque los marks viven en este contexto, y lo consumen
   * Home y Wallet para que los dos muestren el mismo número.
   */
  const portfolio = useMemo(
    () => computePortfolio({ usdtBalance, positionsValue, unrealizedPnl }),
    [usdtBalance, positionsValue, unrealizedPnl]
  );

  const clearError = useCallback(() => setError(null), []);
  const clearTrigger = useCallback(() => setLastTrigger(null), []);

  const value = {
    positions: openPositions,
    allPositions: enrichedPositions,
    realizedPnl,
    unrealizedPnl,
    positionsValue,
    portfolio,
    source,
    busy,
    error,
    marks,
    markFor,
    lastTrigger,
    openTrade,
    closeTrade,
    sellWalletAsset,
    updateLevels,
    refresh: load,
    clearError,
    clearTrigger,
  };

  return <TradeContext.Provider value={value}>{children}</TradeContext.Provider>;
}

export function useTrade() {
  const ctx = useContext(TradeContext);
  if (!ctx) throw new Error('useTrade must be used within a TradeProvider');
  return ctx;
}

export default TradeContext;

import { useCallback, useEffect, useRef, useState } from 'react';
/**
 * El feed está vivo si lo está el gráfico O el ticker. Binance spot no lista
 * todos los pares (HYPE solo cotiza en Futures), así que puede darse un ticker
 * real con velas sintéticas: el precio que se muestra es el real.
 */
const combinedMode = (klines, tick) =>
  klines?.mode === 'live' || tick?.mode === 'live' ? 'live' : 'sim';

import {
  advanceSynthetic,
  fetch24h,
  fetchKlines,
  windowChangePercent,
} from '@/services/market';

/**
 * Live-ish market feed for one pair/timeframe.
 *
 * - live: refetches Binance klines + 24h ticker on a poll interval
 * - sim:  advances a deterministic synthetic series locally and retries the
 *   exchange every 5th poll so it self-heals when the network comes back
 */
/**
 * `pollMs` era 6000: dos pedidos (klines + ticker 24h) cada 6 s. En un gráfico
 * cuyo timeframe mínimo es 15m la vela no cambia en 6 segundos, así que la
 * mitad de esos pedidos devolvía exactamente lo mismo. 15 s sigue siendo
 * perceptiblemente "en vivo" para el último precio y recorta ~60% del tráfico.
 *
 * El gráfico no se queda quieto entre medio: los polls que no van a la exchange
 * avanzan una vela sintética (advanceSynthetic abajo).
 */
export const DEFAULT_POLL_MS = 15000;

export function useMarketData(pairId, timeframeId, { candleCount = 60, pollMs = DEFAULT_POLL_MS } = {}) {
  const [candles, setCandles] = useState([]);
  const [ticker, setTicker] = useState(null);
  const [mode, setMode] = useState('loading'); // 'loading' | 'live' | 'sim'
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);

  const modeRef = useRef('loading');
  const pollCountRef = useRef(0);

  const pull = useCallback(
    async (pair, timeframe, { silent = false } = {}) => {
      if (!silent) setLoading(true);
      const [klines, tick] = await Promise.all([
        fetchKlines(pair, timeframe, candleCount),
        fetch24h(pair),
      ]);
      const nextMode = combinedMode(klines, tick);
      modeRef.current = nextMode;
      setMode(nextMode);
      setCandles(klines.candles);
      setTicker(tick);
      setUpdatedAt(Date.now());
      setLoading(false);
    },
    [candleCount]
  );

  useEffect(() => {
    let active = true;
    pollCountRef.current = 0;

    (async () => {
      setLoading(true);
      const [klines, tick] = await Promise.all([
        fetchKlines(pairId, timeframeId, candleCount),
        fetch24h(pairId),
      ]);
      if (!active) return;
      const nextMode = combinedMode(klines, tick);
      modeRef.current = nextMode;
      setMode(nextMode);
      setCandles(klines.candles);
      setTicker(tick);
      setUpdatedAt(Date.now());
      setLoading(false);
    })();

    const interval = setInterval(() => {
      if (!active) return;
      pollCountRef.current += 1;

      const retryExchange = modeRef.current === 'live' || pollCountRef.current % 5 === 0;

      if (retryExchange) {
        (async () => {
          const [klines, tick] = await Promise.all([
            fetchKlines(pairId, timeframeId, candleCount),
            fetch24h(pairId),
          ]);
          if (!active) return;
          const nextMode = combinedMode(klines, tick);
          modeRef.current = nextMode;
          setMode(nextMode);
          setCandles(klines.candles);
          setTicker(tick);
          setUpdatedAt(Date.now());
        })();
      } else {
        setCandles((prev) => advanceSynthetic(prev, pairId, timeframeId));
      }
    }, pollMs);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [pairId, timeframeId, candleCount, pollMs]);

  const refresh = useCallback(() => pull(pairId, timeframeId, { silent: true }), [pull, pairId, timeframeId]);

  const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
  // Un ticker vivo manda sobre el cierre de la última vela, aunque las velas
  // vengan del generador sintético.
  const priceIsLive = ticker?.mode === 'live';
  const lastPrice = priceIsLive
    ? (ticker.price ?? lastCandle?.c ?? 0)
    : (lastCandle?.c ?? ticker?.price ?? 0);
  const changePercent = priceIsLive
    ? (ticker.changePercent ?? windowChangePercent(candles))
    : windowChangePercent(candles);

  return {
    candles,
    mode,
    loading,
    lastPrice,
    changePercent,
    high24h: ticker?.high ?? null,
    low24h: ticker?.low ?? null,
    volume24h: ticker?.volume ?? null,
    updatedAt,
    refresh,
  };
}

export default useMarketData;

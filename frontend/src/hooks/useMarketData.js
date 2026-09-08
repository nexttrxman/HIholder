import { useCallback, useEffect, useRef, useState } from 'react';
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
export function useMarketData(pairId, timeframeId, { candleCount = 60, pollMs = 6000 } = {}) {
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
      modeRef.current = klines.mode;
      setMode(klines.mode);
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
      modeRef.current = klines.mode;
      setMode(klines.mode);
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
          modeRef.current = klines.mode;
          setMode(klines.mode);
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
  const lastPrice = mode === 'sim'
    ? (lastCandle?.c ?? ticker?.price ?? 0)
    : (ticker?.price ?? lastCandle?.c ?? 0);
  const changePercent = mode === 'sim'
    ? windowChangePercent(candles)
    : (ticker?.changePercent ?? windowChangePercent(candles));

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

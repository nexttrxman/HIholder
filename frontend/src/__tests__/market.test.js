import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Sin mock de @/services/market: acá se prueba la resolución real de venues.
 * trade.test.jsx sí lo mockea, así que estos casos no pueden vivir ahí.
 */
import { PAIRS, fetch24h, fetchKlines, pairSymbols } from '@/services/market';

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
});

describe('market venues', () => {
  it('cae a Binance Futures cuando spot no lista el par (HYPE)', async () => {
    const asked = [];
    global.fetch = vi.fn(async (url) => {
      asked.push(url);
      if (url.includes('fapi.binance.com')) {
        return {
          ok: true,
          json: async () => ({
            lastPrice: '82.90',
            priceChangePercent: '1.2',
            highPrice: '84',
            lowPrice: '80',
            quoteVolume: '1000',
          }),
        };
      }
      return { ok: false, status: 400, json: async () => ({}) };
    });

    const tick = await fetch24h('HYPEUSDT');
    expect(tick.mode).toBe('live');
    expect(tick.source).toBe('binance-futures');
    expect(tick.price).toBe(82.9);
    expect(asked.some((u) => u.includes('api.binance.com'))).toBe(true);
  });

  it('las velas también caen al segundo venue', async () => {
    global.fetch = vi.fn(async (url) => {
      if (!url.includes('fapi.binance.com')) return { ok: false, status: 400 };
      const base = 82;
      return {
        ok: true,
        json: async () =>
          Array.from({ length: 5 }, (_, i) => [
            1700000000000 + i * 3600000,
            String(base + i), String(base + i + 1), String(base + i - 1), String(base + i), '100',
          ]),
      };
    });

    const k = await fetchKlines('HYPEUSDT', '1h', 5);
    expect(k.mode).toBe('live');
    expect(k.source).toBe('binance-futures');
    expect(k.candles).toHaveLength(5);
  });

  it('si ningún venue responde, lo dice en vez de disfrazar el fallback', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    });

    const tick = await fetch24h('HYPEUSDT');
    expect(tick.mode).toBe('sim');
    expect(tick.source).toBe('synthetic');
    // Y el precio sintético sale de la semilla real, no de un número al azar.
    expect(Math.abs(tick.price - 83) / 83).toBeLessThan(0.35);
  });

  it('un precio implausible no gana aunque el venue responda', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ lastPrice: '0.0009', priceChangePercent: '0' }),
    }));

    const tick = await fetch24h('TONUSDT');
    expect(tick.mode).toBe('sim', 'un homónimo a fracciones de centavo no puede pasar por GRAM');
  });

  it('todos los pares tienen semilla y los alias de GRAM están en orden', () => {
    for (const pair of PAIRS) {
      expect(Number.isFinite(pair.seedPrice) && pair.seedPrice > 0, pair.id).toBe(true);
    }
    expect(pairSymbols('TONUSDT')).toEqual(['GRAMUSDT', 'TONUSDT']);
    expect(pairSymbols('HYPEUSDT')).toEqual(['HYPEUSDT']);
  });
});

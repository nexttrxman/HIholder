import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Sin mock de @/services/market: acá se prueba la resolución real de venues.
 * trade.test.jsx sí lo mockea, así que estos casos no pueden vivir ahí.
 */
import { PAIRS, fetch24h, fetch24hMany, fetchKlines, pairSymbols } from '@/services/market';

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

describe('fetch24hMany (batch)', () => {
  const row = (symbol, price) => ({
    symbol,
    lastPrice: String(price),
    priceChangePercent: '0.5',
    highPrice: String(price * 1.01),
    lowPrice: String(price * 0.99),
    quoteVolume: '10',
  });

  it('resuelve varios pares en UN solo pedido', async () => {
    const asked = [];
    global.fetch = vi.fn(async (url) => {
      asked.push(url);
      return {
        ok: true,
        json: async () => [row('BTCUSDT', 79100), row('ETHUSDT', 2495), row('TRXUSDT', 0.312)],
      };
    });

    const ticks = await fetch24hMany(['BTCUSDT', 'ETHUSDT', 'TRXUSDT']);

    expect(asked.length).toBe(1);
    expect(asked[0]).toContain('symbols=');
    expect(ticks.get('BTCUSDT')).toMatchObject({ price: 79100, mode: 'live', symbol: 'BTCUSDT' });
    expect(ticks.get('TRXUSDT').price).toBe(0.312);
  });

  it('un solo par va con ?symbol= (pesa menos que el array)', async () => {
    const asked = [];
    global.fetch = vi.fn(async (url) => {
      asked.push(url);
      return { ok: true, json: async () => row('BTCUSDT', 79100) };
    });

    const ticks = await fetch24hMany(['BTCUSDT']);

    expect(asked.length).toBe(1);
    expect(asked[0]).toContain('symbol=BTCUSDT');
    expect(asked[0]).not.toContain('symbols=');
    expect(ticks.get('BTCUSDT').price).toBe(79100);
  });

  it('si el pedido batcheado falla, resuelve de a uno sin perder los demás', async () => {
    // Escenario real: GRAM declara symbols ['GRAMUSDT','TONUSDT']. Si el venue
    // rechaza el batch entero porque GRAMUSDT no existe, sin el fallback se
    // quedarían sin precio también BTC y el resto.
    const asked = [];
    const prices = { TONUSDT: 1.39, BTCUSDT: 79100 };
    global.fetch = vi.fn(async (url) => {
      asked.push(url);
      if (url.includes('symbols=')) return { ok: false, status: 400, json: async () => ({}) };
      const symbol = new URL(url).searchParams.get('symbol');
      if (!prices[symbol]) return { ok: false, status: 400, json: async () => ({}) };
      return { ok: true, json: async () => row(symbol, prices[symbol]) };
    });

    const ticks = await fetch24hMany(['TONUSDT', 'BTCUSDT']);

    expect(asked.some((u) => u.includes('symbols='))).toBe(true);
    expect(ticks.get('TONUSDT')).toMatchObject({ price: 1.39, symbol: 'TONUSDT' });
    expect(ticks.get('BTCUSDT').price).toBe(79100);
  });

  it('cae al segundo venue solo con los pares que el primero no resolvió (HYPE)', async () => {
    const asked = [];
    global.fetch = vi.fn(async (url) => {
      asked.push(url);
      const futures = url.includes('fapi.binance.com');
      if (url.includes('symbols=')) {
        // spot no lista HYPE: devuelve solo BTC. En futures devuelve ambos.
        return {
          ok: true,
          json: async () =>
            futures ? [row('BTCUSDT', 79100), row('HYPEUSDT', 83.1)] : [row('BTCUSDT', 79100)],
        };
      }
      return { ok: true, json: async () => row('HYPEUSDT', 83.1) };
    });

    const ticks = await fetch24hMany(['BTCUSDT', 'HYPEUSDT']);

    expect(ticks.get('BTCUSDT')).toMatchObject({ price: 79100, source: 'binance-spot' });
    expect(ticks.get('HYPEUSDT')).toMatchObject({ price: 83.1, source: 'binance-futures' });
    // El segundo venue no vuelve a pedir BTC: ya estaba resuelto.
    const segunda = asked.filter((u) => u.includes('fapi.binance.com'));
    expect(segunda.every((u) => !u.includes('BTCUSDT'))).toBe(true);
  });

  it('omite los pares que ningún venue pudo resolver (el llamador conserva el último precio)', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }));

    const ticks = await fetch24hMany(['BTCUSDT', 'ETHUSDT']);

    expect(ticks.size).toBe(0);
    expect(ticks.get('BTCUSDT')).toBeUndefined();
  });

  it('un precio implausible no se cuela (homónimo tipo Kraken Gram a $0.0009)', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => row('TONUSDT', 0.0009) }));

    const ticks = await fetch24hMany(['TONUSDT']);

    expect(ticks.size).toBe(0);
  });

  it('no duplica pares repetidos en la entrada', async () => {
    const asked = [];
    global.fetch = vi.fn(async (url) => {
      asked.push(url);
      return { ok: true, json: async () => row('BTCUSDT', 79100) };
    });

    await fetch24hMany(['BTCUSDT', 'BTCUSDT', 'BTCUSDT']);

    expect(asked.length).toBe(1);
  });
});

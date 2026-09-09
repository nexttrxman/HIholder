/**
 * Market data for the Trade panel.
 *
 * Primary source: the public Binance REST API (no key, CORS enabled, free).
 * Fallback: deterministic synthetic candles, so the panel still works inside
 * Telegram's in-app browser, behind captive networks or when the sandbox blocks
 * third-party requests. The UI always shows which source is active.
 */

const REQUEST_TIMEOUT_MS = 6000;

/**
 * Venues de mercado, en orden de preferencia.
 *
 * Binance **spot** no lista todos los pares: HYPE cotiza en Binance Futures, no
 * en spot. Con un solo venue esos pares fallaban siempre y caían al generador
 * sintético, mostrando un precio inventado de forma permanente. Los dos venues
 * devuelven el mismo formato de respuesta, así que el resto del código no cambia.
 */
const VENUES = [
  { name: 'binance-spot', base: 'https://api.binance.com/api/v3' },
  { name: 'binance-futures', base: 'https://fapi.binance.com/fapi/v1' },
];

export const PAIRS = [
  /**
   * Toncoin se renombró a Gram el 15/06/2026 (mismo activo, 1:1, sin swap):
   * el ticker del token es GRAM y TON queda reservado a la red.
   *
   * `id` sigue siendo TONUSDT porque es la clave que validan el Worker
   * (ALLOWED_PAIRS) y la que queda persistida en trade_positions; cambiarla
   * dejaría huérfanas las posiciones ya abiertas. `symbols` son los tickers de
   * mercado a probar, por si el exchange ya migró el par.
   */
  { id: 'TONUSDT', base: 'GRAM', label: 'GRAM/USDT', symbols: ['GRAMUSDT', 'TONUSDT'], color: '#0098EA', priceDecimals: 3, qtyDecimals: 2, seedPrice: 1.39, vol: 0.0042 },
  { id: 'BTCUSDT', base: 'BTC', label: 'BTC/USDT', color: '#F7931A', priceDecimals: 2, qtyDecimals: 5, seedPrice: 79000, vol: 0.0022 },
  { id: 'ETHUSDT', base: 'ETH', label: 'ETH/USDT', color: '#627EEA', priceDecimals: 2, qtyDecimals: 4, seedPrice: 2490, vol: 0.0031 },
  { id: 'SOLUSDT', base: 'SOL', label: 'SOL/USDT', color: '#14F195', priceDecimals: 2, qtyDecimals: 3, seedPrice: 103, vol: 0.0035 },
  { id: 'HYPEUSDT', base: 'HYPE', label: 'HYPE/USDT', color: '#97FCE4', priceDecimals: 2, qtyDecimals: 3, seedPrice: 83, vol: 0.0045 },
  { id: 'UNIUSDT', base: 'UNI', label: 'UNI/USDT', color: '#FF007A', priceDecimals: 3, qtyDecimals: 2, seedPrice: 6.9, vol: 0.0038 },
  { id: 'TRXUSDT', base: 'TRX', label: 'TRX/USDT', color: '#EF0027', priceDecimals: 5, qtyDecimals: 1, seedPrice: 0.312, vol: 0.0018 },
  { id: 'DOGEUSDT', base: 'DOGE', label: 'DOGE/USDT', color: '#C2A633', priceDecimals: 5, qtyDecimals: 1, seedPrice: 0.09, vol: 0.0052 },
];

// seedPrice es el último precio real conocido de cada par (08/09/2026): solo se
// usa cuando el exchange no responde, y cumple doble función de "precio
// razonable" para descartar listados homónimos. Ver isPlausiblePrice.

export const TIMEFRAMES = [
  { id: '15m', label: '15m', ms: 15 * 60 * 1000, binance: '15m' },
  { id: '1h', label: '1H', ms: 60 * 60 * 1000, binance: '1h' },
  { id: '4h', label: '4H', ms: 4 * 60 * 60 * 1000, binance: '4h' },
  { id: '1d', label: '1D', ms: 24 * 60 * 60 * 1000, binance: '1d' },
];

export const getPair = (id) => PAIRS.find((p) => p.id === id) || PAIRS[0];

/**
 * Tickers de mercado de un par, en orden de preferencia. Un par puede cotizar
 * bajo más de un símbolo durante una transición de nombre (TON -> GRAM).
 */
export function pairSymbols(pairOrId) {
  const pair = typeof pairOrId === 'string' ? getPair(pairOrId) : pairOrId;
  // `symbols` primero: ahí va el ticker actual antes que el anterior. pair.id
  // queda al final como red. Este orden tiene que coincidir con PAIR_ALIASES en
  // cloudflare-worker/lib.js, o el gráfico y el precio de ejecución divergen.
  return [...new Set([...(pair.symbols || []), pair.id])];
}

/**
 * Un precio de exchange se acepta solo si cae dentro de un orden de magnitud
 * del último precio conocido.
 *
 * No es paranoia: hay tokens llamados "Gram" que no son el de The Open Network
 * y cotizan a fracciones de centavo. Sin esta guarda, el primer ticker que
 * responda gana y un homónimo secuestra el precio del par.
 */
export const MAX_SEED_RATIO = 10;

export function isPlausiblePrice(price, seedPrice) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return false;
  const s = Number(seedPrice);
  if (!Number.isFinite(s) || s <= 0) return true;
  const ratio = p / s;
  return ratio >= 1 / MAX_SEED_RATIO && ratio <= MAX_SEED_RATIO;
}
export const getTimeframe = (id) => TIMEFRAMES.find((t) => t.id === id) || TIMEFRAMES[1];

// ============================================
// HTTP
// ============================================
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================
// SYNTHETIC CANDLES (deterministic fallback)
// ============================================
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG so a given pair/timeframe is stable. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller gaussian from a uniform PRNG. */
function gaussian(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function alignToPeriod(ms) {
  return Math.floor(Date.now() / ms) * ms;
}

/**
 * Build `limit` synthetic candles ending at the current (still forming) period.
 */
export function syntheticCandles(pairId, timeframeId, limit = 60) {
  const pair = getPair(pairId);
  const tf = getTimeframe(timeframeId);
  const rand = mulberry32(hashString(`${pairId}|${tf.id}`));

  const end = alignToPeriod(tf.ms);
  const start = end - tf.ms * (limit - 1);

  // Random walk backwards from the seed price, then replay forward so the last
  // close always lands near the seed price.
  const closes = [pair.seedPrice];
  for (let i = 1; i < limit; i += 1) {
    const shock = gaussian(rand) * pair.vol;
    closes.push(closes[i - 1] * (1 + shock));
  }

  const candles = [];
  for (let i = 0; i < limit; i += 1) {
    const open = i === 0 ? closes[0] * (1 - gaussian(rand) * pair.vol * 0.5) : closes[i - 1];
    const close = closes[i];
    const wickUp = Math.abs(gaussian(rand)) * pair.vol * 0.6;
    const wickDown = Math.abs(gaussian(rand)) * pair.vol * 0.6;
    const high = Math.max(open, close) * (1 + wickUp);
    const low = Math.min(open, close) * (1 - wickDown);
    const volume = Math.abs(gaussian(rand)) * 500 + 120;

    candles.push({
      t: start + i * tf.ms,
      o: round(open, pair.priceDecimals),
      h: round(high, pair.priceDecimals),
      l: round(low, pair.priceDecimals),
      c: round(close, pair.priceDecimals),
      v: Number(volume.toFixed(2)),
    });
  }

  return candles;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Move the synthetic series forward one tick: either mutate the candle that is
 * still forming, or roll a new one when its period elapsed.
 */
export function advanceSynthetic(candles, pairId, timeframeId) {
  if (!candles || candles.length === 0) return syntheticCandles(pairId, timeframeId, 60);

  const pair = getPair(pairId);
  const tf = getTimeframe(timeframeId);
  const rand = mulberry32((hashString(`${pairId}|${tf.id}|${Date.now() >> 10}`) % 2147483647) || 1);
  const next = candles.slice();
  const last = { ...next[next.length - 1] };

  if (Date.now() >= last.t + tf.ms) {
    // Roll a fresh candle, keep the window length constant.
    const open = last.c;
    const close = round(open * (1 + gaussian(rand) * pair.vol * 0.4), pair.priceDecimals);
    next.push({
      t: last.t + tf.ms,
      o: open,
      h: Math.max(open, close),
      l: Math.min(open, close),
      c: close,
      v: Number((Math.abs(gaussian(rand)) * 400 + 80).toFixed(2)),
    });
    next.shift();
    return next;
  }

  const close = round(last.c * (1 + gaussian(rand) * pair.vol * 0.22), pair.priceDecimals);
  last.c = close;
  last.h = round(Math.max(last.h, close), pair.priceDecimals);
  last.l = round(Math.min(last.l, close), pair.priceDecimals);
  last.v = round(last.v + Math.abs(gaussian(rand)) * 12, 2);
  next[next.length - 1] = last;
  return next;
}

// ============================================
// PUBLIC FETCHERS
// ============================================
/**
 * @returns {Promise<{mode:'live'|'sim', candles:Array}>}
 */
export async function fetchKlines(pairId, timeframeId, limit = 60) {
  const pair = getPair(pairId);
  const tf = getTimeframe(timeframeId);

  for (const venue of VENUES) {
    for (const symbol of pairSymbols(pair)) {
      try {
        const res = await fetchJson(
          `${venue.base}/klines?symbol=${symbol}&interval=${tf.binance}&limit=${limit}`
        );
        const lastClose = Array.isArray(res) ? Number(res[res.length - 1]?.[4]) : NaN;
        if (Array.isArray(res) && res.length > 0 && isPlausiblePrice(lastClose, pair.seedPrice)) {
          return {
            mode: 'live',
            source: venue.name,
            symbol,
            candles: res.map((k) => ({
              t: Number(k[0]),
              o: Number(k[1]),
              h: Number(k[2]),
              l: Number(k[3]),
              c: Number(k[4]),
              v: Number(k[5]),
            })),
          };
        }
      } catch (e) {
        /* venue/símbolo no disponible: probar el siguiente */
      }
    }
  }

  return { mode: 'sim', source: 'synthetic', candles: syntheticCandles(pairId, timeframeId, limit) };
}

/**
 * @returns {Promise<{mode:'live'|'sim', price:number, changePercent:number, high:number, low:number, volume:number}>}
 */
export async function fetch24h(pairId) {
  const pair = getPair(pairId);

  for (const venue of VENUES) {
    for (const symbol of pairSymbols(pair)) {
      try {
        const data = await fetchJson(`${venue.base}/ticker/24hr?symbol=${symbol}`);
        if (isPlausiblePrice(data?.lastPrice, pair.seedPrice)) {
          const price = Number(data.lastPrice);
          return {
            mode: 'live',
            source: venue.name,
            symbol,
            price,
            changePercent: Number(data.priceChangePercent) || 0,
            high: Number(data.highPrice) || price,
            low: Number(data.lowPrice) || price,
            volume: Number(data.quoteVolume) || 0,
          };
        }
      } catch (e) {
        /* venue/símbolo no disponible: probar el siguiente */
      }
    }
  }

  const candles = syntheticCandles(pairId, '1h', 25);
  const price = candles[candles.length - 1].c;
  const ref = candles[0].o;
  const high = Math.max(...candles.map((c) => c.h));
  const low = Math.min(...candles.map((c) => c.l));
  const volume = candles.reduce((sum, c) => sum + c.v, 0) * price;

  return {
    mode: 'sim',
    source: 'synthetic',
    price,
    changePercent: ((price - ref) / ref) * 100,
    high,
    low,
    volume,
  };
}

/** Change over the visible window — used when the 24h ticker is unavailable. */
export function windowChangePercent(candles) {
  if (!candles || candles.length < 2) return 0;
  const first = candles[0].o;
  const last = candles[candles.length - 1].c;
  if (!first) return 0;
  return ((last - first) / first) * 100;
}

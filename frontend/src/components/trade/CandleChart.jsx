import { useEffect, useMemo, useRef, useState } from 'react';
import { formatPrice } from '@/lib/trade';

const UP = '#00E676';
const DOWN = '#FF2A3A';
const PAD = { t: 14, r: 58, b: 22, l: 6 };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function timeLabel(ts, tfMs) {
  const d = new Date(ts);
  if (tfMs >= 24 * 60 * 60 * 1000) {
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Hand-rolled SVG candlestick chart.
 *
 * No chart library: the Telegram in-app browser is memory constrained and we
 * need pixel control over the wicks, the neon last-price chip and the touch
 * crosshair.
 */
export function CandleChart({ candles, pair, timeframe, levels = null, height = 200, className = '' }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(340);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;

    const measure = () => setWidth(el.clientWidth || 340);
    measure();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }

    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const geo = useMemo(() => {
    const n = candles.length;
    const plotW = width - PAD.l - PAD.r;
    const plotH = height - PAD.t - PAD.b;
    if (n === 0 || plotW <= 20 || plotH <= 20) return null;

    let min = Infinity;
    let max = -Infinity;
    let maxVol = 0;
    for (const c of candles) {
      if (c.l < min) min = c.l;
      if (c.h > max) max = c.h;
      if (c.v > maxVol) maxVol = c.v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min === max) {
      min *= 0.995;
      max *= 1.005;
    }
    const span = max - min;
    min -= span * 0.08;
    max += span * 0.08;

    const step = plotW / n;
    const bodyW = Math.max(1.5, Math.min(step * 0.62, 14));
    const volH = plotH * 0.18;

    const y = (v) => PAD.t + (1 - (v - min) / (max - min)) * plotH;
    const x = (i) => PAD.l + step * (i + 0.5);

    const gridLines = [0, 1, 2, 3, 4].map((k) => min + ((max - min) * k) / 4);
    const timeIdx = [0.08, 0.32, 0.56, 0.8]
      .map((f) => Math.min(n - 1, Math.round(f * n)))
      .filter((v, i, arr) => arr.indexOf(v) === i);

    let area = '';
    candles.forEach((c, i) => {
      area += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(c.c).toFixed(2)} `;
    });
    const areaFill = `${area}L${x(n - 1).toFixed(2)},${(PAD.t + plotH).toFixed(2)} L${x(0).toFixed(2)},${(PAD.t + plotH).toFixed(2)} Z`;

    const lastClose = candles[n - 1].c;
    const trendUp = lastClose >= candles[0].o;

    return {
      n,
      step,
      bodyW,
      plotW,
      plotH,
      volH,
      min,
      max,
      maxVol,
      y,
      x,
      gridLines,
      timeIdx,
      areaFill,
      trendUp,
      lastClose,
      lastY: y(lastClose),
    };
  }, [candles, width, height]);

  const hoveredCandle = hover !== null && geo ? candles[hover] : null;

  const handlePointer = (event) => {
    if (!geo) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const relX = event.clientX - rect.left;
    const index = Math.floor((relX - PAD.l) / geo.step);
    setHover(Math.max(0, Math.min(geo.n - 1, index)));
  };

  const gradientId = `area-${pair.id}-${timeframe.id}`;
  const strokeColor = geo?.trendUp ? UP : DOWN;

  return (
    <div
      ref={wrapRef}
      className={`relative w-full select-none ${className}`}
      style={{ height }}
      data-testid="candle-chart"
    >
      {!geo ? (
        <div className="w-full h-full rounded-xl bg-white/[0.02] animate-pulse" />
      ) : (
        <>
          <svg
            width={width}
            height={height}
            className="block touch-none"
            onPointerDown={handlePointer}
            onPointerMove={handlePointer}
            onPointerUp={() => setHover(null)}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={strokeColor} stopOpacity="0.28" />
                <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* horizontal grid + price axis */}
            {geo.gridLines.map((value, i) => (
              <g key={`grid-${i}`}>
                <line
                  x1={PAD.l}
                  x2={PAD.l + geo.plotW}
                  y1={geo.y(value)}
                  y2={geo.y(value)}
                  stroke="rgba(255,255,255,0.05)"
                  strokeWidth="1"
                />
                <text
                  x={PAD.l + geo.plotW + 8}
                  y={geo.y(value) + 3.5}
                  fill="rgba(255,255,255,0.35)"
                  fontSize="9.5"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  {formatPrice(value, pair.priceDecimals)}
                </text>
              </g>
            ))}

            {/* time axis */}
            {geo.timeIdx.map((i) => (
              <text
                key={`time-${i}`}
                x={geo.x(i)}
                y={height - 6}
                fill="rgba(255,255,255,0.28)"
                fontSize="9"
                textAnchor="middle"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {timeLabel(candles[i].t, timeframe.ms)}
              </text>
            ))}

            {/* volume */}
            {geo.maxVol > 0 && candles.map((c, i) => {
              const h = Math.max(1, (c.v / geo.maxVol) * geo.volH);
              const up = c.c >= c.o;
              return (
                <rect
                  key={`vol-${i}`}
                  x={geo.x(i) - geo.bodyW / 2}
                  y={PAD.t + geo.plotH - h}
                  width={geo.bodyW}
                  height={h}
                  fill={up ? UP : DOWN}
                  opacity="0.16"
                />
              );
            })}

            {/* close-line area */}
            <path d={geo.areaFill} fill={`url(#${gradientId})`} />

            {/* candles */}
            {candles.map((c, i) => {
              const up = c.c >= c.o;
              const color = up ? UP : DOWN;
              const bodyTop = geo.y(Math.max(c.o, c.c));
              const bodyBottom = geo.y(Math.min(c.o, c.c));
              const bodyHeight = Math.max(1, bodyBottom - bodyTop);

              return (
                <g key={`c-${i}`}>
                  <line
                    x1={geo.x(i)}
                    x2={geo.x(i)}
                    y1={geo.y(c.h)}
                    y2={geo.y(c.l)}
                    stroke={color}
                    strokeWidth="1"
                    opacity="0.85"
                  />
                  <rect
                    x={geo.x(i) - geo.bodyW / 2}
                    y={bodyTop}
                    width={geo.bodyW}
                    height={bodyHeight}
                    fill={color}
                    rx={geo.bodyW > 4 ? 1 : 0}
                    opacity={hover !== null && hover !== i ? 0.55 : 1}
                  />
                </g>
              );
            })}

            {/* last price marker */}
            <line
              x1={PAD.l}
              x2={PAD.l + geo.plotW}
              y1={geo.lastY}
              y2={geo.lastY}
              stroke={strokeColor}
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity="0.7"
            />
            <rect
              x={PAD.l + geo.plotW + 2}
              y={geo.lastY - 8}
              width={geo.plotW > 0 ? PAD.r - 4 : 0}
              height="16"
              rx="4"
              fill={strokeColor}
              opacity="0.95"
            />
            <text
              x={PAD.l + geo.plotW + 8}
              y={geo.lastY + 3.5}
              fill="#050505"
              fontSize="9.5"
              fontWeight="700"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {formatPrice(geo.lastClose, pair.priceDecimals)}
            </text>

            {/* Take Profit / Stop Loss lines (pinned to the edge when off-scale) */}
            {[
              { key: 'tp', value: levels?.takeProfit, color: UP, label: 'TP', testId: 'chart-tp-line' },
              { key: 'sl', value: levels?.stopLoss, color: DOWN, label: 'SL', testId: 'chart-sl-line' },
            ]
              .filter((level) => Number.isFinite(level.value) && level.value > 0)
              .map((level) => {
                const rawY = geo.y(level.value);
                const top = PAD.t + 9;
                const bottom = PAD.t + geo.plotH - 4;
                const y = Math.max(top, Math.min(rawY, bottom));
                const offScale = rawY < top || rawY > bottom;
                return (
                  <g key={level.key} data-testid={level.testId}>
                    <line
                      x1={PAD.l}
                      x2={PAD.l + geo.plotW}
                      y1={y}
                      y2={y}
                      stroke={level.color}
                      strokeWidth="1"
                      strokeDasharray="5 4"
                      opacity={offScale ? 0.45 : 0.8}
                    />
                    <text
                      x={PAD.l + 4}
                      y={y - 3.5}
                      fill={level.color}
                      fontSize="8.5"
                      fontWeight="700"
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    >
                      {`${offScale ? (level.value > geo.max ? '\u25B2 ' : '\u25BC ') : ''}${level.label} ${formatPrice(level.value, pair.priceDecimals)}`}
                    </text>
                  </g>
                );
              })}

            {/* crosshair */}
            {hover !== null && (
              <line
                x1={geo.x(hover)}
                x2={geo.x(hover)}
                y1={PAD.t}
                y2={PAD.t + geo.plotH}
                stroke="rgba(255,255,255,0.35)"
                strokeWidth="1"
                strokeDasharray="2 3"
              />
            )}
          </svg>

          {hoveredCandle && (
            <div
              className="pointer-events-none absolute top-1 z-10 rounded-xl border border-white/10 bg-black/80 px-3 py-2 backdrop-blur-md"
              style={{
                left: Math.max(4, Math.min(geo.x(hover) - 74, width - 152)),
              }}
              data-testid="chart-tooltip"
            >
              <p className="font-mono text-[10px] text-white/40">
                {new Date(hoveredCandle.t).toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
              <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px]">
                <span className="text-white/40">O</span>
                <span className="text-white">{formatPrice(hoveredCandle.o, pair.priceDecimals)}</span>
                <span className="text-white/40">H</span>
                <span className="text-brand-green">{formatPrice(hoveredCandle.h, pair.priceDecimals)}</span>
                <span className="text-white/40">L</span>
                <span className="text-brand-red">{formatPrice(hoveredCandle.l, pair.priceDecimals)}</span>
                <span className="text-white/40">C</span>
                <span className="text-white">{formatPrice(hoveredCandle.c, pair.priceDecimals)}</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default CandleChart;

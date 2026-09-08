import { describe, it, expect } from 'vitest';

import { computePortfolio } from '@/lib/portfolio';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('computePortfolio', () => {
  it('sin posiciones ni TRX el total es el saldo USDT', () => {
    const p = computePortfolio({ usdtBalance: 100 });
    expect(close(p.total, 100)).toBe(true);
    expect(close(p.usdt, 100)).toBe(true);
    expect(close(p.trades, 0)).toBe(true);
  });

  it('suma las posiciones a mercado, así que una posición en pérdida resta', () => {
    // Salió 50 USDT del saldo; la posición hoy vale 45 → PnL -5.
    // El capital sigue siendo 250, y el total tiene que mostrar 245.
    const p = computePortfolio({ usdtBalance: 200, positionsValue: 45, unrealizedPnl: -5 });
    expect(close(p.total, 245)).toBe(true);
    expect(close(p.pnl, -5)).toBe(true);
  });

  it('una posición en ganancia suma por encima del capital', () => {
    const p = computePortfolio({ usdtBalance: 200, positionsValue: 60, unrealizedPnl: 10 });
    expect(close(p.total, 260)).toBe(true);
  });

  it('convierte el TRX al total cuando hay precio de mercado', () => {
    const p = computePortfolio({ usdtBalance: 10, trxBalance: 100, trxPrice: 0.3 });
    expect(close(p.trxUsd, 30)).toBe(true);
    expect(close(p.total, 40)).toBe(true);
  });

  it('sin precio de TRX no inventa uno: queda afuera del total y se reporta', () => {
    const p = computePortfolio({ usdtBalance: 10, trxBalance: 100, trxPrice: null });
    expect(close(p.total, 10)).toBe(true);
    expect(close(p.trxAmount, 100)).toBe(true);
    expect(p.trxPrice).toBeNull();
    expect(close(p.trxUsd, 0)).toBe(true);
  });

  it('un saldo negativo no puede arrastrar el total por debajo del capital real', () => {
    // Los saldos internos nunca son negativos, pero si llegara un dato roto es
    // preferible acotarlo a mostrar un total absurdo.
    const p = computePortfolio({ usdtBalance: -50, positionsValue: 20 });
    expect(close(p.total, 20)).toBe(true);
  });

  it('ignora valores no numéricos en vez de propagar NaN', () => {
    const p = computePortfolio({
      usdtBalance: 'abc',
      trxBalance: null,
      trxPrice: 'x',
      positionsValue: undefined,
      unrealizedPnl: NaN,
    });
    expect(Number.isNaN(p.total)).toBe(false);
    expect(close(p.total, 0)).toBe(true);
  });

  it('sin argumentos no explota', () => {
    const p = computePortfolio();
    expect(close(p.total, 0)).toBe(true);
  });
});

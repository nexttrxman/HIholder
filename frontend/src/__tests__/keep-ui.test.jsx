import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * $KEEP (v3.2): token propio.
 *
 * Cubre lo que el usuario pidió: KEEP aparece en Trade con precio manejado
 * (Worker /price), se puede comprar pero NO vender, y el saldo entra a la
 * wallet. Los premios en KEEP del check-in/misiones/claim se prueban en la
 * base (supabase/tests/keep-rewards.test.mjs); acá se prueba que la UI los
 * muestra cuando el backend los manda.
 */

// ============================================
// market.js: la fuente de KEEP es el Worker, nunca Binance
// ============================================
const managed = vi.hoisted(() => ({ response: null, fail: false }));

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getManagedMarket: vi.fn(async () => {
      if (managed.fail) throw new Error('worker down');
      return managed.response;
    }),
  };
});

import { fetchKlines, fetch24h, fetch24hMany, getPair, syntheticCandles } from '@/services/market';
import { resetMockWallet } from '@/services/api';
import { computePortfolio } from '@/lib/portfolio';
import { validateManagedBuy, TRADE_CONFIG } from '@/lib/trade';
import { WalletProvider } from '@/contexts/WalletContext';
import { TradeProvider } from '@/contexts/TradeContext';
import { TradePanel } from '@/components/trade/TradePanel';

const CANDLES = Array.from({ length: 5 }, (_, i) => ({
  t: 1789245000000 + i * 3600000,
  o: 0.00035, h: 0.00037, l: 0.00034, c: 0.00036, v: 10 + i,
}));

beforeEach(() => {
  localStorage.clear();
  resetMockWallet();
  managed.fail = false;
  managed.response = {
    ok: true, mode: 'managed', pair: 'KEEPUSDT',
    price: 0.00036, change_percent: 2.5, floor: 0.00012, cap: 0.0006,
    candles: CANDLES,
  };
});

describe('mercado KEEP (fuente manejada)', () => {
  it('el par KEEP existe, es manejado y buy-only', () => {
    const pair = getPair('KEEPUSDT');
    expect(pair.base).toBe('KEEP');
    expect(pair.managed).toBe(true);
    expect(pair.buyOnly).toBe(true);
    expect(pair.seedPrice).toBe(0.00036);
  });

  it('fetchKlines usa el Worker y etiqueta managed', async () => {
    const res = await fetchKlines('KEEPUSDT', '1h', 5);
    expect(res.mode).toBe('managed');
    expect(res.candles).toEqual(CANDLES);
  });

  it('fetch24h trae el precio manejado', async () => {
    const res = await fetch24h('KEEPUSDT');
    expect(res.mode).toBe('managed');
    expect(res.price).toBe(0.00036);
    expect(res.changePercent).toBe(2.5);
  });

  it('fetch24hMany resuelve KEEP por su vía y no lo manda a Binance', async () => {
    const out = await fetch24hMany(['KEEPUSDT']);
    expect(out.get('KEEPUSDT')?.price).toBe(0.00036);
  });

  it('si el Worker no responde, cae al generador sintético (no se queda sin gráfico)', async () => {
    managed.fail = true;
    const res = await fetchKlines('KEEPUSDT', '1h', 60);
    expect(res.mode).toBe('sim');
    expect(res.candles.length).toBe(60);
    const tick = await fetch24h('KEEPUSDT');
    expect(tick.mode).toBe('sim');
    expect(tick.price).toBeGreaterThan(0);
  });
});

describe('validación local de la compra (espejo del Worker)', () => {
  it('acepta, y rechaza por saldo/mínimo igual que validateKeepBuy', () => {
    expect(validateManagedBuy({ amount: 10, balance: 25 }).ok).toBe(true);
    expect(validateManagedBuy({ amount: 10, balance: 10.005 }).error).toMatch(/Insufficient/);
    expect(validateManagedBuy({ amount: 0.5, balance: 100 }).error).toMatch(/Minimum order size/);
    expect(validateManagedBuy({ amount: TRADE_CONFIG.MAX_NOTIONAL + 1, balance: 1e9 }).error).toMatch(/Maximum/);
  });
});

describe('portafolio con KEEP', () => {
  it('suma el KEEP valorizado al total', () => {
    const p = computePortfolio({ usdtBalance: 10, keepBalance: 10000, keepPrice: 0.00036 });
    expect(p.keepUsd).toBeCloseTo(3.6, 9);
    expect(p.total).toBeCloseTo(13.6, 9);
  });

  it('sin precio manejado no inventa valor', () => {
    const p = computePortfolio({ usdtBalance: 10, keepBalance: 10000, keepPrice: null });
    expect(p.keepPrice).toBeNull();
    expect(p.keepUsd).toBe(0);
    expect(p.total).toBe(10);
  });
});

// ============================================
// OrderForm: buy-only de punta a punta (modo dev/local)
// ============================================
function renderWithProviders(ui) {
  return render(
    <WalletProvider>
      <TradeProvider markPollMs={60000}>{ui}</TradeProvider>
    </WalletProvider>
  );
}

describe('Trade panel con KEEP', () => {
  beforeEach(() => {
    managed.response = { ...managed.response, candles: syntheticCandles('KEEPUSDT', '1h', 60) };
  });

  it('muestra el aviso buy-only, apaga el SELL y no ofrece TP/SL', async () => {
    renderWithProviders(<TradePanel />);
    fireEvent.click(screen.getByTestId('pair-selector-trigger'));
    await waitFor(() => expect(screen.getByTestId('pair-selector-menu')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pair-option-KEEPUSDT'));

    await waitFor(() => expect(screen.getByTestId('trade-buy-only-note')).toBeInTheDocument());
    expect(screen.getByTestId('trade-side-sell')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByTestId('trade-limits-toggle')).not.toBeInTheDocument();

    // El SELL no se puede ni seleccionar.
    fireEvent.click(screen.getByTestId('trade-side-sell'));
    expect(screen.getByTestId('trade-side-sell')).toHaveAttribute('aria-pressed', 'false');
  });

  it('compra KEEP: debita USDT con fee y acredita el saldo (sin abrir posición)', async () => {
    renderWithProviders(<TradePanel />);
    fireEvent.click(screen.getByTestId('pair-selector-trigger'));
    await waitFor(() => expect(screen.getByTestId('pair-selector-menu')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pair-option-KEEPUSDT'));

    await waitFor(() => expect(screen.getByTestId('trade-available-value')).toHaveTextContent('$250.00'));
    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '10' } });
    // qty = 10 / precio; el precio sale del worker mock (0.00036)
    await waitFor(() => expect(screen.getByTestId('trade-preview-qty')).toHaveTextContent('27,777.78 KEEP'));
    fireEvent.click(screen.getByTestId('trade-buy-submit'));

    await waitFor(() => expect(screen.getByTestId('trade-order-result')).toHaveTextContent(/added to your balance/));
    // No hay posición abierta: la compra es spot contra keep_balance.
    expect(screen.queryByTestId('position-KEEPUSDT')).not.toBeInTheDocument();
  });
});

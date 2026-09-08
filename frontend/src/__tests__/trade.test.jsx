import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Only the network layer is stubbed here. Pair metadata and the synthetic
 * candle generator stay real, so the chart renders exactly what it would render
 * on a device without connectivity (the documented fallback path).
 */
vi.mock('@/services/market', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchKlines: vi.fn(async (pairId, timeframeId, limit) => ({
      mode: 'live',
      candles: actual.syntheticCandles(pairId, timeframeId, limit),
    })),
    fetch24h: vi.fn(async () => ({
      mode: 'live',
      price: 3.5,
      changePercent: 1.25,
      high: 3.62,
      low: 3.41,
      volume: 1250000,
    })),
  };
});

import { resetMockWallet } from '@/services/api';
import { WalletProvider } from '@/contexts/WalletContext';
import { TradeProvider } from '@/contexts/TradeContext';
import { TradePanel } from '@/components/trade/TradePanel';
import { TradePage } from '@/pages/Trade';
import { AppContent } from '@/App';
import { syntheticCandles, advanceSynthetic } from '@/services/market';
import {
  TRADE_CONFIG,
  validateTradeRequest,
  calcOpenTrade,
  calcCloseTrade,
} from '@/lib/trade';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

function renderWithProviders(ui) {
  return render(
    <WalletProvider>
      <TradeProvider>{ui}</TradeProvider>
    </WalletProvider>
  );
}

// ============================================
// PURE MATHS (mirror of the worker helpers)
// ============================================
describe('trade maths', () => {
  it('rejects an order the balance cannot cover', () => {
    expect(validateTradeRequest({ pair: 'TONUSDT', amount: 500, balance: 100 }).ok).toBe(false);
    expect(validateTradeRequest({ pair: 'TONUSDT', amount: 50, balance: 100 }).ok).toBe(true);
  });

  it('rejects unknown markets and amounts below the minimum', () => {
    expect(validateTradeRequest({ pair: 'FAKEUSDT', amount: 10, balance: 100 }).error).toMatch(/Unsupported/);
    expect(
      validateTradeRequest({ pair: 'TONUSDT', amount: TRADE_CONFIG.MIN_NOTIONAL - 0.5, balance: 100 }).error
    ).toMatch(/Minimum order size/);
  });

  it('sizes a buy with a 0.1% fee', () => {
    const fill = calcOpenTrade({ amount: 50, price: 3.5 });
    expect(close(fill.qty, 50 / 3.5)).toBe(true);
    expect(close(fill.fee, 0.05)).toBe(true);
    expect(close(fill.totalDebit, 50.05)).toBe(true);
  });

  it('books realized PnL net of both fees', () => {
    const res = calcCloseTrade({ qty: 50 / 3.5, entryPrice: 3.5, exitPrice: 3.5 });
    expect(close(res.credit, 49.95)).toBe(true);
    expect(close(res.pnl, -0.1)).toBe(true); // round trip costs exactly the two fees
  });
});

// ============================================
// SYNTHETIC MARKET FALLBACK
// ============================================
describe('synthetic market fallback', () => {
  it('builds a chronologically ordered series with valid OHLC', () => {
    const candles = syntheticCandles('TONUSDT', '1h', 40);
    expect(candles).toHaveLength(40);

    candles.forEach((c, i) => {
      expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
      expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
      if (i > 0) expect(c.t).toBeGreaterThan(candles[i - 1].t);
    });
  });

  it('is deterministic for the same pair and timeframe', () => {
    const a = syntheticCandles('BTCUSDT', '4h', 20);
    const b = syntheticCandles('BTCUSDT', '4h', 20);
    expect(a.map((c) => c.c)).toEqual(b.map((c) => c.c));
  });

  it('advances the forming candle without changing the window length', () => {
    const candles = syntheticCandles('ETHUSDT', '15m', 30);
    const next = advanceSynthetic(candles, 'ETHUSDT', '15m');
    expect(next).toHaveLength(candles.length);
    expect(next[next.length - 1].t).toBeGreaterThanOrEqual(candles[candles.length - 1].t);
  });
});

// ============================================
// NAVIGATION
// ============================================
describe('navigation', () => {
  it('puts Trade in the middle of the bottom bar', async () => {
    renderWithProviders(<AppContent />);
    await waitFor(() => expect(screen.getByTestId('home-page')).toBeInTheDocument());
    const labels = screen.getAllByTestId(/^nav-/).map((el) => el.getAttribute('data-testid'));
    expect(labels).toEqual(['nav-home', 'nav-missions', 'nav-trade', 'nav-referrals', 'nav-wallet']);
  });

  it('no longer hosts Deposit/Withdraw or the trade panel on Home', async () => {
    renderWithProviders(<AppContent />);

    await waitFor(() => expect(screen.getByTestId('home-page')).toBeInTheDocument());
    expect(screen.queryByTestId('quick-deposit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-withdraw')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trade-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('hold-button')).toBeInTheDocument();
  });
});

// ============================================
// UI FLOW: Trade tab -> buy -> positions -> close
// ============================================
describe('Trade page', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMockWallet(); // the mock wallet is module state; put it back to 250 USDT
  });

  it('buys with the wallet balance and closes the position', async () => {
    renderWithProviders(<TradePage />);

    await waitFor(() => expect(screen.getByTestId('trade-last-price')).toHaveTextContent('3.500'));
    await waitFor(() => expect(screen.getByTestId('trade-stat-cash')).toHaveTextContent('$250.00'));
    expect(screen.getByTestId('candle-chart')).toBeInTheDocument();

    // Size and send the order
    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '50' } });
    await waitFor(() => expect(screen.getByTestId('trade-preview-qty')).toHaveTextContent('14.29 TON'));
    fireEvent.click(screen.getByTestId('trade-buy-submit'));

    await waitFor(() => expect(screen.getByTestId('position-TONUSDT')).toBeInTheDocument());
    // 250 - (50 + 0.05 fee)
    await waitFor(() => expect(screen.getByTestId('trade-stat-cash')).toHaveTextContent('$199.95'));
    expect(screen.getByTestId('trade-stat-exposure')).toHaveTextContent('$50.00');
    expect(screen.getByTestId('position-TONUSDT')).toHaveTextContent('@ 3.500');

    // Close (tap to arm, tap again to confirm)
    fireEvent.click(screen.getByTestId('close-position-TONUSDT'));
    await waitFor(() => expect(screen.getByTestId('close-position-TONUSDT')).toHaveTextContent('Confirm close'));
    fireEvent.click(screen.getByTestId('close-position-TONUSDT'));

    await waitFor(() => expect(screen.getByTestId('positions-empty')).toBeInTheDocument());
    // 199.95 + 49.95 credit = 249.90 -> the round trip cost the two fees
    await waitFor(() => expect(screen.getByTestId('trade-stat-cash')).toHaveTextContent('$249.90'));
    expect(screen.getByTestId('trade-stat-pnl')).toHaveTextContent('-$0.10');
  });

  it('blocks orders outside the allowed size', async () => {
    renderWithProviders(<TradePage />);

    await waitFor(() => expect(screen.getByTestId('trade-available-balance')).toHaveTextContent('$250.00'));

    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '500' } });
    await waitFor(() => expect(screen.getByText(/Insufficient USDT balance/)).toBeInTheDocument());
    expect(screen.getByTestId('trade-buy-submit')).toBeDisabled();

    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '200000' } });
    await waitFor(() => expect(screen.getByText(/Maximum order size/)).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '0.10' } });
    await waitFor(() => expect(screen.getByText(/Minimum order size/)).toBeInTheDocument());
  });

  it('fills the order from the MAX preset using the available balance', async () => {
    renderWithProviders(<TradePage />);
    await waitFor(() => expect(screen.getByTestId('trade-available-balance')).toHaveTextContent('$250.00'));

    fireEvent.click(screen.getByTestId('trade-preset-100'));
    const input = screen.getByTestId('trade-amount-input');
    expect(Number(input.value)).toBeCloseTo(250 / (1 + TRADE_CONFIG.FEE_RATE), 2);

    fireEvent.click(screen.getByTestId('trade-buy-submit'));
    await waitFor(() => expect(screen.getByTestId('position-TONUSDT')).toBeInTheDocument());
  });
});

// ============================================
// History lives inside Wallet
// ============================================
describe('Wallet page', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMockWallet();
  });

  it('logs a trade made on the Trade tab into Wallet -> Activity', async () => {
    renderWithProviders(<AppContent />);

    // Home -> Trade tab
    await waitFor(() => expect(screen.getByTestId('home-page')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('nav-trade'));
    await waitFor(() => expect(screen.getByTestId('trade-page')).toBeInTheDocument());

    await waitFor(() => expect(screen.getByTestId('trade-available-balance')).toHaveTextContent('$250.00'));
    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('trade-buy-submit'));
    await waitFor(() => expect(screen.getByTestId('position-TONUSDT')).toBeInTheDocument());

    // Trade -> Wallet: no panel here anymore, and the trade shows in Activity
    fireEvent.click(screen.getByTestId('nav-wallet'));
    await waitFor(() => expect(screen.getByTestId('wallet-page')).toBeInTheDocument());
    expect(screen.queryByTestId('trade-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('wallet-total-balance')).toHaveTextContent('$224.97'); // 250 - 25.025

    fireEvent.click(screen.getByTestId('wallet-section-activity'));
    await waitFor(() => expect(screen.getByTestId('transaction-list')).toBeInTheDocument());
    expect(screen.getByTestId('filter-trades')).toBeInTheDocument();
    expect(screen.getByText('Trade Buy')).toBeInTheDocument();
  });
});

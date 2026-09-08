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
import { WalletPage } from '@/pages/Wallet';
import { BottomNav } from '@/components/layout/BottomNav';
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
// NAVIGATION: History merged into Wallet
// ============================================
describe('navigation', () => {
  it('drops the History tab now that it lives inside Wallet', () => {
    render(<BottomNav activeTab="home" onTabChange={() => {}} />);
    expect(screen.getByTestId('nav-home')).toBeInTheDocument();
    expect(screen.getByTestId('nav-wallet')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-history')).not.toBeInTheDocument();
  });
});

// ============================================
// UI FLOW: chart -> buy -> positions -> close -> activity
// ============================================
describe('Trade panel in the Wallet page', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMockWallet(); // the mock wallet is module state; put it back to 250 USDT
  });

  it('renders the chart, buys with the wallet balance and logs the trade in Activity', async () => {
    renderWithProviders(<WalletPage initialSection="balance" />);

    // Boot: mock user (250 demo USDT) + market feed
    await waitFor(() => expect(screen.getByTestId('trade-last-price')).toHaveTextContent('3.500'));
    expect(screen.getByTestId('candle-chart')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('wallet-total-balance')).toHaveTextContent('$250.00'));

    // Size an order
    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '50' } });
    await waitFor(() => expect(screen.getByTestId('trade-preview-qty')).toHaveTextContent('14.29 TON'));

    // Buy
    fireEvent.click(screen.getByTestId('trade-buy-submit'));
    await waitFor(() => expect(screen.getByTestId('position-TONUSDT')).toBeInTheDocument());

    // Balance debited: 250 - (50 + 0.05 fee)
    await waitFor(() => expect(screen.getByTestId('wallet-total-balance')).toHaveTextContent('$199.95'));
    expect(screen.getByTestId('position-TONUSDT')).toHaveTextContent('@ 3.500');

    // Close (tap to arm, tap again to confirm)
    const closeBtn = screen.getByTestId('close-position-TONUSDT');
    fireEvent.click(closeBtn);
    await waitFor(() => expect(screen.getByTestId('close-position-TONUSDT')).toHaveTextContent('Confirm close'));
    fireEvent.click(screen.getByTestId('close-position-TONUSDT'));

    await waitFor(() => expect(screen.getByTestId('positions-empty')).toBeInTheDocument());
    // 199.95 + (49.95 credit) = 249.90  -> the round trip cost the two fees
    await waitFor(() => expect(screen.getByTestId('wallet-total-balance')).toHaveTextContent('$249.90'));

    // Activity section (the old History tab) shows both legs
    fireEvent.click(screen.getByTestId('wallet-section-activity'));
    await waitFor(() => expect(screen.getByTestId('transaction-list')).toBeInTheDocument());
    expect(screen.getByTestId('filter-trades')).toBeInTheDocument();
    expect(screen.getByText('Trade Buy')).toBeInTheDocument();
    expect(screen.getByText('Trade Sell')).toBeInTheDocument();
  });

  it('blocks an order larger than the balance', async () => {
    renderWithProviders(<TradePanel />);

    await waitFor(() => expect(screen.getByTestId('trade-last-price')).toHaveTextContent('3.500'));

    await waitFor(() => expect(screen.getByTestId('trade-available-balance')).toHaveTextContent('$250.00'));

    // Above the balance, below the cap
    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '500' } });
    await waitFor(() => expect(screen.getByText(/Insufficient USDT balance/)).toBeInTheDocument());
    expect(screen.getByTestId('trade-buy-submit')).toBeDisabled();

    // Above the hard cap
    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '200000' } });
    await waitFor(() => expect(screen.getByText(/Maximum order size/)).toBeInTheDocument());

    // Below the minimum notional
    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '0.10' } });
    await waitFor(() => expect(screen.getByText(/Minimum order size/)).toBeInTheDocument());
  });

  it('fills the order from the MAX preset using the available balance', async () => {
    renderWithProviders(<TradePanel />);
    await waitFor(() => expect(screen.getByTestId('trade-last-price')).toHaveTextContent('3.500'));
    await waitFor(() => expect(screen.getByTestId('trade-available-balance')).toHaveTextContent('$250.00'));

    fireEvent.click(screen.getByTestId('trade-preset-100'));
    const input = screen.getByTestId('trade-amount-input');
    expect(Number(input.value)).toBeCloseTo(250 / (1 + TRADE_CONFIG.FEE_RATE), 2);

    fireEvent.click(screen.getByTestId('trade-buy-submit'));
    await waitFor(() => expect(screen.getByTestId('position-TONUSDT')).toBeInTheDocument());
  });
});

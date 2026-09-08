import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Only the network layer is stubbed here. Pair metadata and the synthetic
 * candle generator stay real, so the chart renders exactly what it would render
 * on a device without connectivity (the documented fallback path).
 */
const market = vi.hoisted(() => ({ price: 3.5, changePercent: 1.25 }));

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
      price: market.price,
      changePercent: market.changePercent,
      high: market.price * 1.02,
      low: market.price * 0.98,
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
  validateLevels,
  checkLevelTrigger,
  priceFromPercent,
  calcWalletSale,
  walletAssetForPair,
} from '@/lib/trade';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

function renderWithProviders(ui, { markPollMs = 10000 } = {}) {
  return render(
    <WalletProvider>
      <TradeProvider markPollMs={markPollMs}>{ui}</TradeProvider>
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

describe('order limits maths', () => {
  it('places the levels on the right side of the entry', () => {
    expect(validateLevels({ entryPrice: 3.5, takeProfit: 3.675, stopLoss: 3.395 }).ok).toBe(true);
    expect(validateLevels({ entryPrice: 3.5, takeProfit: 3.4 }).error).toMatch(/above the entry/);
    expect(validateLevels({ entryPrice: 3.5, stopLoss: 3.6 }).error).toMatch(/below the entry/);
  });

  it('fires the Stop Loss first when both are crossed', () => {
    expect(
      checkLevelTrigger({ entryPrice: 3.5, markPrice: 3.1, takeProfit: 3.675, stopLoss: 3.395 })
    ).toBe('sl');
    expect(
      checkLevelTrigger({ entryPrice: 3.5, markPrice: 3.7, takeProfit: 3.675, stopLoss: 3.395 })
    ).toBe('tp');
    expect(
      checkLevelTrigger({ entryPrice: 3.5, markPrice: 3.5, takeProfit: 3.675, stopLoss: 3.395 })
    ).toBe(null);
  });

  it('prices a percentage away from the entry', () => {
    expect(priceFromPercent(3.5, 0.05)).toBeCloseTo(3.675, 6);
    expect(priceFromPercent(3.5, -0.03)).toBeCloseTo(3.395, 6);
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
    market.price = 3.5;
  });

  it('buys with the wallet balance and closes the position', async () => {
    renderWithProviders(<TradePage />);

    await waitFor(() => expect(screen.getByTestId('trade-last-price')).toHaveTextContent('3.500'));
    await waitFor(() => expect(screen.getByTestId('trade-stat-cash')).toHaveTextContent('$250.00'));
    expect(screen.getByTestId('candle-chart')).toBeInTheDocument();

    // Size and send the order
    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '50' } });
    await waitFor(() => expect(screen.getByTestId('trade-preview-qty')).toHaveTextContent('14.29 GRAM'));
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
    // El total no es solo el saldo libre: suma la posición a mercado (PnL 0 acá,
    // el mark del mock es el mismo precio de entrada).
    //   224.975 saldo  +  25.00 posición  =  249.975  (los 0.025 fueron de fee)
    const headline = screen.getByTestId('wallet-total-balance-amount');
    await waitFor(() => {
      const total = Number(headline.textContent.replace(/[^0-9.]/g, ''));
      expect(close(total, 250 - 25.025 + 25, 0.01)).toBe(true);
    });
    // El saldo libre y la posición quedan a la vista en el desglose.
    expect(screen.getByTestId('portfolio-breakdown')).toHaveTextContent('1 open position');

    fireEvent.click(screen.getByTestId('wallet-section-activity'));
    await waitFor(() => expect(screen.getByTestId('transaction-list')).toBeInTheDocument());
    expect(screen.getByTestId('filter-trades')).toBeInTheDocument();
    expect(screen.getByText('Trade Buy')).toBeInTheDocument();
  });
});

// ============================================
// MARKET PICKER (mini menu instead of chips)
// ============================================
describe('market picker', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMockWallet();
    market.price = 3.5;
  });

  it('picks the market from a menu instead of a chip row', async () => {
    renderWithProviders(<TradePage />);
    await waitFor(() => expect(screen.getByTestId('trade-last-price')).toHaveTextContent('3.500'));

    // no inline chip row anymore
    expect(screen.queryByTestId('pair-TONUSDT')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pair-selector-menu')).not.toBeInTheDocument();

    // trigger shows the pair name only
    // Toncoin se renombró a Gram: el par se muestra GRAM/USDT.
    expect(screen.getByTestId('pair-selector-label')).toHaveTextContent('GRAM/USDT');

    fireEvent.click(screen.getByTestId('pair-selector-trigger'));
    await waitFor(() => expect(screen.getByTestId('pair-selector-menu')).toBeInTheDocument());

    // each row is the pair name + its quote, with no abbreviation badge repeated
    const ethRow = screen.getByTestId('pair-option-ETHUSDT');
    expect(ethRow).toHaveTextContent('ETH/USDT');
    expect(ethRow.textContent.replace('ETH/USDT', '')).not.toContain('ETH');

    fireEvent.click(screen.getByTestId('pair-option-BTCUSDT'));
    await waitFor(() => expect(screen.queryByTestId('pair-selector-menu')).not.toBeInTheDocument());

    // BTC quotes 2 decimals, GRAM 3 -> the price rendering proves the switch
    await waitFor(() => expect(screen.getByTestId('trade-last-price')).toHaveTextContent('3.50'));
    expect(screen.getByTestId('pair-selector-label')).toHaveTextContent('BTC/USDT');
    await waitFor(() => expect(screen.getByTestId('trade-available-balance')).toBeInTheDocument());
  });
});

// ============================================
// TAKE PROFIT / STOP LOSS
// ============================================
describe('order limits', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMockWallet();
    market.price = 3.5;
  });

  it('attaches a TP/SL bracket to the order and shows it on the position', async () => {
    renderWithProviders(<TradePage />);
    await waitFor(() => expect(screen.getByTestId('trade-available-balance')).toHaveTextContent('$250.00'));

    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('trade-limits-toggle'));

    // +5% / -3% presets against a 3.500 entry
    fireEvent.click(screen.getByTestId('tp-preset-5'));
    fireEvent.click(screen.getByTestId('sl-preset-3'));
    expect(screen.getByTestId('tp-input')).toHaveValue(3.675);
    expect(screen.getByTestId('sl-input')).toHaveValue(3.395);

    // Net-of-fees previews: +2.40 / -1.60 on 50 USDT
    await waitFor(() => expect(screen.getByTestId('tp-preview')).toHaveTextContent('+$2.40'));
    expect(screen.getByTestId('sl-preview')).toHaveTextContent('-$1.60');

    fireEvent.click(screen.getByTestId('trade-buy-submit'));
    await waitFor(() => expect(screen.getByTestId('position-TONUSDT')).toBeInTheDocument());

    expect(screen.getByTestId('position-tp')).toHaveTextContent('TP 3.675');
    expect(screen.getByTestId('position-sl')).toHaveTextContent('SL 3.395');
    // ...and on the chart
    expect(screen.getByTestId('chart-tp-line')).toBeInTheDocument();
    expect(screen.getByTestId('chart-sl-line')).toBeInTheDocument();
  });

  it('rejects a bracket on the wrong side of the entry', async () => {
    renderWithProviders(<TradePage />);
    await waitFor(() => expect(screen.getByTestId('trade-available-balance')).toHaveTextContent('$250.00'));

    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('trade-limits-toggle'));
    fireEvent.change(screen.getByTestId('tp-input'), { target: { value: '3.2' } }); // below entry

    await waitFor(() => expect(screen.getByText(/Take Profit must be above the entry/)).toBeInTheDocument());
    expect(screen.getByTestId('trade-buy-submit')).toBeDisabled();
  });

  it('auto-closes the position when the price hits the Stop Loss', async () => {
    renderWithProviders(<TradePage />, { markPollMs: 40 });
    await waitFor(() => expect(screen.getByTestId('trade-available-balance')).toHaveTextContent('$250.00'));

    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('trade-limits-toggle'));
    fireEvent.change(screen.getByTestId('tp-input'), { target: { value: '3.9' } });
    fireEvent.change(screen.getByTestId('sl-input'), { target: { value: '3.2' } });
    fireEvent.click(screen.getByTestId('trade-buy-submit'));

    await waitFor(() => expect(screen.getByTestId('position-TONUSDT')).toBeInTheDocument());

    // Price drops through the stop loss
    market.price = 3.1;
    await waitFor(() => expect(screen.getByTestId('trade-trigger-banner')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByTestId('trade-trigger-banner')).toHaveTextContent('Stop Loss hit');

    await waitFor(() => expect(screen.getByTestId('positions-empty')).toBeInTheDocument());
    // 199.95 after the buy + credit (14.2857 * 3.1 - 0.1% fee = 44.24) = 244.19
    await waitFor(() => expect(screen.getByTestId('trade-stat-cash')).toHaveTextContent('$244.19'));
  });

  it('edits the levels of an open position', async () => {
    renderWithProviders(<TradePage />);
    await waitFor(() => expect(screen.getByTestId('trade-available-balance')).toHaveTextContent('$250.00'));

    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('trade-buy-submit'));
    await waitFor(() => expect(screen.getByTestId('position-TONUSDT')).toBeInTheDocument());
    expect(screen.getByTestId('levels-edit')).toHaveTextContent('Add TP/SL');

    fireEvent.click(screen.getByTestId('levels-edit'));
    await waitFor(() => expect(screen.getByTestId('levels-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('levels-tp-input'), { target: { value: '3.8' } });
    fireEvent.change(screen.getByTestId('levels-sl-input'), { target: { value: '4.1' } }); // above entry
    fireEvent.click(screen.getByTestId('levels-save'));
    await waitFor(() =>
      expect(screen.getByText(/Stop Loss must be below the entry price/)).toBeInTheDocument()
    );

    fireEvent.change(screen.getByTestId('levels-sl-input'), { target: { value: '3.2' } });
    fireEvent.click(screen.getByTestId('levels-save'));

    await waitFor(() => expect(screen.getByTestId('position-tp')).toHaveTextContent('TP 3.800'));
    expect(screen.getByTestId('position-sl')).toHaveTextContent('SL 3.200');
  });
});

// ============================================
// SELL side
// ============================================
describe('selling', () => {
  beforeEach(() => {
    resetMockWallet();
    localStorage.clear();
    market.price = 3.5;
    market.changePercent = 1.25;
  });

  const buyFifty = async () => {
    await waitFor(() => expect(screen.getByTestId('trade-available-balance')).toHaveTextContent('$250.00'));
    fireEvent.change(screen.getByTestId('trade-amount-input'), { target: { value: '50' } });
    await waitFor(() => expect(screen.getByTestId('trade-preview-qty')).toHaveTextContent('14.29 GRAM'));
    fireEvent.click(screen.getByTestId('trade-buy-submit'));
    await waitFor(() => expect(screen.getByTestId('position-TONUSDT')).toBeInTheDocument());
  };

  it('has a Buy/Sell switch that starts on Buy', async () => {
    renderWithProviders(<TradePage />);
    await waitFor(() => expect(screen.getByTestId('trade-side-toggle')).toBeInTheDocument());

    expect(screen.getByTestId('trade-side-buy')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('trade-side-sell')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('trade-buy-submit')).toHaveAttribute('data-side', 'buy');
    expect(screen.getByTestId('trade-buy-submit').textContent).toContain('Buy GRAM');
  });

  it('has nothing to sell before a position exists', async () => {
    renderWithProviders(<TradePage />);
    await waitFor(() => expect(screen.getByTestId('trade-side-toggle')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('trade-side-sell'));

    expect(await screen.findByTestId('trade-sell-empty')).toBeInTheDocument();
    expect(screen.getByTestId('trade-buy-submit')).toBeDisabled();
    expect(screen.getByTestId('trade-buy-submit').textContent).toContain('Sell GRAM');
    // the TP/SL bracket is a buy-only concept
    expect(screen.queryByTestId('trade-limits-toggle')).not.toBeInTheDocument();
  });

  it('shows the whole position as the amount to sell', async () => {
    renderWithProviders(<TradePage />);
    await buyFifty();

    fireEvent.click(screen.getByTestId('trade-side-sell'));

    const amount = await screen.findByTestId('trade-sell-amount');
    expect(amount.textContent).toContain('14.29 GRAM');
    // no quantity field on the sell side: the close is always total
    expect(screen.queryByTestId('trade-amount-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('trade-preset-100')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('trade-sell-preview')).toBeInTheDocument());
    expect(screen.getByTestId('trade-sell-pnl').textContent).toContain('-');
  });

  it('sells the open position at market and credits the wallet', async () => {
    renderWithProviders(<TradePage />);
    await buyFifty();
    await waitFor(() => expect(screen.getByTestId('trade-stat-cash')).toHaveTextContent('$199.95'));

    fireEvent.click(screen.getByTestId('trade-side-sell'));
    await waitFor(() => expect(screen.getByTestId('trade-sell-preview')).toBeInTheDocument());
    expect(screen.getByTestId('trade-buy-submit')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('trade-buy-submit'));

    await waitFor(() => expect(screen.getByTestId('positions-empty')).toBeInTheDocument());
    // 199.95 + 49.95 credit = 249.90, the round trip cost the two fees
    await waitFor(() => expect(screen.getByTestId('trade-stat-cash')).toHaveTextContent('$249.90'));
    expect(screen.getByTestId('trade-stat-pnl')).toHaveTextContent('-$0.10');
    expect(screen.getByTestId('trade-order-result').textContent).toContain('Sold 14.29 GRAM');
  });

  it('switching back to Buy restores the amount field and the bracket', async () => {
    renderWithProviders(<TradePage />);
    await waitFor(() => expect(screen.getByTestId('trade-side-toggle')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('trade-side-sell'));
    await waitFor(() => expect(screen.queryByTestId('trade-amount-input')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('trade-side-buy'));

    await waitFor(() => expect(screen.getByTestId('trade-amount-input')).toBeInTheDocument());
    expect(screen.getByTestId('trade-available-value').textContent).toContain('$250.00');
    expect(screen.getByTestId('trade-limits-toggle')).toBeInTheDocument();
  });
});

// ============================================
// VENDER EL SALDO DE LA WALLET (TRX -> USDT)
// ============================================
describe('calcWalletSale', () => {
  it('cobra la fee de un solo lado, como sell_wallet_asset()', () => {
    // 5 TRX a 0.30 = 1.50 de proceeds, 0.1% de fee = 0.0015.
    const res = calcWalletSale({ amount: 5, price: 0.3 });
    expect(res.ok).toBe(true);
    expect(close(res.proceeds, 1.5)).toBe(true);
    expect(close(res.fee, 0.0015)).toBe(true);
    expect(close(res.credit, 1.4985)).toBe(true);
  });

  it('rechaza montos y precios inválidos', () => {
    expect(calcWalletSale({ amount: 0, price: 1 }).ok).toBe(false);
    expect(calcWalletSale({ amount: -1, price: 1 }).ok).toBe(false);
    expect(calcWalletSale({ amount: 1, price: 0 }).ok).toBe(false);
    expect(calcWalletSale({ amount: 'x', price: 1 }).ok).toBe(false);
  });

  it('solo TRX y TON tienen saldo interno vendible', () => {
    expect(walletAssetForPair('TRXUSDT')).toBe('TRX');
    expect(walletAssetForPair('TONUSDT')).toBe('TON');
    expect(walletAssetForPair('BTCUSDT')).toBeNull();
  });
});

describe('selling the wallet TRX balance', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMockWallet();
    market.price = 3.5;
  });

  it('vende el TRX de la wallet en TRX/USDT sin necesidad de una posición', async () => {
    renderWithProviders(<AppContent />);
    await waitFor(() => expect(screen.getByTestId('home-page')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('nav-trade'));
    await waitFor(() => expect(screen.getByTestId('trade-page')).toBeInTheDocument());

    // Elegir TRX/USDT
    fireEvent.click(screen.getByTestId('pair-selector-trigger'));
    await waitFor(() => expect(screen.getByTestId('pair-selector-menu')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pair-option-TRXUSDT'));
    await waitFor(() => expect(screen.getByTestId('pair-selector-label')).toHaveTextContent('TRX/USDT'));

    // No hay posición abierta, así que el SELL ofrece el saldo de la wallet.
    fireEvent.click(screen.getByTestId('trade-side-sell'));
    await waitFor(() => expect(screen.getByTestId('trade-sell-amount')).toBeInTheDocument());
    expect(screen.getByTestId('trade-sell-amount')).toHaveTextContent('Selling from wallet');
    // TRX/USDT muestra 1 decimal y formatQty recorta el cero sobrante.
    expect(screen.getByTestId('trade-sell-amount')).toHaveTextContent('5 TRX');
    expect(screen.getByTestId('trade-buy-submit')).not.toBeDisabled();

    // 5 TRX × 3.50 = 17.50, menos 0.1% de fee = 17.4825
    await waitFor(() =>
      expect(screen.getByTestId('trade-wallet-sell-credit')).toHaveTextContent('$17.48')
    );

    fireEvent.click(screen.getByTestId('trade-buy-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('trade-order-result')).toHaveTextContent('from wallet')
    );

    // El TRX salió de la wallet y el USDT entró.
    fireEvent.click(screen.getByTestId('nav-wallet'));
    await waitFor(() => expect(screen.getByTestId('wallet-page')).toBeInTheDocument());
    expect(screen.getByTestId('balance-card-trx')).toHaveTextContent('0.00');
    await waitFor(() => {
      const total = Number(
        screen.getByTestId('wallet-total-balance-amount').textContent.replace(/[^0-9.]/g, '')
      );
      expect(close(total, 250 + 5 * 3.5 * 0.999, 0.01)).toBe(true);
    });
  });

  it('en un par sin saldo interno el SELL sigue pidiendo una posición', async () => {
    renderWithProviders(<TradePage />);
    await waitFor(() => expect(screen.getByTestId('trade-last-price')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('pair-selector-trigger'));
    await waitFor(() => expect(screen.getByTestId('pair-selector-menu')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pair-option-BTCUSDT'));
    await waitFor(() => expect(screen.getByTestId('pair-selector-label')).toHaveTextContent('BTC/USDT'));

    fireEvent.click(screen.getByTestId('trade-side-sell'));
    await waitFor(() => expect(screen.getByTestId('trade-sell-empty')).toBeInTheDocument());
    expect(screen.getByTestId('trade-buy-submit')).toBeDisabled();
  });
});

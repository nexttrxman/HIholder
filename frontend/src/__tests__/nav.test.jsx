import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Navigation smoke test: every bottom-nav tab must render its page and keep the
 * shell alive. Regression guard for "the tab opens a blank/dark screen".
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
      high: 3.57,
      low: 3.43,
      volume: 1250000,
    })),
  };
});

import { resetMockWallet } from '@/services/api';
import { WalletProvider } from '@/contexts/WalletContext';
import { TradeProvider } from '@/contexts/TradeContext';
import { AppContent } from '@/App';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';

function renderApp() {
  return render(
    <WalletProvider>
      <TradeProvider markPollMs={60000}>
        <AppContent />
      </TradeProvider>
    </WalletProvider>
  );
}

// [nav testid, page testid, shell renders <Header/> on this tab]
const TABS = [
  ['nav-home', 'home-page', true],
  ['nav-missions', 'missions-page', false],
  ['nav-trade', 'trade-page', false],
  ['nav-referrals', 'referrals-page', false],
  ['nav-wallet', 'wallet-page', false],
];

describe('bottom navigation', () => {
  beforeEach(() => {
    resetMockWallet();
    localStorage.clear();
  });

  it('renders the app shell', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByTestId('bottom-nav')).toBeInTheDocument());
    expect(screen.getByTestId('header')).toBeInTheDocument();
    expect(screen.getByTestId('home-page')).toBeInTheDocument();
  });

  describe.each(TABS)('%s', (navId, pageId, hasHeader) => {
    it(`opens ${pageId} without crashing`, async () => {
      renderApp();
      await waitFor(() => expect(screen.getByTestId('bottom-nav')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId(navId));

      await waitFor(() => expect(screen.getByTestId(pageId)).toBeInTheDocument(), {
        timeout: 3000,
      });
      // the shell must survive the switch, and the boundary must stay silent
      expect(screen.getByTestId('bottom-nav')).toBeInTheDocument();
      expect(screen.queryByTestId('error-boundary')).not.toBeInTheDocument();
      if (hasHeader) expect(screen.getByTestId('header')).toBeInTheDocument();
    });
  });
});

describe('ErrorBoundary', () => {
  function Boom() {
    throw new Error('synthetic crash');
  }

  it('reports a crashing subtree instead of unmounting the app', () => {
    // React logs the caught error; keep the test output clean.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <div data-testid="shell">
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </div>
    );

    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('error-boundary-message').textContent).toContain(
      'synthetic crash'
    );
    // the surrounding shell is still mounted — this is the whole point
    expect(screen.getByTestId('shell')).toBeInTheDocument();

    // "Try again" clears the boundary and retries the subtree
    fireEvent.click(screen.getByTestId('error-boundary-retry'));
    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();

    spy.mockRestore();
  });
});

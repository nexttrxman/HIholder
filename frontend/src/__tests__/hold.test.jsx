import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { resetMockWallet } from '@/services/api';
import { WalletProvider } from '@/contexts/WalletContext';
import { TradeProvider } from '@/contexts/TradeContext';
import { HoldButton } from '@/components/earn/HoldButton';

/**
 * Regression net for the core earn loop, so the UI can be restyled safely:
 *   hold 3s -> prize -> 3 holds per cycle -> claim ready
 */

const HOLD_MS = 3000;
const PRIZE_DELAY_MS = 350; // prize overlay appears 300ms after the hold completes
const RESET_MS = 2400; // 300ms delay + 2000ms prize overlay

function renderHold(onClaimReady = vi.fn()) {
  render(
    <WalletProvider>
      <TradeProvider>
        <HoldButton onClaimReady={onClaimReady} />
      </TradeProvider>
    </WalletProvider>
  );
  return onClaimReady;
}

/** Let the async boot (authUser -> cycle -> wallet) settle under fake timers. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function holdFor(ms) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('Hold to Earn — 3 second hold + claim loop', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMockWallet();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing before 3 seconds and pays out exactly at 3s', async () => {
    renderHold();
    await settle();

    const button = screen.getByTestId('hold-button');
    expect(screen.getByText('Hold to earn')).toBeInTheDocument();

    fireEvent.mouseDown(button);
    await holdFor(2900);
    expect(screen.queryByText('✓ Done!')).not.toBeInTheDocument();

    await holdFor(150);
    expect(screen.getByText('✓ Done!')).toBeInTheDocument();

    // the prize overlay (random 0.02 - 0.08 USDT) pops 300ms later
    await holdFor(PRIZE_DELAY_MS);
    expect(screen.getByText(/\+\$0\.0[2-8]/)).toBeInTheDocument();
  });

  it('releasing early cancels the hold', async () => {
    renderHold();
    await settle();

    const button = screen.getByTestId('hold-button');
    fireEvent.mouseDown(button);
    await holdFor(1500);
    fireEvent.mouseUp(button);
    await holdFor(HOLD_MS);

    expect(screen.queryByText('✓ Done!')).not.toBeInTheDocument();
    expect(screen.getByText('Hold to earn')).toBeInTheDocument();
  });

  it('counts 3 holds per cycle and unlocks the claim', async () => {
    const onClaimReady = renderHold();
    await settle();

    const button = screen.getByTestId('hold-button');

    for (let i = 1; i <= 3; i += 1) {
      fireEvent.mouseDown(button);
      await holdFor(HOLD_MS + 50);
      expect(screen.getByText('✓ Done!')).toBeInTheDocument();
      await holdFor(RESET_MS + 50);

      if (i < 3) {
        expect(onClaimReady).not.toHaveBeenCalled();
      }
    }

    // third hold completes the cycle -> claim handed to the app
    expect(onClaimReady).toHaveBeenCalledTimes(1);
    expect(onClaimReady.mock.calls[0][0]).toMatchObject({
      claim_id: expect.any(String),
      total_prize: expect.any(Number),
      ton_fee: 0.05,
      treasury_wallet: expect.any(String),
    });

    // and the button stops offering holds until the claim is resolved
    expect(screen.getByText('Claim your reward!')).toBeInTheDocument();
    expect(screen.getByText(/Complete 3 holds to unlock your reward|Cycle complete/)).toBeInTheDocument();
  });

  it('advances the cycle counter as holds complete', async () => {
    renderHold();
    await settle();

    const button = screen.getByTestId('hold-button');
    fireEvent.mouseDown(button);
    await holdFor(HOLD_MS + 50);
    await holdFor(PRIZE_DELAY_MS);
    expect(screen.getByText(/\+\$0\.0[2-8]/)).toBeInTheDocument();
    await holdFor(RESET_MS + 50);

    // cycle dots: first one filled, the rest still pending
    const dots = screen.getByTestId('holds-remaining').firstElementChild.children;
    expect(dots.length).toBe(3);
    expect(dots[0].className).toContain('bg-brand-green');
    expect(dots[1].className).toContain('bg-white/10');
  });
});

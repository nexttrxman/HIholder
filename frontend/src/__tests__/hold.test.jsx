import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

import { resetMockWallet, authUser, registerHold } from '@/services/api';
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
    // filled dots carry the accent background, pending ones do not
    expect(dots[0].className).toContain('bg-brand-green');
    expect(dots[1].className).not.toContain('bg-brand-green');
    expect(dots[2].className).not.toContain('bg-brand-green');
  });
});

// ============================================
// Claim lifecycle: an unclaimed reward must not brick the button
// ============================================
describe('unclaimed claim', () => {
  beforeEach(() => {
    resetMockWallet();
    localStorage.clear();
  });

  /** authUser() hands back the live claim object, so expiring it is a write. */
  const expirePendingClaim = (auth) => {
    auth.pending_claim.expires_at = new Date(Date.now() - 1000).toISOString();
  };

  it('reports the pending claim once the cycle is complete', async () => {
    for (let i = 0; i < 3; i++) await registerHold(0.05);

    const auth = await authUser();
    expect(auth.pending_claim).toBeTruthy();
    expect(auth.pending_claim.total_prize).toBe(0.15);
    expect(auth.cycle.holds_completed).toBe(3);
    expect(auth.cycle.remaining_holds).toBe(0);
  });

  it('forfeits an expired claim and resets the cycle to 0 holds', async () => {
    for (let i = 0; i < 3; i++) await registerHold(0.05);

    const auth = await authUser();
    expect(auth.pending_claim).toBeTruthy();
    expirePendingClaim(auth);

    const after = await authUser();
    expect(after.pending_claim).toBeNull();
    expect(after.cycle.holds_completed).toBe(0);
    expect(after.cycle.remaining_holds).toBe(3);
  });

  it('keeps the claim payable while it has not expired', async () => {
    for (let i = 0; i < 3; i++) await registerHold(0.05);

    const auth = await authUser();
    const again = await authUser();

    expect(again.pending_claim).toBeTruthy();
    expect(again.pending_claim.claim_id).toBe(auth.pending_claim.claim_id);
    expect(again.cycle.holds_completed).toBe(3);
  });

  it('lets the user hold again after a forfeit', async () => {
    for (let i = 0; i < 3; i++) await registerHold(0.05);
    expirePendingClaim(await authUser());

    await authUser(); // forfeits and restarts the cycle

    const hold = await registerHold(0.05);
    expect(hold.hold_number).toBe(1);
    expect(hold.remaining_holds).toBe(2);
    expect(hold.cycle_complete).toBe(false);
  });
});

// ============================================
// Nova + unclipped glow
// ============================================
describe('hold feedback', () => {
  beforeEach(() => {
    resetMockWallet();
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not clip the button or the progress ring', async () => {
    renderHold();
    await settle();

    // the old overflow-hidden cut the glow into a box; the image is rounded
    // on its own so the clip was never needed
    const button = screen.getByTestId('hold-button');
    expect(button.className).not.toContain('overflow-hidden');

    const svg = button.parentElement.querySelector('svg');
    expect(svg.style.overflow).toBe('visible');
  });

  it('fires a full-screen nova when the hold completes', async () => {
    renderHold();
    await settle();

    const button = screen.getByTestId('hold-button');
    fireEvent.mouseDown(button);
    await holdFor(HOLD_MS + 50);

    // findBy* cannot advance fake timers — query directly after the act()
    const nova = screen.getByTestId('hold-nova');
    // it must cover the whole screen and sit above the app
    expect(nova.className).toContain('fixed');
    expect(nova.className).toContain('inset-0');
    expect(nova.className).toContain('z-[70]');
    expect(nova.className).toContain('pointer-events-none');

    // and it must clean itself up
    await holdFor(1200);
    expect(screen.queryByTestId('hold-nova')).not.toBeInTheDocument();
  });
});

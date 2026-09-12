import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { HoldButton } from '@/components/earn/HoldButton';

// El standby tras un claim cobrado: el usuario pidió VER cuánto falta para
// volver a holdear, segundo a segundo. Estos tests fijan el countdown y que el
// botón, apagado y todo, responda al dedo con haptic.

const vibrate = vi.fn();
const doHold = vi.fn(async () => ({ success: true }));
const refreshData = vi.fn();

let walletState;

vi.mock('@/hooks/useTelegram', () => ({
  useTelegram: () => ({ vibrate, share: vi.fn(), isTelegramWebApp: false }),
}));

vi.mock('@/contexts/WalletContext', () => ({
  useWallet: () => walletState,
}));

const TWO_HOURS = 2 * 3600 * 1000;

function setState(over = {}) {
  walletState = {
    canHold: () => false,
    doHold,
    HOLD_DURATION: 3000,
    remainingHolds: 0,
    holdsCompleted: 3,
    pendingClaim: null,
    cycleEndsAt: new Date(Date.now() + TWO_HOURS).toISOString(),
    refreshData,
    ...over,
  };
}

describe('Standby tras el claim: countdown visible', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vibrate.mockClear();
    doHold.mockClear();
    refreshData.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('muestra cuánto falta para el siguiente ciclo, con horas, minutos y segundos', () => {
    setState();
    render(<HoldButton />);
    const el = screen.getByTestId('hold-cooldown');
    expect(el.textContent).toMatch(/New cycle in 2h \d+m \d+s/);
  });

  it('tickea segundo a segundo', async () => {
    setState();
    render(<HoldButton />);
    const before = screen.getByTestId('hold-cooldown').textContent;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const after = screen.getByTestId('hold-cooldown').textContent;
    expect(after).not.toBe(before);
  });

  it('sin cooldown no hay countdown', () => {
    setState({ canHold: () => true, holdsCompleted: 1, remainingHolds: 2, cycleEndsAt: null });
    render(<HoldButton />);
    expect(screen.queryByTestId('hold-cooldown')).toBeNull();
  });

  it('con claim pendiente no muestra standby: hay que cobrar, no esperar', () => {
    setState({ pendingClaim: { claim_id: 'C1', expires_at: new Date(Date.now() + 60000).toISOString() } });
    render(<HoldButton />);
    expect(screen.queryByTestId('hold-cooldown')).toBeNull();
  });

  it('apagado y todo, el botón vibra al apretarlo y no arranca un hold', () => {
    setState();
    render(<HoldButton />);
    const btn = screen.getByTestId('hold-button');
    // Ya no lleva el atributo disabled: mataría el haptic y el "Wait...".
    expect(btn).not.toBeDisabled();

    fireEvent.mouseDown(btn);
    expect(vibrate).toHaveBeenCalledWith('error');
    expect(doHold).not.toHaveBeenCalled();
  });

  it('cuando la cuenta llega a cero recarga el estado solo', async () => {
    setState({ cycleEndsAt: new Date(Date.now() + 1500).toISOString() });
    render(<HoldButton />);
    expect(screen.getByTestId('hold-cooldown')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(refreshData).toHaveBeenCalled();
  });
});

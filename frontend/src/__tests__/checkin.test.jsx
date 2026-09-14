import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

/**
 * Daily check-in (v3.3): 0.15 USDT + 500 KEEP fijos por dia. La semana de 7
 * dias ya NO acredita un bono directo: abre un CLAIM semanal (1.5 USDT +
 * 2000 KEEP) que se cobra pagando 0.15 TON via TonConnect y vence al fin de
 * la semana ISO. El estado sobrevive un reload (localStorage en dev,
 * checkins+claims en produccion).
 */
import { WalletProvider } from '@/contexts/WalletContext';
import { TradeProvider } from '@/contexts/TradeContext';
import { CheckInCard } from '@/components/missions/CheckInCard';
import {
  resetMockCheckins,
  resetMockWallet,
  checkinStatus,
  dailyCheckin,
  verifyPayment,
} from '@/services/api';
import { isoWeekKey } from '@/lib/checkin';

const CHECKIN_KEY = 'tk_checkins_v1';
const WEEKLY_CLAIM_KEY = 'tk_weekly_claim_v1';

function renderCard() {
  return render(
    <WalletProvider>
      <TradeProvider markPollMs={60000}>
        <CheckInCard />
      </TradeProvider>
    </WalletProvider>
  );
}

const seedDays = (days) => localStorage.setItem(CHECKIN_KEY, JSON.stringify(days));

describe('check-in api', () => {
  beforeEach(() => {
    resetMockCheckins();
    resetMockWallet();
    localStorage.clear();
  });

  it('starts with nothing done', async () => {
    const s = await checkinStatus();
    expect(s.ok).toBe(true);
    expect(s.checked_in_today).toBe(false);
    expect(s.days_this_week).toBe(0);
    expect(s.streak).toBe(0);
    expect(s.weekly_claim).toBeNull();
  });

  it('credits 0.15 USDT + 500 KEEP fijos, una vez por dia', async () => {
    const first = await dailyCheckin();
    expect(first.ok).toBe(true);
    expect(first.credited).toBeCloseTo(0.15, 10);
    expect(first.days_this_week).toBe(1);

    // v3.3: 500 KEEP fijos, sin sorteo.
    expect(first.keep_reward).toBe(500);
    expect(first.keep_weekly).toBe(0);
    expect(first.keep_balance).toBe(500);

    const second = await dailyCheckin();
    expect(second.ok).toBe(false);
    expect(second.error).toBe('already_checked_in');
  });

  it('el dia 7 abre el claim semanal en vez de acreditar el bono', async () => {
    // Sunday of 2026-W37; Monday 07 .. Saturday 12 already done.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    seedDays(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']);

    const res = await dailyCheckin();
    expect(res.ok).toBe(true);
    expect(res.days_this_week).toBe(7);
    expect(res.weekly_complete).toBe(true);

    // El bono directo NO existe mas: el premio es un claim por TonConnect.
    expect(res.weekly_bonus).toBe(0);
    expect(res.keep_weekly).toBe(0);
    expect(res.credited).toBeCloseTo(0.15, 10);

    // Claim semanal: 1.5 USDT + 2000 KEEP, fee 0.15 TON, vence el lunes.
    expect(res.weekly_claim_id).toBe('CLMW_DEV_2026-W37');
    expect(res.weekly_claim.total_prize).toBeCloseTo(1.5, 10);
    expect(res.weekly_claim.keep_bonus).toBe(2000);
    expect(res.weekly_claim.ton_fee).toBe(0.15);
    expect(new Date(res.weekly_claim.expires_at).toISOString())
      .toBe('2026-09-14T00:00:00.000Z'); // lunes 00:00 UTC = fin de W37

    // El claim queda visible en el status (CTA de la tarjeta).
    const s = await checkinStatus();
    expect(s.weekly_claim?.claim_id).toBe('CLMW_DEV_2026-W37');

    vi.useRealTimers();
  });

  it('el claim semanal se cobra por verify-payment (1.5 USDT + 2000 KEEP)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    seedDays(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']);
    await dailyCheckin();

    const paid = await verifyPayment('CLMW_DEV_2026-W37', 'EQSender');
    expect(paid.ok).toBe(true);
    expect(paid.credited).toBeCloseTo(1.5, 10);
    expect(paid.keep_credited).toBe(2000);

    // Cobrado: el CTA desaparece.
    const s = await checkinStatus();
    expect(s.weekly_claim).toBeNull();

    vi.useRealTimers();
  });

  it('la semana siguiente arranca de cero y sin claim', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    seedDays(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']);
    await dailyCheckin();

    vi.setSystemTime(new Date('2026-09-14T12:00:00Z')); // Monday of 2026-W38
    const next = await dailyCheckin();

    expect(next.ok).toBe(true);
    expect(next.days_this_week).toBe(1, 'new week starts from zero');
    expect(next.weekly_bonus).toBe(0);
    expect(next.credited).toBeCloseTo(0.15, 10);
    expect(next.weekly_claim_id).toBeNull();

    vi.useRealTimers();
  });
});

describe('CheckInCard', () => {
  beforeEach(() => {
    resetMockCheckins();
    resetMockWallet();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows an enabled button when nothing is done today', async () => {
    renderCard();
    const btn = await screen.findByTestId('checkin-button');
    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(btn.textContent).toContain('Check in');
    expect(screen.getByTestId('checkin-progress').textContent).toContain('0/7');
    // v3.3: el premio semanal se muestra con su KEEP.
    expect(screen.getByTestId('checkin-progress').textContent).toContain('1.50 USDT + 2000 KEEP');
  });

  it('checks in, shows the reward and disables itself', async () => {
    renderCard();
    const btn = await screen.findByTestId('checkin-button');
    await waitFor(() => expect(btn).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(btn);
    });

    expect(await screen.findByTestId('checkin-reward')).toBeInTheDocument();
    expect(screen.getByTestId('checkin-reward').textContent).toContain('0.15');
    // v3.3: el feedback muestra los 500 KEEP fijos.
    expect(screen.getByTestId('checkin-reward').textContent).toContain('500');
    expect(screen.getByTestId('checkin-button')).toBeDisabled();
    expect(screen.getByTestId('checkin-button').textContent).toContain('Checked in today');
    expect(screen.getByTestId('checkin-progress').textContent).toContain('1/7');
    expect(screen.getByTestId('checkin-day-0')).toHaveAttribute('data-filled', 'true');
  });

  it('muestra el CTA del claim semanal cuando hay uno pendiente', async () => {
    // Claim semanal pendiente sembrado directo (como lo deja el dia 7).
    const monday = new Date(Date.now() + 86400000 * 3);
    localStorage.setItem(WEEKLY_CLAIM_KEY, JSON.stringify({
      week: isoWeekKey(),
      status: 'pending',
      claim_id: `CLMW_DEV_${isoWeekKey()}`,
      expires_at: monday.toISOString(),
      total_prize: 1.5,
      ton_fee: 0.15,
      keep_bonus: 2000,
    }));

    renderCard();
    const cta = await screen.findByTestId('claim-weekly-button');
    expect(cta.textContent).toContain('1.50 USDT');
    expect(cta.textContent).toContain('2000 KEEP');
  });

  it('renders the week as 7 slots with the gift on the last one', async () => {
    renderCard();
    await screen.findByTestId('checkin-button');
    for (let i = 0; i < 7; i++) {
      expect(screen.getByTestId(`checkin-day-${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('checkin-day-7')).not.toBeInTheDocument();
  });

  it('reports the streak in the header', async () => {
    // real dates (no fake timers here: the card loads asynchronously)
    const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    seedDays([day(-2), day(-1)]);

    renderCard();
    const streak = await screen.findByTestId('checkin-streak');
    await waitFor(() => expect(streak.textContent).toContain('2'));
  });
});

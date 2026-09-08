import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

/**
 * Daily check-in: one credit a day, weekly bonus on the 7th day of the ISO
 * week, and the state survives a reload (localStorage mirror in dev,
 * `checkins` table in production).
 */
import { WalletProvider } from '@/contexts/WalletContext';
import { TradeProvider } from '@/contexts/TradeContext';
import { CheckInCard } from '@/components/missions/CheckInCard';
import {
  resetMockCheckins,
  resetMockWallet,
  checkinStatus,
  dailyCheckin,
} from '@/services/api';

const CHECKIN_KEY = 'tk_checkins_v1';

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
  });

  it('credits the daily reward once per day', async () => {
    const first = await dailyCheckin();
    expect(first.ok).toBe(true);
    expect(first.credited).toBeCloseTo(0.05, 10);
    expect(first.days_this_week).toBe(1);

    const second = await dailyCheckin();
    expect(second.ok).toBe(false);
    expect(second.error).toBe('already_checked_in');
  });

  it('pays the weekly bonus only on the 7th day of the ISO week', async () => {
    // Sunday of 2026-W37; Monday 07 .. Saturday 12 already done.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    seedDays(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']);

    const res = await dailyCheckin();
    expect(res.ok).toBe(true);
    expect(res.days_this_week).toBe(7);
    expect(res.weekly_complete).toBe(true);
    expect(res.weekly_bonus).toBeCloseTo(0.5, 10);
    expect(res.credited).toBeCloseTo(0.55, 10);

    vi.useRealTimers();
  });

  it('does not pay the weekly bonus twice in the same week', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    seedDays(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']);

    await dailyCheckin();
    // a new day inside the same ISO week is impossible, so simulate the next
    // day being reached with the week already paid
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z')); // Monday of 2026-W38
    const next = await dailyCheckin();

    expect(next.ok).toBe(true);
    expect(next.days_this_week).toBe(1, 'new week starts from zero');
    expect(next.weekly_bonus).toBe(0);
    expect(next.credited).toBeCloseTo(0.05, 10);

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
  });

  it('checks in, shows the reward and disables itself', async () => {
    renderCard();
    const btn = await screen.findByTestId('checkin-button');
    await waitFor(() => expect(btn).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(btn);
    });

    expect(await screen.findByTestId('checkin-reward')).toBeInTheDocument();
    expect(screen.getByTestId('checkin-reward').textContent).toContain('0.05');
    expect(screen.getByTestId('checkin-button')).toBeDisabled();
    expect(screen.getByTestId('checkin-button').textContent).toContain('Checked in today');
    expect(screen.getByTestId('checkin-progress').textContent).toContain('1/7');
    expect(screen.getByTestId('checkin-day-0')).toHaveAttribute('data-filled', 'true');
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

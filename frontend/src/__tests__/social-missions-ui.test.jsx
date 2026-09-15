import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SocialMissions } from '@/components/missions/SocialMissions';
import * as api from '@/services/api';

// La UI de las misiones (v3.3): muestra lo que manda el Worker, dispara el
// verify, y muestra la causa real cuando el Worker rechaza ('Not joined yet',
// 'Progress not complete'...). Cubre los tres verify: telegram_member,
// progress (barra + meta) y manual (Request review → Under review).

vi.mock('@/services/api', () => ({
  getSocialMissions: vi.fn(),
  verifySocialMission: vi.fn(),
  shareToStory: vi.fn(),
  KEEP_REWARDS: {
    mission: { min: 500, max: 1200 },
    checkin: { min: 500, max: 500 },
    weekly: 2000,
    claim: { min: 500, max: 2500 },
  },
}));
vi.mock('@/hooks/useTelegram', () => ({
  useTelegram: () => ({ vibrate: vi.fn(), share: vi.fn(), isTelegramWebApp: false }),
}));
const refreshData = vi.fn();
vi.mock('@/contexts/WalletContext', () => ({
  useWallet: () => ({ refreshData, uid: 'U123' }),
}));

const TG_MISSION = {
  id: 'tg_channel', platform: 'telegram', title: 'Follow the channel',
  description: 'Official announcements.', url: 'https://t.me/KeeperExchange',
  reward: 0.4, verify: 'telegram_member',
  reward_keep: null, repeat: 'once', goal: null, progress_type: null, current: null,
};

const MISSIONS = {
  ok: true,
  missions: [TG_MISSION],
  completed: [],
  pending: [],
  keep_min: 500,
  keep_max: 1200,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getSocialMissions.mockResolvedValue(MISSIONS);
});

describe('Misiones sociales (UI)', () => {
  it('muestra la mision con su premio y el boton Verify', async () => {
    render(<SocialMissions />);
    await waitFor(() => expect(screen.getByTestId('social-mission-tg_channel')).toBeTruthy());
    expect(screen.getByText('Follow the channel')).toBeTruthy();
    expect(screen.getByTestId('reward-tg_channel').textContent)
      .toBe('+$0.40 USDT · +500–1200 KEEP');
    expect(screen.getByTestId('verify-tg_channel')).toBeTruthy();
    expect(screen.getByTestId('open-tg_channel').getAttribute('href'))
      .toBe('https://t.me/KeeperExchange');
  });

  it('verify exitoso queda Done y refresca el saldo', async () => {
    api.verifySocialMission.mockResolvedValue({ ok: true, reward: 0.4 });
    render(<SocialMissions />);
    await waitFor(() => expect(screen.getByTestId('verify-tg_channel')).toBeTruthy());

    fireEvent.click(screen.getByTestId('verify-tg_channel'));
    await waitFor(() => expect(screen.getByTestId('verify-tg_channel')).toHaveTextContent('Done'));
    expect(api.verifySocialMission).toHaveBeenCalledWith('tg_channel');
    expect(refreshData).toHaveBeenCalled();
  });

  it('si Telegram dice que no esta, muestra la causa real', async () => {
    api.verifySocialMission.mockRejectedValue(new Error('Not joined yet'));
    render(<SocialMissions />);
    await waitFor(() => expect(screen.getByTestId('verify-tg_channel')).toBeTruthy());

    fireEvent.click(screen.getByTestId('verify-tg_channel'));
    await waitFor(() => expect(screen.getByTestId('error-tg_channel')).toHaveTextContent('Not joined yet'));
  });

  it('una mision ya completada arranca en Done y no se puede reverificar', async () => {
    api.getSocialMissions.mockResolvedValue({ ...MISSIONS, completed: ['tg_channel'] });
    render(<SocialMissions />);
    await waitFor(() => expect(screen.getByTestId('verify-tg_channel')).toHaveTextContent('Done'));
    expect(screen.getByTestId('verify-tg_channel')).toBeDisabled();
  });

  it('sin misiones habilitadas no pinta nada', async () => {
    api.getSocialMissions.mockResolvedValue({ ok: true, missions: [], completed: [] });
    const { container } = render(<SocialMissions />);
    await waitFor(() => expect(api.getSocialMissions).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="social-missions"]')).toBeNull();
  });
});

describe('Misiones v3.3 (UI)', () => {
  const FIRST_DEPOSIT = {
    id: 'first_deposit', platform: 'app', title: 'First Deposit',
    description: 'Make your first deposit (min 1GRAM or 1 USDT). (review automatico con la wallet)', url: '',
    reward: 1, verify: 'automatic',
    reward_keep: 3000, repeat: 'once', goal: null, progress_type: null, current: null,
  };
  const DAILY_HOLD = {
    id: 'daily_hold', platform: 'app', title: 'Daily Holder',
    description: 'Start 3 holds today.', url: '',
    reward: 0.1, verify: 'progress',
    reward_keep: null, repeat: 'daily', goal: 3, progress_type: 'holds_today', current: 1,
  };
  const WEEKLY_REFERRAL = {
    id: 'weekly_referral', platform: 'app', title: 'Social Butterfly',
    description: 'Invite 5 friends this week.', url: '',
    reward: 2.5, verify: 'progress',
    reward_keep: 5000, repeat: 'weekly', goal: 5,
    progress_type: 'referrals_week', current: 5,
  };

  it('First Deposit muestra descripcion exacta, premio fijo y revision automatica', async () => {
    api.getSocialMissions.mockResolvedValue({ ...MISSIONS, missions: [FIRST_DEPOSIT] });
    render(<SocialMissions />);
    await waitFor(() => expect(screen.getByTestId('social-mission-first_deposit')).toBeTruthy());
    expect(screen.getByText(FIRST_DEPOSIT.description)).toBeTruthy();
    expect(screen.getByTestId('reward-first_deposit').textContent)
      .toBe('+$1.00 USDT · +3,000 KEEP');
    // Sin url no hay boton de abrir y la wallet controla la revision.
    expect(screen.queryByTestId('open-first_deposit')).toBeNull();
    expect(screen.getByTestId('verify-first_deposit').textContent).toContain('Automatic review');
    expect(screen.getByTestId('verify-first_deposit')).toBeDisabled();
    expect(api.verifySocialMission).not.toHaveBeenCalled();
  });

  it('Social ButterflyWeekly muestra descripcion y premio exactos', async () => {
    api.getSocialMissions.mockResolvedValue({ ...MISSIONS, missions: [WEEKLY_REFERRAL] });
    render(<SocialMissions />);
    await waitFor(() => expect(screen.getByTestId('social-mission-weekly_referral')).toBeTruthy());
    expect(screen.getByText(WEEKLY_REFERRAL.description)).toBeTruthy();
    expect(screen.getByTestId('reward-weekly_referral').textContent)
      .toBe('+$2.50 USDT · +5,000 KEEP');
    expect(screen.getByTestId('repeat-weekly_referral')).toHaveTextContent('Weekly');
    expect(screen.getByTestId('progress-weekly_referral')).toHaveTextContent('5/5');
  });

  it('mision de progreso: barra 1/3 y boton deshabilitado hasta la meta', async () => {
    api.getSocialMissions.mockResolvedValue({ ...MISSIONS, missions: [DAILY_HOLD] });
    render(<SocialMissions />);
    await waitFor(() => expect(screen.getByTestId('progress-daily_hold')).toBeTruthy());
    expect(screen.getByTestId('progress-daily_hold').textContent).toContain('1/3');
    expect(screen.getByTestId('verify-daily_hold')).toBeDisabled();
    expect(screen.getByTestId('repeat-daily_hold').textContent).toBe('Daily');
  });

  it('mision de progreso: con la meta alcanzada se puede cobrar', async () => {
    api.getSocialMissions.mockResolvedValue({
      ...MISSIONS, missions: [{ ...DAILY_HOLD, current: 3 }],
    });
    api.verifySocialMission.mockResolvedValue({ ok: true, reward: 0.1, keep_reward: 700 });
    render(<SocialMissions />);
    await waitFor(() => expect(screen.getByTestId('progress-daily_hold')).toBeTruthy());
    const btn = screen.getByTestId('verify-daily_hold');
    expect(btn).not.toBeDisabled();

    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveTextContent('Done'));
  });

  it('si el Worker dice Progress not complete, muestra el error', async () => {
    api.getSocialMissions.mockResolvedValue({
      ...MISSIONS, missions: [{ ...DAILY_HOLD, current: 3 }],
    });
    api.verifySocialMission.mockRejectedValue(new Error('Progress not complete'));
    render(<SocialMissions />);
    await waitFor(() => expect(screen.getByTestId('verify-daily_hold')).toBeTruthy());

    fireEvent.click(screen.getByTestId('verify-daily_hold'));
    await waitFor(() => expect(screen.getByTestId('error-daily_hold')).toHaveTextContent('Progress not complete'));
  });
});

describe('Mision de compartir v3.4 (UI)', () => {
  const TG_SHARE = {
    id: 'tg_share', platform: 'telegram', title: 'Share on Telegram',
    description: 'Share TronKeeper on your story, then request review.', url: '',
    reward: 0.5, verify: 'manual',
    reward_keep: 1500, repeat: 'weekly', goal: null, progress_type: null, current: null,
    share_text: '🎁 Join me on TronKeeper!',
  };

  it('muestra el boton "Share on Telegram" y el premio fijo', async () => {
    api.getSocialMissions.mockResolvedValue({ ...MISSIONS, missions: [TG_SHARE] });
    render(<SocialMissions />);
    await waitFor(() => expect(screen.getByTestId('social-mission-tg_share')).toBeTruthy());
    expect(screen.getByTestId('reward-tg_share').textContent)
      .toBe('+$0.50 USDT · +1,500 KEEP');
    expect(screen.getByTestId('verify-tg_share').textContent).toContain('Share on Telegram');
    // Sin url propia: no hay boton de abrir link.
    expect(screen.queryByTestId('open-tg_share')).toBeNull();
  });

  it('al compartir crea la solicitud manual y sube la foto a la historia', async () => {
    api.getSocialMissions.mockResolvedValue({ ...MISSIONS, missions: [TG_SHARE] });
    api.verifySocialMission.mockResolvedValue({ ok: true, pending: true });
    render(<SocialMissions />);
    await waitFor(() => expect(screen.getByTestId('verify-tg_share')).toBeTruthy());

    fireEvent.click(screen.getByTestId('verify-tg_share'));
    await waitFor(() => expect(screen.getByTestId('verify-tg_share')).toHaveTextContent('Under review'));
    // Sube la foto del bot a la historia con el uid y el texto de la mision.
    expect(api.shareToStory).toHaveBeenCalledWith('U123', '🎁 Join me on TronKeeper!');
    // Y deja la solicitud en revision manual.
    expect(api.verifySocialMission).toHaveBeenCalledWith('tg_share');
    expect(screen.getByTestId('verify-tg_share')).toBeDisabled();
  });
});

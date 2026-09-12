import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SocialMissions } from '@/components/missions/SocialMissions';
import * as api from '@/services/api';

// La UI de las misiones sociales: muestra lo que manda el Worker, dispara el
// verify, y muestra la causa real cuando Telegram dice "no estas".

vi.mock('@/services/api', () => ({
  getSocialMissions: vi.fn(),
  verifySocialMission: vi.fn(),
}));
vi.mock('@/hooks/useTelegram', () => ({
  useTelegram: () => ({ vibrate: vi.fn(), share: vi.fn(), isTelegramWebApp: false }),
}));
const refreshData = vi.fn();
vi.mock('@/contexts/WalletContext', () => ({
  useWallet: () => ({ refreshData }),
}));

const MISSIONS = {
  ok: true,
  missions: [
    { id: 'tg_channel', platform: 'telegram', title: 'Follow the channel',
      description: 'Official announcements.', url: 'https://t.me/KeeperExchange',
      reward: 0.4, verify: 'telegram_member' },
  ],
  completed: [],
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
    expect(screen.getByText('+$0.40 USDT')).toBeTruthy();
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

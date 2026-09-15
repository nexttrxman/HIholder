import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminPage } from '@/pages/Admin';
import * as api from '@/services/api';

// Panel de admin (v3.3): gate por token, dos colas (misiones manuales y
// retiros), aprobar/rechazar. Todo contra la API admin del Worker.

vi.mock('@/services/api', () => ({
  adminListMissionRequests: vi.fn(),
  adminApproveMission: vi.fn(),
  adminRejectMission: vi.fn(),
  adminListWithdrawals: vi.fn(),
  adminResolveWithdrawal: vi.fn(),
  adminListDeposits: vi.fn(),
  adminResolveDeposit: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('AdminPage', () => {
  it('sin token muestra el login y no llama a la API', () => {
    render(<AdminPage />);
    expect(screen.getByTestId('admin-login')).toBeTruthy();
    expect(api.adminListMissionRequests).not.toHaveBeenCalled();
  });

  it('al guardar el token carga las dos colas', async () => {
    api.adminListMissionRequests.mockResolvedValue({ ok: true, requests: [] });
    api.adminListWithdrawals.mockResolvedValue({ ok: true, requests: [] });
    api.adminListDeposits.mockResolvedValue({ ok: true, deposits: [] });
    render(<AdminPage />);

    fireEvent.change(screen.getByTestId('admin-token-input'), { target: { value: 'tok' } });
    fireEvent.click(screen.getByText('Enter'));

    await waitFor(() => expect(screen.getByTestId('admin-page')).toBeTruthy());
    expect(api.adminListMissionRequests).toHaveBeenCalledWith('tok');
    expect(api.adminListWithdrawals).toHaveBeenCalledWith('tok');
  });

  it('muestra una solicitud de mision y la aprueba', async () => {
    api.adminListMissionRequests.mockResolvedValue({
      ok: true,
      requests: [{
        user_id: '42', username: 'ana', first_name: 'Ana', mission_id: 'first_deposit',
        title: 'First Deposit', reward_usdt: '1.00000000', reward_keep: 3000,
        requested_at: '2026-09-14T10:00:00Z',
      }],
    });
    api.adminListWithdrawals.mockResolvedValue({ ok: true, requests: [] });
    api.adminListDeposits.mockResolvedValue({ ok: true, deposits: [] });
    api.adminApproveMission.mockResolvedValue({ ok: true, reward: 1, keep_reward: 3000 });

    render(<AdminPage />);
    fireEvent.change(screen.getByTestId('admin-token-input'), { target: { value: 'tok' } });
    fireEvent.click(screen.getByText('Enter'));

    const row = await screen.findByTestId('admin-mission-42');
    expect(row.textContent).toContain('Ana');
    expect(row.textContent).toContain('3,000 KEEP');

    fireEvent.click(screen.getByTestId('approve-42'));
    await waitFor(() => expect(api.adminApproveMission).toHaveBeenCalledWith('tok', '42', 'first_deposit'));
  });

  it('un 401 limpia el token y vuelve al login', async () => {
    api.adminListMissionRequests.mockRejectedValue(new Error('Unauthorized'));
    api.adminListWithdrawals.mockRejectedValue(new Error('Unauthorized'));
    api.adminListDeposits.mockRejectedValue(new Error('Unauthorized'));

    render(<AdminPage />);
    fireEvent.change(screen.getByTestId('admin-token-input'), { target: { value: 'malo' } });
    fireEvent.click(screen.getByText('Enter'));

    await waitFor(() => expect(screen.getByTestId('admin-login')).toBeTruthy());
    expect(sessionStorage.getItem('tk_admin_token_v1')).toBeNull();
  });

  it('la cola de retiros marca pagado con tx hash', async () => {
    api.adminListMissionRequests.mockResolvedValue({ ok: true, requests: [] });
    api.adminListDeposits.mockResolvedValue({ ok: true, deposits: [] });
    api.adminListWithdrawals.mockResolvedValue({
      ok: true,
      requests: [{
        id: 'wd-1', user_id: '77', asset: 'USDT', amount: '25.00000000',
        fee_trx: '5.50000000', to_address: 'TXyz', created_at: '2026-09-14T09:00:00Z',
      }],
    });
    api.adminResolveWithdrawal.mockResolvedValue({ ok: true });

    render(<AdminPage />);
    fireEvent.change(screen.getByTestId('admin-token-input'), { target: { value: 'tok' } });
    fireEvent.click(screen.getByText('Enter'));

    await waitFor(() => expect(screen.getByTestId('admin-page')).toBeTruthy());
    fireEvent.click(screen.getByTestId('admin-tab-withdrawals'));
    await screen.findByTestId('admin-wd-wd-1');
    // El prompt del tx hash:
    window.prompt = () => 'TXH123';
    fireEvent.click(screen.getByTestId('wd-paid-wd-1'));
    await waitFor(() =>
      expect(api.adminResolveWithdrawal).toHaveBeenCalledWith('tok', 'wd-1', 'paid', 'TXH123'));
  });
});

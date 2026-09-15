import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TransactionList } from '@/components/transactions/TransactionList';

// Regresión del reclamo del usuario: "en activity todas las operaciones están
// en ALL, deben estar acomodadas en cada subpestaña". El servidor manda las
// operaciones del ledger ('withdrawal', 'trade_buy', 'checkin_daily'...) y el
// filtro solo conocía 'withdraw' y 'buy'/'sell', así que las subpestañas
// quedaban vacías.

let txs;
vi.mock('@/contexts/WalletContext', () => ({
  useWallet: () => ({
    transactions: txs,
    loadingTransactions: false,
    loadTransactions: vi.fn(),
  }),
}));

const base = { status: 'confirmed', timestamp: Date.now(), asset: 'USDT', amount: 1 };
const mk = (id, type, asset = 'USDT') => ({ ...base, id, type, asset });

const FIXTURE = [
  mk('dep', 'deposit'),
  mk('wd', 'withdrawal'),
  mk('fee', 'fee_deduction', 'TRX'),
  mk('tbuy', 'trade_buy'),
  mk('tsell', 'trade_sell'),
  mk('buy', 'buy'),          // entrada optimista local
  mk('sell', 'sell'),        // entrada optimista local
  mk('claim', 'claim_credit'),
  mk('ref', 'referral_bonus', 'TRX'),
  mk('wel', 'signup_bonus', 'TRX'),
  mk('chk', 'checkin_daily'),
];

function ids() {
  return [...document.querySelectorAll('[data-testid^="transaction-"]')]
    .map((n) => n.getAttribute('data-testid'))
    // Ni el contenedor ('transaction-list') ni los montos ('...-amount').
    .filter((t) => !t.endsWith('-amount') && t !== 'transaction-list')
    .map((t) => t.replace('transaction-', ''));
}

function renderList() {
  txs = FIXTURE;
  render(<TransactionList />);
}

describe('Activity: cada operación en su subpestaña', () => {
  it('All muestra todo', () => {
    renderList();
    fireEvent.click(screen.getByTestId('filter-all'));
    expect(ids()).toHaveLength(FIXTURE.length);
  });

  it('Withdrawals junta el retiro, su fee y nada más', () => {
    renderList();
    fireEvent.click(screen.getByTestId('filter-withdraw'));
    expect(ids().sort()).toEqual(['fee', 'wd']);
  });

  it('Trades junta las operaciones del servidor y las locales', () => {
    renderList();
    fireEvent.click(screen.getByTestId('filter-trades'));
    expect(ids().sort()).toEqual(['buy', 'sell', 'tbuy', 'tsell']);
  });

  it('Rewards junta claim, referidos, bienvenida y check-ins', () => {
    renderList();
    fireEvent.click(screen.getByTestId('filter-reward'));
    expect(ids().sort()).toEqual(['chk', 'claim', 'ref', 'wel']);
  });

  it('Deposits muestra solo depósitos', () => {
    renderList();
    fireEvent.click(screen.getByTestId('filter-deposit'));
    expect(ids()).toEqual(['dep']);
  });
});

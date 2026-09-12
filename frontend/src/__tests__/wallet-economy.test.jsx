/**
 * Reglas de economía de la wallet: saldo inicial, fee de retiro y envío interno.
 *
 * Estos números viven duplicados a propósito —el Worker los cobra, el frontend
 * los muestra— así que el test que importa es que coincidan con lo que el
 * usuario ve y con lo que CONFIG declara del otro lado.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';

import {
  WITHDRAWAL_FEE_TRX,
  SIGNUP_TRX_BONUS,
  INTERNAL_TRANSFER_ENABLED,
} from '@/services/api';
import { BalanceCard } from '@/components/wallet/BalanceCard';
import { TransactionItem } from '@/components/transactions/TransactionItem';

const HERE = dirname(fileURLToPath(import.meta.url));
// El Worker es la fuente de verdad: es el que cobra.
const LIB_JS = readFileSync(
  resolve(HERE, '../../../cloudflare-worker/lib.js'),
  'utf-8',
);

describe('economía: constantes espejadas con el Worker', () => {
  it('el fee de retiro coincide con CONFIG.WITHDRAWAL_FEE_TRX', () => {
    const m = LIB_JS.match(/WITHDRAWAL_FEE_TRX:\s*([\d.]+)/);
    expect(m, 'no se encontró WITHDRAWAL_FEE_TRX en lib.js').toBeTruthy();
    expect(WITHDRAWAL_FEE_TRX).toBe(parseFloat(m[1]));
    expect(WITHDRAWAL_FEE_TRX).toBe(5.5);
  });

  it('el saldo inicial coincide con CONFIG.SIGNUP_TRX_BONUS', () => {
    const m = LIB_JS.match(/SIGNUP_TRX_BONUS:\s*([\d.]+)/);
    expect(m, 'no se encontró SIGNUP_TRX_BONUS en lib.js').toBeTruthy();
    expect(SIGNUP_TRX_BONUS).toBe(parseFloat(m[1]));
    expect(SIGNUP_TRX_BONUS).toBe(1);
  });

  it('el fee es mayor que el saldo inicial: nadie retira el primer día', () => {
    // No es un bug, es el diseño: para retirar hay que juntar TRX antes
    // (referidos, check-in). Se fija acá para que si alguien baja el fee o sube
    // el bonus sin querer, el cambio se note.
    expect(WITHDRAWAL_FEE_TRX).toBeGreaterThan(SIGNUP_TRX_BONUS);
  });

  it('el envío interno arranca deshabilitado (no hay endpoint todavía)', () => {
    expect(INTERNAL_TRANSFER_ENABLED).toBe(false);
  });
});

describe('BalanceCard: botón de envío interno', () => {
  it('no aparece si no se pasa onSend', () => {
    render(<BalanceCard asset="TRX" amount={1} />);
    expect(screen.queryByTestId('send-trx-btn')).toBeNull();
  });

  it('ya no muestra el texto "Soon" ni queda disabled: ahora abre el cartel', () => {
    render(
      <BalanceCard asset="TRX" amount={1} onSend={() => {}} sendDisabled />,
    );
    const btn = screen.getByTestId('send-trx-btn');
    expect(btn.disabled).toBe(false);
    expect(btn).not.toHaveTextContent('Soon');
  });

  it('el circulito de información queda al lado de la palabra Send, adentro del botón', () => {
    render(<BalanceCard asset="USDT" amount={10} onSend={() => {}} sendDisabled />);
    const btn = screen.getByTestId('send-usdt-btn');
    const info = screen.getByTestId('send-usdt-info');
    expect(btn.contains(info)).toBe(true);
  });

  it('apretar Send abre el cartel con el logo y no dispara el envío', () => {
    const onSend = vi.fn();
    render(<BalanceCard asset="USDT" amount={10} onSend={onSend} sendDisabled />);
    expect(screen.queryByTestId('send-usdt-soon-card')).toBeNull();

    fireEvent.click(screen.getByTestId('send-usdt-btn'));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('send-usdt-soon-card')).toBeTruthy();
    expect(screen.getByTestId('send-usdt-soon-logo')).toBeTruthy();
    expect(screen.getByTestId('send-usdt-soon-card')).toHaveTextContent(/other users/i);
  });

  it('el cartel se cierra con su botón y tocando afuera', () => {
    render(<BalanceCard asset="USDT" amount={10} onSend={() => {}} sendDisabled />);
    fireEvent.click(screen.getByTestId('send-usdt-btn'));
    expect(screen.getByTestId('send-usdt-soon-card')).toBeTruthy();

    fireEvent.click(screen.getByTestId('send-usdt-soon-close'));
    expect(screen.queryByTestId('send-usdt-soon-card')).toBeNull();

    fireEvent.click(screen.getByTestId('send-usdt-btn'));
    fireEvent.click(screen.getByTestId('send-usdt-soon-overlay'));
    expect(screen.queryByTestId('send-usdt-soon-card')).toBeNull();
  });

  it('sin sendDisabled no hay circulito (el envío ya funciona)', () => {
    render(<BalanceCard asset="USDT" amount={10} onSend={() => {}} sendDisabled={false} />);
    expect(screen.queryByTestId('send-usdt-info')).toBeNull();
  });

  it('el botón de retiro sigue estando', () => {
    render(
      <BalanceCard
        asset="TRX"
        amount={1}
        onWithdraw={() => {}}
        onSend={() => {}}
        sendDisabled
      />,
    );
    expect(screen.getByTestId('withdraw-trx-btn')).toBeTruthy();
  });
});

// ==========================================================================
// Historial: signos y etiquetas
// ==========================================================================
// Un retiro de 2000 USDT se mostraba como "Deposit" y "+$-2000.00": la tabla de
// tipos solo conocía los nombres de la UI ('withdraw'), el servidor manda los del
// ledger ('withdrawal'), así que todo caía en el fallback 'deposit'; y el signo se
// deducía del tipo mientras el monto YA venía firmado. Estos tests fijan las dos
// cosas, porque el bug pasó justamente por no tener ninguno.
describe('TransactionItem: signos del historial', () => {
  const base = { id: 't1', status: 'confirmed', timestamp: Date.now() };
  const text = (tx) => {
    render(<TransactionItem transaction={tx} />);
    return screen.getByTestId(`transaction-${tx.id}-amount`).textContent;
  };

  it('un retiro de USDT va en menos y no duplica el signo', () => {
    // Tal cual lo escribe request_withdrawal(): amount = -p_amount.
    const t = text({ ...base, type: 'withdrawal', asset: 'USDT', amount: -2000 });
    expect(t).toBe('-$2000.00');
  });

  it('la comisión de red va en menos', () => {
    const t = text({ ...base, type: 'fee_deduction', asset: 'TRX', amount: -5.5 });
    expect(t).toBe('-5.50');
  });

  it('un depósito va en más', () => {
    const t = text({ ...base, type: 'deposit', asset: 'USDT', amount: 2622.58 });
    expect(t).toBe('+$2622.58');
  });

  it('ningún monto sale con doble signo', () => {
    for (const type of ['withdrawal', 'fee_deduction', 'deposit', 'claim_credit',
                        'referral_bonus', 'signup_bonus', 'checkin_daily',
                        'checkin_weekly', 'trade_buy', 'trade_sell']) {
      for (const amount of [-2000, -5.5, 0, 5.5, 2000]) {
        const t = text({ ...base, id: `x${type}${amount}`, type, asset: 'USDT', amount });
        // Forma exacta: un signo, el "$" si es USDT, y el número. El bug era
        // "+$-2000.00": el signo del componente más el signo del monto.
        expect(t, `${type} ${amount}`).toMatch(/^[+-]\$?\d+\.\d{2}$/);
      }
    }
  });

  it('el retiro y la comisión se etiquetan distinto del depósito', () => {
    render(<TransactionItem transaction={{ ...base, type: 'withdrawal', asset: 'USDT', amount: -2000 }} />);
    expect(screen.getByText('Withdrawal')).toBeTruthy();
    render(<TransactionItem transaction={{ ...base, id: 't2', type: 'fee_deduction', asset: 'TRX', amount: -5.5 }} />);
    expect(screen.getByText('Network Fee')).toBeTruthy();
  });

  it('los tipos que el servidor manda ya no caen en el fallback "Deposit"', () => {
    for (const type of ['withdrawal', 'fee_deduction', 'signup_bonus',
                        'checkin_daily', 'checkin_weekly', 'trade_buy', 'trade_sell']) {
      const { unmount } = render(
        <TransactionItem transaction={{ ...base, id: `lab${type}`, type, asset: 'USDT', amount: 1 }} />,
      );
      expect(screen.queryByText('Deposit'), type).toBeNull();
      unmount();
    }
  });

  it('una compra local (monto positivo) sigue contando como salida', () => {
    // TradeContext manda amount positivo y el signo lo daba el tipo. Además queda
    // guardado en localStorage, así que hay filas viejas con esa forma.
    const t = text({ ...base, type: 'buy', asset: 'USDT', amount: 100 });
    expect(t).toBe('-$100.00');
  });

  it('una venta local (monto positivo) sigue contando como entrada', () => {
    const t = text({ ...base, type: 'sell', asset: 'USDT', amount: 100 });
    expect(t).toBe('+$100.00');
  });
});

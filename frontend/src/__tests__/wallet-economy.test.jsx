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
import { render, screen } from '@testing-library/react';

import {
  WITHDRAWAL_FEE_TRX,
  SIGNUP_TRX_BONUS,
  INTERNAL_TRANSFER_ENABLED,
} from '@/services/api';
import { BalanceCard } from '@/components/wallet/BalanceCard';

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

  it('aparece deshabilitado y marcado como "Soon"', () => {
    render(
      <BalanceCard asset="TRX" amount={1} onSend={() => {}} sendDisabled />,
    );
    const btn = screen.getByTestId('send-trx-btn');
    expect(btn.disabled).toBe(true);
    expect(btn).toHaveTextContent('Soon');
  });

  it('queda habilitado cuando se activa la flag', () => {
    render(
      <BalanceCard asset="USDT" amount={10} onSend={() => {}} sendDisabled={false} />,
    );
    const btn = screen.getByTestId('send-usdt-btn');
    expect(btn.disabled).toBe(false);
    expect(btn).not.toHaveTextContent('Soon');
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

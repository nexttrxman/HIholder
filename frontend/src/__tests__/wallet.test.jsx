import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { resetMockWallet } from '@/services/api';
import { WalletProvider } from '@/contexts/WalletContext';
import { TradeProvider } from '@/contexts/TradeContext';
import { WalletPage } from '@/pages/Wallet';

/**
 * Orden y presencia de los bloques de Wallet: Deposit Information arriba y
 * expandido, tarjetas de saldo, y los paneles de withdrawal al pie — todo en la
 * misma pantalla, sin cambiar de pestaña.
 */

function renderWallet(props = {}) {
  return render(
    <WalletProvider>
      <TradeProvider>
        <WalletPage {...props} />
      </TradeProvider>
    </WalletProvider>
  );
}

/** true si `a` aparece antes que `b` en el documento. */
const isBefore = (a, b) =>
  // eslint-disable-next-line no-bitwise
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('Wallet — layout', () => {
  beforeEach(() => resetMockWallet());
  afterEach(() => localStorage.clear());

  it('muestra Deposit Information expandido por defecto', () => {
    renderWallet();
    expect(screen.getByTestId('toggle-deposit')).toBeInTheDocument();
    // Arranca abierto: el panel de depósito ya está en el DOM.
    expect(screen.getByTestId('deposit-info')).toBeInTheDocument();
  });

  it('el toggle cierra y abre el panel de depósito', async () => {
    renderWallet();
    fireEvent.click(screen.getByTestId('toggle-deposit'));
    // AnimatePresence deja el nodo montado durante la animación de salida.
    await waitFor(() => expect(screen.queryByTestId('deposit-info')).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId('toggle-deposit'));
    expect(screen.getByTestId('deposit-info')).toBeInTheDocument();
  });

  it('tiene un panel de withdrawal por activo, al pie', () => {
    renderWallet();
    const panels = screen.getByTestId('withdraw-panels');
    expect(panels).toBeInTheDocument();
    expect(screen.getByTestId('withdraw-panel-usdt')).toBeInTheDocument();
    expect(screen.getByTestId('withdraw-panel-trx')).toBeInTheDocument();
    expect(screen.getByTestId('withdraw-open-usdt')).toBeInTheDocument();
    expect(screen.getByTestId('withdraw-open-trx')).toBeInTheDocument();
  });

  it('el orden es: depósito, tarjetas de saldo, withdrawal', () => {
    renderWallet();
    const deposit = screen.getByTestId('toggle-deposit');
    const usdtCard = screen.getByTestId('balance-card-usdt');
    const withdraw = screen.getByTestId('withdraw-panels');

    expect(isBefore(deposit, usdtCard)).toBe(true);
    expect(isBefore(usdtCard, withdraw)).toBe(true);
  });

  it('los paneles de withdrawal abren el modal con el activo correcto', () => {
    let opened = null;
    renderWallet({ onOpenWithdraw: (asset) => { opened = asset; } });

    fireEvent.click(screen.getByTestId('withdraw-open-trx'));
    expect(opened).toBe('TRX');

    fireEvent.click(screen.getByTestId('withdraw-open-usdt'));
    expect(opened).toBe('USDT');
  });
});

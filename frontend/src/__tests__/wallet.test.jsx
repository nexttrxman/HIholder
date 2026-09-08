import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Precios fijos para que el total del portafolio sea predecible. El resto del
 * módulo (metadatos de pares, velas sintéticas) queda real.
 */
const market = vi.hoisted(() => ({ prices: { TRXUSDT: 0.3, TONUSDT: 3.5 } }));

vi.mock('@/services/market', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchKlines: vi.fn(async (pairId, timeframeId, limit) => ({
      mode: 'sim',
      candles: actual.syntheticCandles(pairId, timeframeId, limit),
    })),
    fetch24h: vi.fn(async (pairId) => ({
      mode: 'live',
      price: market.prices[pairId] ?? 1,
      changePercent: 0,
      high: 1,
      low: 1,
      volume: 0,
    })),
  };
});

import { resetMockWallet } from '@/services/api';
import { WalletProvider } from '@/contexts/WalletContext';
import { TradeProvider } from '@/contexts/TradeContext';
import { WalletPage } from '@/pages/Wallet';

/**
 * Layout de Wallet: Deposit Information arriba y expandido, y UNA tarjeta por
 * activo que concentra Deposit / Withdraw. El total del hero suma saldos +
 * posiciones a mercado + TRX valorado.
 *
 * Saldo mock (resetMockWallet): 250 USDT y 5 TRX.
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

  it('tiene una sola tarjeta por activo — sin una segunda versión duplicada', () => {
    renderWallet();
    expect(screen.getByTestId('balance-card-usdt')).toBeInTheDocument();
    expect(screen.getByTestId('balance-card-trx')).toBeInTheDocument();

    // Los paneles de withdrawal del pie repetían las mismas tarjetas en otro
    // tamaño; no van más.
    expect(screen.queryByTestId('withdraw-panels')).not.toBeInTheDocument();
    expect(screen.queryByTestId('withdraw-panel-usdt')).not.toBeInTheDocument();

    // Y la función sigue viva: exactamente un botón Withdraw por activo.
    expect(screen.getAllByRole('button', { name: 'Withdraw' })).toHaveLength(2);
  });

  it('el orden es: total, depósito, tarjetas', () => {
    renderWallet();
    const total = screen.getByTestId('wallet-total-balance');
    const deposit = screen.getByTestId('toggle-deposit');
    const usdtCard = screen.getByTestId('balance-card-usdt');

    expect(isBefore(total, deposit)).toBe(true);
    expect(isBefore(deposit, usdtCard)).toBe(true);
  });

  it('el botón Withdraw de cada tarjeta abre el modal con el activo correcto', () => {
    let opened = null;
    renderWallet({ onOpenWithdraw: (asset) => { opened = asset; } });

    fireEvent.click(screen.getByTestId('withdraw-trx-btn'));
    expect(opened).toBe('TRX');

    fireEvent.click(screen.getByTestId('withdraw-usdt-btn'));
    expect(opened).toBe('USDT');
  });
});

describe('Wallet — total balance', () => {
  beforeEach(() => resetMockWallet());
  afterEach(() => localStorage.clear());

  it('el total es el saldo USDT y el desglose no muestra el TRX', async () => {
    renderWallet();

    // Sin posiciones abiertas el total es el saldo libre: 250 USDT.
    await waitFor(() =>
      expect(screen.getByTestId('wallet-total-balance-amount')).toHaveTextContent('$250.00')
    );

    const breakdown = screen.getByTestId('portfolio-breakdown');
    expect(breakdown).toHaveTextContent('$250.00 USDT');
    // El TRX vive en su tarjeta de saldo, no debajo del total.
    expect(breakdown.textContent).not.toContain('TRX');
  });
});

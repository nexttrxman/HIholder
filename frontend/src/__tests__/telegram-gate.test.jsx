import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { shouldShowTelegramGate, TelegramGate } from '@/components/layout/TelegramGate';
import App from '@/App';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('shouldShowTelegramGate', () => {
  it('producción sin initData muestra la puerta', () => {
    expect(shouldShowTelegramGate({ isProd: true, initData: null })).toBe(true);
    expect(shouldShowTelegramGate({ isProd: true, initData: '' })).toBe(true);
    expect(shouldShowTelegramGate({ isProd: true, initData: undefined })).toBe(true);
  });

  it('producción con initData deja pasar a la app', () => {
    expect(shouldShowTelegramGate({ isProd: true, initData: 'user=1&hash=x' })).toBe(false);
  });

  it('dev sin initData NO muestra la puerta: el modo mock existe para desarrollar', () => {
    expect(shouldShowTelegramGate({ isProd: false, initData: null })).toBe(false);
    expect(shouldShowTelegramGate({ isProd: false, initData: undefined })).toBe(false);
  });
});

describe('TelegramGate', () => {
  it('no muestra ningún saldo inventado', () => {
    const { container } = render(<TelegramGate />);

    expect(screen.getByTestId('telegram-gate')).toBeTruthy();
    // MOCK_START_BALANCE es 250; si la puerta dejara ver la wallet mock, aparecería.
    expect(container.textContent).not.toContain('250');
    expect(screen.queryByTestId('home-total-balance')).toBeNull();
    expect(screen.queryByTestId('bottom-nav')).toBeNull();
  });

  it('el botón apunta al bot de Telegram', () => {
    render(<TelegramGate />);

    const link = screen.getByTestId('telegram-gate-link');
    expect((link.getAttribute('href') || '').startsWith('https://t.me/')).toBe(true);
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});

// initTelegram (services/api.js) llama ready(), expand(), setHeaderColor y
// setBackgroundColor. Un mock que solo trae initData revienta con
// "tg.ready is not a function" y el test falla por el motivo equivocado.
const mockTelegramWebApp = () => ({
  initData: 'user=1&hash=x',
  initDataUnsafe: { user: { id: 1, first_name: 'Test', username: 'test' } },
  ready: vi.fn(),
  expand: vi.fn(),
  setHeaderColor: vi.fn(),
  setBackgroundColor: vi.fn(),
  HapticFeedback: {
    impactOccurred: vi.fn(),
    notificationOccurred: vi.fn(),
    selectionChanged: vi.fn(),
  },
});

describe('App fuera de Telegram', () => {
  beforeEach(() => {
    delete window.Telegram;
  });

  it('en producción muestra la puerta y no monta la billetera', () => {
    vi.stubEnv('PROD', true);

    render(<App />);

    expect(screen.getByTestId('telegram-gate')).toBeTruthy();
    expect(screen.queryByTestId('bottom-nav')).toBeNull();
    expect(screen.queryByTestId('home-total-balance')).toBeNull();
  });
});

describe('App dentro de Telegram', () => {
  // El riesgo de regresión acá es el inverso: si la puerta apareciera con
  // initData presente, la app quedaría inutilizable para todos. Por eso la
  // aserción es que NO aparece; el resto del render lo cubren los otros suites.
  it('en producción con initData no muestra la puerta', () => {
    vi.stubEnv('PROD', true);
    window.Telegram = { WebApp: mockTelegramWebApp() };

    render(<App />);

    expect(screen.queryByTestId('telegram-gate')).toBeNull();
  });

  it('en desarrollo sin initData no muestra la puerta (modo mock)', () => {
    vi.stubEnv('PROD', false);

    render(<App />);

    expect(screen.queryByTestId('telegram-gate')).toBeNull();
  });
});

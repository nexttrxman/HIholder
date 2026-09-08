/**
 * La pantalla de "Connection Error" mostraba siempre el mismo texto, así que un
 * Worker sin deployar y un initData rechazado con 401 se veían idénticos. Estos
 * tests fijan que la causa real llegue a la UI.
 */
import { describe, it, expect } from 'vitest';

import {
  describeApiError,
  normalizeBaseUrl,
  requireWorkerUrl,
  MISSING_WORKER_URL,
} from '../services/api';

describe('describeApiError', () => {
  it('un fallo de red dice que no llega al backend y recuerda revisar la URL', () => {
    const msg = describeApiError(new TypeError('Failed to fetch'));
    expect(msg).toContain('Cannot reach the backend');
    expect(msg).toContain('VITE_WORKER_URL');
    // No se aserta la URL concreta: en los tests VITE_WORKER_URL no está seteado
    // y el mensaje debe degradar bien en vez de imprimir "at .".
  });

  it('un error con texto de red también se trata como inalcanzable', () => {
    expect(describeApiError(new Error('NetworkError when attempting to fetch'))).toContain(
      'Cannot reach the backend'
    );
    expect(describeApiError(new Error('Load failed'))).toContain('Cannot reach the backend');
  });

  it('un rechazo del Worker muestra el mensaje del servidor', () => {
    expect(describeApiError(new Error('Invalid initData'))).toBe(
      'Backend error: Invalid initData'
    );
    expect(describeApiError(new Error('Request failed: 500'))).toBe(
      'Backend error: Request failed: 500'
    );
  });

  it('no se rompe con valores raros', () => {
    expect(typeof describeApiError(undefined)).toBe('string');
    expect(typeof describeApiError(null)).toBe('string');
    expect(typeof describeApiError({})).toBe('string');
    expect(describeApiError('algo pasó')).toBe('Backend error: algo pasó');
  });
});

describe('normalizeBaseUrl', () => {
  // `${WORKER_URL}/auth` con una barra final arma '//auth', que el Worker no
  // reconoce: 404 "Not found" mientras /health responde perfecto.
  it.each([
    ['https://w.dev/', 'https://w.dev'],
    ['https://w.dev///', 'https://w.dev'],
    ['https://w.dev', 'https://w.dev'],
    ['https://w.dev/api/', 'https://w.dev/api'],
  ])('quita las barras finales de %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it('devuelve vacío para valores ausentes', () => {
    expect(normalizeBaseUrl(undefined)).toBe('');
    expect(normalizeBaseUrl(null)).toBe('');
    expect(normalizeBaseUrl('')).toBe('');
  });
});

describe('requireWorkerUrl', () => {
  // Antes un VITE_WORKER_URL ausente caía en un fallback hardcodeado a
  // tkworker.tkexchange.workers.dev: la app hablaba con un Worker distinto del
  // que se estaba configurando y devolvía Invalid initData sin ninguna pista.
  it('devuelve la URL cuando está', () => {
    expect(requireWorkerUrl('https://api.example')).toBe('https://api.example');
  });

  it('falla fuerte cuando falta, en vez de usar un Worker ajeno', () => {
    expect(() => requireWorkerUrl('')).toThrow(MISSING_WORKER_URL);
    expect(MISSING_WORKER_URL).toContain('VITE_WORKER_URL');
  });

  it('el mensaje llega a la pantalla sin prefijo confuso', () => {
    expect(describeApiError(new Error(MISSING_WORKER_URL))).toBe(MISSING_WORKER_URL);
    expect(describeApiError(new Error(MISSING_WORKER_URL))).not.toContain('Backend error:');
  });
});

describe('buildReferralLink', () => {
  it('con appName usa startapp, que es lo único que llega al initData', async () => {
    const { buildReferralLink } = await import('../services/api');
    expect(buildReferralLink('TK123', { botUrl: 'https://t.me/TKcex_bot', appName: 'keeper' })).toBe(
      'https://t.me/TKcex_bot/keeper?startapp=TK123'
    );
  });

  it('sin appName degrada a ?start= (le llega al bot, no a la Mini App)', async () => {
    const { buildReferralLink } = await import('../services/api');
    expect(buildReferralLink('TK123', { botUrl: 'https://t.me/TKcex_bot', appName: '' })).toBe(
      'https://t.me/TKcex_bot?start=TK123'
    );
  });

  it('saca la barra final del bot y codifica el uid', async () => {
    const { buildReferralLink } = await import('../services/api');
    expect(buildReferralLink('a b&c', { botUrl: 'https://t.me/bot/', appName: 'ap p' })).toBe(
      'https://t.me/bot/ap%20p?startapp=a%20b%26c'
    );
  });
});

/**
 * La pantalla de "Connection Error" mostraba siempre el mismo texto, así que un
 * Worker sin deployar y un initData rechazado con 401 se veían idénticos. Estos
 * tests fijan que la causa real llegue a la UI.
 */
import { describe, it, expect } from 'vitest';

import { describeApiError, normalizeBaseUrl } from '../services/api';

describe('describeApiError', () => {
  it('un fallo de red dice que no llega al backend y recuerda revisar la URL', () => {
    const msg = describeApiError(new TypeError('Failed to fetch'));
    expect(msg).toContain('Cannot reach the backend');
    expect(msg).toContain('VITE_WORKER_URL');
    expect(msg).toContain('http');
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

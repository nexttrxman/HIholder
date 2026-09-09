import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

import {
  DEFAULT_LANGUAGE,
  DICTIONARIES,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  dictionaryFor,
  isRtl,
  isSupported,
  normalizeKey,
  translateText,
} from '@/i18n';
import { LanguageProvider, useLanguage } from '@/i18n/LanguageProvider';
import { LanguageSwitcher } from '@/components/layout/LanguageSwitcher';

/**
 * Cadenas de alta visibilidad: si alguna desaparece de un diccionario, esa
 * etiqueta queda en inglés en producción.
 */
const MUST_HAVE = [
  'Total Balance', 'Home', 'Wallet', 'Trade', 'Missions', 'Invite',
  'Deposit', 'Withdraw', 'Balance', 'Hold to Earn', 'Claim Reward',
  'Take Profit', 'Stop Loss', 'Buy', 'Sell', 'Daily Check-In',
];

describe('diccionarios', () => {
  it('los seis idiomas están registrados', () => {
    expect(Object.keys(DICTIONARIES).sort()).toEqual(['ar', 'es', 'fa', 'pt', 'ru', 'zh']);
    expect(SUPPORTED_LANGUAGES.map((l) => l.code)).toEqual(
      ['en', 'es', 'pt', 'ru', 'zh', 'fa', 'ar']
    );
  });

  it('todos los diccionarios tienen exactamente las mismas claves que el español', () => {
    const reference = Object.keys(DICTIONARIES.es).sort();
    for (const [code, dict] of Object.entries(DICTIONARIES)) {
      const keys = Object.keys(dict).sort();
      const missing = reference.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !reference.includes(k));
      expect({ code, missing, extra }).toEqual({ code, missing: [], extra: [] });
    }
  });

  it('ninguna traducción queda vacía ni es igual al inglés por descuido', () => {
    for (const [code, dict] of Object.entries(DICTIONARIES)) {
      for (const [en, value] of Object.entries(dict)) {
        expect(value?.trim().length, `${code}: "${en}"`).toBeGreaterThan(0);
        // "Stop Loss" y "Take Profit" se usan igual en varios idiomas, así que
        // no se exige que TODO difiera: solo que no sea el diccionario entero.
      }
    }
    for (const [code, dict] of Object.entries(DICTIONARIES)) {
      const identical = Object.entries(dict).filter(([en, v]) => v === en).length;
      expect(identical, `${code} tiene demasiadas entradas sin traducir`).toBeLessThan(5);
    }
  });

  it('las cadenas de alta visibilidad están en los seis idiomas', () => {
    for (const code of Object.keys(DICTIONARIES)) {
      for (const key of MUST_HAVE) {
        expect(DICTIONARIES[code][key], `${code} -> ${key}`).toBeTruthy();
      }
    }
  });
});

describe('helpers', () => {
  it('inglés no tiene diccionario: no hay nada que traducir', () => {
    expect(dictionaryFor('en')).toBeNull();
    expect(dictionaryFor(DEFAULT_LANGUAGE)).toBeNull();
    expect(dictionaryFor('xx')).toBeNull();
  });

  it('traduce por coincidencia exacta y deja intacto lo que no conoce', () => {
    const dict = dictionaryFor('es');
    expect(translateText('Total Balance', dict)).toBe('Saldo total');
    expect(translateText('  Total   Balance ', dict)).toBe('Saldo total');
    expect(translateText('UQABC123', dict)).toBe('UQABC123');
    expect(translateText('12.50', dict)).toBe('12.50');
    expect(translateText('Total Balance', null)).toBe('Total Balance');
  });

  it('normalizeKey colapsa espacios sin tocar mayúsculas', () => {
    expect(normalizeKey('  Daily   Check-In ')).toBe('Daily Check-In');
    expect(normalizeKey('daily check-in')).toBe('daily check-in');
  });

  it('farsi y árabe son RTL; el resto no', () => {
    expect(isRtl('fa')).toBe(true);
    expect(isRtl('ar')).toBe(true);
    for (const code of ['en', 'es', 'pt', 'ru', 'zh']) expect(isRtl(code)).toBe(false);
    expect(isSupported('fa')).toBe(true);
    expect(isSupported('klingon')).toBe(false);
  });
});

// ============================================
// El traductor aplicado al DOM
// ============================================
function Probe() {
  const { language, dir } = useLanguage();
  return (
    <div>
      <h1>Total Balance</h1>
      <p>Daily Check-In</p>
      <span data-testid="code">{language}</span>
      <span data-testid="dir">{dir}</span>
      <span data-no-translate>Daily Check-In</span>
    </div>
  );
}

describe('LanguageProvider', () => {
  it('traduce el DOM al cambiar de idioma y restaura al volver a inglés', async () => {
    localStorage.clear();
    render(
      <LanguageProvider>
        <LanguageSwitcher />
        <Probe />
      </LanguageProvider>
    );

    expect(screen.getByRole('heading').textContent).toBe('Total Balance');
    expect(document.documentElement.dir).toBe('ltr');

    fireEvent.click(screen.getByTestId('language-switcher'));
    fireEvent.click(screen.getByTestId('language-option-es'));

    expect(await screen.findByText('Saldo total')).toBeTruthy();
    expect(screen.getByTestId('code').textContent).toBe('es');
    // Lo marcado como no traducible queda en inglés.
    expect(screen.getAllByText('Daily Check-In')).toHaveLength(1);
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es');

    fireEvent.click(screen.getByTestId('language-switcher'));
    fireEvent.click(screen.getByTestId('language-option-en'));

    expect(await screen.findByRole('heading')).toBeTruthy();
    expect(screen.getByRole('heading').textContent).toBe('Total Balance');
    expect(screen.getByTestId('dir').textContent).toBe('ltr');
  });

  it('farsi pone dir=rtl en el documento', async () => {
    localStorage.clear();
    render(
      <LanguageProvider>
        <LanguageSwitcher />
        <Probe />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByTestId('language-switcher'));
    fireEvent.click(screen.getByTestId('language-option-fa'));

    expect(await screen.findByTestId('dir')).toBeTruthy();
    expect(screen.getByTestId('dir').textContent).toBe('rtl');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('fa');
  });

  it('NO congela el texto que React actualiza (precio, etiqueta del par)', async () => {
    // Regresión del bug de Trade: apply() guardaba el "original" de TODOS los
    // nodos, incluso los no traducibles. Cuando React actualizaba el precio, el
    // observer lo comparaba contra ese original viejo y lo escribía de vuelta,
    // así que el precio y el selector de pares quedaban congelados.
    localStorage.clear();
    function LivePrice() {
      const [price, setPrice] = useState('1.39');
      return (
        <button type="button" data-testid="bump" onClick={() => setPrice((p) => (p === '1.39' ? '1.40' : '1.41'))}>
          <span data-testid="price">{price}</span>
        </button>
      );
    }
    function LiveLabel() {
      const [label, setLabel] = useState('Total Balance');
      return (
        <button type="button" data-testid="swap" onClick={() => setLabel('Balance')}>
          <span data-testid="label">{label}</span>
        </button>
      );
    }
    render(
      <LanguageProvider>
        <LanguageSwitcher />
        <LivePrice />
        <LiveLabel />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByTestId('language-switcher'));
    fireEvent.click(screen.getByTestId('language-option-es'));
    await act(async () => {});

    // Las lecturas van con waitFor a propósito: el traductor corre en un
    // requestAnimationFrame, así que una lectura sincrónica pasaría aunque el
    // observer todavía no hubiera tenido la chance de pisar el valor.
    const price = () => screen.getByTestId('price').textContent;
    const label = () => screen.getByTestId('label').textContent;

    await waitFor(() => expect(price()).toBe('1.39'));
    await waitFor(() => expect(label()).toBe('Saldo total'));

    // El precio no es traducible y tiene que seguir respondiendo a React.
    fireEvent.click(screen.getByTestId('bump'));
    await waitFor(() => expect(price()).toBe('1.40'));
    fireEvent.click(screen.getByTestId('bump'));
    await waitFor(() => expect(price()).toBe('1.41'));

    // Y un nodo que SÍ se traducía tiene que poder cambiar a otra cadena.
    fireEvent.click(screen.getByTestId('swap'));
    await waitFor(() => expect(label()).toBe('Saldo'));
  });

  it('recupera el idioma guardado', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ru');
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>
    );
    expect(screen.getByTestId('code').textContent).toBe('ru');
  });

  it('ignora un idioma inválido guardado', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'klingon');
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>
    );
    expect(screen.getByTestId('code').textContent).toBe('en');
  });
});

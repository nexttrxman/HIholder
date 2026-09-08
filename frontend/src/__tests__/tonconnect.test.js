/**
 * El claim se caía con "manifest not found" porque manifestUrl apuntaba a un
 * repo de terceros (raw.githubusercontent.com/AntipressTeam/...). Estos tests
 * fijan que el manifiesto se sirva desde el propio origen y que tenga la forma
 * que exige TonConnect.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildManifest,
  APP_NAME,
  ICON_PATH,
  DEV_APP_URL,
} from '../../tonconnect.manifest.js';

// En jsdom import.meta.url no es file://, así que se resuelve desde la raíz
// del proyecto (vitest corre con cwd = frontend/).
const appJsx = fs.readFileSync(path.resolve(process.cwd(), 'src/App.jsx'), 'utf8');

describe('manifiesto de TonConnect', () => {
  it('arma url, name e iconUrl a partir del origen del deploy', () => {
    expect(buildManifest('https://mi-app.pages.dev')).toEqual({
      url: 'https://mi-app.pages.dev',
      name: APP_NAME,
      iconUrl: `https://mi-app.pages.dev${ICON_PATH}`,
    });
  });

  it('recorta la barra final para no armar una url doble', () => {
    const m = buildManifest('https://mi-app.pages.dev///');
    expect(m.url).toBe('https://mi-app.pages.dev');
    expect(m.iconUrl).toBe(`https://mi-app.pages.dev${ICON_PATH}`);
  });

  it('el icono cuelga del mismo origen que la app', () => {
    const m = buildManifest('https://otro-dominio.com');
    expect(m.iconUrl.startsWith(m.url)).toBe(true);
  });

  it('los tres campos que exige TonConnect quedan no vacíos', () => {
    const m = buildManifest(DEV_APP_URL);
    for (const key of ['url', 'name', 'iconUrl']) {
      expect(typeof m[key]).toBe('string');
      expect(m[key].length).toBeGreaterThan(0);
    }
  });

  it('App.jsx pide el manifiesto al propio origen', () => {
    expect(appJsx).toContain('window.location.origin');
    expect(appJsx).toContain('/tonconnect-manifest.json');
  });

  it('App.jsx no vuelve a colgar el manifiesto de un host de terceros', () => {
    expect(appJsx).not.toMatch(/raw\.githubusercontent\.com/);
    expect(appJsx).not.toMatch(/AntipressTeam/);
    // manifestUrl no puede ser una URL absoluta escrita a mano
    expect(appJsx).not.toMatch(/manifestUrl\s*=\s*['"]https?:\/\//);
  });
});

/**
 * Manifiesto de TonConnect.
 *
 * TonConnect exige un JSON público con `url`, `name` e `iconUrl`: la wallet lo
 * descarga antes de conectar y, si no lo encuentra, aborta con "manifest not
 * found". Acá se genera desde el propio origen (ver el plugin
 * `tonconnectManifest` en vite.config.js) en vez de colgar de un host de
 * terceros, que es lo que rompía el claim.
 *
 * `url` debe ser el origen real donde vive la Mini App: las wallets móviles lo
 * usan para volver a la app después de aprobar la conexión. Se toma de
 * VITE_APP_URL al compilar.
 */

export const APP_NAME = 'TronKeeper';
export const ICON_PATH = '/tether.png';

/** @param {string} appUrl origen absoluto, sin barra final */
export function buildManifest(appUrl) {
  const base = String(appUrl || '').replace(/\/+$/, '');
  return {
    url: base,
    name: APP_NAME,
    iconUrl: `${base}${ICON_PATH}`,
  };
}

/** Qué se sirve cuando VITE_APP_URL no está definido. */
export const DEV_APP_URL = 'http://localhost:3000';

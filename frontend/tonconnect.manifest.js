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

/**
 * Origen de producción: el alias estable del proyecto en Cloudflare Pages.
 *
 * NO usar la URL con hash de un deploy puntual
 * (798d88f1.hiholder.pages.dev): cambia en cada deploy, y como las wallets
 * identifican la conexión por `url`, los usuarios tendrían que reconectar y el
 * manifiesto apuntaría a un deploy viejo. Se puede pisar con VITE_APP_URL si
 * más adelante se usa un dominio propio.
 */
export const PROD_APP_URL = 'https://hiholder.pages.dev';

/** Qué se sirve en dev/preview cuando VITE_APP_URL no está definido. */
export const DEV_APP_URL = 'http://localhost:3000';

/** @param {string} appUrl origen absoluto, sin barra final */
export function buildManifest(appUrl) {
  const base = String(appUrl || '').replace(/\/+$/, '');
  return {
    url: base,
    name: APP_NAME,
    iconUrl: `${base}${ICON_PATH}`,
  };
}


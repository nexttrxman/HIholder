import { TELEGRAM_BOT_URL } from '@/services/api';

/**
 * ¿Hay que mostrar la puerta de Telegram en vez de la app?
 *
 * La app es una Mini App: fuera de Telegram no tiene initData, y sin initData
 * `apiCall` (services/api.js) devuelve null sin hacer ningún pedido. El
 * resultado es que un visitante que abra el dominio en un navegador común ve la
 * app entera en modo mock, con un saldo falso de 250 USDT
 * (MOCK_START_BALANCE). No es un agujero de seguridad —nada llega al Worker y
 * el Worker exige initData firmado por HMAC en 14 handlers— pero es una
 * billetera inventada a la vista de cualquiera, indexable por Google y
 * capturable en una captura de pantalla.
 *
 * La puerta va FUERA de los providers a propósito: si WalletProvider y
 * TradeProvider no montan, no hay estado mock ni polling de precios.
 *
 * Solo aplica en build de producción. En `npm run dev` el modo mock sigue
 * disponible, que es para lo que existe.
 *
 * Función pura y exportada para poder testearla sin tocar import.meta.env.
 *
 * @param {{isProd: boolean, initData: string|null|undefined}} opts
 * @returns {boolean}
 */
export function shouldShowTelegramGate({ isProd, initData }) {
  return Boolean(isProd) && !initData;
}

export function TelegramGate() {
  return (
    <div
      data-testid="telegram-gate"
      className="min-h-screen flex flex-col items-center justify-center gap-6 px-6 text-center"
    >
      <div className="w-16 h-16 rounded-3xl bg-brand-teal/10 border border-brand-teal/25 flex items-center justify-center shadow-glow-teal">
        <span className="text-2xl" aria-hidden="true">🤖</span>
      </div>

      <div className="space-y-2 max-w-xs">
        <h1 className="text-xl font-semibold tracking-tight text-white">TronKeeper</h1>
        <p className="text-sm leading-relaxed text-white/60">
          This app runs inside Telegram. Open it from the bot to see your balance
          and start earning.
        </p>
      </div>

      <a
        href={TELEGRAM_BOT_URL}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="telegram-gate-link"
        className="px-6 py-3 rounded-2xl bg-brand-green text-black text-sm font-semibold shadow-glow-teal"
      >
        Open in Telegram
      </a>

      <p className="text-[11px] text-white/30 max-w-xs leading-relaxed">
        Nothing is displayed here on purpose: balances only exist inside your
        Telegram session.
      </p>
    </div>
  );
}

export default TelegramGate;

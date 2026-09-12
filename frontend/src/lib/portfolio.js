/**
 * Total del portafolio. Lo consumen Home y Wallet desde el mismo objeto, así
 * que las dos pantallas muestran el mismo número por construcción.
 *
 *   total = USDT libre + posiciones abiertas a mercado + TRX valorado en USD
 *
 * Las posiciones entran a valor de mercado (`qty * mark`), no por lo que
 * costaron: al abrir una el saldo USDT se debita por el costo, así que sumar
 * ambos no duplica nada y el PnL queda incorporado —una posición en pérdida
 * vale menos de lo que costó y por eso resta del total.
 *
 * El TRX se convierte con el mark de TRX/USDT. Si el feed no responde no se
 * inventa un precio: ese componente queda en 0 y `trxPrice` sale null para que
 * la UI pueda decir que falta, en vez de mostrar un total falso.
 */

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function computePortfolio({
  usdtBalance = 0,
  trxBalance = 0,
  trxPrice = null,
  keepBalance = 0,
  keepPrice = null,
  positionsValue = 0,
  unrealizedPnl = 0,
} = {}) {
  const usdt = Math.max(0, num(usdtBalance));
  const trades = Math.max(0, num(positionsValue));
  const pnl = num(unrealizedPnl);

  const price = Number(trxPrice);
  const hasTrxPrice = Number.isFinite(price) && price > 0;
  const trxAmount = Math.max(0, num(trxBalance));
  const trxUsd = hasTrxPrice ? trxAmount * price : 0;

  // $KEEP (v3.2): mismo trato que el TRX — si no hay precio manejado, ese
  // componente vale 0 y keepPrice sale null en vez de inventar un numero.
  const kPrice = Number(keepPrice);
  const hasKeepPrice = Number.isFinite(kPrice) && kPrice > 0;
  const keepAmount = Math.max(0, num(keepBalance));
  const keepUsd = hasKeepPrice ? keepAmount * kPrice : 0;

  return {
    total: usdt + trades + trxUsd + keepUsd,
    usdt,
    trades,
    pnl,
    trxAmount,
    trxPrice: hasTrxPrice ? price : null,
    trxUsd,
    keepAmount,
    keepPrice: hasKeepPrice ? kPrice : null,
    keepUsd,
  };
}

export default computePortfolio;

/**
 * Total del portafolio.
 *
 * Cuando se abre una posición el saldo USDT interno se debita por el costo
 * (notional + fee) y la posición pasa a valer `qty * mark`. Sumar el saldo y el
 * valor de mercado de las posiciones no duplica nada y arrastra el PnL: una
 * posición en pérdida vale menos de lo que costó, así que ya resta del total.
 *
 * El TRX entra convertido a USDT con el mark de TRX/USDT. Si no hay precio no se
 * inventa uno: queda afuera del total y se reporta aparte (`trxPrice: null`).
 */

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function computePortfolio({
  usdtBalance = 0,
  trxBalance = 0,
  trxPrice = null,
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

  return {
    total: usdt + trades + trxUsd,
    usdt,
    trades,
    pnl,
    trxAmount,
    trxPrice: hasTrxPrice ? price : null,
    trxUsd,
  };
}

export default computePortfolio;

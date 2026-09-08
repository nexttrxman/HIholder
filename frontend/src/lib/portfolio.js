/**
 * Total del portafolio.
 *
 * Cuando se abre una posición el saldo USDT interno se debita por el costo
 * (notional + fee) y la posición pasa a valer `qty * mark`. Sumar el saldo y el
 * valor de mercado de las posiciones no duplica nada y arrastra el PnL: una
 * posición en pérdida vale menos de lo que costó, así que ya resta del total.
 *
 * El TRX de la wallet queda AFUERA del total: es otra unidad, no USDT, y se
 * muestra por separado en su tarjeta de saldo. Mezclarlo exigiría un precio de
 * TRX y haría que el total dependiera de un feed que puede no responder.
 */

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function computePortfolio({ usdtBalance = 0, positionsValue = 0, unrealizedPnl = 0 } = {}) {
  const usdt = Math.max(0, num(usdtBalance));
  const trades = Math.max(0, num(positionsValue));

  return {
    total: usdt + trades,
    usdt,
    trades,
    pnl: num(unrealizedPnl),
  };
}

export default computePortfolio;

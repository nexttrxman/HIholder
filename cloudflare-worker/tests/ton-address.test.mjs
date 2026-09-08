/**
 * Tests de direcciones TON.
 *
 * Run with: node --test tests/ton-address.test.mjs
 *
 * Este es el bug que hizo que un claim pagado no se acreditara: TonConnect UI
 * entrega wallet.account.address en forma AMIGABLE ("UQ..."), TonCenter entrega
 * in_msg.source en forma CRUDA ("0:hex"), y normalizeTonAddress solo hacía
 * trim+lowercase. El tesoro recibía el TON y findValidTonPayment no matcheaba
 * nunca, así que el frontend agotaba sus 30 intentos y daba error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTonAddress,
  decodeFriendlyTonAddress,
  encodeFriendlyTonAddress,
  crc16Xmodem,
  findValidTonPayment,
  CONFIG,
} from '../lib.js';

// Dirección real del tesoro, tal como la devuelve /health en producción.
const TREASURY_FRIENDLY = CONFIG.TREASURY_WALLET;

const RAW_WC0 = '0:' + 'ab'.repeat(32);
const RAW_WC1 = '-1:' + 'cd'.repeat(32);

// ============================================
// crc16Xmodem
// ============================================

test('crc16Xmodem: vector conocido de CRC-16/XMODEM', () => {
  // "123456789" -> 0x31C3 es el check value estándar de CRC-16/XMODEM.
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crc16Xmodem(bytes), 0x31c3);
});

// ============================================
// La dirección real del tesoro (ancla externa)
// ============================================

test('la dirección del tesoro en producción decodifica con CRC válido', () => {
  assert.equal(TREASURY_FRIENDLY.length, 48);
  const raw = decodeFriendlyTonAddress(TREASURY_FRIENDLY);
  assert.ok(raw, 'una dirección real debería decodificar');
  assert.match(raw, /^(-1|0):[0-9a-f]{64}$/);
});

test('la dirección del tesoro no es bounceable (empieza en UQ)', () => {
  const raw = decodeFriendlyTonAddress(TREASURY_FRIENDLY);
  // UQ = tag 0x51 = non-bounceable. Si el layout estuviera mal, el CRC no
  // cerraría y el test anterior ya habría fallado.
  assert.equal(encodeFriendlyTonAddress(raw, { bounceable: false }), TREASURY_FRIENDLY);
});

// ============================================
// Round-trip
// ============================================

for (const raw of [RAW_WC0, RAW_WC1]) {
  test(`round-trip ${raw.slice(0, 3)}...`, () => {
    const friendly = encodeFriendlyTonAddress(raw);
    assert.equal(friendly.length, 48);
    assert.equal(decodeFriendlyTonAddress(friendly), raw);
  });

  test(`bounceable y non-bounceable del mismo raw normalizan igual (${raw.slice(0, 3)})`, () => {
    const b = encodeFriendlyTonAddress(raw, { bounceable: true });
    const nb = encodeFriendlyTonAddress(raw, { bounceable: false });
    assert.notEqual(b, nb);
    assert.equal(normalizeTonAddress(b), normalizeTonAddress(nb));
    assert.equal(normalizeTonAddress(b), raw);
  });
}

test('el tag de testnet también se acepta', () => {
  const t = encodeFriendlyTonAddress(RAW_WC0, { testnet: true });
  assert.notEqual(t, encodeFriendlyTonAddress(RAW_WC0));
  assert.equal(normalizeTonAddress(t), RAW_WC0);
});

// ============================================
// Rechazos
// ============================================

test('un CRC roto se rechaza', () => {
  const friendly = encodeFriendlyTonAddress(RAW_WC0);
  const corrupt = (friendly[0] === 'A' ? 'B' : 'A') + friendly.slice(1);
  assert.equal(decodeFriendlyTonAddress(corrupt), null);
});

test('basura no rompe ni lanza', () => {
  assert.equal(decodeFriendlyTonAddress(''), null);
  assert.equal(decodeFriendlyTonAddress('no-es-una-direccion'), null);
  assert.equal(decodeFriendlyTonAddress('A'.repeat(48)), null);
  assert.equal(decodeFriendlyTonAddress(null), null);
  assert.equal(decodeFriendlyTonAddress(42), null);
  // normalizeTonAddress degrada a trim+lowercase en vez de tirar.
  assert.equal(normalizeTonAddress('  Algo Raro '), 'algo raro');
  assert.equal(normalizeTonAddress(''), '');
  assert.equal(normalizeTonAddress(null), '');
});

test('una dirección cruda se canonicaliza (mayúsculas y espacios)', () => {
  assert.equal(normalizeTonAddress(`  ${RAW_WC0.toUpperCase()} `), RAW_WC0);
});

// ============================================
// La regresión que importaba: end-to-end
// ============================================

function txFrom({ source, value, comment, utime, hash }) {
  return {
    transaction_id: { hash, lt: '1' },
    utime,
    in_msg: {
      source,
      value: String(value),
      message: comment,
    },
  };
}

test('findValidTonPayment matchea un pago aunque el wallet venga en forma amigable', async () => {
  const claimId = 'CLM_TEST_1';
  const friendly = encodeFriendlyTonAddress(RAW_WC0, { bounceable: false });

  const payment = await findValidTonPayment({
    // Lo que manda TonConnect UI: forma amigable.
    senderAddress: friendly,
    claimId,
    minAmountNano: 50_000_000,
    earliestUtime: 1000,
    // Lo que devuelve TonCenter: forma cruda.
    txsOverride: [
      txFrom({
        source: RAW_WC0,
        value: 50_000_000,
        comment: `CLAIM:${claimId}`,
        utime: 2000,
        hash: 'TXHASH1',
      }),
    ],
  });

  assert.ok(payment, 'antes de la conversión esto devolvía null siempre');
  assert.equal(payment.tx_hash, 'TXHASH1');
  assert.equal(payment.amount_nano, 50_000_000);
});

test('findValidTonPayment sigue rechazando un remitente distinto', async () => {
  const claimId = 'CLM_TEST_2';
  const otro = encodeFriendlyTonAddress('0:' + 'ff'.repeat(32));

  const payment = await findValidTonPayment({
    senderAddress: otro,
    claimId,
    minAmountNano: 50_000_000,
    earliestUtime: 1000,
    txsOverride: [
      txFrom({
        source: RAW_WC0,
        value: 50_000_000,
        comment: `CLAIM:${claimId}`,
        utime: 2000,
        hash: 'TXHASH2',
      }),
    ],
  });

  assert.equal(payment, null);
});

test('findValidTonPayment acepta que el wallet venga en forma cruda', async () => {
  const claimId = 'CLM_TEST_3';
  const payment = await findValidTonPayment({
    senderAddress: RAW_WC0,
    claimId,
    minAmountNano: 50_000_000,
    earliestUtime: 1000,
    txsOverride: [
      txFrom({
        source: encodeFriendlyTonAddress(RAW_WC0),
        value: 60_000_000,
        comment: `CLAIM:${claimId}`,
        utime: 2000,
        hash: 'TXHASH3',
      }),
    ],
  });
  assert.ok(payment, 'el source on-chain también puede venir amigable');
  assert.equal(payment.tx_hash, 'TXHASH3');
});

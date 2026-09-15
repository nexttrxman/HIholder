/**
 * Tests de validateInitData: la puerta de entrada de toda la app.
 *
 * Run with: node --test tests/auth.test.mjs
 *
 * validateInitData es lo único que separa a un usuario del saldo de otro: si
 * acepta un initData que no firmó Telegram, cualquiera se hace pasar por
 * cualquiera. Estos tests firman initData reales con el algoritmo de Telegram
 * (HMAC-SHA256 de "WebAppData" + botToken sobre el data_check_string) y
 * verifican tanto lo que debe pasar como lo que debe rebotar.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateInitData, CONFIG } from '../lib.js';

const BOT_TOKEN = '123456789:TESTTOKENTESTTOKENTESTTOKEN';
const USER = { id: 555000111, first_name: 'Ana', username: 'ana', language_code: 'es' };

/** Firma un initData exactamente como lo hace Telegram. */
async function signInitData(fields, botToken = BOT_TOKEN) {
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const enc = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    'raw', enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const secret = await crypto.subtle.sign('HMAC', secretKey, enc.encode(botToken));
  const dataKey = await crypto.subtle.importKey(
    'raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', dataKey, enc.encode(dataCheckString));
  const hash = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');

  const qs = new URLSearchParams(fields);
  qs.set('hash', hash);
  return qs.toString();
}

const freshInitData = (ageSeconds = 0) =>
  signInitData({
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify(USER),
    auth_date: String(Math.floor(Date.now() / 1000) - ageSeconds),
    start_param: 'ref_1',
    chat_type: 'private',
    chat_instance: '888',
  });

test('acepta un initData válido y reciente', async () => {
  const user = await validateInitData(await freshInitData(0), BOT_TOKEN);
  assert.ok(user, 'debería devolver el usuario');
  assert.equal(user.id, USER.id);
  assert.equal(user.username, 'ana');
});

test('rechaza un initData sin hash', async () => {
  const qs = new URLSearchParams({ user: JSON.stringify(USER), auth_date: '1' });
  assert.equal(await validateInitData(qs.toString(), BOT_TOKEN), null);
});

test('rechaza un user manipulado (la firma ata la identidad)', async () => {
  const signed = await freshInitData();
  // Cambia el id del usuario sin volver a firmar: la firma ya no cierra.
  const stolen = signed.replace(
    `user=${encodeURIComponent(JSON.stringify(USER))}`,
    `user=${encodeURIComponent(JSON.stringify({ ...USER, id: 999999999 }))}`
  );
  assert.notEqual(stolen, signed, 'el reemplazo tiene que haber cambiado algo');
  assert.equal(await validateInitData(stolen, BOT_TOKEN), null);
});

test('rechaza un initData firmado con otro bot token', async () => {
  const signed = await freshInitData(0);
  assert.equal(await validateInitData(signed, '999:OTTRO_TOKEN_DISTINTO'), null);
});

test('rechaza basura, vacío y null', async () => {
  assert.equal(await validateInitData(null, BOT_TOKEN), null);
  assert.equal(await validateInitData('', BOT_TOKEN), null);
  assert.equal(await validateInitData('no-es-un-init-data', BOT_TOKEN), null);
  assert.equal(await validateInitData(await freshInitData(0), ''), null);
});

// --- Freshness (anti-replay) ----------------------------------------------

test('rechaza un initData viejo: un initData capturado no sirve para siempre', async () => {
  const stale = await freshInitData(CONFIG.AUTH_MAX_AGE_SECONDS + 3600);
  assert.equal(await validateInitData(stale, BOT_TOKEN), null);
});

test('acepta uno justo en el límite de la ventana', async () => {
  const edge = await freshInitData(CONFIG.AUTH_MAX_AGE_SECONDS - 5);
  const user = await validateInitData(edge, BOT_TOKEN);
  assert.ok(user, 'dentro de la ventana debe pasar');
  assert.equal(user.id, USER.id);
});

test('la ventana es configurable y se inyecta el reloj', async () => {
  const fixed = 1_800_000_000_000; // ms
  const initData = await signInitData({
    user: JSON.stringify(USER),
    auth_date: String(Math.floor(fixed / 1000) - 10),
  });
  const user = await validateInitData(initData, BOT_TOKEN, { now: fixed });
  assert.equal(user.id, USER.id);

  // Mismo payload, reloj 25 h adelante -> fuera de la ventana de 24 h
  const later = await validateInitData(initData, BOT_TOKEN, {
    now: fixed + 25 * 3600 * 1000,
  });
  assert.equal(later, null);

  // ...y con una ventana más grande vuelve a pasar: lo que rechaza es la edad
  const relaxed = await validateInitData(initData, BOT_TOKEN, {
    now: fixed + 25 * 3600 * 1000,
    maxAgeSeconds: 48 * 3600,
  });
  assert.equal(relaxed.id, USER.id);
});

test('rechaza auth_date ausente o no numérico', async () => {
  const sinFecha = await signInitData({ user: JSON.stringify(USER) });
  assert.equal(await validateInitData(sinFecha, BOT_TOKEN), null);

  const fechaRara = await signInitData({
    user: JSON.stringify(USER),
    auth_date: 'ayer',
  });
  assert.equal(await validateInitData(fechaRara, BOT_TOKEN), null);
});

test('la ventana por defecto es de 24 horas', () => {
  assert.equal(CONFIG.AUTH_MAX_AGE_SECONDS, 24 * 60 * 60);
});

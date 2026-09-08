/**
 * Tests de bots mirror: la app publicada bajo varios bots contra un solo backend.
 *
 * Run with: node --test tests/mirrors.test.mjs
 *
 * Telegram firma el initData con el token del bot desde el que se abrió la Mini
 * App. Con un único BOT_TOKEN, el segundo bot da 401 "Invalid initData" aunque
 * todo lo demás esté bien. Estos tests cubren la lista de tokens y, sobre todo,
 * que la ventana anti-replay NO se pierda al pasar por el camino multi-token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBotTokens, validateInitData, validateInitDataAny, CONFIG } from '../lib.js';
import worker from '../worker.js';

const TOKEN_MAIN = '111111111:TKCEXMAINBOTMAINBOTMAINBOT';
const TOKEN_MIRROR = '222222222:KEEPERTRADEMIRRORMIRRORMIR';
const TOKEN_ALIEN = '333333333:ALIENTOKENALIENTOKENALIENT';

const USER = { id: 555000111, first_name: 'Ana', username: 'ana', language_code: 'es' };

/** Firma un initData exactamente como lo hace Telegram. */
async function signInitData(fields, botToken) {
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

const freshFields = () => ({
  query_id: 'AAH',
  auth_date: String(Math.floor(Date.now() / 1000)),
  user: JSON.stringify(USER),
});

// ============================================
// parseBotTokens
// ============================================

test('parseBotTokens separa por coma', () => {
  assert.deepEqual(parseBotTokens(`${TOKEN_MAIN},${TOKEN_MIRROR}`), [TOKEN_MAIN, TOKEN_MIRROR]);
});

test('parseBotTokens separa por espacio y salto de línea', () => {
  assert.deepEqual(parseBotTokens(`${TOKEN_MAIN}\n${TOKEN_MIRROR}`), [TOKEN_MAIN, TOKEN_MIRROR]);
  assert.deepEqual(parseBotTokens(`${TOKEN_MAIN} ${TOKEN_MIRROR}`), [TOKEN_MAIN, TOKEN_MIRROR]);
});

test('parseBotTokens recorta y descarta vacíos (coma final, comas dobles)', () => {
  assert.deepEqual(parseBotTokens(` ${TOKEN_MAIN} , ,${TOKEN_MIRROR}, `), [
    TOKEN_MAIN,
    TOKEN_MIRROR,
  ]);
});

test('parseBotTokens no duplica', () => {
  assert.deepEqual(parseBotTokens(`${TOKEN_MAIN},${TOKEN_MAIN}`), [TOKEN_MAIN]);
});

test('parseBotTokens acepta un array', () => {
  assert.deepEqual(parseBotTokens([TOKEN_MAIN, ` ${TOKEN_MIRROR} `, '']), [
    TOKEN_MAIN,
    TOKEN_MIRROR,
  ]);
});

test('parseBotTokens devuelve lista vacía para valores ausentes', () => {
  assert.deepEqual(parseBotTokens(undefined), []);
  assert.deepEqual(parseBotTokens(null), []);
  assert.deepEqual(parseBotTokens(''), []);
  assert.deepEqual(parseBotTokens('   ,,  '), []);
});

test('parseBotTokens con un solo token sigue siendo una lista de uno', () => {
  assert.deepEqual(parseBotTokens(TOKEN_MAIN), [TOKEN_MAIN]);
});

// ============================================
// validateInitDataAny
// ============================================

test('acepta el initData del bot principal cuando está listado segundo', async () => {
  const initData = await signInitData(freshFields(), TOKEN_MAIN);
  const user = await validateInitDataAny(initData, `${TOKEN_MIRROR},${TOKEN_MAIN}`);
  assert.equal(user?.id, USER.id);
});

test('acepta el initData del mirror cuando está listado primero', async () => {
  const initData = await signInitData(freshFields(), TOKEN_MIRROR);
  const user = await validateInitDataAny(initData, `${TOKEN_MAIN},${TOKEN_MIRROR}`);
  assert.equal(user?.id, USER.id);
});

test('un solo token sigue funcionando igual que antes', async () => {
  const initData = await signInitData(freshFields(), TOKEN_MAIN);
  const user = await validateInitDataAny(initData, TOKEN_MAIN);
  assert.equal(user?.id, USER.id);
});

test('rechaza un initData firmado por un bot que no está en la lista', async () => {
  const initData = await signInitData(freshFields(), TOKEN_ALIEN);
  assert.equal(await validateInitDataAny(initData, `${TOKEN_MAIN},${TOKEN_MIRROR}`), null);
});

test('rechaza cuando la lista está vacía o el secret no existe', async () => {
  const initData = await signInitData(freshFields(), TOKEN_MAIN);
  assert.equal(await validateInitDataAny(initData, ''), null);
  assert.equal(await validateInitDataAny(initData, undefined), null);
});

test('rechaza si falta el initData', async () => {
  assert.equal(await validateInitDataAny('', `${TOKEN_MAIN},${TOKEN_MIRROR}`), null);
  assert.equal(await validateInitDataAny(undefined, TOKEN_MAIN), null);
});

test('tolera espacios y comas sueltas en el secret', async () => {
  const initData = await signInitData(freshFields(), TOKEN_MIRROR);
  const user = await validateInitDataAny(initData, ` ${TOKEN_MAIN} ,\n ${TOKEN_MIRROR} , `);
  assert.equal(user?.id, USER.id);
});

// ============================================
// La ventana anti-replay no se pierde en el camino multi-token
// ============================================

test('un initData expirado se rechaza aunque el bot sea válido', async () => {
  const fields = {
    ...freshFields(),
    auth_date: String(Math.floor(Date.now() / 1000) - (CONFIG.AUTH_MAX_AGE_SECONDS + 60)),
  };
  const initData = await signInitData(fields, TOKEN_MIRROR);
  assert.equal(await validateInitDataAny(initData, `${TOKEN_MAIN},${TOKEN_MIRROR}`), null);
});

test('la ventana de 24 h se aplica igual por el camino multi-token', async () => {
  const authDate = Math.floor(Date.now() / 1000) - 3600; // hace 1 hora
  const initData = await signInitData({ ...freshFields(), auth_date: String(authDate) }, TOKEN_MIRROR);

  // auth_date de hace 1 h: con now real está dentro de la ventana de 24 h,
  // con un now 25 h después del auth_date ya no.
  assert.notEqual(await validateInitDataAny(initData, `${TOKEN_MAIN},${TOKEN_MIRROR}`), null);
  assert.equal(
    await validateInitDataAny(initData, `${TOKEN_MAIN},${TOKEN_MIRROR}`, {
      now: (authDate + 25 * 3600) * 1000,
    }),
    null
  );
  // Y 23 h después todavía pasa: el corte es exactamente la ventana.
  assert.notEqual(
    await validateInitDataAny(initData, `${TOKEN_MAIN},${TOKEN_MIRROR}`, {
      now: (authDate + 23 * 3600) * 1000,
    }),
    null
  );
});

test('el camino multi-token y el de un solo token deciden lo mismo', async () => {
  const initData = await signInitData(freshFields(), TOKEN_MAIN);
  const single = await validateInitData(initData, TOKEN_MAIN);
  const multi = await validateInitDataAny(initData, TOKEN_MAIN);
  assert.deepEqual(single, multi);
});

// ============================================
// Punta a punta: los 12 handlers de worker.js usan el camino multi-token
// ============================================

const SUPA_ENV = { SUPA_URL: 'https://invalid.test', SUPA_SERVICE_KEY: 'sk', TON_API_KEY: 'tk' };

async function postAuth(initData, botToken) {
  const res = await worker.fetch(
    new Request('https://api.example/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    }),
    { BOT_TOKEN: botToken, ...SUPA_ENV }
  );
  return res.status;
}

test('POST /auth acepta el initData del mirror cuando está en BOT_TOKEN', async () => {
  const initData = await signInitData(freshFields(), TOKEN_MIRROR);
  // Supabase no existe acá, así que el handler sigue y revienta después: lo que
  // importa es que YA NO es 401, o sea que pasó la puerta de autenticación.
  assert.notEqual(await postAuth(initData, `${TOKEN_MAIN},${TOKEN_MIRROR}`), 401);
});

test('POST /auth rechaza el mirror si BOT_TOKEN tiene solo el bot principal', async () => {
  const initData = await signInitData(freshFields(), TOKEN_MIRROR);
  assert.equal(await postAuth(initData, TOKEN_MAIN), 401);
});

test('POST /auth sigue aceptando el bot principal con un solo token', async () => {
  const initData = await signInitData(freshFields(), TOKEN_MAIN);
  assert.notEqual(await postAuth(initData, TOKEN_MAIN), 401);
});

test('un handler que revienta devuelve 500 CON headers CORS', async () => {
  const initData = await signInitData(freshFields(), TOKEN_MAIN);
  const res = await worker.fetch(
    new Request('https://api.example/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    }),
    { BOT_TOKEN: TOKEN_MAIN, ...SUPA_ENV }
  );

  // La autenticación pasó y el handler reventó al llamar a Supabase, que acá no
  // existe. Antes del `return await` esa promesa rechazada escapaba del try/catch
  // del fetch: Cloudflare respondía su propio error, sin Access-Control-Allow-
  // Origin, y el navegador no podía leer el cuerpo. Es lo que 90003c1 quiso
  // arreglar y no arreglaba.
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

/**
 * Tests del endpoint /health.
 *
 * Run with: node --test tests/health.test.mjs
 *
 * 'Invalid initData' (401) se devuelve igual cuando BOT_TOKEN falta, cuando está
 * mal escrito y cuando es de otro bot: validateInitData devuelve null en los
 * tres casos y el handler no distingue. /health reporta qué variables están
 * presentes para que eso se pueda diagnosticar desde afuera, así que este test
 * fija dos cosas: que reporte la presencia correcta y que NUNCA filtre valores.
 *
 * /health es público (no pide initData), así que además fija que NO enumere los
 * nombres del entorno: eso era un mapa gratis del runtime para cualquier
 * scanner. El caso del nombre mal escrito se diagnostica en el dashboard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker.js';

const FULL_ENV = {
  BOT_TOKEN: '123456789:AA-secret-token',
  SUPA_URL: 'https://abc.supabase.co',
  SUPA_SERVICE_KEY: 'eyJ-service-key',
  TON_API_KEY: 'toncenter-key',
};

async function health(env) {
  const res = await worker.fetch(new Request('https://api.example/health'), env);
  assert.equal(res.status, 200);
  return res.json();
}

test('GET /health reporta la versión y las variables presentes', async () => {
  const body = await health(FULL_ENV);

  assert.equal(body.ok, true);
  assert.equal(body.service, 'TronKeeper API');
  assert.equal(body.version, '2.8.1');
  assert.deepEqual(body.env, {
    BOT_TOKEN: true,
    SUPA_URL: true,
    SUPA_SERVICE_KEY: true,
    TON_API_KEY: true,
  });
});

test('GET /health marca en false lo que falta, sin romper', async () => {
  const body = await health({ BOT_TOKEN: 'tok' });

  assert.deepEqual(body.env, {
    BOT_TOKEN: true,
    SUPA_URL: false,
    SUPA_SERVICE_KEY: false,
    TON_API_KEY: false,
  });
});

test('GET /health con env vacío sigue respondiendo 200 y todo en false', async () => {
  const body = await health({});

  assert.equal(body.ok, true);
  assert.deepEqual(body.env, {
    BOT_TOKEN: false,
    SUPA_URL: false,
    SUPA_SERVICE_KEY: false,
    TON_API_KEY: false,
  });
});

test('GET /health no filtra el valor de ningún secreto', async () => {
  const res = await worker.fetch(new Request('https://api.example/health'), FULL_ENV);
  const raw = await res.text();

  for (const secret of Object.values(FULL_ENV)) {
    assert.equal(raw.includes(secret), false, `se filtró ${secret}`);
  }
  // Los booleanos, no los strings.
  assert.equal(raw.includes('"BOT_TOKEN":true'), true);
});

test('GET / es un alias de /health', async () => {
  const res = await worker.fetch(new Request('https://api.example/'), FULL_ENV);
  const body = await res.json();
  assert.equal(body.version, '2.8.1');
  assert.equal(body.env.BOT_TOKEN, true);
});

test('una ruta POST desconocida sigue dando 404 "Not found"', async () => {
  const res = await worker.fetch(
    new Request('https://api.example//auth', { method: 'POST', body: '{}' }),
    FULL_ENV
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

// ============================================
// /health es PUBLICO: no debe enumerar el entorno
// ============================================

test('GET /health no lista los nombres de las variables del runtime', async () => {
  const res = await worker.fetch(new Request('https://api.example/health'), {
    ...FULL_ENV,
    MI_KV: {},
    OTRA_COSA: '1',
  });
  // Leer el texto primero: una vez consumido el body no se puede clonar.
  const raw = await res.text();

  // Acá iba `envKeys: Object.keys(env)`. Como /health no pide initData, listaba
  // el entorno entero a cualquiera que lo pidiera, incluidos los bindings
  // internos de Cloudflare que no son de la app.
  assert.equal(raw.includes('envKeys'), false, 'sigue exponiendo envKeys');
  assert.equal(raw.includes('MI_KV'), false, 'se filtró un binding ajeno');
  assert.equal(raw.includes('OTRA_COSA'), false, 'se filtró un binding ajeno');

  // Los booleanos sí quedan: alcanzan para saber si algo está configurado.
  assert.deepEqual(JSON.parse(raw).env, {
    BOT_TOKEN: true,
    SUPA_URL: true,
    SUPA_SERVICE_KEY: true,
    TON_API_KEY: true,
  });

  for (const secret of Object.values(FULL_ENV)) {
    assert.equal(raw.includes(secret), false, `se filtró ${secret}`);
  }
});

test('GET /health no delata un nombre mal escrito', async () => {
  // Un espacio de más o minúsculas dan BOT_TOKEN: false, idéntico a no haberlo
  // cargado. Antes envKeys mostraba la diferencia desde internet; ahora no.
  const res = await worker.fetch(
    new Request('https://api.example/health'),
    { 'BOT_TOKEN ': 'x', bot_token: 'y' },
  );
  const raw = await res.text();

  assert.equal(JSON.parse(raw).env.BOT_TOKEN, false);
  assert.equal(raw.includes('bot_token'), false, 'se filtró el nombre mal escrito');
  assert.equal(raw.includes('BOT_TOKEN '), false, 'se filtró el nombre mal escrito');
});

// ============================================
// Headers de seguridad
// ============================================

test('las respuestas JSON llevan los headers de seguridad', async () => {
  const res = await worker.fetch(new Request('https://api.example/health'), FULL_ENV);

  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  // Saldos y posiciones: que no los guarde ninguna caché.
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('las respuestas de error también llevan los headers', async () => {
  const res = await worker.fetch(new Request('https://api.example/no-existe'), FULL_ENV);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('NO se setea X-Frame-Options: la app corre en un iframe en Telegram Web', async () => {
  // X-Frame-Options solo sabe DENY o SAMEORIGIN, no tiene allowlist: ponerlo
  // bloquearía la app en web.telegram.org. El equivalente que sí permite
  // listar orígenes es `frame-ancestors`, y se configura en
  // frontend/public/_headers porque aplica al HTML, no a esta API.
  for (const url of ['https://api.example/health', 'https://api.example/no-existe']) {
    const res = await worker.fetch(new Request(url), FULL_ENV);
    assert.equal(res.headers.get('X-Frame-Options'), null);
  }
});

test('una ruta de scanner de configuración da 404 genérico, sin eco de la ruta', async () => {
  // Lo que busca un bot que barre rutas: .env, .git/config, wp-login.php...
  // La respuesta no debe revelar nada sobre el sistema de archivos ni sobre
  // qué rutas sí existen, ni repetir la ruta pedida (eso permite inyectar).
  for (const p of ['/.env', '/.git/config', '/wp-login.php', '/phpinfo.php', '/config.json']) {
    const res = await worker.fetch(new Request(`https://api.example${p}`), FULL_ENV);
    assert.equal(res.status, 404, `${p} no dio 404`);
    assert.equal(res.headers.get('Content-Type'), 'application/json');

    const raw = await res.text();
    assert.equal(raw, JSON.stringify({ error: 'Not found' }), `${p} dio ${raw}`);
    assert.equal(raw.includes(p), false, `${p}: la respuesta hace eco de la ruta`);
  }
});

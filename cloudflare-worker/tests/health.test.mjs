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
  assert.equal(body.version, '2.6.0');
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
  assert.equal(body.version, '2.6.0');
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

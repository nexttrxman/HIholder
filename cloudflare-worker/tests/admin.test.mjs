/**
 * Tests del modulo /admin (v3.3): cola de misiones manuales + retiros.
 *
 * Run with: node --test tests/admin.test.mjs
 *
 * El admin entra desde un navegador comun (fuera de Telegram), asi que NO usa
 * initData: autentica con el secreto ADMIN_TOKEN via header x-admin-token.
 * Estos tests fijan la capa de seguridad: sin token configurado el modulo
 * esta apagado (503) y con token mal/ausente nadie pasa (401). Las rutas con
 * credencial valida llegan a la base y se cubren en supabase/tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker.js';

const ENV = {
  BOT_TOKEN: '123456789:AA-secret-token',
  SUPA_URL: 'https://abc.supabase.co',
  SUPA_SERVICE_KEY: 'eyJ-service-key',
  ADMIN_TOKEN: 'admin-secret',
};

const post = (path, env, token) =>
  worker.fetch(new Request(`https://api.example${path}`, {
    method: 'POST',
    headers: token == null ? {} : { 'x-admin-token': token },
    body: '{}',
  }), env);

for (const path of ['/admin/missions/list', '/admin/missions/approve', '/admin/missions/reject',
                    '/admin/withdrawals/list', '/admin/withdrawals/resolve']) {
  test(`${path} sin ADMIN_TOKEN configurado responde 503`, async () => {
    const res = await post(path, { ...ENV, ADMIN_TOKEN: undefined }, 'admin-secret');
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'Admin not configured' });
  });

  test(`${path} sin header responde 401`, async () => {
    const res = await post(path, ENV, null);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'Unauthorized' });
  });

  test(`${path} con token equivocado responde 401`, async () => {
    const res = await post(path, ENV, 'otro-token');
    assert.equal(res.status, 401);
  });
}

test('una ruta /admin/* inexistente da el 404 generico (sin revelar el namespace)', async () => {
  // /admin/nada NO esta en el switch: cae al 404 comun, igual que cualquier
  // ruta desconocida. handleAdmin solo existe para las 5 rutas reales.
  const res = await post('/admin/nada', ENV, 'admin-secret');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

test('el token admin nunca se filtra en las respuestas', async () => {
  const res = await post('/admin/missions/list', ENV, 'mal');
  const raw = await res.text();
  assert.equal(raw.includes('admin-secret'), false);
});

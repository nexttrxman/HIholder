/**
 * Tests de extractStartParam: de dónde sale el uid del referente.
 *
 * Run with: node --test tests/referral.test.mjs
 *
 * Telegram pone el valor de ?startapp=<uid> en start_param dentro del initData.
 * Sin eso el Worker no sabe quién trajo al usuario y el referido no se registra
 * nunca — que es exactamente por lo que la tabla referrals estaba siempre vacía.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractStartParam, REFERRAL_CONFIG } from '../lib.js';

test('saca start_param de un initData', () => {
  const initData = new URLSearchParams({
    query_id: 'AAH',
    user: '{"id":42}',
    auth_date: '1700000000',
    start_param: 'TK99887766',
    hash: 'abc',
  }).toString();

  assert.equal(extractStartParam(initData), 'TK99887766');
});

test('devuelve vacío cuando no hay start_param', () => {
  const initData = new URLSearchParams({ user: '{"id":42}', hash: 'abc' }).toString();
  assert.equal(extractStartParam(initData), '');
});

test('devuelve vacío con start_param vacío', () => {
  const initData = new URLSearchParams({ start_param: '', hash: 'abc' }).toString();
  assert.equal(extractStartParam(initData), '');
});

test('no lanza con entradas raras', () => {
  assert.equal(extractStartParam(''), '');
  assert.equal(extractStartParam(null), '');
  assert.equal(extractStartParam(undefined), '');
  assert.equal(extractStartParam(42), '');
  assert.equal(extractStartParam('no=es&valido%%%'), '');
});

test('un uid con caracteres especiales viaja codificado y llega entero', () => {
  const initData = new URLSearchParams({ start_param: 'TK 12/34' }).toString();
  assert.equal(extractStartParam(initData), 'TK 12/34');
});

test('la recompensa coincide con el esquema y con la UI', () => {
  // referrals.reward_amount DEFAULT 2 / reward_asset 'TRX', y la UI dice
  // "Earn 2 TRX for each friend who joins".
  assert.equal(REFERRAL_CONFIG.REWARD_TRX, 2);
  assert.equal(REFERRAL_CONFIG.REWARD_ASSET, 'TRX');
});

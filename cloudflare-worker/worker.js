/**
 * TronKeeper Cloudflare Worker - TON Claims + Simulated Trade (v2.4)
 *
 * Environment Variables (Secrets):
 * - BOT_TOKEN: Telegram Bot Token
 * - SUPA_URL: Supabase project URL
 * - SUPA_SERVICE_KEY: Supabase service role key
 * - TON_API_KEY: TON Center API key (recommended for higher rate limits)
 *
 * Trade endpoints (/trade, /trade/close, /positions) mark positions against the
 * public Binance ticker, so no extra secret is needed.
 *
 * Treasury Wallet (V5): UQCydneDGeAcamdCFS6e13Z2xoxwA5DsLkFONRdp-cavw-Th
 */

import {
  validateInitDataAny,
  extractStartParam,
  jsonResponse,
  securityHeaders,
  resolveHoldGate,
  isValidTronAddress,
  checkTelegramMembership,
  generateClaimId,
  normalizeTonAddress,
  decodeTonComment,
  findValidTonPayment,
  validateTradeRequest,
  validateLevels,
  calcUnrealizedPnl,
  isPriceWithinTolerance,
  fetchMarkPrice,
  validateWalletSale,
  pairForWalletAsset,
  resolveAuthCycle,
  CONFIG,
  TRADE_CONFIG,
  KEEP_CONFIG,
  MANAGED_INTERVAL_SECONDS,
  validateKeepBuy,
  resolvePendingClaim,
  summarizeCheckins,
  CHECKIN_CONFIG,
  isoWeekKey,
  safeEqualStrings,
  rollHoldPrize,
  generateDepositCode,
  fetchTreasuryTransactions,
} from './lib.js';

// ============================================
// SUPABASE HELPERS
// ============================================
const supabase = (env) => ({
  async query(table, method, options = {}) {
    let url = `${env.SUPA_URL}/rest/v1/${table}`;
    const headers = {
      'Content-Type': 'application/json',
      'apikey': env.SUPA_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPA_SERVICE_KEY}`,
      'Prefer': 'return=representation',
    };

    if (options.select) url += `?select=${options.select}`;
    if (options.filters) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.filters)) {
        params.append(key, `eq.${value}`);
      }
      url += (url.includes('?') ? '&' : '?') + params.toString();
    }
    if (options.order) url += `${url.includes('?') ? '&' : '?'}order=${options.order}`;
    if (options.limit) url += `${url.includes('?') ? '&' : '?'}limit=${options.limit}`;
    if (options.onConflict) {
      url += `${url.includes('?') ? '&' : '?'}on_conflict=${encodeURIComponent(options.onConflict)}`;
    }

    const res = await fetch(url, {
      method: method === 'select' ? 'GET'
        : method === 'insert' || method === 'upsert' ? 'POST'
        : 'PATCH',
      headers: method === 'upsert'
        ? { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' }
        : headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    return res.json();
  },

  async rpc(fn, params) {
    const res = await fetch(`${env.SUPA_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': env.SUPA_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPA_SERVICE_KEY}`,
      },
      body: JSON.stringify(params),
    });
    return res.json();
  },
});

/** Ensure every account has exactly one stable TON deposit code. */
async function ensureDepositCode(db, userId) {
  const existing = await db.query('deposit_codes', 'select', {
    filters: { user_id: userId },
    limit: 1,
  });
  if (Array.isArray(existing) && existing[0]?.code) return existing[0].code;

  // A unique constraint handles the very small race between two first logins.
  // If a random code itself collides, the next attempt simply tries another one.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateDepositCode();
    const inserted = await db.query('deposit_codes', 'insert', {
      body: { user_id: userId, code },
    });
    if (Array.isArray(inserted) && inserted[0]?.code) return inserted[0].code;

    const afterRace = await db.query('deposit_codes', 'select', {
      filters: { user_id: userId },
      limit: 1,
    });
    if (Array.isArray(afterRace) && afterRace[0]?.code) return afterRace[0].code;
  }

  throw new Error('Could not assign TON deposit code');
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  ...securityHeaders,
};

// ============================================
// AUTH - Get or create user + active cycle
// ============================================
async function handleAuth(request, env) {
  const { initData } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);

  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  let users = await db.query('users', 'select', { filters: { telegram_id: tgId } });
  let user = users[0];

  if (!user) {
    const uid = `TK${telegramUser.id}`;
    users = await db.query('users', 'insert', {
      body: {
        telegram_id: tgId,
        uid,
        username: telegramUser.username || null,
        first_name: telegramUser.first_name || null,
        last_name: telegramUser.last_name || null,
      }
    });
    user = users[0];

    // Todo usuario arranca con CONFIG.SIGNUP_TRX_BONUS de TRX. Ojo con el
    // orden de economía: el fee de retiro es WITHDRAWAL_FEE_TRX, o sea que
    // nadie puede retirar hasta juntar la diferencia por su cuenta.
    await db.query('internal_wallets', 'insert', {
      body: {
        user_id: tgId,
        usdt_balance: 0,
        trx_balance: CONFIG.SIGNUP_TRX_BONUS,
        ton_balance: 0
      }
    });
  }

  // El código se asigna al alta y se recupera en cada login para que la UI
  // nunca dependa de un valor generado en el navegador.
  const depositCode = await ensureDepositCode(db, tgId);

  // Referidos: Telegram pone el valor de ?startapp=<uid> en start_param.
  // El initData ya fue validado, así que el parámetro es confiable. Se registra
  // en 'pending'; el pago de 2 TRX al referente lo dispara confirm_pending_referral
  // desde credit_claim, en el primer claim del referido.
  // Un start_param inválido no puede romper el login: se ignora el resultado.
  const startParam = extractStartParam(initData);
  if (startParam) {
    const ref = await db.rpc('register_referral', {
      p_referrer_uid: startParam,
      p_referred_id: tgId,
      p_referred_username: telegramUser.username || null,
    });
    // Un start_param inválido no puede romper el login, pero el fallo tiene que
    // quedar en los logs: tragárselo en silencio es exactamente por lo que un
    // referido que no se registra no se puede diagnosticar desde afuera.
    if (!ref || ref.ok !== true) {
      console.error('register_referral rechazó el alta', {
        referrer_uid: startParam,
        referred_id: tgId,
        error: ref?.error || 'sin respuesta del RPC',
      });
    }
  }

  // El último ciclo de CUALQUIER estado, no solo los activos: un ciclo
  // 'completed' con ends_at en el futuro es el cooldown posterior al claim, y
  // hay que respetarlo. Filtrar por status='active' hacía que /auth no lo viera
  // y abriera un ciclo nuevo en el siguiente login, así que el usuario podía
  // holdear de nuevo inmediatamente después de cobrar.
  let cycles = await db.query('hold_cycles', 'select', {
    filters: { user_id: tgId },
    order: 'created_at.desc',
    limit: 1
  });
  const decision = resolveAuthCycle(cycles[0], new Date());

  if (decision.mustExpire) {
    await db.query('hold_cycles', 'patch', {
      filters: { id: decision.expiredId },
      body: { status: 'expired' }
    });
  }

  let cycle = decision.cycle;

  if (decision.mustCreate) {
    const now = new Date();
    const endsAt = new Date(now.getTime() + CONFIG.CYCLE_DURATION_HOURS * 60 * 60 * 1000);
    cycles = await db.query('hold_cycles', 'insert', {
      body: {
        user_id: tgId,
        started_at: now.toISOString(),
        ends_at: endsAt.toISOString(),
        holds_completed: 0,
        status: 'active'
      }
    });
    cycle = cycles[0];
  }

  const wallets = await db.query('internal_wallets', 'select', { filters: { user_id: tgId } });
  const wallet = wallets[0] || { usdt_balance: 0, trx_balance: 0, ton_balance: 0, keep_balance: 0 };

  const claims = await db.query('claims', 'select', {
    filters: { cycle_id: cycle.id, status: 'pending' }
  });
  let pendingClaim = claims[0];

  // v3.6 (regla final): el claim que venció sin firmarse se pierde y el ciclo
  // vuelve a 0 holds, así el usuario puede jugar de nuevo; el cooldown de 8 h
  // rige SOLO tras un claim cobrado. Sin este reset /hold seguiría rechazando
  // (3/3) y el botón quedaría muerto hasta que termine la ventana.
  const claimState = resolvePendingClaim(pendingClaim, new Date(), cycle.holds_completed);
  if (claimState.forfeited) {
    await db.query('claims', 'patch', {
      filters: { claim_id: pendingClaim.claim_id },
      body: { status: 'expired_unclaimed' }
    });
    await db.query('hold_cycles', 'patch', {
      filters: { id: cycle.id },
      body: { holds_completed: 0 }
    });
    cycle = { ...cycle, holds_completed: claimState.holdsCompleted };
  }
  pendingClaim = claimState.pendingClaim;

  const referrals = await db.query('referrals', 'select', { filters: { referrer_id: tgId } });
  const totalRefs = Array.isArray(referrals) ? referrals.length : 0;
  const trxFromRefs = Array.isArray(referrals)
    ? referrals.reduce((sum, r) => sum + (parseFloat(r.reward_amount) || 0), 0)
    : 0;

  return jsonResponse({
    ok: true,
    user: {
      uid: user.uid,
      deposit_code: depositCode,
      usdt_balance: parseFloat(wallet.usdt_balance) || 0,
      trx_balance: parseFloat(wallet.trx_balance) || 0,
      ton_balance: parseFloat(wallet.ton_balance) || 0,
      keep_balance: parseFloat(wallet.keep_balance) || 0,
      total_refs: totalRefs,
      trx_refs: trxFromRefs,
    },
    cycle: {
      id: cycle.id,
      holds_completed: cycle.holds_completed,
      ends_at: cycle.ends_at,
      remaining_holds: CONFIG.MAX_HOLDS_PER_CYCLE - cycle.holds_completed,
    },
    pending_claim: pendingClaim ? {
      claim_id: pendingClaim.claim_id,
      total_prize: parseFloat(pendingClaim.total_prize),
      ton_fee: parseFloat(pendingClaim.ton_fee),
      expires_at: pendingClaim.expires_at,
    } : null,
    deposit_code: depositCode,
    treasury_wallet: CONFIG.TREASURY_WALLET,
  });
}

// ============================================
// HOLD - Register a hold (max 3 per cycle)
// ============================================
async function handleHold(request, env) {
  const { initData } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);

  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  // El premio se sortea acá, no lo manda el cliente. Antes venía en el body y,
  // aunque estaba acotado al rango, cualquiera con la consola abierta mandaba
  // siempre el máximo. Ver rollHoldPrize en lib.js.
  const prize = rollHoldPrize();

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  // El último ciclo de CUALQUIER estado: uno 'completed' con ends_at en el
  // futuro es el cooldown posterior al claim y hay que respetarlo. Antes esta
  // consulta filtraba status='active' y, si no había ninguno, /hold devolvía
  // 'No active cycle' sin crear nada: el botón quedaba muerto hasta que el
  // usuario recargara la app y pasara por /auth.
  const cycles = await db.query('hold_cycles', 'select', {
    filters: { user_id: tgId },
    order: 'created_at.desc',
    limit: 1
  });
  const latestCycle = cycles[0] || null;

  const pendingClaims = latestCycle
    ? await db.query('claims', 'select', {
        filters: { cycle_id: latestCycle.id, status: 'pending' }
      })
    : [];

  const gate = resolveHoldGate(latestCycle, pendingClaims[0] || null, new Date());

  if (gate.action === 'reject') {
    return jsonResponse({
      ok: false,
      // Dos rechazos legítimos y son distintos: 'cooldown' es la espera de 8 h
      // tras haber cobrado; 'claim_pending' es un premio todavía vivo que hay
      // que cobrar antes de seguir jugando.
      error: gate.reason === 'cooldown'
        ? 'Cooldown active after your last claim.'
        : 'You have a pending claim. Claim it to keep playing!',
      reason: gate.reason,
      cooldown_ends_at: gate.cooldownEndsAt || null,
    }, 400);
  }

  // v3.6: claim que expiró sin cobrarse: el premio se perdió y el ciclo vuelve
  // a 0. Se resuelve acá, en el mismo pedido, en vez de depender del pg_cron
  // (corre cada minuto y puede no estar activo) o de que el cliente recargue.
  if (gate.forfeitClaimId) {
    await db.query('claims', 'patch', {
      filters: { claim_id: gate.forfeitClaimId },
      body: { status: 'expired_unclaimed' }
    });
  }

  let cycle;
  if (gate.action === 'create') {
    const now = new Date();
    const created = await db.query('hold_cycles', 'insert', {
      body: {
        user_id: tgId,
        started_at: now.toISOString(),
        ends_at: new Date(now.getTime() + CONFIG.CYCLE_DURATION_HOURS * 60 * 60 * 1000).toISOString(),
        holds_completed: 0,
        status: 'active'
      }
    });
    cycle = created[0];
  } else {
    cycle = gate.cycle;
    const patch = {};
    if (gate.resetHolds) patch.holds_completed = 0;
    if (gate.extendEndsAt) {
      patch.ends_at = new Date(
        Date.now() + CONFIG.CYCLE_DURATION_HOURS * 60 * 60 * 1000
      ).toISOString();
    }
    if (Object.keys(patch).length > 0) {
      await db.query('hold_cycles', 'patch', { filters: { id: cycle.id }, body: patch });
      cycle = { ...cycle, ...patch };
    }
  }

  const holdNumber = Number(cycle.holds_completed) + 1;
  await db.query('holds', 'insert', {
    body: {
      user_id: tgId,
      cycle_id: cycle.id,
      hold_number: holdNumber,
      prize_amount: prize
    }
  });

  await db.query('hold_cycles', 'patch', {
    filters: { id: cycle.id },
    body: { holds_completed: holdNumber }
  });

  let claim = null;
  if (holdNumber === CONFIG.MAX_HOLDS_PER_CYCLE) {
    const holds = await db.query('holds', 'select', { filters: { cycle_id: cycle.id } });
    const totalPrize = (Array.isArray(holds) ? holds : []).reduce((sum, h) => sum + parseFloat(h.prize_amount), 0);

    const claimId = generateClaimId();
    const expiresAt = new Date(Date.now() + CONFIG.CLAIM_EXPIRY_MINUTES * 60 * 1000);

    const claimsInsert = await db.query('claims', 'insert', {
      body: {
        claim_id: claimId,
        user_id: tgId,
        cycle_id: cycle.id,
        total_prize: totalPrize,
        ton_fee: CONFIG.TON_FEE,
        status: 'pending',
        expires_at: expiresAt.toISOString()
      }
    });
    claim = claimsInsert[0];
  }

  return jsonResponse({
    ok: true,
    hold_number: holdNumber,
    // El cliente necesita el valor real para mostrarlo: ya no lo conoce de
    // antemano porque no lo genera él.
    prize_amount: prize,
    remaining_holds: CONFIG.MAX_HOLDS_PER_CYCLE - holdNumber,
    cycle_complete: holdNumber === CONFIG.MAX_HOLDS_PER_CYCLE,
    claim: claim ? {
      claim_id: claim.claim_id,
      total_prize: parseFloat(claim.total_prize),
      ton_fee: parseFloat(claim.ton_fee),
      expires_at: claim.expires_at,
      treasury_wallet: CONFIG.TREASURY_WALLET,
    } : null
  });
}

// ============================================
// GET CLAIM - Get pending claim info
// ============================================
async function handleGetClaim(request, env) {
  const { initData } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);

  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const cycles = await db.query('hold_cycles', 'select', {
    filters: { user_id: tgId, status: 'active' }
  });
  const cycle = cycles[0];

  if (!cycle) {
    return jsonResponse({ ok: true, claim: null });
  }

  const claims = await db.query('claims', 'select', {
    filters: { cycle_id: cycle.id, status: 'pending' }
  });
  const claim = claims[0];

  // Sin regeneración a propósito (v2.8.1): un claim que venció sin pagarse se
  // pierde junto con sus 3 holds, y /auth ya dejó el ciclo en 0 para que el
  // usuario pueda holdear de nuevo. Regenerar acá permitía cobrar dos veces el
  // mismo trabajo.

  if (!claim) {
    return jsonResponse({ ok: true, claim: null });
  }

  if (new Date(claim.expires_at) < new Date()) {
    await db.query('claims', 'patch', {
      filters: { claim_id: claim.claim_id },
      body: { status: 'expired_unclaimed' }
    });
    return jsonResponse({ ok: true, claim: null, expired: true });
  }

  return jsonResponse({
    ok: true,
    claim: {
      claim_id: claim.claim_id,
      total_prize: parseFloat(claim.total_prize),
      ton_fee: parseFloat(claim.ton_fee),
      expires_at: claim.expires_at,
      seconds_remaining: Math.max(0, Math.floor((new Date(claim.expires_at) - new Date()) / 1000)),
      treasury_wallet: CONFIG.TREASURY_WALLET,
      payment_comment: `CLAIM:${claim.claim_id}`,
    }
  });
}

// ============================================
// VERIFY PAYMENT
// ============================================
async function handleVerifyPayment(request, env) {
  const { initData, claim_id, sender_address } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);

  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  if (!claim_id || !sender_address) {
    return jsonResponse({ ok: false, error: 'Missing claim_id or sender_address' }, 400);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const claims = await db.query('claims', 'select', { filters: { claim_id } });
  const claim = claims[0];

  if (!claim) return jsonResponse({ ok: false, error: 'Claim not found' }, 404);
  if (claim.user_id !== tgId) return jsonResponse({ ok: false, error: 'Unauthorized' }, 403);
  if (claim.status === 'credited') {
    return jsonResponse({ ok: true, already_credited: true, credited: parseFloat(claim.total_prize) });
  }
  if (claim.status === 'expired_unclaimed') {
    return jsonResponse({ ok: false, error: 'Claim expired' }, 400);
  }
  if (new Date(claim.expires_at) < new Date()) {
    await db.query('claims', 'patch', { filters: { claim_id }, body: { status: 'expired_unclaimed' } });
    return jsonResponse({ ok: false, error: 'Claim expired' }, 400);
  }

  const minAmountNano = Math.floor(parseFloat(claim.ton_fee) * 1e9);
  const earliestTs = Math.floor(new Date(claim.created_at).getTime() / 1000) - 60;

  let payment;
  try {
    payment = await findValidTonPayment({
      tonApiKey: env.TON_API_KEY,
      treasury: CONFIG.TREASURY_WALLET,
      senderAddress: sender_address,
      claimId: claim_id,
      minAmountNano,
      earliestUtime: earliestTs,
      fetchImpl: fetch,
    });
  } catch (err) {
    console.error('TON verify error:', err);
    return jsonResponse({ ok: false, pending: true, error: 'TON network unreachable. Retry in a few seconds.' }, 202);
  }

  if (!payment) {
    return jsonResponse({ ok: false, pending: true, error: 'Payment not found on chain yet. The TON network can take up to 60s.' }, 202);
  }

  const existingPayments = await db.query('claim_payments', 'select', { filters: { tx_hash: payment.tx_hash } });
  if (Array.isArray(existingPayments) && existingPayments.length > 0) {
    if (existingPayments[0].claim_id === claim_id) {
      return jsonResponse({ ok: true, already_credited: true, credited: parseFloat(claim.total_prize) });
    }
    return jsonResponse({ ok: false, error: 'Transaction already used for another claim' }, 400);
  }

  // El cooldown post-claim vive en CONFIG, no hardcodeado en el SQL: el DEFAULT
  // de la función es solo la red si alguien la llama sin el parámetro.
  const result = await db.rpc('credit_claim', {
    p_cooldown_hours: CONFIG.CYCLE_DURATION_HOURS,
    p_claim_id: claim_id,
    p_tx_hash: payment.tx_hash,
    p_amount: payment.amount_nano / 1e9,
    p_from_address: payment.from_address,
  });

  if (result.ok) {
    return jsonResponse({
      ok: true,
      credited: parseFloat(result.credited),
      new_balance: parseFloat(result.new_balance),
      // Bonus $KEEP del claim (v3.2): el SQL sortea 500-2500 y lo devuelve.
      keep_credited: Number(result.keep_credited) || 0,
      keep_balance: parseFloat(result.keep_balance) || 0,
      tx_hash: payment.tx_hash,
    });
  }
  return jsonResponse({ ok: false, error: result.error || 'Credit failed' }, 400);
}

// ============================================
// TON DEPOSITS — automatic MEMO sweep
// ============================================
const DEPOSIT_CODE_PATTERN = /^DEP:[A-Z0-9]{6}$/;

function tonDepositEvidence(tx, treasury = CONFIG.TREASURY_WALLET) {
  const inMsg = tx?.in_msg;
  if (!inMsg) return null;

  const txHash = String(tx.transaction_id?.hash || '').trim();
  const fromAddress = String(inMsg.source || '').trim();
  const destination = String(inMsg.destination || '').trim();
  const treasuryAddress = normalizeTonAddress(treasury);
  // TonCenter returns both inbound and outbound transactions for a wallet.
  // Only an inbound message whose destination is the configured treasury is a
  // deposit; otherwise an outgoing transfer with a DEP comment could mint
  // balance in the app.
  if (!destination || normalizeTonAddress(destination) !== treasuryAddress) return null;
  if (!fromAddress || normalizeTonAddress(fromAddress) === treasuryAddress) return null;

  const rawNano = String(inMsg.value ?? '').trim();
  const amountNano = Number(rawNano);
  const utime = Number(tx.utime);
  if (!txHash || !Number.isSafeInteger(amountNano) || amountNano <= 0) return null;

  const timestamp = Number.isFinite(utime) && utime > 0
    ? new Date(utime * 1000).toISOString()
    : new Date().toISOString();
  return {
    tx_hash: txHash,
    from_address: fromAddress,
    amount_nano: amountNano,
    amount: amountNano / 1e9,
    comment: String(decodeTonComment(inMsg) || '').trim(),
    tx_timestamp: timestamp,
  };
}

function rpcObject(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function saveUnmatchedDeposit(db, evidence) {
  const existing = await db.query('unmatched_deposits', 'select', {
    filters: { tx_hash: evidence.tx_hash },
    limit: 1,
  });
  if (Array.isArray(existing) && existing.length > 0) return false;

  const inserted = await db.query('unmatched_deposits', 'upsert', {
    onConflict: 'tx_hash',
    body: {
      tx_hash: evidence.tx_hash,
      from_address: evidence.from_address,
      amount: evidence.amount,
      comment: evidence.comment,
      tx_timestamp: evidence.tx_timestamp,
    },
  });
  return Array.isArray(inserted) && inserted.length > 0;
}

/**
 * Read the treasury's recent TON transactions and credit only exact MEMO
 * matches. This function is exported so the cron behavior can be tested with
 * fake TonCenter/Supabase responses without requiring a Cloudflare runtime.
 */
export async function runTonDepositSweep(env, { fetchImpl = fetch } = {}) {
  const db = supabase(env);
  const txs = await fetchTreasuryTransactions({
    treasury: CONFIG.TREASURY_WALLET,
    tonApiKey: env.TON_API_KEY,
    limit: 100,
    fetchImpl,
  });
  const summary = { scanned: 0, credited: 0, unmatched: 0, skipped_claims: 0, errors: 0 };

  for (const tx of txs) {
    const evidence = tonDepositEvidence(tx, CONFIG.TREASURY_WALLET);
    if (!evidence) continue;
    summary.scanned += 1;

    // CLAIM:<id> belongs exclusively to the existing claim verifier. It is not
    // a deposit and must not appear in the unmatched admin queue.
    if (evidence.comment.toUpperCase().startsWith('CLAIM:')) {
      summary.skipped_claims += 1;
      continue;
    }

    let codeRow = [];
    if (DEPOSIT_CODE_PATTERN.test(evidence.comment)) {
      codeRow = await db.query('deposit_codes', 'select', {
        filters: { code: evidence.comment },
        limit: 1,
      });
    }

    const codeMatchesUser = Array.isArray(codeRow) && codeRow[0]?.user_id;
    if (!codeMatchesUser || evidence.amount < CONFIG.TON_DEPOSIT_MIN) {
      if (await saveUnmatchedDeposit(db, evidence)) summary.unmatched += 1;
      continue;
    }

    const rawResult = await db.rpc('credit_ton_deposit', {
      p_user_id: codeRow[0].user_id,
      p_tx_hash: evidence.tx_hash,
      p_from_address: evidence.from_address,
      p_amount: evidence.amount,
      p_comment: evidence.comment,
      p_tx_timestamp: evidence.tx_timestamp,
      p_unmatched_id: null,
    });
    const result = rpcObject(rawResult);
    if (result?.ok === true) {
      if (!result.already_credited) summary.credited += 1;
    } else {
      // A temporary RPC failure is retried on the next tick. Do not turn a
      // valid, correctly coded deposit into a rejected admin item.
      summary.errors += 1;
      console.error('TON deposit credit error:', result?.error || rawResult);
    }
  }

  return summary;
}

// ============================================
// TRANSACTIONS
// ============================================
async function handleTransactions(request, env) {
  const { initData, limit = 50 } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);

  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const ledger = await db.query('wallet_ledger', 'select', {
    filters: { user_id: tgId },
    order: 'created_at.desc',
    limit
  });

  const transactions = (Array.isArray(ledger) ? ledger : []).map(l => ({
    id: l.id,
    type: l.operation === 'claim_credit' ? 'reward' : l.operation,
    asset: l.asset,
    amount: parseFloat(l.amount),
    status: 'confirmed',
    timestamp: new Date(l.created_at).getTime(),
    description: l.description,
  }));

  return jsonResponse({ ok: true, transactions });
}

// ============================================
// REFERRALS
// ============================================
async function handleReferrals(request, env) {
  const { initData } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);

  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const poolData = await db.query('referral_pool', 'select', { limit: 1 });
  const pool = poolData[0] || { total_pool: 50000, distributed: 0 };

  const referrals = await db.query('referrals', 'select', { filters: { referrer_id: tgId } });
  const yourEarnings = (Array.isArray(referrals) ? referrals : [])
    .reduce((sum, r) => sum + (parseFloat(r.reward_amount) || 0), 0);

  return jsonResponse({
    ok: true,
    pool: {
      total_pool: parseFloat(pool.total_pool),
      remaining: parseFloat(pool.total_pool) - parseFloat(pool.distributed || 0),
      your_earnings: yourEarnings,
    },
  });
}

// ============================================
// TRADE - open a simulated spot position with internal USDT
// ============================================
async function handleTrade(request, env) {
  const { initData, pair, amount, price, take_profit, stop_loss } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);

  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const wallets = await db.query('internal_wallets', 'select', { filters: { user_id: tgId } });
  const wallet = (Array.isArray(wallets) ? wallets : [])[0];
  if (!wallet) return jsonResponse({ ok: false, error: 'Wallet not found' }, 404);

  const balance = parseFloat(wallet.usdt_balance) || 0;
  const validation = validateTradeRequest({ pair, amount, balance });
  if (!validation.ok) {
    return jsonResponse({ ok: false, error: validation.error }, 400);
  }

  // The exchange mark price wins over whatever the client chart sent.
  const markPrice = await fetchMarkPrice(pair);
  const fillPrice = markPrice ?? Number(price);

  if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
    return jsonResponse({ ok: false, error: 'Price unavailable. Try again in a moment.' }, 502);
  }
  if (markPrice && price && !isPriceWithinTolerance(price, markPrice)) {
    return jsonResponse(
      { ok: false, error: 'Price moved. Refresh the chart and try again.', fill_price: markPrice },
      409
    );
  }

  const levels = validateLevels({ entryPrice: fillPrice, takeProfit: take_profit, stopLoss: stop_loss });
  if (!levels.ok) {
    return jsonResponse({ ok: false, error: levels.error }, 400);
  }

  const result = await db.rpc('open_trade', {
    p_user_id: tgId,
    p_pair: pair,
    p_amount: validation.amount,
    p_price: fillPrice,
    p_take_profit: levels.takeProfit,
    p_stop_loss: levels.stopLoss,
  });

  if (!result || result.ok !== true) {
    return jsonResponse({ ok: false, error: result?.error || 'Trade failed' }, 400);
  }

  return jsonResponse({
    ok: true,
    position: result.position,
    new_balance: parseFloat(result.new_balance),
    mark_price: markPrice || null,
    fee_rate: TRADE_CONFIG.FEE_RATE,
  });
}

// ============================================
// TRADE CLOSE - realize PnL back into internal USDT
// ============================================
async function handleTradeClose(request, env) {
  const { initData, position_id, price } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);

  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }
  if (!position_id) {
    return jsonResponse({ ok: false, error: 'Missing position_id' }, 400);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const rows = await db.query('trade_positions', 'select', { filters: { id: position_id } });
  const position = (Array.isArray(rows) ? rows : [])[0];
  if (!position) return jsonResponse({ ok: false, error: 'Position not found' }, 404);
  if (position.user_id !== tgId) return jsonResponse({ ok: false, error: 'Unauthorized' }, 403);
  if (position.status !== 'open') {
    return jsonResponse({ ok: false, error: 'Position already closed' }, 400);
  }

  const markPrice = await fetchMarkPrice(position.pair);
  const fillPrice = markPrice ?? Number(price);
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
    return jsonResponse({ ok: false, error: 'Price unavailable. Try again in a moment.' }, 502);
  }

  const result = await db.rpc('close_trade', {
    p_user_id: tgId,
    p_position_id: position_id,
    p_price: fillPrice,
  });

  if (!result || result.ok !== true) {
    return jsonResponse({ ok: false, error: result?.error || 'Close failed' }, 400);
  }

  return jsonResponse({
    ok: true,
    pnl: parseFloat(result.pnl),
    pnl_pct: parseFloat(result.pnl_pct),
    credited: parseFloat(result.credit),
    new_balance: parseFloat(result.new_balance),
  });
}

// ============================================
// SELL FROM WALLET - convierte TRX/TON de la wallet interna a USDT
// ============================================
// Distinto de /trade/close, que liquida una posición abierta. Esto vende un
// activo que el usuario ya tenía acreditado (bonus de referidos en TRX, por
// ejemplo) y que antes quedaba trabado: se veía en la wallet sin forma de uso.
async function handleSellAsset(request, env) {
  const { initData, asset, amount, price } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);

  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const wallets = await db.query('internal_wallets', 'select', { filters: { user_id: tgId } });
  const wallet = (Array.isArray(wallets) ? wallets : [])[0];
  if (!wallet) return jsonResponse({ ok: false, error: 'Wallet not found' }, 404);

  const have =
    parseFloat(asset === 'TRX' ? wallet.trx_balance : wallet.ton_balance) || 0;

  // Sin amount explícito se vende todo el saldo del activo.
  const validation = validateWalletSale({ asset, amount: amount ?? have, balance: have });
  if (!validation.ok) {
    return jsonResponse({ ok: false, error: validation.error }, 400);
  }

  // El precio del exchange manda sobre el que trae el cliente.
  const markPrice = await fetchMarkPrice(pairForWalletAsset(asset));
  const fillPrice = markPrice ?? Number(price);
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
    return jsonResponse({ ok: false, error: 'Price unavailable. Try again in a moment.' }, 502);
  }
  if (markPrice && price && !isPriceWithinTolerance(price, markPrice)) {
    return jsonResponse(
      { ok: false, error: 'Price moved. Refresh and try again.', fill_price: markPrice },
      409
    );
  }

  const result = await db.rpc('sell_wallet_asset', {
    p_user_id: tgId,
    p_asset: asset,
    p_amount: validation.amount,
    p_price: fillPrice,
  });

  if (!result || result.ok !== true) {
    return jsonResponse({ ok: false, error: result?.error || 'Sale failed' }, 400);
  }

  return jsonResponse({
    ok: true,
    asset,
    amount: parseFloat(result.amount),
    price: fillPrice,
    fee: parseFloat(result.fee),
    credited: parseFloat(result.credit),
    new_balance: parseFloat(result.new_balance),
    asset_balance: parseFloat(result.asset_balance),
  });
}

// ============================================
// KEEP PRICE - precio manejado (GET, publico)
// ============================================
// KEEP no cotiza en ningun exchange: el precio vive en managed_prices y lo
// mueve un walk dentro de la banda que define el proyecto. Este endpoint es
// la unica fuente de verdad para el grafico y la compra. Solo lectura, sin
// initData: no expone nada del usuario.
async function handlePrice(request, env, url) {
  const pair = String(url.searchParams.get('pair') || '').toUpperCase();
  if (pair !== KEEP_CONFIG.PAIR) {
    return jsonResponse({ ok: false, error: 'Unsupported pair' }, 400);
  }
  const interval = url.searchParams.get('interval') || '1h';
  const bucketSeconds = MANAGED_INTERVAL_SECONDS[interval];
  if (!bucketSeconds) {
    return jsonResponse({ ok: false, error: 'Unsupported interval' }, 400);
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), 300);

  const db = supabase(env);
  const result = await db.rpc('managed_price_candles', {
    p_pair: pair,
    p_bucket_seconds: bucketSeconds,
    p_limit: limit,
  });
  if (!result || result.ok !== true) {
    return jsonResponse({ ok: false, error: 'Price unavailable. Try again in a moment.' }, 502);
  }

  return jsonResponse({
    ok: true,
    mode: 'managed',
    pair,
    price: Number(result.price),
    change_percent: Number(result.change_percent) || 0,
    floor: Number(result.floor),
    cap: Number(result.cap),
    candles: (Array.isArray(result.candles) ? result.candles : []).map((c) => ({
      t: Number(c.t), o: Number(c.o), h: Number(c.h), l: Number(c.l),
      c: Number(c.c), v: Number(c.v),
    })),
  });
}

// ============================================
// KEEP BUY - spot con USDT interno (no abre posicion)
// ============================================
// El mark price es SIEMPRE el manejado (managed_price_tick): el precio del
// cliente solo se acepta dentro de la tolerancia y nunca decide el fill.
// No hay operacion inversa: KEEP no se vende.
async function handleBuyKeep(request, env) {
  const { initData, amount, price } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const wallets = await db.query('internal_wallets', 'select', { filters: { user_id: tgId } });
  const wallet = (Array.isArray(wallets) ? wallets : [])[0];
  if (!wallet) return jsonResponse({ ok: false, error: 'Wallet not found' }, 404);

  const validation = validateKeepBuy({ amount, balance: parseFloat(wallet.usdt_balance) || 0 });
  if (!validation.ok) {
    return jsonResponse({ ok: false, error: validation.error }, 400);
  }

  const tick = await db.rpc('managed_price_tick', { p_pair: KEEP_CONFIG.PAIR });
  if (!tick || tick.ok !== true) {
    return jsonResponse({ ok: false, error: 'Price unavailable. Try again in a moment.' }, 502);
  }
  const markPrice = Number(tick.price);
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    return jsonResponse({ ok: false, error: 'Price unavailable. Try again in a moment.' }, 502);
  }
  if (price && !isPriceWithinTolerance(Number(price), markPrice)) {
    return jsonResponse(
      { ok: false, error: 'Price moved. Refresh and try again.', fill_price: markPrice },
      409
    );
  }

  const result = await db.rpc('buy_keep', {
    p_user_id: tgId,
    p_amount: validation.amount,
    p_price: markPrice,
  });
  if (!result || result.ok !== true) {
    return jsonResponse({ ok: false, error: result?.error || 'Purchase failed' }, 400);
  }

  return jsonResponse({
    ok: true,
    qty: Number(result.qty),
    fee: Number(result.fee),
    price: Number(result.price),
    usdt_balance: Number(result.usdt_balance),
    keep_balance: Number(result.keep_balance),
  });
}

// ============================================
// TRADE LEVELS - set / edit Take Profit and Stop Loss
// ============================================
async function handleTradeLevels(request, env) {
  const { initData, position_id, take_profit, stop_loss } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);

  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }
  if (!position_id) {
    return jsonResponse({ ok: false, error: 'Missing position_id' }, 400);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const rows = await db.query('trade_positions', 'select', { filters: { id: position_id } });
  const position = (Array.isArray(rows) ? rows : [])[0];
  if (!position) return jsonResponse({ ok: false, error: 'Position not found' }, 404);
  if (position.user_id !== tgId) return jsonResponse({ ok: false, error: 'Unauthorized' }, 403);
  if (position.status !== 'open') {
    return jsonResponse({ ok: false, error: 'Position already closed' }, 400);
  }

  const levels = validateLevels({
    entryPrice: parseFloat(position.entry_price),
    takeProfit: take_profit,
    stopLoss: stop_loss,
  });
  if (!levels.ok) {
    return jsonResponse({ ok: false, error: levels.error }, 400);
  }

  const result = await db.rpc('set_trade_levels', {
    p_user_id: tgId,
    p_position_id: position_id,
    p_take_profit: levels.takeProfit,
    p_stop_loss: levels.stopLoss,
  });

  if (!result || result.ok !== true) {
    return jsonResponse({ ok: false, error: result?.error || 'Update failed' }, 400);
  }

  return jsonResponse({ ok: true, take_profit: levels.takeProfit, stop_loss: levels.stopLoss });
}

// ============================================
// POSITIONS - open positions + realized PnL
// ============================================
async function handlePositions(request, env) {
  const { initData } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);

  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const rows = await db.query('trade_positions', 'select', {
    filters: { user_id: tgId },
    order: 'opened_at.desc',
    limit: 100,
  });
  const all = Array.isArray(rows) ? rows : [];

  // Best-effort mark prices; positions stay listed even if the exchange is down.
  const pairs = [...new Set(all.filter(p => p.status === 'open').map(p => p.pair))];
  const marks = {};
  await Promise.all(
    pairs.map(async (pair) => {
      marks[pair] = await fetchMarkPrice(pair);
    })
  );

  const positions = all.map((p) => {
    const qty = parseFloat(p.qty);
    const entry = parseFloat(p.entry_price);
    const mark = marks[p.pair];
    const live = p.status === 'open' && mark ? calcUnrealizedPnl({ qty, entryPrice: entry, markPrice: mark }) : null;

    return {
      id: p.id,
      pair: p.pair,
      qty,
      entry_price: entry,
      cost_basis: parseFloat(p.cost_basis),
      fee_paid: parseFloat(p.fee_paid),
      take_profit: p.take_profit === null || p.take_profit === undefined ? null : parseFloat(p.take_profit),
      stop_loss: p.stop_loss === null || p.stop_loss === undefined ? null : parseFloat(p.stop_loss),
      status: p.status,
      opened_at: p.opened_at,
      closed_at: p.closed_at,
      mark_price: mark ?? null,
      value: live ? live.value : (p.status === 'closed' ? parseFloat(p.credit || 0) : null),
      unrealized_pnl: live ? live.unrealized : null,
      unrealized_pct: live ? live.unrealizedPct : null,
      realized_pnl: p.status === 'closed' ? parseFloat(p.realized_pnl) : null,
    };
  });

  const open = positions.filter(p => p.status === 'open');
  const realized = positions.reduce((sum, p) => sum + (p.realized_pnl || 0), 0);
  const unrealized = open.reduce((sum, p) => sum + (p.unrealized_pnl || 0), 0);

  return jsonResponse({
    ok: true,
    positions: open,
    closed: positions.filter(p => p.status === 'closed').slice(0, 20),
    realized_pnl: realized,
    unrealized_pnl: unrealized,
    positions_value: open.reduce((sum, p) => sum + (p.value || 0), 0),
    fee_rate: TRADE_CONFIG.FEE_RATE,
  });
}

// ============================================
// MAIN HANDLER
// ============================================
// ============================================
// DAILY CHECK-IN
// ============================================

/** POST /checkin/status — streak, days this week and whether today is done. */
async function handleCheckinStatus(request, env) {
  const { initData } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const rows = await db.query('checkins', 'select', {
    filters: { user_id: tgId },
    order: 'checkin_date.desc',
    limit: 60
  });

  // v3.3: el premio de la semana completa (1.5 USDT + 2000 KEEP) no se
  // acredita solo: queda como claim pendiente que el usuario cobra pagando
  // 0.15 TON via TonConnect. Si hay uno vivo, la UI muestra el CTA.
  const weeklyRows = await db.query('claims', 'select', {
    filters: { user_id: tgId, status: 'pending', claim_type: 'weekly' },
    order: 'created_at.desc',
    limit: 1,
  });
  const wc = (Array.isArray(weeklyRows) ? weeklyRows : [])[0] || null;
  const weeklyClaim = wc && new Date(wc.expires_at) > new Date()
    ? {
        claim_id: wc.claim_id,
        expires_at: wc.expires_at,
        total_prize: Number(wc.total_prize),
        ton_fee: Number(wc.ton_fee),
        keep_bonus: CHECKIN_CONFIG.WEEKLY_KEEP,
      }
    : null;

  return jsonResponse({
    ok: true,
    ...summarizeCheckins(rows),
    // v3.3: el diario paga 500 KEEP fijos (min == max) y el semanal 2000.
    keep_min: KEEP_CONFIG.CHECKIN_MIN,
    keep_max: KEEP_CONFIG.CHECKIN_MAX,
    weekly_keep: KEEP_CONFIG.CHECKIN_WEEKLY,
    weekly_claim: weeklyClaim,
  });
}

/**
 * POST /checkin — credits the daily reward, and the weekly bonus on the 7th
 * day of the ISO week. The whole thing runs inside daily_checkin(), so two
 * rapid taps cannot credit twice (the table has UNIQUE(user_id, checkin_date)).
 */
async function handleCheckin(request, env) {
  const { initData } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const result = await db.rpc('daily_checkin', { p_user_id: tgId });

  if (!result.ok) {
    const status = result.error === 'already_checked_in' ? 200 : 400;
    return jsonResponse(result, status);
  }
  return jsonResponse(result);
}

// ============================================
// WITHDRAW — cola manual
// ============================================
// No hay clave privada acá: descuenta saldo + fee y deja el pedido en
// withdrawal_requests. La transferencia on-chain la hace un humano desde la
// tesorería y después marca la fila con resolve_withdrawal('paid', tx_id).
async function handleWithdraw(request, env) {
  const { initData, asset, amount, toAddress } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  if (!isValidTronAddress(toAddress)) {
    return jsonResponse({ ok: false, error: 'Invalid TRON address' }, 400);
  }

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return jsonResponse({ ok: false, error: 'Invalid amount' }, 400);
  }

  const db = supabase(env);
  const result = await db.rpc('request_withdrawal', {
    p_user_id: telegramUser.id.toString(),
    p_asset: String(asset || '').toUpperCase(),
    p_amount: value,
    p_to_address: String(toAddress).trim(),
  });

  if (!result || result.ok !== true) {
    return jsonResponse(result || { ok: false, error: 'Withdrawal failed' }, 400);
  }
  return jsonResponse(result);
}

// Fee y mínimos desde la base, no hardcodeados: withdrawal_config es la fuente
// de verdad y el modal los pide acá para no desincronizarse.
async function handleWithdrawSettings(request, env) {
  const { initData } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const result = await db.rpc('withdrawal_settings', {});
  return jsonResponse({ ok: true, ...(result || {}) });
}

// ============================================
// ADMIN — cola de aprobaciones
// ============================================
// Dos colas manuales en una sola pantalla /admin:
//   * misiones de revision humana (First Deposit)
//   * retiros pendientes de pago on-chain
// Autentica con el secreto ADMIN_TOKEN (header x-admin-token); no usa
// initData porque el admin entra desde un navegador comun, fuera de Telegram.
// Sin ADMIN_TOKEN configurado, todo el modulo responde 503.
async function handleAdmin(request, env, path) {
  if (!env.ADMIN_TOKEN) {
    return jsonResponse({ ok: false, error: 'Admin not configured' }, 503);
  }
  const token = request.headers.get('x-admin-token') || '';
  // Comparacion de tiempo constante: un `!==` comun corta en el primer
  // caracter distinto y filtra informacion util para fuerza bruta.
  if (!safeEqualStrings(token, env.ADMIN_TOKEN)) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }

  const db = supabase(env);

  if (path === '/admin/missions/list') {
    const rows = await db.rpc('list_pending_mission_requests', {});
    return jsonResponse({ ok: true, requests: Array.isArray(rows) ? rows : [] });
  }

  if (path === '/admin/missions/approve' || path === '/admin/missions/reject') {
    const { user_id, mission_id } = await request.json();
    if (!user_id || !mission_id) {
      return jsonResponse({ ok: false, error: 'Missing user_id or mission_id' }, 400);
    }
    const fn = path.endsWith('approve') ? 'approve_mission_request' : 'reject_mission_request';
    const r = await db.rpc(fn, { p_user_id: String(user_id), p_mission_id: String(mission_id) });
    return jsonResponse(r || { ok: false, error: 'failed' }, r?.ok ? 200 : 400);
  }

  if (path === '/admin/withdrawals/list') {
    const rows = await db.query('withdrawal_requests', 'select', {
      filters: { status: 'pending' },
      order: 'created_at.asc',
      limit: 100,
    });
    return jsonResponse({ ok: true, requests: Array.isArray(rows) ? rows : [] });
  }

  if (path === '/admin/withdrawals/resolve') {
    const { request_id, status, tx_id, note } = await request.json();
    if (!request_id || !status) {
      return jsonResponse({ ok: false, error: 'Missing request_id or status' }, 400);
    }
    const r = await db.rpc('resolve_withdrawal', {
      p_request_id: request_id,
      p_status: String(status),
      p_tx_id: tx_id == null ? null : String(tx_id),
      p_note: note == null ? null : String(note),
    });
    return jsonResponse(r || { ok: false, error: 'failed' }, r?.ok ? 200 : 400);
  }

  if (path === '/admin/deposits/list') {
    const rows = await db.query('unmatched_deposits', 'select', {
      filters: { status: 'pending' },
      order: 'created_at.asc',
      limit: 100,
    });
    return jsonResponse({ ok: true, deposits: Array.isArray(rows) ? rows : [] });
  }

  if (path === '/admin/deposits/resolve') {
    const { deposit_id, tx_hash, status, user_id, code, note } = await request.json();
    const resolution = String(status || '').toLowerCase();
    if ((!deposit_id && !tx_hash) || !['credited', 'rejected'].includes(resolution)) {
      return jsonResponse({ ok: false, error: 'Missing deposit evidence or invalid status' }, 400);
    }

    const rows = await db.query('unmatched_deposits', 'select', {
      filters: deposit_id ? { id: deposit_id } : { tx_hash: String(tx_hash).trim() },
      limit: 1,
    });
    const deposit = Array.isArray(rows) ? rows[0] : null;
    if (!deposit) return jsonResponse({ ok: false, error: 'Unmatched deposit not found' }, 404);
    if (deposit.status !== 'pending') {
      return jsonResponse({ ok: false, error: 'Unmatched deposit already resolved' }, 409);
    }

    if (resolution === 'rejected') {
      const updated = await db.query('unmatched_deposits', 'patch', {
        filters: { id: deposit.id, status: 'pending' },
        body: {
          status: 'rejected',
          resolution_note: note == null ? 'Rejected by admin' : String(note),
          resolved_by: 'admin',
          resolved_at: new Date().toISOString(),
        },
      });
      return jsonResponse({ ok: true, status: 'rejected', deposit: Array.isArray(updated) ? updated[0] : deposit });
    }

    let resolvedUserId = user_id == null ? '' : String(user_id).trim();
    if (code != null && String(code).trim()) {
      const codeRows = await db.query('deposit_codes', 'select', {
        filters: { code: String(code).trim() },
        limit: 1,
      });
      resolvedUserId = Array.isArray(codeRows) ? String(codeRows[0]?.user_id || '') : '';
    }
    if (!resolvedUserId) {
      return jsonResponse({ ok: false, error: 'A valid deposit code or user_id is required' }, 400);
    }

    // All amount, source, comment and hash values come from the stored chain
    // evidence. credit_ton_deposit locks the queue row and checks them again.
    const rawResult = await db.rpc('credit_ton_deposit', {
      p_user_id: resolvedUserId,
      p_tx_hash: deposit.tx_hash,
      p_from_address: deposit.from_address,
      p_amount: deposit.amount,
      p_comment: deposit.comment,
      p_tx_timestamp: deposit.tx_timestamp,
      p_unmatched_id: deposit.id,
    });
    const result = rpcObject(rawResult);
    return jsonResponse(result || { ok: false, error: 'Deposit credit failed' }, result?.ok ? 200 : 400);
  }

  return jsonResponse({ ok: false, error: 'Not found' }, 404);
}

// ============================================
// SOCIAL MISSIONS
// ============================================
async function handleMissions(request, env) {
  const { initData } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);
  if (!telegramUser) return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const missions = await db.query('social_missions', 'select', {
    filters: { enabled: true },
    order: 'sort.asc',
  });
  const done = await db.query('user_social_missions', 'select', {
    filters: { user_id: tgId, status: 'paid' },
  });
  // v3.3: las misiones repetibles solo cuentan como "Done" si se completaron
  // en el periodo actual (daily = hoy UTC, weekly = semana ISO en curso); si
  // no, Daily Holder quedaria marcada "Done" para siempre desde ayer.
  const todayKey = new Date().toISOString().slice(0, 10);
  const weekKey = isoWeekKey(new Date());
  const currentPeriod = (repeat) =>
    (repeat === 'daily' ? todayKey : repeat === 'weekly' ? weekKey : '');
  const byId = new Map((Array.isArray(missions) ? missions : []).map((x) => [x.id, x]));
  const completed = (Array.isArray(done) ? done : [])
    .filter((d) => (d.period || '') === currentPeriod(byId.get(d.mission_id)?.repeat || 'once'))
    .map((d) => d.mission_id);
  // Las misiones automáticas (First Deposit) no generan solicitudes: el cron
  // las completa dentro del RPC de depósito. `pending` queda reservado para
  // acciones realmente manuales, como compartir en una historia.
  const pendingRows = await db.query('user_social_missions', 'select', {
    filters: { user_id: tgId, status: 'pending' },
  });
  const pending = (Array.isArray(pendingRows) ? pendingRows : []).map((d) => d.mission_id);

  // v3.3: progreso REAL de las misiones 'progress' (holds de hoy, referidos
  // de la semana, ganancias de holds). Una sola llamada SQL para todas.
  const progress = await db.rpc('mission_progress', { p_user_id: tgId });

  return jsonResponse({
    ok: true,
    missions: (Array.isArray(missions) ? missions : []).map((m) => ({
      id: m.id, platform: m.platform, title: m.title, description: m.description,
      url: m.url, reward: Number(m.reward_usdt), verify: m.verify,
      // v3.3: KEEP fijo por mision (null = sorteo 500-1200), repetibilidad,
      // y para las de progreso su meta y el avance actual.
      reward_keep: m.reward_keep == null ? null : Number(m.reward_keep),
      repeat: m.repeat || 'once',
      goal: m.goal == null ? null : Number(m.goal),
      progress_type: m.progress_type || null,
      current: m.progress_type ? Number(progress?.[m.progress_type] || 0) : null,
      // v3.4: texto para el boton "Share on Telegram" (misiones de compartir).
      share_text: m.share_text || null,
    })),
    completed,
    pending,
    // Rango de KEEP que paga cada mision (v3.2), para mostrarlo en la card.
    keep_min: KEEP_CONFIG.MISSION_MIN,
    keep_max: KEEP_CONFIG.MISSION_MAX,
  });
}

async function handleVerifyMission(request, env) {
  const { initData, missionId } = await request.json();
  const telegramUser = await validateInitDataAny(initData, env.BOT_TOKEN);
  if (!telegramUser) return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const rows = await db.query('social_missions', 'select', {
    filters: { id: missionId, enabled: true },
    limit: 1,
  });
  const mission = (rows || [])[0];
  if (!mission) return jsonResponse({ ok: false, error: 'Unknown or disabled mission' }, 400);

  if (mission.verify === 'telegram_member') {
    if (!env.BOT_TOKEN) return jsonResponse({ ok: false, error: 'check_failed' }, 500);
    const check = await checkTelegramMembership(env.BOT_TOKEN, mission.chat_id, telegramUser.id);
    if (!check.ok) {
      // 'not_joined': el usuario todavia no entro. 'telegram_error': el bot no
      // puede ver el chat (falta admin) o la API no respondio. Distintos, y el
      // cliente los muestra distintos (apiCall levanta `error` tal cual).
      return jsonResponse(check.reason === 'not_joined'
        ? { ok: false, reason: check.reason, error: 'Not joined yet' }
        : { ok: false, reason: check.reason, error: 'Check failed. Try again.' }, 400);
    }
  } else if (mission.verify === 'progress') {
    // v3.3: misiones de progreso (Daily Holder, Social Butterfly, Big Earner).
    // El avance se mide SIEMPRE en el servidor contra datos reales; el numero
    // que muestra la app es solo informativo.
    const progress = await db.rpc('mission_progress', { p_user_id: tgId });
    const current = Number(progress?.[mission.progress_type] || 0);
    const goal = Number(mission.goal || 0);
    if (current < goal) {
      return jsonResponse({ ok: false, error: 'Progress not complete', current, goal }, 400);
    }
  } else if (mission.verify === 'automatic' || mission.verify === 'deposit') {
    // First Deposit se revisa dentro de credit_ton_deposit: el hash, el
    // comentario DEP y el monto quedan validados en la misma transacción que
    // acredita GRAM. Nunca se crea una solicitud manual desde la UI.
    return jsonResponse({
      ok: false,
      error: 'Automatic review is handled by the wallet deposit scanner',
    }, 400);
  } else if (mission.verify === 'manual') {
    // Las acciones que no se pueden comprobar automáticamente (por ejemplo,
    // compartir una historia) sí crean una solicitud para el admin.
    const req = await db.rpc('request_manual_mission', {
      p_user_id: tgId,
      p_mission_id: missionId,
    });
    if (req?.ok && req.pending) {
      return jsonResponse({ ok: true, pending: true });
    }
    return jsonResponse(req || { ok: false, error: 'failed' }, 400);
  }
  // 'honor' pasa directo: la unicidad la garantiza la PK en la base.

  // db.rpc manda un objeto con los nombres de los parametros de la funcion,
  // igual que el resto de los rpc de este archivo.
  const result = await db.rpc('complete_social_mission', {
    p_user_id: tgId,
    p_mission_id: missionId,
  });
  const body = result?.ok ? result : (result || {});
  if (body.ok) {
    return jsonResponse({
      ok: true,
      reward: body.reward,
      // v3.2: la mision tambien paga KEEP (500-1200, sorteados en el SQL).
      keep_reward: Number(body.keep_reward) || 0,
    });
  }
  return jsonResponse({ ok: false, error: body.error || 'failed' }, 400);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'POST') {
        switch (path) {
          case '/auth':           return await handleAuth(request, env);
          case '/hold':           return await handleHold(request, env);
          case '/claim':
          case '/get-claim':      return await handleGetClaim(request, env);
          case '/verify-payment': return await handleVerifyPayment(request, env);
          case '/transactions':   return await handleTransactions(request, env);
          case '/referrals':      return await handleReferrals(request, env);
          case '/trade':          return await handleTrade(request, env);
          case '/trade/close':    return await handleTradeClose(request, env);
          case '/trade/sell-asset': return await handleSellAsset(request, env);
          case '/trade/buy-keep':  return await handleBuyKeep(request, env);
          case '/trade/levels':   return await handleTradeLevels(request, env);
          case '/positions':      return await handlePositions(request, env);
          case '/withdraw':         return await handleWithdraw(request, env);
          case '/missions':        return await handleMissions(request, env);
          case '/verify-mission':  return await handleVerifyMission(request, env);
          case '/withdraw/settings': return await handleWithdrawSettings(request, env);
          case '/checkin':        return await handleCheckin(request, env);
          case '/checkin/status': return await handleCheckinStatus(request, env);
          // v3.3: cola de aprobaciones del admin (misiones manuales + retiros).
          case '/admin/missions/list':
          case '/admin/missions/approve':
          case '/admin/missions/reject':
          case '/admin/withdrawals/list':
          case '/admin/withdrawals/resolve':
          case '/admin/deposits/list':
          case '/admin/deposits/resolve':
            return await handleAdmin(request, env, path);
        }
      }

      if (path === '/price') {
        return await handlePrice(request, env, url);
      }

      if (path === '/' || path === '/health') {
        // Solo presencia (booleanos), nunca valores: 'Invalid initData' sale igual
        // si BOT_TOKEN falta, si está mal escrito o si es de otro bot, y desde
        // afuera no hay forma de distinguirlo.
        return jsonResponse({
          ok: true,
          service: 'TronKeeper API',
          // 3.4: check-in fijo 0.15+500, claim semanal por TonConnect,
          // misiones reales (progress/manual) y cola admin. Sirve para
          // verificar EN VIVO que el Worker corre el codigo nuevo: si /health
          // devuelve una version menor, el deploy no se hizo.
          version: '3.9',
          treasury: CONFIG.TREASURY_WALLET,
          env: {
            BOT_TOKEN: Boolean(env.BOT_TOKEN),
            SUPA_URL: Boolean(env.SUPA_URL),
            SUPA_SERVICE_KEY: Boolean(env.SUPA_SERVICE_KEY),
            TON_API_KEY: Boolean(env.TON_API_KEY),
            ADMIN_TOKEN: Boolean(env.ADMIN_TOKEN),
          },
          // Acá iba `envKeys: Object.keys(env)`, que listaba los nombres de
          // todas las variables del runtime — incluidas las internas de
          // Cloudflare. /health es público y sin autenticar, o sea que era un
          // mapa gratis del entorno para cualquier scanner. Los booleanos de
          // arriba alcanzan para saber si algo está configurado; para el caso
          // de un nombre mal escrito se mira en el dashboard
          // (Settings → Variables and Secrets), no desde internet.
        });
      }

      return jsonResponse({ error: 'Not found' }, 404);

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(
        // Sin error.message: puede contener nombres de tablas, columnas y
        // fragmentos de query. El detalle queda en console.error (logs del
        // Worker), que es donde lo necesita quien debuggea, no el cliente.
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
          }
        }
      );
    }
  },

  async scheduled(controller, env, ctx) {
    const sweep = runTonDepositSweep(env)
      .then((summary) => {
        console.log('TON deposit sweep completed', summary);
        return summary;
      })
      .catch((error) => {
        console.error('TON deposit sweep failed', error);
        throw error;
      });
    if (ctx?.waitUntil) return ctx.waitUntil(sweep);
    return sweep;
  },
};

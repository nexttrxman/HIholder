/**
 * TronKeeper Cloudflare Worker - TON Claims System
 * 
 * Environment Variables (Secrets):
 * - BOT_TOKEN: Telegram Bot Token
 * - SUPA_URL: Supabase project URL
 * - SUPA_SERVICE_KEY: Supabase service role key
 * - TON_API_KEY: TON Center API key (optional)
 * 
 * Treasury Wallet (V5): UQCydneDGeAcamdCFS6e13Z2xoxwA5DsLkFONRdp-cavw-Th
 */

const TREASURY_WALLET = 'UQCydneDGeAcamdCFS6e13Z2xoxwA5DsLkFONRdp-cavw-Th';
const CLAIM_EXPIRY_MINUTES = 15;
const CYCLE_DURATION_HOURS = 8;
const MAX_HOLDS_PER_CYCLE = 3;
const TON_FEE = 0.05; // 0.05 TON fee per claim

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

    const res = await fetch(url, {
      method: method === 'select' ? 'GET' : method === 'insert' ? 'POST' : 'PATCH',
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

// ============================================
// TELEGRAM VALIDATION
// ============================================
async function validateInitData(initData, botToken) {
  if (!initData) return null;
  
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    const sortedParams = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      'raw', encoder.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const secretKeyHash = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));
    
    const dataKey = await crypto.subtle.importKey(
      'raw', secretKeyHash,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', dataKey, encoder.encode(sortedParams));
    
    const calculatedHash = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    if (calculatedHash !== hash) return null;
    
    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch (e) {
    console.error('initData validation error:', e);
    return null;
  }
}

// ============================================
// HELPERS
// ============================================
function generateClaimId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `CLM_${timestamp}_${random}`.toUpperCase();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ============================================
// AUTH - Get or create user + active cycle
// ============================================
async function handleAuth(request, env) {
  const { initData } = await request.json();
  const telegramUser = await validateInitData(initData, env.BOT_TOKEN);
  
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  // Get or create user
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

    // Create internal wallet
    await db.query('internal_wallets', 'insert', {
      body: { user_id: tgId, usdt_balance: 0, trx_balance: 0, ton_balance: 0 }
    });
  }

  // Get or create active cycle
  let cycles = await db.query('hold_cycles', 'select', {
    filters: { user_id: tgId, status: 'active' },
    order: 'created_at.desc',
    limit: 1
  });
  let cycle = cycles[0];

  // Check if cycle expired
  if (cycle && new Date(cycle.ends_at) < new Date()) {
    await db.query('hold_cycles', 'patch', {
      filters: { id: cycle.id },
      body: { status: 'expired' }
    });
    cycle = null;
  }

  // Create new cycle if needed
  if (!cycle) {
    const now = new Date();
    const endsAt = new Date(now.getTime() + CYCLE_DURATION_HOURS * 60 * 60 * 1000);
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

  // Get internal wallet balance
  const wallets = await db.query('internal_wallets', 'select', { filters: { user_id: tgId } });
  const wallet = wallets[0] || { usdt_balance: 0, trx_balance: 0, ton_balance: 0 };

  // Check for pending claim
  const claims = await db.query('claims', 'select', {
    filters: { cycle_id: cycle.id, status: 'pending' }
  });
  const pendingClaim = claims[0];

  // Get referral stats
  const referrals = await db.query('referrals', 'select', { filters: { referrer_id: tgId } });
  const totalRefs = referrals?.length || 0;
  const trxFromRefs = referrals?.reduce((sum, r) => sum + (parseFloat(r.reward_amount) || 0), 0) || 0;

  return jsonResponse({
    ok: true,
    user: {
      uid: user.uid,
      usdt_balance: parseFloat(wallet.usdt_balance) || 0,
      trx_balance: parseFloat(wallet.trx_balance) || 0,
      ton_balance: parseFloat(wallet.ton_balance) || 0,
      total_refs: totalRefs,
      trx_refs: trxFromRefs,
    },
    cycle: {
      id: cycle.id,
      holds_completed: cycle.holds_completed,
      ends_at: cycle.ends_at,
      remaining_holds: MAX_HOLDS_PER_CYCLE - cycle.holds_completed,
    },
    pending_claim: pendingClaim ? {
      claim_id: pendingClaim.claim_id,
      total_prize: parseFloat(pendingClaim.total_prize),
      ton_fee: parseFloat(pendingClaim.ton_fee),
      expires_at: pendingClaim.expires_at,
    } : null,
    treasury_wallet: TREASURY_WALLET,
  });
}

// ============================================
// HOLD - Register a hold (max 3 per cycle)
// ============================================
async function handleHold(request, env) {
  const { initData, prize } = await request.json();
  const telegramUser = await validateInitData(initData, env.BOT_TOKEN);
  
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  if (!prize || prize <= 0 || prize > 0.10) {
    return jsonResponse({ ok: false, error: 'Invalid prize' }, 400);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  // Get active cycle
  const cycles = await db.query('hold_cycles', 'select', {
    filters: { user_id: tgId, status: 'active' },
    order: 'created_at.desc',
    limit: 1
  });
  const cycle = cycles[0];

  if (!cycle) {
    return jsonResponse({ ok: false, error: 'No active cycle' }, 400);
  }

  if (cycle.holds_completed >= MAX_HOLDS_PER_CYCLE) {
    return jsonResponse({ ok: false, error: 'Cycle complete. Claim your reward!' }, 400);
  }

  // Register hold
  const holdNumber = cycle.holds_completed + 1;
  await db.query('holds', 'insert', {
    body: {
      user_id: tgId,
      cycle_id: cycle.id,
      hold_number: holdNumber,
      prize_amount: prize
    }
  });

  // Update cycle
  await db.query('hold_cycles', 'patch', {
    filters: { id: cycle.id },
    body: { holds_completed: holdNumber }
  });

  // If 3 holds completed, create claim
  let claim = null;
  if (holdNumber === 3) {
    // Get total prize from all holds
    const holds = await db.query('holds', 'select', { filters: { cycle_id: cycle.id } });
    const totalPrize = holds.reduce((sum, h) => sum + parseFloat(h.prize_amount), 0);

    const claimId = generateClaimId();
    const expiresAt = new Date(Date.now() + CLAIM_EXPIRY_MINUTES * 60 * 1000);

    const claims = await db.query('claims', 'insert', {
      body: {
        claim_id: claimId,
        user_id: tgId,
        cycle_id: cycle.id,
        total_prize: totalPrize,
        ton_fee: TON_FEE,
        status: 'pending',
        expires_at: expiresAt.toISOString()
      }
    });
    claim = claims[0];
  }

  return jsonResponse({
    ok: true,
    hold_number: holdNumber,
    remaining_holds: MAX_HOLDS_PER_CYCLE - holdNumber,
    cycle_complete: holdNumber === 3,
    claim: claim ? {
      claim_id: claim.claim_id,
      total_prize: parseFloat(claim.total_prize),
      ton_fee: parseFloat(claim.ton_fee),
      expires_at: claim.expires_at,
      treasury_wallet: TREASURY_WALLET,
    } : null
  });
}

// ============================================
// GET CLAIM - Get pending claim info
// ============================================
async function handleGetClaim(request, env) {
  const { initData } = await request.json();
  const telegramUser = await validateInitData(initData, env.BOT_TOKEN);
  
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  // Get active cycle
  const cycles = await db.query('hold_cycles', 'select', {
    filters: { user_id: tgId, status: 'active' }
  });
  const cycle = cycles[0];

  if (!cycle) {
    return jsonResponse({ ok: true, claim: null });
  }

  // Get pending claim
  const claims = await db.query('claims', 'select', {
    filters: { cycle_id: cycle.id, status: 'pending' }
  });
  const claim = claims[0];

  if (!claim) {
    return jsonResponse({ ok: true, claim: null });
  }

  // Check if expired
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
      treasury_wallet: TREASURY_WALLET,
      payment_comment: `CLAIM:${claim.claim_id}`,
    }
  });
}

// ============================================
// VERIFY PAYMENT - Check TON payment and credit
// ============================================
async function handleVerifyPayment(request, env) {
  const { initData, claim_id, tx_hash } = await request.json();
  const telegramUser = await validateInitData(initData, env.BOT_TOKEN);
  
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  if (!claim_id || !tx_hash) {
    return jsonResponse({ ok: false, error: 'Missing claim_id or tx_hash' }, 400);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  // Get claim
  const claims = await db.query('claims', 'select', { filters: { claim_id } });
  const claim = claims[0];

  if (!claim) {
    return jsonResponse({ ok: false, error: 'Claim not found' }, 404);
  }

  if (claim.user_id !== tgId) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 403);
  }

  if (claim.status === 'credited') {
    return jsonResponse({ ok: true, already_credited: true });
  }

  if (claim.status === 'expired_unclaimed') {
    return jsonResponse({ ok: false, error: 'Claim expired' }, 400);
  }

  if (new Date(claim.expires_at) < new Date()) {
    await db.query('claims', 'patch', {
      filters: { claim_id },
      body: { status: 'expired_unclaimed' }
    });
    return jsonResponse({ ok: false, error: 'Claim expired' }, 400);
  }

  // Check if tx already processed
  const existingPayments = await db.query('claim_payments', 'select', { filters: { tx_hash } });
  if (existingPayments.length > 0) {
    return jsonResponse({ ok: false, error: 'Transaction already processed' }, 400);
  }

  // TODO: In production, verify tx on TON blockchain using TON API
  // For now, we trust the frontend to provide valid tx_hash
  // This should be replaced with actual TON API verification:
  // const txData = await verifyTonTransaction(tx_hash, env.TON_API_KEY);
  // Validate: txData.to === TREASURY_WALLET, txData.comment === `CLAIM:${claim_id}`, txData.amount >= TON_FEE

  // Credit the claim using the atomic function
  const result = await db.rpc('credit_claim', {
    p_claim_id: claim_id,
    p_tx_hash: tx_hash,
    p_amount: TON_FEE,
    p_from_address: 'user_wallet' // In production, get from tx verification
  });

  if (result.ok) {
    return jsonResponse({
      ok: true,
      credited: parseFloat(result.credited),
      new_balance: parseFloat(result.new_balance),
    });
  } else {
    return jsonResponse({ ok: false, error: result.error }, 400);
  }
}

// ============================================
// TRANSACTIONS
// ============================================
async function handleTransactions(request, env) {
  const { initData, limit = 50 } = await request.json();
  const telegramUser = await validateInitData(initData, env.BOT_TOKEN);
  
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  // Get from ledger
  const ledger = await db.query('wallet_ledger', 'select', {
    filters: { user_id: tgId },
    order: 'created_at.desc',
    limit
  });

  const transactions = ledger.map(l => ({
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
  const telegramUser = await validateInitData(initData, env.BOT_TOKEN);
  
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  const tgId = telegramUser.id.toString();

  const poolData = await db.query('referral_pool', 'select', { limit: 1 });
  const pool = poolData[0] || { total_pool: 50000, distributed: 0 };

  const referrals = await db.query('referrals', 'select', { filters: { referrer_id: tgId } });
  const yourEarnings = referrals?.reduce((sum, r) => sum + (parseFloat(r.reward_amount) || 0), 0) || 0;

  return jsonResponse({
    ok: true,
    pool: {
      total_pool: parseFloat(pool.total_pool),
      remaining: parseFloat(pool.total_pool) - parseFloat(pool.distributed),
      your_earnings: yourEarnings,
    },
  });
}

// ============================================
// MAIN HANDLER
// ============================================
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
          case '/auth':
            return handleAuth(request, env);
          case '/hold':
            return handleHold(request, env);
          case '/claim':
          case '/get-claim':
            return handleGetClaim(request, env);
          case '/verify-payment':
            return handleVerifyPayment(request, env);
          case '/transactions':
            return handleTransactions(request, env);
          case '/referrals':
            return handleReferrals(request, env);
        }
      }

      if (path === '/' || path === '/health') {
        return jsonResponse({ 
          ok: true, 
          service: 'TronKeeper API', 
          version: '2.0.0',
          treasury: TREASURY_WALLET 
        });
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};

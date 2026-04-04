/**
 * TronKeeper Cloudflare Worker
 * 
 * Architecture: Telegram Mini App -> This Worker -> Supabase
 * 
 * Environment Variables (Secrets):
 * - BOT_TOKEN: Telegram Bot Token (for initData validation)
 * - SUPA_URL: Supabase project URL
 * - SUPA_SERVICE_KEY: Supabase service role key
 * 
 * Endpoints:
 * - POST /auth         - Authenticate user, create if not exists
 * - POST /claim        - Claim hold reward
 * - POST /transactions - Get user transactions
 * - POST /withdraw     - Request withdrawal
 * - POST /referrals    - Get referral pool stats
 */

// CORS headers for Telegram Mini App
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Supabase client helper
const supabase = (env) => ({
  url: env.SUPA_URL,
  key: env.SUPA_SERVICE_KEY,
  
  async query(sql, params = []) {
    const response = await fetch(`${this.url}/rest/v1/rpc/raw_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': this.key,
        'Authorization': `Bearer ${this.key}`,
      },
      body: JSON.stringify({ query: sql, params }),
    });
    return response.json();
  },

  async from(table) {
    return {
      url: `${env.SUPA_URL}/rest/v1/${table}`,
      headers: {
        'Content-Type': 'application/json',
        'apikey': env.SUPA_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPA_SERVICE_KEY}`,
        'Prefer': 'return=representation',
      },

      async select(columns = '*', filters = {}) {
        let url = `${env.SUPA_URL}/rest/v1/${table}?select=${columns}`;
        for (const [key, value] of Object.entries(filters)) {
          url += `&${key}=eq.${value}`;
        }
        const res = await fetch(url, { headers: this.headers });
        return res.json();
      },

      async insert(data) {
        const res = await fetch(`${env.SUPA_URL}/rest/v1/${table}`, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(data),
        });
        return res.json();
      },

      async update(data, filters = {}) {
        let url = `${env.SUPA_URL}/rest/v1/${table}?`;
        for (const [key, value] of Object.entries(filters)) {
          url += `${key}=eq.${value}&`;
        }
        const res = await fetch(url, {
          method: 'PATCH',
          headers: this.headers,
          body: JSON.stringify(data),
        });
        return res.json();
      },

      async upsert(data) {
        const res = await fetch(`${env.SUPA_URL}/rest/v1/${table}`, {
          method: 'POST',
          headers: { ...this.headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(data),
        });
        return res.json();
      },
    };
  },
});

/**
 * Validate Telegram initData
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
async function validateInitData(initData, botToken) {
  if (!initData || initData === 'dev_mode') {
    return null; // Invalid in production
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    // Sort params alphabetically
    const sortedParams = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    // Create HMAC-SHA256
    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const secretKeyHash = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));
    
    const dataKey = await crypto.subtle.importKey(
      'raw',
      secretKeyHash,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', dataKey, encoder.encode(sortedParams));
    
    const calculatedHash = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (calculatedHash !== hash) {
      return null; // Invalid signature
    }

    // Parse user data
    const userStr = params.get('user');
    if (userStr) {
      return JSON.parse(userStr);
    }
    return null;
  } catch (e) {
    console.error('initData validation error:', e);
    return null;
  }
}

/**
 * Get or create user
 */
async function getOrCreateUser(env, telegramUser) {
  const db = supabase(env);
  const users = await db.from('users');
  
  // Try to find existing user
  const existing = await users.select('*', { telegram_id: telegramUser.id.toString() });
  
  if (existing && existing.length > 0) {
    return existing[0];
  }

  // Create new user
  const uid = `TK${telegramUser.id}`;
  const newUser = {
    telegram_id: telegramUser.id.toString(),
    uid: uid,
    username: telegramUser.username || null,
    first_name: telegramUser.first_name || null,
    last_name: telegramUser.last_name || null,
    usdt_balance: 0,
    trx_balance: 0,
    total_earned: 0,
    wins: 0,
    holds_count: 0,
    holds_reset_at: null,
    referred_by: null,
    created_at: new Date().toISOString(),
  };

  const result = await users.insert(newUser);
  return result[0] || newUser;
}

/**
 * POST /auth - Authenticate and get user data
 */
async function handleAuth(request, env) {
  const { initData } = await request.json();
  
  const telegramUser = await validateInitData(initData, env.BOT_TOKEN);
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const user = await getOrCreateUser(env, telegramUser);
  
  // Get referral stats
  const db = supabase(env);
  const referrals = await db.from('referrals');
  const userReferrals = await referrals.select('*', { referrer_id: user.telegram_id });
  const totalRefs = userReferrals?.length || 0;
  const trxFromRefs = userReferrals?.reduce((sum, r) => sum + (r.reward_amount || 0), 0) || 0;

  return jsonResponse({
    ok: true,
    user: {
      uid: user.uid,
      usdt_balance: user.usdt_balance || 0,
      trx_balance: user.trx_balance || 0,
      total_earned: user.total_earned || 0,
      wins: user.wins || 0,
      holds_count: user.holds_count || 0,
      holds_reset_at: user.holds_reset_at,
      total_refs: totalRefs,
      trx_refs: trxFromRefs,
    },
  });
}

/**
 * POST /claim - Claim hold reward
 */
async function handleClaim(request, env) {
  const { initData, prize } = await request.json();
  
  const telegramUser = await validateInitData(initData, env.BOT_TOKEN);
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  if (!prize || prize <= 0 || prize > 0.10) {
    return jsonResponse({ ok: false, error: 'Invalid prize amount' }, 400);
  }

  const db = supabase(env);
  const users = await db.from('users');
  
  // Get user
  const existing = await users.select('*', { telegram_id: telegramUser.id.toString() });
  if (!existing || existing.length === 0) {
    return jsonResponse({ ok: false, error: 'User not found' }, 404);
  }

  const user = existing[0];
  const now = Date.now();
  const sixHours = 6 * 60 * 60 * 1000;

  // Check holds limit
  let holdsCount = user.holds_count || 0;
  let holdsResetAt = user.holds_reset_at ? new Date(user.holds_reset_at).getTime() : 0;

  if (holdsResetAt && now > holdsResetAt) {
    // Reset holds
    holdsCount = 0;
    holdsResetAt = 0;
  }

  if (holdsCount >= 3) {
    return jsonResponse({ ok: false, error: 'Holds limit reached. Wait for reset.' }, 429);
  }

  // Update user
  const newTotal = (user.total_earned || 0) + prize;
  const newBalance = (user.usdt_balance || 0) + prize;
  const newWins = (user.wins || 0) + 1;
  const newHoldsCount = holdsCount + 1;
  const newResetAt = newHoldsCount === 1 ? new Date(now + sixHours).toISOString() : user.holds_reset_at;

  await users.update({
    total_earned: newTotal,
    usdt_balance: newBalance,
    wins: newWins,
    holds_count: newHoldsCount,
    holds_reset_at: newResetAt,
  }, { telegram_id: telegramUser.id.toString() });

  // Record claim transaction
  const transactions = await db.from('transactions');
  await transactions.insert({
    user_id: user.telegram_id,
    type: 'reward',
    asset: 'USDT',
    amount: prize,
    status: 'confirmed',
    description: 'Hold to Earn reward',
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    ok: true,
    total: newTotal,
    wins: newWins,
    holdsCount: newHoldsCount,
  });
}

/**
 * POST /transactions - Get user transactions
 */
async function handleTransactions(request, env) {
  const { initData, limit = 50, offset = 0, type } = await request.json();
  
  const telegramUser = await validateInitData(initData, env.BOT_TOKEN);
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);
  
  // Build query URL
  let url = `${env.SUPA_URL}/rest/v1/transactions?user_id=eq.${telegramUser.id}&order=created_at.desc&limit=${limit}&offset=${offset}`;
  if (type && type !== 'all') {
    url += `&type=eq.${type}`;
  }

  const response = await fetch(url, {
    headers: {
      'apikey': env.SUPA_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPA_SERVICE_KEY}`,
    },
  });

  const transactions = await response.json();

  // Format for frontend
  const formatted = (transactions || []).map(tx => ({
    id: tx.id,
    type: tx.type,
    asset: tx.asset,
    amount: tx.amount,
    status: tx.status,
    timestamp: new Date(tx.created_at).getTime(),
    description: tx.description,
    txHash: tx.tx_hash,
    toAddress: tx.to_address,
  }));

  return jsonResponse({ ok: true, transactions: formatted });
}

/**
 * POST /withdraw - Request withdrawal
 */
async function handleWithdraw(request, env) {
  const { initData, asset, amount, toAddress } = await request.json();
  
  const telegramUser = await validateInitData(initData, env.BOT_TOKEN);
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  // Validate input
  if (!asset || !['USDT', 'TRX'].includes(asset)) {
    return jsonResponse({ ok: false, error: 'Invalid asset' }, 400);
  }
  if (!amount || amount <= 0) {
    return jsonResponse({ ok: false, error: 'Invalid amount' }, 400);
  }
  if (!toAddress || !toAddress.startsWith('T') || toAddress.length !== 34) {
    return jsonResponse({ ok: false, error: 'Invalid TRON address' }, 400);
  }

  const minWithdraw = asset === 'USDT' ? 5 : 10;
  if (amount < minWithdraw) {
    return jsonResponse({ ok: false, error: `Minimum withdrawal is ${minWithdraw} ${asset}` }, 400);
  }

  const db = supabase(env);
  const users = await db.from('users');

  // Get user and check balance
  const existing = await users.select('*', { telegram_id: telegramUser.id.toString() });
  if (!existing || existing.length === 0) {
    return jsonResponse({ ok: false, error: 'User not found' }, 404);
  }

  const user = existing[0];
  const balanceField = asset === 'USDT' ? 'usdt_balance' : 'trx_balance';
  const currentBalance = user[balanceField] || 0;

  if (currentBalance < amount) {
    return jsonResponse({ ok: false, error: 'Insufficient balance' }, 400);
  }

  // Deduct balance
  await users.update({
    [balanceField]: currentBalance - amount,
  }, { telegram_id: telegramUser.id.toString() });

  // Create withdrawal record
  const withdrawals = await db.from('withdrawals');
  const withdrawal = await withdrawals.insert({
    user_id: user.telegram_id,
    asset: asset,
    amount: amount,
    to_address: toAddress,
    status: 'pending',
    created_at: new Date().toISOString(),
  });

  // Create transaction record
  const transactions = await db.from('transactions');
  await transactions.insert({
    user_id: user.telegram_id,
    type: 'withdraw',
    asset: asset,
    amount: amount,
    status: 'pending',
    to_address: toAddress,
    description: `Withdrawal to ${toAddress.slice(0, 8)}...`,
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    ok: true,
    status: 'pending',
    txId: withdrawal[0]?.id || `wd_${Date.now()}`,
    message: 'Withdrawal request submitted. Processing may take up to 24 hours.',
  });
}

/**
 * POST /referrals - Get referral pool stats
 */
async function handleReferrals(request, env) {
  const { initData } = await request.json();
  
  const telegramUser = await validateInitData(initData, env.BOT_TOKEN);
  if (!telegramUser) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  const db = supabase(env);

  // Get pool stats
  const poolUrl = `${env.SUPA_URL}/rest/v1/referral_pool?select=*&limit=1`;
  const poolRes = await fetch(poolUrl, {
    headers: {
      'apikey': env.SUPA_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPA_SERVICE_KEY}`,
    },
  });
  const poolData = await poolRes.json();
  const pool = poolData[0] || { total_pool: 50000, distributed: 0 };

  // Get user's referrals
  const referrals = await db.from('referrals');
  const userReferrals = await referrals.select('*', { referrer_id: telegramUser.id.toString() });
  
  const yourEarnings = userReferrals?.reduce((sum, r) => sum + (r.reward_amount || 0), 0) || 0;

  return jsonResponse({
    ok: true,
    pool: {
      total_pool: pool.total_pool,
      remaining: pool.total_pool - (pool.distributed || 0),
      your_earnings: yourEarnings,
    },
    referrals: (userReferrals || []).map(r => ({
      id: r.id,
      referred_user: r.referred_username || 'Anonymous',
      reward: r.reward_amount,
      date: r.created_at,
    })),
  });
}

/**
 * JSON response helper
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

/**
 * Main request handler
 */
export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Route requests
      if (request.method === 'POST') {
        switch (path) {
          case '/auth':
            return handleAuth(request, env);
          case '/claim':
            return handleClaim(request, env);
          case '/transactions':
            return handleTransactions(request, env);
          case '/withdraw':
            return handleWithdraw(request, env);
          case '/referrals':
            return handleReferrals(request, env);
        }
      }

      // Health check
      if (path === '/' || path === '/health') {
        return jsonResponse({ ok: true, service: 'TronKeeper API', version: '1.0.0' });
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};

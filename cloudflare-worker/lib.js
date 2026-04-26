/**
 * TronKeeper Worker - Pure helpers (testable in isolation)
 *
 * No Cloudflare bindings used here. Everything is dependency-injected so the
 * functions are unit-testable under Node.js.
 */

export const CONFIG = {
  TREASURY_WALLET: 'UQCydneDGeAcamdCFS6e13Z2xoxwA5DsLkFONRdp-cavw-Th',
  CLAIM_EXPIRY_MINUTES: 15,
  CYCLE_DURATION_HOURS: 8,
  MAX_HOLDS_PER_CYCLE: 3,
  TON_FEE: 0.05, // TON per claim
  TONCENTER_BASE: 'https://toncenter.com/api/v2',
};

// ============================================
// JSON RESPONSE
// ============================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ============================================
// CLAIM ID
// ============================================
export function generateClaimId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `CLM_${timestamp}_${random}`.toUpperCase();
}

// ============================================
// TELEGRAM initData VALIDATION (HMAC-SHA256)
// ============================================
export async function validateInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
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
// TON ADDRESS NORMALIZATION
// ============================================
/**
 * Normalize a TON address for equality comparison.
 *
 * TON addresses come in multiple formats:
 *   - Raw: "0:abc123..."  (workchain:hexHash, lowercase)
 *   - User-friendly: "EQ..." / "UQ..." / "kQ..." / "0Q..." (base64 with checksum)
 *
 * TonConnect always returns raw "0:hex" lowercase.
 * TonCenter v2 in_msg.source is also raw "0:hex" lowercase.
 *
 * To be defensive, we normalize:
 *   - Trim whitespace
 *   - Lowercase
 *   - For raw "wc:hex", keep as-is (already canonical)
 *   - For friendly "EQ.../UQ...", we cannot decode without TonWeb. We return
 *     the lowercased friendly form. Direct equality between raw and friendly
 *     will NOT match — but TonConnect + TonCenter both deliver raw, so this
 *     is fine for our flow.
 */
export function normalizeTonAddress(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.trim().toLowerCase();
}

// ============================================
// TON COMMENT DECODING
// ============================================
/**
 * Extract the text comment from a TonCenter v2 in_msg object.
 *
 * TonCenter returns either:
 *   in_msg.message: "CLAIM:CLM_XXX"  (sometimes plain string)
 *   in_msg.msg_data.text: "Q0xBSU06Q0xN..."  (base64 of UTF-8 bytes prefixed
 *     with the 4-byte op code 0x00000000 for text comments)
 *
 * The reference Telegram-style text comment payload starts with 4 zero bytes
 * (the op code for "text comment"). When TonCenter returns msg_data.text it
 * may include that prefix; we strip leading zero bytes to be safe.
 */
export function decodeTonComment(inMsg) {
  if (!inMsg) return '';

  // Direct message field (some TonCenter versions decode it for us)
  if (typeof inMsg.message === 'string' && inMsg.message.length > 0) {
    return inMsg.message.replace(/^\0+/, '');
  }

  // msg_data.text is base64 of the message body cells. For a simple text
  // comment, after base64-decode we get: 4 bytes opcode (0x00000000) + utf8.
  const b64 = inMsg.msg_data?.text || inMsg.msg_data?.body;
  if (!b64) return '';

  try {
    // Cross-runtime base64 decode (atob exists in CF Workers and modern Node)
    let bin;
    if (typeof atob === 'function') {
      bin = atob(b64);
    } else {
      bin = Buffer.from(b64, 'base64').toString('binary');
    }

    // Strip leading null bytes (text-comment opcode)
    let start = 0;
    while (start < bin.length && bin.charCodeAt(start) === 0) start++;

    // Convert remaining bytes to UTF-8 string
    const bytes = new Uint8Array(bin.length - start);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = bin.charCodeAt(start + i);
    }
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(bytes);
    }
    return Buffer.from(bytes).toString('utf-8');
  } catch (e) {
    console.error('decodeTonComment error:', e);
    return '';
  }
}

// ============================================
// TON CENTER - Fetch treasury transactions
// ============================================
export async function fetchTreasuryTransactions({
  treasury,
  tonApiKey,
  limit = 30,
  fetchImpl = fetch,
}) {
  const params = new URLSearchParams({
    address: treasury,
    limit: String(limit),
    archival: 'true',
  });
  if (tonApiKey) params.set('api_key', tonApiKey);

  const url = `${CONFIG.TONCENTER_BASE}/getTransactions?${params.toString()}`;
  const res = await fetchImpl(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`TonCenter HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`TonCenter error: ${data.error || 'unknown'}`);
  }
  return Array.isArray(data.result) ? data.result : [];
}

// ============================================
// FIND VALID TON PAYMENT
// ============================================
/**
 * Search the treasury's recent inbound transactions for one matching:
 *   - in_msg.source == senderAddress (normalized)
 *   - decoded comment == "CLAIM:<claimId>"
 *   - in_msg.value (nanoTON) >= minAmountNano
 *   - tx.utime >= earliestUtime (defends against replaying old txs)
 *
 * Returns { tx_hash, from_address, amount_nano, comment, utime } or null.
 */
export async function findValidTonPayment({
  treasury = CONFIG.TREASURY_WALLET,
  tonApiKey,
  senderAddress,
  claimId,
  minAmountNano,
  earliestUtime = 0,
  fetchImpl = fetch,
  // Test hook: allows injecting a tx list directly to bypass HTTP
  txsOverride = null,
}) {
  const expectedSender = normalizeTonAddress(senderAddress);
  const expectedComment = `CLAIM:${claimId}`;

  if (!expectedSender || !claimId) return null;

  const txs = txsOverride
    ? txsOverride
    : await fetchTreasuryTransactions({ treasury, tonApiKey, limit: 30, fetchImpl });

  for (const tx of txs) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;

    const source = normalizeTonAddress(inMsg.source);
    if (source !== expectedSender) continue;

    const comment = decodeTonComment(inMsg);
    if (comment !== expectedComment) continue;

    const value = parseInt(inMsg.value || '0', 10);
    if (!Number.isFinite(value) || value < minAmountNano) continue;

    const utime = parseInt(tx.utime || '0', 10);
    if (utime < earliestUtime) continue;

    const txHash =
      tx.transaction_id?.hash ||
      `${tx.transaction_id?.lt || 'unknown'}_${utime}`;

    return {
      tx_hash: txHash,
      from_address: inMsg.source,
      amount_nano: value,
      comment,
      utime,
    };
  }

  return null;
}

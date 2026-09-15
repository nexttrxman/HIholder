// Ruta REAL de migracion v3.3: base = schema.sql hasta v3.2 (lo que tiene la
// base del usuario una vez aplicado v3.2) + migrate-v3.3.sql.
//
//   1. Que el archivo que va al SQL Editor funcione SOBRE ESA BASE.
//   2. Que sea idempotente: se puede pegar dos veces sin romper nada.
//   3. Drift: el cuerpo de migrate-v3.3.sql es byte a byte el bloque v3.3 de
//      schema.sql, igual que se verifica para v3.0/v3.1/v3.2.
//   4. Humo funcional: check-in fijo 0.15+500, claim semanal 1.5+2000 con
//      vencimiento de fin de semana ISO, misiones reales (manual/progress),
//      referidos en USDT.
//
//   cd supabase/tests && npm install && npm run test:migrate-v33
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 55472;
const strip = (s) =>
  s.replace('CREATE EXTENSION IF NOT EXISTS "pg_cron";', '-- pg_cron')
   .replace(/DO \$\$\s*BEGIN[\s\S]*?cron\.schedule[\s\S]*?\$\$;/, '-- bloque pg_cron omitido (solo arnes)');

let failures = 0;
const check = (n, ok, d) => { if (!ok) failures++; console.log(`${ok?'PASS':'FAIL'}  ${n}${d?`  -> ${d}`:''}`); };

// ---- Drift: schema.sql vs migrate-v3.3.sql (sin levantar postgres) ----
{
  const schemaLines = fs.readFileSync(path.resolve(HERE,'..','schema.sql'),'utf8').split('\n');
  const migLines = fs.readFileSync(path.resolve(HERE,'..','migrate-v3.3.sql'),'utf8').split('\n');
  const s33 = schemaLines.findIndex((l) => l.startsWith('-- v3.3 — check-in'));
  const mi = migLines.findIndex((l) => l.startsWith('-- v3.3 — check-in'));
  // Desde v3.4 el bloque v3.3 ya no llega al EOF de schema.sql: termina donde
  // empieza el bloque v3.4 (su marca, precedida de separadora y linea en blanco).
  const s34 = schemaLines.findIndex((l) => l.startsWith('-- v3.4 — misiones'));
  let end33 = s34 >= 0 ? s34 - 2 : schemaLines.length;
  while (end33 > 0 && schemaLines[end33 - 1].trim() === '') end33 -= 1;
  const cuerpo = schemaLines.slice(s33, end33);
  check('migrate-v3.3.sql no se desincronizo de schema.sql',
    s33 >= 0 && mi >= 0 && JSON.stringify(migLines.slice(mi, mi + cuerpo.length)) === JSON.stringify(cuerpo),
    `schema.sql:${s33 + 1}..${end33} vs migrate-v3.3.sql:${mi + 1}`);
  check('migrate-v3.3.sql termina donde termina su bloque',
    migLines.length - (mi + cuerpo.length) <= 1,
    `${migLines.length} vs ${mi + cuerpo.length}`);
}

const db = new EmbeddedPostgres({ databaseDir: path.join(HERE,'pgdata-migrate-v33'), user:'postgres', password:'postgres', port: PORT, persistent:false });
await db.initialise(); await db.start();
const c = new pg.Client(`postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);
await c.connect();
const one = async (s,p) => (await c.query(s,p)).rows[0];

// Base: schema.sql SIN el bloque v3.3 = el estado real tras v3.2.
const full = fs.readFileSync(path.resolve(HERE,'..','schema.sql'),'utf8');
const markerIdx = full.indexOf('-- v3.3 — check-in');
const sepIdx = full.lastIndexOf('-- =============================================', markerIdx);
const cut = full.slice(0, sepIdx);
await c.query(strip(cut));
console.log('--- base aplicada: schema.sql hasta v3.2 ---');

check('la base NO tiene claims.claim_type',
  Number((await one(`SELECT count(*) c FROM information_schema.columns
    WHERE table_name='claims' AND column_name='claim_type'`)).c) === 0);

// migrate-v3.3, dos veces (idempotencia)
await c.query(strip(fs.readFileSync(path.resolve(HERE,'..','migrate-v3.3.sql'),'utf8')));
console.log('--- migrate-v3.3 aplicado ---');
await c.query(strip(fs.readFileSync(path.resolve(HERE,'..','migrate-v3.3.sql'),'utf8')));
check('migrate-v3.3 es idempotente', true);

// ---- Estructura post-migracion ----
check('claims.claim_type + week_key existen',
  Number((await one(`SELECT count(*) c FROM information_schema.columns
    WHERE table_name='claims' AND column_name IN ('claim_type','week_key')`)).c) === 2);
check('cycle_id ahora es nullable',
  (await one(`SELECT is_nullable n FROM information_schema.columns
    WHERE table_name='claims' AND column_name='cycle_id'`)).n === 'YES');
check('indice unico semanal por usuario',
  Number((await one(`SELECT count(*) c FROM pg_indexes WHERE indexname='uq_weekly_claim_per_week'`)).c) === 1);
check('social_missions: reward_keep/repeat/goal/progress_type',
  Number((await one(`SELECT count(*) c FROM information_schema.columns
    WHERE table_name='social_missions'
      AND column_name IN ('reward_keep','repeat','goal','progress_type')`)).c) === 4);
check('verify acepta progress',
  (await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
    WHERE conname='social_missions_verify_check'`)).d.includes('progress'));
check('user_social_missions: period + status',
  Number((await one(`SELECT count(*) c FROM information_schema.columns
    WHERE table_name='user_social_missions' AND column_name IN ('period','status')`)).c) === 2);
check('PK nueva (user, mision, periodo)',
  (await one(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
    WHERE conname='user_social_missions_pkey'`)).d.replace(/\s/g,'') ===
    'PRIMARYKEY(user_id,mission_id,period)');
check('funciones v3.3 presentes',
  Number((await one(`SELECT count(*) c FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('request_manual_mission','approve_mission_request',
      'reject_mission_request','list_pending_mission_requests','mission_progress')`)).c) === 5);

// Las 4 misiones nuevas, canonicas
const m = (id) => one(`SELECT reward_usdt, reward_keep, verify, repeat, goal, progress_type, enabled
  FROM social_missions WHERE id=$1`, [id]);
const fd = await m('first_deposit');
check('First Deposit: 1 USDT + 3000 KEEP, manual',
  Number(fd.reward_usdt)===1 && fd.reward_keep===3000 && fd.verify==='manual' && fd.enabled===true,
  JSON.stringify(fd));
const dh = await m('daily_hold');
check('Daily Holder: 0.10 USDT, diaria, 3 holds',
  Number(dh.reward_usdt)===0.1 && dh.repeat==='daily' && dh.goal===3 && dh.progress_type==='holds_today',
  JSON.stringify(dh));
const wr = await m('weekly_referral');
check('Social Butterfly: 0.50 USDT, semanal, 5 amigos',
  Number(wr.reward_usdt)===0.5 && wr.repeat==='weekly' && wr.goal===5 && wr.progress_type==='referrals_week',
  JSON.stringify(wr));
const be = await m('big_earner');
check('Big Earner: 2 USDT, unica, $10',
  Number(be.reward_usdt)===2 && be.repeat==='once' && be.goal===10 && be.progress_type==='hold_earnings',
  JSON.stringify(be));
check('las misiones de Telegram siguen intactas',
  Number((await one(`SELECT count(*) c FROM social_missions
    WHERE verify='telegram_member' AND enabled`)).c) === 2);

// ---- Check-in: 0.15 USDT + 500 KEEP fijos ----
const u = '99001';
await c.query(`INSERT INTO users (telegram_id, uid, username) VALUES ($1,'u99001','ck')`, [u]);
await c.query(`INSERT INTO internal_wallets (user_id, usdt_balance, keep_balance) VALUES ($1, 10, 0)`, [u]);

let r = (await one(`SELECT daily_checkin($1) AS r`, [u])).r;
check('check-in diario ok', r.ok===true, JSON.stringify(r));
check('premio diario fijo 0.15 USDT', Number(r.daily_reward)===0.15, String(r.daily_reward));
check('KEEP diario fijo 500', Number(r.keep_reward)===500, String(r.keep_reward));
const w1 = await one(`SELECT usdt_balance, keep_balance FROM internal_wallets WHERE user_id=$1`, [u]);
check('wallet refleja 10.15 / 500',
  Number(w1.usdt_balance)===10.15 && Number(w1.keep_balance)===500, JSON.stringify(w1));

r = (await one(`SELECT daily_checkin($1) AS r`, [u])).r;
check('doble check-in el mismo dia se rechaza', r.ok===false && r.error==='already_checked_in');

// ---- Semana completa: abre el claim semanal ----
// 6 checkins "previos" de la misma semana ISO (fechas distintas de hoy).
const weekRow = await one(`SELECT to_char(now() AT TIME ZONE 'UTC','IYYY-"W"IW') AS wk,
  (now() AT TIME ZONE 'UTC')::date AS hoy`);
const fakeDate = (back) => {
  const d = new Date(`${weekRow.hoy.toISOString().slice(0,10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0,10);
};
for (let i = 1; i <= 6; i++) {
  await c.query(`INSERT INTO checkins (user_id, checkin_date, streak, week_key)
    VALUES ($1, $2::date, $3, $4)
    ON CONFLICT (user_id, checkin_date) DO UPDATE SET week_key = EXCLUDED.week_key`,
    [u, fakeDate(i + 30), i + 30, weekRow.wk]); // fechas fuera de esta semana pero week_key forzado
}
// El conteo semanal es por week_key: reescribimos el week_key de la fila real de hoy ya existe;
// las 6 de arriba tienen week_key de esta semana => 7 en total al contar.
r = (await one(`SELECT daily_checkin($1) AS r`, ['99002'])).r; // otro usuario no llega a 7
await c.query(`INSERT INTO users (telegram_id, uid, username) VALUES ('99003','u99003','x') ON CONFLICT DO NOTHING`);

// Para u ya hizo check-in hoy; forzamos el camino del dia 7 con un usuario nuevo
// que tenga 6 filas de esta semana + la de hoy.
const u7 = '99003';
for (let i = 1; i <= 6; i++) {
  await c.query(`INSERT INTO checkins (user_id, checkin_date, streak, week_key)
    VALUES ($1, $2::date, $3, $4)
    ON CONFLICT (user_id, checkin_date) DO UPDATE SET week_key = EXCLUDED.week_key`,
    [u7, fakeDate(i + 30), i + 30, weekRow.wk]);
}
await c.query(`INSERT INTO internal_wallets (user_id, usdt_balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`, [u7]);
r = (await one(`SELECT daily_checkin($1) AS r`, [u7])).r;
check('dia 7: check-in ok', r.ok===true, JSON.stringify(r));
check('dia 7: abre claim semanal', !!r.weekly_claim_id, String(r.weekly_claim_id));
check('dia 7: ya no acredita bono directo', Number(r.weekly_bonus)===0 && Number(r.keep_weekly)===0);

const wc = await one(`SELECT claim_id, total_prize, ton_fee, status, claim_type, week_key, expires_at,
  (expires_at > now()) AS vivo,
  (date_trunc('week', expires_at AT TIME ZONE 'UTC') = date_trunc('week', now() AT TIME ZONE 'UTC') + interval '7 days') AS vence_lunes
  FROM claims WHERE user_id=$1 AND claim_type='weekly'`, [u7]);
check('claim semanal: 1.5 USDT / 0.15 TON / pending',
  wc && Number(wc.total_prize)===1.5 && Number(wc.ton_fee)===0.15 && wc.status==='pending', JSON.stringify(wc));
check('claim semanal vence al fin de la semana ISO', wc?.vence_lunes===true && wc?.vivo===true);

// Un segundo intento en la misma semana no duplica el claim.
const dup = await c.query(`INSERT INTO claims (claim_id, user_id, total_prize, ton_fee, expires_at, claim_type, week_key)
  VALUES ('CLM_DUP_TEST', $1, 1.5, 0.15, now() + interval '1 day', 'weekly', $2)
  ON CONFLICT DO NOTHING RETURNING claim_id`, [u7, weekRow.wk]).catch((e) => e);
check('indice unico bloquea dos claims semanales',
  (dup instanceof Error) || (dup.rowCount === 0), String(dup?.rowCount ?? dup?.message));

// ---- credit_claim semanal: 2000 KEEP fijos ----
const saldoAntes = await one(`SELECT usdt_balance, keep_balance FROM internal_wallets WHERE user_id=$1`, [u7]);
const cred = (await one(`SELECT credit_claim($1, 'TXWEEK01', 0.15, 'EQSender') AS r`, [wc.claim_id])).r;
check('credit_claim semanal ok', cred.ok===true, JSON.stringify(cred));
check('acredita 1.5 USDT', Number(cred.credited)===1.5);
check('KEEP semanal FIJO 2000', Number(cred.keep_credited)===2000, String(cred.keep_credited));
const saldoDesp = await one(`SELECT usdt_balance, keep_balance FROM internal_wallets WHERE user_id=$1`, [u7]);
check('wallet: +1.5 USDT y +2000 KEEP',
  Number(saldoDesp.usdt_balance) === Number(saldoAntes.usdt_balance) + 1.5
  && Number(saldoDesp.keep_balance) === Number(saldoAntes.keep_balance) + 2000,
  JSON.stringify(saldoDesp));
const descLedger = await one(`SELECT description FROM wallet_ledger
  WHERE user_id=$1 AND asset='USDT' AND description LIKE 'Weekly check-in%'`, [u7]);
check('ledger dice Weekly check-in prize', !!descLedger);

// credit_claim de holds sigue sorteando 500-2500 (defensa: no es 2000 fijo siempre)
let sorteos = new Set();
for (let i = 0; i < 12; i++) {
  const uu = `9910${i}`;
  await c.query(`INSERT INTO users (telegram_id, uid) VALUES ($1, $1)`, [uu]);
  await c.query(`INSERT INTO internal_wallets (user_id, usdt_balance) VALUES ($1, 0)`, [uu]);
  await c.query(`INSERT INTO claims (claim_id, user_id, total_prize, ton_fee, expires_at, claim_type)
    VALUES ($1, $2, 0.5, 0.15, now() + interval '10 min', 'hold')`, [`CLM_H${i}`, uu]);
  const rc = (await one(`SELECT credit_claim($1, $2, 0.15, 'EQS') AS r`, [`CLM_H${i}`, `TXH${i}`])).r;
  sorteos.add(Number(rc.keep_credited));
}
check('claim de holds sigue con KEEP aleatorio (500-2500)',
  sorteos.size >= 2 && [...sorteos].every((k) => k >= 500 && k <= 2500), JSON.stringify([...sorteos]));

// ---- Misiones: manual (First Deposit) ----
const saldoFd0 = await one(`SELECT usdt_balance, keep_balance FROM internal_wallets WHERE user_id=$1`, [u]);
r = (await one(`SELECT complete_social_mission($1,'first_deposit') AS r`, [u])).r;
check('complete directo de mision manual se rechaza', r.ok===false && r.error==='manual_review', JSON.stringify(r));
r = (await one(`SELECT request_manual_mission($1,'first_deposit') AS r`, [u])).r;
check('solicitud manual creada', r.ok===true && r.pending===true, JSON.stringify(r));
r = (await one(`SELECT complete_social_mission($1,'first_deposit') AS r`, [u])).r;
check('complete jamas procesa misiones manuales (aun con solicitud)',
  r.ok===false && r.error==='manual_review', JSON.stringify(r));
const pend = await one(`SELECT count(*) c FROM list_pending_mission_requests() WHERE user_id=$1`, [u]);
check('aparece en list_pending_mission_requests', Number(pend.c)===1);
r = (await one(`SELECT approve_mission_request($1,'first_deposit') AS r`, [u])).r;
check('aprobacion manual ok', r.ok===true && Number(r.reward)===1 && Number(r.keep_reward)===3000, JSON.stringify(r));
const saldoFd1 = await one(`SELECT usdt_balance, keep_balance FROM internal_wallets WHERE user_id=$1`, [u]);
check('First Deposit pago 1 USDT + 3000 KEEP',
  Number(saldoFd1.usdt_balance) === Number(saldoFd0.usdt_balance) + 1
  && Number(saldoFd1.keep_balance) === Number(saldoFd0.keep_balance) + 3000,
  JSON.stringify(saldoFd1));
r = (await one(`SELECT approve_mission_request($1,'first_deposit') AS r`, [u])).r;
check('doble aprobacion se rechaza', r.ok===false);
r = (await one(`SELECT request_manual_mission($1,'first_deposit') AS r`, [u])).r;
check('ya cobrada: no se puede volver a pedir', r.ok===false && r.error==='already');

// Rechazo: otro usuario pide, se rechaza y puede volver a pedir
const u2 = '99201';
await c.query(`INSERT INTO users (telegram_id, uid) VALUES ($1,$1)`, [u2]);
await c.query(`INSERT INTO internal_wallets (user_id, usdt_balance) VALUES ($1, 0)`, [u2]);
await one(`SELECT request_manual_mission($1,'first_deposit') AS r`, [u2]);
r = (await one(`SELECT reject_mission_request($1,'first_deposit') AS r`, [u2])).r;
check('rechazo manual ok', r.ok===true);
r = (await one(`SELECT request_manual_mission($1,'first_deposit') AS r`, [u2])).r;
check('tras el rechazo puede volver a pedir', r.ok===true && r.pending===true);

// ---- Misiones de progreso ----
// 3 holds hoy para u2
const cyc = await one(`INSERT INTO hold_cycles (user_id, ends_at) VALUES ($1, now() + interval '8 h') RETURNING id`, [u2]);
for (let i = 1; i <= 3; i++) {
  await c.query(`INSERT INTO holds (user_id, cycle_id, hold_number, prize_amount) VALUES ($1,$2,$3,0.2)`, [u2, cyc.id, i]);
}
let prog = (await one(`SELECT mission_progress($1) AS r`, [u2])).r;
check('mission_progress: holds_today = 3', Number(prog.holds_today)===3, JSON.stringify(prog));
r = (await one(`SELECT complete_social_mission($1,'daily_hold') AS r`, [u2])).r;
check('Daily Holder paga 0.10 USDT + 500-1200 KEEP',
  r.ok===true && Number(r.reward)===0.1 && Number(r.keep_reward)>=500 && Number(r.keep_reward)<=1200, JSON.stringify(r));
const periodHoy = (await one(`SELECT (now() AT TIME ZONE 'UTC')::date::text AS p`)).p;
check('fila diaria con periodo = hoy',
  Number((await one(`SELECT count(*) c FROM user_social_missions
    WHERE user_id=$1 AND mission_id='daily_hold' AND period=$2`, [u2, periodHoy])).c)===1);
r = (await one(`SELECT complete_social_mission($1,'daily_hold') AS r`, [u2])).r;
check('Daily Holder no se repite el mismo dia', r.ok===false && r.error==='already');

// Referidos de la semana + Big Earner
await c.query(`INSERT INTO users (telegram_id, uid) VALUES ('99202','99202'),('99203','99203')`);
await c.query(`INSERT INTO referrals (referrer_id, referred_id, status) VALUES ($1,'99202','confirmed'),($1,'99203','confirmed')`, [u2]);
await c.query(`INSERT INTO claims (claim_id, user_id, total_prize, ton_fee, expires_at, claim_type, status)
  VALUES ('CLM_E1', $1, 6.0, 0.15, now() + interval '1 h', 'hold', 'credited')`, [u2]);
prog = (await one(`SELECT mission_progress($1) AS r`, [u2])).r;
check('mission_progress: referrals_week = 2', Number(prog.referrals_week)===2, JSON.stringify(prog));
check('mission_progress: hold_earnings = 6', Number(prog.hold_earnings)===6, JSON.stringify(prog));
r = (await one(`SELECT complete_social_mission($1,'weekly_referral') AS r`, [u2])).r;
check('Social Butterfly: periodo = semana ISO',
  r.ok===true && /^\d{4}-W\d{2}$/.test(r.period), JSON.stringify(r));
r = (await one(`SELECT complete_social_mission($1,'big_earner') AS r`, [u2])).r;
check('Big Earner cobra (el Worker valida el progreso)', r.ok===true && Number(r.reward)===2, JSON.stringify(r));
r = (await one(`SELECT complete_social_mission($1,'big_earner') AS r`, [u2])).r;
check('Big Earner es unica', r.ok===false && r.error==='already');

// Mision de Telegram sigue pagando con sorteo 500-1200 (reward_keep NULL)
r = (await one(`SELECT complete_social_mission($1,'tg_channel') AS r`, [u2])).r;
check('mision Telegram: 0.4 USDT + 500-1200 KEEP',
  r.ok===true && Number(r.reward)===0.4 && Number(r.keep_reward)>=500 && Number(r.keep_reward)<=1200,
  JSON.stringify(r));

// ---- Referidos pagan USDT ----
const u3 = '99301', u4 = '99302';
await c.query(`INSERT INTO users (telegram_id, uid) VALUES ($1,$1),($2,$2)`, [u3, u4]);
await c.query(`INSERT INTO internal_wallets (user_id, usdt_balance) VALUES ($1, 0),($2, 0)`, [u3, u4]);
await c.query(`INSERT INTO referrals (referrer_id, referred_id, reward_amount, reward_asset, status)
  VALUES ($1, $2, 2, 'USDT', 'pending')`, [u3, u4]);
const ref = (await one(`SELECT confirm_pending_referral($1) AS r`, [u4])).r;
check('referido confirmado', ref.ok===true && ref.confirmed===true, JSON.stringify(ref));
const saldoU3 = await one(`SELECT usdt_balance, trx_balance FROM internal_wallets WHERE user_id=$1`, [u3]);
check('bonus de referido va a USDT (no TRX)',
  Number(saldoU3.usdt_balance)===2 && Number(saldoU3.trx_balance)===0, JSON.stringify(saldoU3));
check('default de referrals.reward_asset = USDT',
  (await one(`SELECT column_default d FROM information_schema.columns
    WHERE table_name='referrals' AND column_name='reward_asset'`)).d.includes('USDT'));

// ---- Expiracion del claim semanal ----
const u5 = '99401';
await c.query(`INSERT INTO users (telegram_id, uid) VALUES ($1,$1)`, [u5]);
await c.query(`INSERT INTO claims (claim_id, user_id, total_prize, ton_fee, expires_at, claim_type, week_key)
  VALUES ('CLM_EXP33', $1, 1.5, 0.15, now() - interval '1 h', 'weekly', '2020-W01')`, [u5]);
await c.query(`SELECT expire_claims_and_cycles()`);
const exp = await one(`SELECT status FROM claims WHERE claim_id='CLM_EXP33'`);
check('claim semanal vencido se marca expired_unclaimed', exp.status==='expired_unclaimed', exp.status);

// ---- Permisos ----
const acl = await one(`SELECT count(*) c FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('request_manual_mission','approve_mission_request','reject_mission_request',
                      'list_pending_mission_requests','mission_progress')
    AND has_function_privilege('public', p.oid, 'EXECUTE')`);
check('las funciones nuevas NO son publicas', Number(acl.c)===0, String(acl.c));

await c.end(); await db.stop();
console.log(`\n${failures===0 ? 'TODO OK' : failures+' FALLOS'}`);
process.exit(failures?1:0);

-- ============================================================
-- Limpieza de datos históricos (ejecutar 1 vez al mes).
--
-- Con muchos usuarios, holds/claims/ciclos viejos crecen sin fin.
-- Esto borra registros de más de 180 días YA cerrados.
-- NO toca: users, wallets, ledger financiero, payments, referrals.
--
-- Uso:
--   cat scripts/retention.sql | docker compose exec -T postgres \
--     psql -U postgres -d trxkeeper
-- ============================================================

-- 1. Holds de ciclos cerrados con más de 180 días
DELETE FROM holds h
USING hold_cycles c
WHERE h.cycle_id = c.id
  AND c.status IN ('completed', 'expired')
  AND c.ends_at < NOW() - INTERVAL '180 days';

-- 2. Claims cerrados con más de 180 días
DELETE FROM claims
WHERE status IN ('credited', 'expired_unclaimed')
  AND created_at < NOW() - INTERVAL '180 days';

-- 3. Ciclos cerrados con más de 180 días (ya sin holds ni claims)
DELETE FROM hold_cycles
WHERE status IN ('completed', 'expired')
  AND ends_at < NOW() - INTERVAL '180 days'
  AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.cycle_id = hold_cycles.id)
  AND NOT EXISTS (SELECT 1 FROM claims cl WHERE cl.cycle_id = hold_cycles.id);

-- 4. Recupera espacio (puede tardar; ejecútalo en horario valle)
VACUUM (ANALYZE) holds;
VACUUM (ANALYZE) claims;
VACUUM (ANALYZE) hold_cycles;

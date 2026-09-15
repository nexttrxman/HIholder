-- =====================================================================
-- TronKeeper — MIGRACION v3.6 — el vencimiento sin firmar libera el hold
-- =====================================================================
-- Pegar TODO este archivo en el SQL Editor de Supabase y correr.
-- Es idempotente: se puede ejecutar dos veces sin romper nada.
-- Requiere v2.9 + v3.0 + v3.1 + v3.2 + v3.3 + v3.4 aplicados. Funciona
-- hayas o no aplicado v3.5 (la reparacion cubre ambos casos).
--
-- Que hace:
--   1. expire_claims_and_cycles(): el claim que vence sin firmarse vuelve a
--      resetear el ciclo a 0 holds (disponible enseguida). El cooldown de
--      8 h queda SOLO para el claim cobrado.
--   2. Reparacion unica: los ciclos que la regla v3.5 dejo bloqueados 8 h
--      por un vencimiento sin cobrar se liberan ahora.

-- =============================================
-- v3.6 — el vencimiento sin firmar libera el hold (regla final)
-- =============================================
-- Decision final de producto: el cooldown de 8 h es SOLO para el claim
-- cobrado (el usuario firmo y pago con la wallet). Si la ventana de 15
-- minutos pasa sin firmar, el premio se pierde y el ciclo vuelve a 0 holds:
-- el boton de HOLD se reabre enseguida. (Reviente de la regla v3.5, que
-- aplicaba 8 h tambien al vencimiento: la ventana de 15 min ya es castigo.)
--
-- 1) expire_claims_and_cycles vuelve a resetear los holds a 0.
-- 2) Reparacion unica: libera los ciclos que la regla v3.5 (o el Worker
--    3.6/3.7) dejo en cooldown de 8 h por un vencimiento sin cobrar.

CREATE OR REPLACE FUNCTION expire_claims_and_cycles() RETURNS void AS $$
BEGIN
  -- v3.6 (regla final): el claim que expiro sin pagarse se pierde y los 3
  -- holds con el. El ciclo vuelve a 0 holds para que el usuario pueda
  -- holdear de nuevo enseguida. El bloqueo de 8 horas rige solo tras un
  -- claim exitoso: el ciclo queda en 3/3 y /hold lo rechaza hasta que vence.
  --
  -- El UPDATE va primero y usa las filas que estamos por expirar: este job
  -- corre cada minuto y casi siempre gana la carrera contra /auth.
  UPDATE hold_cycles hc
  SET holds_completed = 0
  FROM claims c
  WHERE c.status = 'pending'
    AND c.expires_at < NOW()
    AND c.cycle_id = hc.id
    AND hc.status = 'active'
    AND hc.holds_completed > 0;

  UPDATE claims
  SET status = 'expired_unclaimed'
  WHERE status = 'pending' AND expires_at < NOW();

  UPDATE hold_cycles
  SET status = 'expired'
  WHERE status = 'active' AND ends_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Reparacion unica para bases donde la regla v3.5 llego a correr (cron o
-- Worker 3.6/3.7): ciclos cerrados como 'expired' con cooldown de 8 h por un
-- vencimiento sin cobrar. Vuelven a 'active' con 0 holds y ventana nueva.
-- El filtro por ends_at futuro deja intactos los cooldowns ya cumplidos, y
-- el standby legitimo post-cobro no se toca porque es 'completed', no
-- 'expired', y su claim no es 'expired_unclaimed'.
UPDATE hold_cycles hc
SET status = 'active',
    holds_completed = 0,
    ends_at = NOW() + make_interval(hours => 8)
WHERE hc.status = 'expired'
  AND hc.ends_at > NOW()
  AND EXISTS (
    SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'expired_unclaimed'
  )
  AND NOT EXISTS (
    SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'pending'
  );

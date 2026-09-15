-- =====================================================================
-- TronKeeper — MIGRACION v3.5 — cooldown tras el vencimiento sin cobrar
-- =====================================================================
-- Pegar TODO este archivo en el SQL Editor de Supabase y correr.
-- Es idempotente: se puede ejecutar dos veces sin romper nada.
-- Requiere v2.9 + v3.0 + v3.1 + v3.2 + v3.3 + v3.4 aplicados.
--
-- Que hace:
--   1. Reemplaza expire_claims_and_cycles(): el claim que vence sin cobrar
--      ya NO devuelve el ciclo a 0 holds; lo cierra con cooldown de 8 h
--      (igual que un claim cobrado) y los holds se quedan en 3/3.
--   2. Reparacion unica: los ciclos 3/3 cuyo premio ya se perdio entran en
--      cooldown ahora, para que nadie siga holdeando sin cobrar.

-- =============================================
-- v3.5 — cooldown tras el vencimiento sin cobrar
-- =============================================
-- Reporte del usuario: dejo vencer 3 claims sin cobrar y el boton de HOLD
-- quedo disponible de nuevo al instante, sin cooldown. Regla nueva: dejar
-- vencer el premio cuesta lo mismo que cobrarlo. El ciclo se cierra con
-- cooldown de 8 h (ends_at = NOW() + 8h) y holds_completed se queda en 3/3.
-- El worker (/auth y /hold) y el frontend aplican la misma regla.
--
-- 1) Reemplaza expire_claims_and_cycles (la version v2.8.1 reseteaba a 0).
-- 2) Reparacion unica: cierra los ciclos 3/3 cuyo premio ya se perdio.

CREATE OR REPLACE FUNCTION expire_claims_and_cycles() RETURNS void AS $$
BEGIN
  -- Claims que expiraron sin pagarse: el premio se pierde.
  UPDATE claims
  SET status = 'expired_unclaimed'
  WHERE status = 'pending' AND expires_at < NOW();

  -- v3.5: esos ciclos se cierran con el mismo cooldown de 8 h que un claim
  -- exitoso. Los holds se quedan en 3/3, asi el boton sigue bloqueado hasta
  -- que pase la ventana. Solo toca ciclos activos: no estira el cooldown de
  -- un ciclo ya en espera, ni toca los 'completed' (el standby tras cobrar
  -- lo maneja credit_claim).
  UPDATE hold_cycles hc
  SET status = 'expired',
      ends_at = NOW() + make_interval(hours => 8)
  WHERE hc.status = 'active'
    AND hc.holds_completed >= 3
    AND NOT EXISTS (
      SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'pending'
    )
    AND EXISTS (
      SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'expired_unclaimed'
    );

  -- Ciclos activos cuya ventana de 8 h paso sin completarse: expiran.
  UPDATE hold_cycles
  SET status = 'expired'
  WHERE status = 'active' AND ends_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Reparacion unica para bases donde la regla vieja ya corria: cubre el caso
-- danino, ciclo activo 3/3 cuyo premio ya se perdio (expired_unclaimed o
-- pendiente vencido). Entra en cooldown de inmediato para que nadie siga
-- holdeando sin cobrar. No toca ciclos que en el pasado ya volvieron a 0
-- holds (ese tiempo ya se perdio) ni ventanas vencidas hace rato.
UPDATE claims
SET status = 'expired_unclaimed'
WHERE status = 'pending' AND expires_at < NOW();

UPDATE hold_cycles hc
SET status = 'expired',
    ends_at = NOW() + make_interval(hours => 8)
WHERE hc.status = 'active'
  AND hc.holds_completed >= 3
  AND NOT EXISTS (
    SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'pending'
  )
  AND EXISTS (
    SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'expired_unclaimed'
  );

-- ============================================================================
-- MIGRACION v3.1 — MISIONES SOCIALES (one-time)
-- ============================================================================
-- Correlo en supabase -> SQL Editor ANTES de redeployar el Worker, igual que
-- v3.0. Es idempotente: se puede pegar dos veces.
--
-- Que crea:
--   social_missions        config: 2 misiones de Telegram habilitadas (0.4 USDT,
--                        verificadas con getChatMember) + 3 placeholders
--                        disabled (instagram/youtube/x) listos para habilitar.
--   user_social_missions   una fila por usuario+mision: el anti-doble-cobro.
--   complete_social_mission()  paga una sola vez, con ledger 'mission_reward'.
--
-- IMPORTANTE: para que la verificacion de Telegram funcione, el bot
-- @TKcex_bot tiene que estar como ADMIN de @KeeperExchange y de
-- @KeeperExchange_CHAT. Sin eso, Telegram no le deja ver miembros y el verify
-- da "check failed".
--
-- Al final, un SELECT de verificacion: 5 filas, todas "OK".
-- ============================================================================

-- v3.1 — MISIONES SOCIALES (one-time)
-- =============================================
-- Config-driven: agregar una mision nueva es un INSERT, no un deploy. Las de
-- Telegram se verifican DE VERDAD: el Worker pregunta a la Bot API
-- getChatMember(chat_id, user_id) con el telegram_id que sale del initData
-- validado, asi que desde la consola no se puede mentir. El bot tiene que
-- estar como admin del canal/grupo para que Telegram le deje ver miembros.
--
-- verify:
--   'telegram_member'  pregunta a Telegram si el usuario esta en chat_id.
--   'honor'            el usuario confirma; one-time por PK. Para redes sin
--                      API de follows (cuando se decida usarlas asi).
--   'manual'           revision humana. El Worker la rechaza hasta que exista
--                      la UI de admin; queda como placeholder habilitable.
--
-- Las filas de instagram/youtube/x van sembradas pero disabled: es el
-- placeholder que se pidio para proximas misiones de este estilo.

CREATE TABLE IF NOT EXISTS social_missions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  reward_usdt DECIMAL(18, 8) NOT NULL DEFAULT 0.4,
  verify TEXT NOT NULL DEFAULT 'telegram_member'
    CHECK (verify IN ('telegram_member', 'honor', 'manual')),
  chat_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_social_missions (
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES social_missions(id) ON DELETE CASCADE,
  reward_usdt DECIMAL(18, 8) NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, mission_id)
);

INSERT INTO social_missions
  (id, platform, title, description, url, reward_usdt, verify, chat_id, enabled, sort)
VALUES
  ('tg_channel', 'telegram', 'Follow the channel',
   'Official announcements of Keeper Exchange.',
   'https://t.me/KeeperExchange', 0.4, 'telegram_member', '@KeeperExchange', true, 1),
  ('tg_community', 'telegram', 'Join the community',
   'Chat with other holders.',
   'https://t.me/KeeperExchange_CHAT', 0.4, 'telegram_member', '@KeeperExchange_CHAT', true, 2),
  -- Placeholders para proximas misiones: se habilitan con un UPDATE
  -- (enabled = true) cuando existan las cuentas y se decida el verify.
  ('instagram', 'instagram', 'Follow on Instagram', '', 'https://instagram.com', 0.4, 'manual', NULL, false, 3),
  ('youtube', 'youtube', 'Subscribe on YouTube', '', 'https://youtube.com', 0.4, 'manual', NULL, false, 4),
  ('x', 'x', 'Follow on X', '', 'https://x.com', 0.4, 'manual', NULL, false, 5)
ON CONFLICT (id) DO NOTHING;

-- Paga la mision una sola vez. La PK de user_social_missions es la garantia
-- anti-doble-cobro; el segundo intento cae en unique_violation y devuelve
-- 'already' sin tocar el saldo.
CREATE OR REPLACE FUNCTION complete_social_mission(
  p_user_id TEXT,
  p_mission_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_mission RECORD;
  v_before DECIMAL(18, 8);
  v_after DECIMAL(18, 8);
BEGIN
  SELECT * INTO v_mission FROM social_missions
   WHERE id = p_mission_id AND enabled;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Unknown or disabled mission');
  END IF;

  IF EXISTS (SELECT 1 FROM user_social_missions
              WHERE user_id = p_user_id AND mission_id = p_mission_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already');
  END IF;

  BEGIN
    INSERT INTO user_social_missions (user_id, mission_id, reward_usdt)
    VALUES (p_user_id, p_mission_id, v_mission.reward_usdt);
  EXCEPTION WHEN unique_violation THEN
    -- Carrera: dos verify simultaneos. Uno gana, el otro no cobra.
    RETURN jsonb_build_object('ok', false, 'error', 'already');
  END;

  SELECT usdt_balance INTO v_before FROM internal_wallets
   WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No wallet');
  END IF;
  v_after := v_before + v_mission.reward_usdt;

  UPDATE internal_wallets SET usdt_balance = v_after, updated_at = NOW()
   WHERE user_id = p_user_id;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id, asset, amount,
    balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'mission_reward', 'social_mission', NULL, 'USDT', v_mission.reward_usdt,
    v_before, v_after, format('Mission: %s', v_mission.title)
  );

  RETURN jsonb_build_object('ok', true, 'reward', v_mission.reward_usdt);
END;
$$ LANGUAGE plpgsql;

ALTER TABLE social_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_social_missions ENABLE ROW LEVEL SECURITY;

-- El ledger acepta 'mission_reward'. Se reescribe la CHECK con la lista
-- COMPLETA: el helper avisa si algun valor quedo afuera.
SELECT wallet_ledger_apply_operation_check(ARRAY[
  'claim_credit', 'referral_bonus', 'deposit', 'withdrawal', 'fee_deduction',
  'trade_buy', 'trade_sell', 'checkin_daily', 'checkin_weekly', 'signup_bonus',
  'mission_reward'
]);

-- Permisos v3.1: complete_social_mission mueve plata; solo service_role.
DO $$
BEGIN
  IF to_regprocedure('complete_social_mission(TEXT, TEXT)') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION complete_social_mission(TEXT, TEXT) FROM PUBLIC';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION complete_social_mission(TEXT, TEXT) FROM authenticated';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION complete_social_mission(TEXT, TEXT) FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION complete_social_mission(TEXT, TEXT) TO service_role';
    END IF;
  END IF;
END $$;

-- ============================================================================
-- VERIFICACION — debe devolver 5 filas, todas "OK"
-- ============================================================================
SELECT * FROM (
  SELECT 1 AS n, 'tabla social_missions' AS que,
    CASE WHEN to_regclass('public.social_missions') IS NOT NULL
         THEN 'OK' ELSE 'FALTA' END AS estado
  UNION ALL
  SELECT 2, 'tabla user_social_missions',
    CASE WHEN to_regclass('public.user_social_missions') IS NOT NULL
         THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  SELECT 3, 'misiones de Telegram habilitadas (2)',
    CASE WHEN (SELECT count(*) FROM social_missions
               WHERE verify='telegram_member' AND enabled) = 2
         THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  SELECT 4, 'placeholders disabled (3)',
    CASE WHEN (SELECT count(*) FROM social_missions
               WHERE enabled = false) = 3
         THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  SELECT 5, 'funcion complete_social_mission',
    CASE WHEN to_regprocedure('complete_social_mission(TEXT, TEXT)') IS NOT NULL
         THEN 'OK' ELSE 'FALTA' END
) v ORDER BY n;

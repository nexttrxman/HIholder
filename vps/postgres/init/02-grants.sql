-- ============================================================
-- 02-grants.sql - Permisos para los roles de PostgREST
--
--   service_role : acceso total (el Worker usa este JWT).
--   anon         : sin acceso a tablas (peticiones sin JWT denegadas).
-- ============================================================

GRANT USAGE ON SCHEMA public TO anon, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Para objetos que se creen en el futuro
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON ROUTINES TO service_role;

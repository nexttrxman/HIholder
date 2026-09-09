# Migraciones de esquema (regla de oro para la futura migración al VPS)

> **Estrategia actual:** quedarse en Supabase hasta ~50k usuarios y luego migrar
> a Hetzner con la guía de [/vps/GUIA-VPS.md](../../vps/GUIA-VPS.md).

Para que ese día el traspaso sea de 30 minutos y no de 3 días, sigue esta regla:

## Regla de oro

**Todo cambio de esquema se escribe como archivo SQL numerado en esta carpeta
y se aplica en AMBOS lados:**

1. Supabase (SQL Editor, hoy).
2. `vps/postgres/init/01-schema.sql` (para que el VPS nazca con el esquema al día).

## Convención de nombres

```
001_descripcion_corta.sql
002_agrega_tabla_misiones.sql
...
```

## Ejemplo de flujo

```bash
# 1. Crear la migración
cp supabase/migrations/000_template.sql supabase/migrations/003_mi_cambio.sql
# 2. Editarla, probarla en Supabase SQL Editor
# 3. Reflejar el cambio en vps/postgres/init/01-schema.sql
# 4. Commit de ambos archivos juntos
```

## Qué evitar hasta la migración

Cada feature exclusivo de Supabase que adoptes es algo más que migrar.
Hoy el proyecto solo usa **Postgres + REST + RPC + pg_cron** (todo replicable
en el VPS). Evita engancharte a:

- Supabase Auth / Storage / Realtime / Edge Functions
- `pg_net` (webhooks desde la DB), `vault`, extensiones raras
- Políticas RLS complejas atadas a `auth.uid()` (el Worker usa service_role)

Si necesitas algo de eso, consúltalo primero: casi todo tiene equivalente
simple en el VPS.

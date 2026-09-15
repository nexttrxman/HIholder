/**
 * Tests del archivo frontend/public/_headers.
 *
 * Cloudflare Pages lee este archivo desde la raíz del directorio publicado
 * (Vite lo copia de public/ a dist/ tal cual). No hay interruptor en el
 * dashboard: si el archivo no llega a dist/, los headers no se aplican.
 *
 * El punto que este test cuida de verdad es que NO aparezca X-Frame-Options.
 * Es lo primero que sugiere cualquier checklist de seguridad y acá rompería la
 * app: TronKeeper corre dentro de un iframe en Telegram Web, y X-Frame-Options
 * solo admite DENY o SAMEORIGIN — no tiene forma de autorizar un origen.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HEADERS_PATH = resolve(HERE, '../../public/_headers');

describe('public/_headers', () => {
  it('existe, para que el build lo copie a dist/', () => {
    expect(existsSync(HEADERS_PATH)).toBe(true);
  });

  const raw = readFileSync(HEADERS_PATH, 'utf-8');
  // Solo las directivas, sin los comentarios: el archivo explica por qué NO se
  // usa X-Frame-Options y ese texto nombra el header. Buscar contra el archivo
  // entero daría un falso positivo sobre un comentario.
  const directives = raw
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');

  it('NO usa X-Frame-Options: bloquearía el iframe de Telegram Web', () => {
    // Comparar contra el nombre del header, no contra 'DENY': el error sería
    // agregarlo con cualquier valor.
    expect(directives).not.toMatch(/x-frame-options/i);
  });

  it('protege contra clickjacking con frame-ancestors, autorizando a Telegram', () => {
    expect(directives).toMatch(/frame-ancestors/);
    expect(directives).toMatch(/https:\/\/telegram\.org/);
    expect(directives).toMatch(/https:\/\/\*\.telegram\.org/);
  });

  it.each([
    ['nosniff', /X-Content-Type-Options: nosniff/],
    ['referrer-policy', /Referrer-Policy: strict-origin-when-cross-origin/],
    ['HSTS', /Strict-Transport-Security: max-age=31536000/],
    ['no-store', /Cache-Control: no-store/],
    ['permissions-policy', /Permissions-Policy:/],
  ])('setea %s', (_nombre, re) => {
    expect(directives).toMatch(re);
  });

  it('no apaga clipboard-write: copiar la dirección de depósito lo necesita', () => {
    // Permissions-Policy solo restringe lo que se lista. Si clipboard-write
    // apareciera con () vacío, el botón de copiar dejaría de funcionar.
    const line = directives.split('\n').find((l) => /Permissions-Policy:/i.test(l)) || '';
    expect(line).not.toMatch(/clipboard-write\s*=\s*\(\)/);
  });

  it('aplica a todas las rutas', () => {
    expect(raw).toMatch(/^\/\*$/m);
  });
});

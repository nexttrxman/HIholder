import fs from 'node:fs';
import path from 'node:path';

/**
 * Extracción de cadenas visibles, para el test de cobertura.
 *
 * La primera versión del plugin se hizo con un regex que solo buscaba `>texto<`
 * y se perdió todo lo que está dentro de `{...}`, lo que empieza con número y lo
 * que está en minúscula: por eso media app quedó en inglés.
 *
 * Acá se sacan primero className/style/data-testid (de ahí solo salen clases de
 * Tailwind) y después se aceptan literales que parezcan prosa.
 */

/**
 * Cadenas que deliberadamente NO se traducen.
 * Cada entrada necesita un motivo: este listado no es un tacho de basura.
 */
export const DO_NOT_TRANSLATE = {
  // Marca, tickers y unidades: no tienen traducción.
  TronKeeper: 'marca', USDT: 'ticker', TRX: 'ticker', TON: 'ticker',
  'Tether USD': 'nombre oficial del activo', LONG: 'jerga de trading',
  MAX: 'jerga de trading', PnL: 'sigla', Live: 'etiqueta de estado del feed',
  '24h H': 'etiqueta de tabla', '24h L': 'etiqueta de tabla',
  'TP / SL · optional': 'siglas', 'Add TP/SL': 'siglas',
  // Títulos de misión: el usuario pidió que queden en inglés a propósito.
  'Big Earner': 'título de misión (a pedido)', 'Daily Holder': 'título de misión (a pedido)',
  'First Deposit': 'título de misión (a pedido)', 'Social Butterfly': 'título de misión (a pedido)',
  // Mensajes para desarrolladores, nunca los ve un usuario final.
  'Referral links are being generated in': 'aviso de configuración (dev)',
  'form, which opens the bot chat instead of the app — invites will not be tracked. Set': 'aviso de configuración (dev)',
  'and rebuild.': 'aviso de configuración (dev)',
  'useTrade must be used within a TradeProvider': 'error de desarrollo',
  'useWallet must be used within a WalletProvider': 'error de desarrollo',
  'positions unavailable, running the trade panel locally:': 'error de desarrollo',
  // Atributos no visibles y placeholders técnicos.
  Avatar: 'atributo alt', Language: 'aria-label', 'TXyz...': 'placeholder de hash',
  'CLAIM:': 'prefijo de comentario on-chain',
  // Fragmentos que se concatenan con valores; se traducen por separado o no aportan.
  '· Stop Loss': 'fragmento', '· Take Profit': 'fragmento', '· weekly bonus +': 'fragmento',
  '— position opened': 'fragmento', '— TP/SL armed': 'fragmento', '· PnL': 'fragmento',
  // Meses del eje del gráfico: abreviaturas estándar.
  Jan: 'mes', Feb: 'mes', Mar: 'mes', Apr: 'mes', May: 'mes', Jun: 'mes',
  Jul: 'mes', Aug: 'mes', Sep: 'mes', Oct: 'mes', Nov: 'mes', Dec: 'mes',
};

const NOISE = /[\[\]\{\}\(\)#;=<>/\\]|--|\dpx|rgba|^\W+$/;

// Vocabulario de utilidades de Tailwind. Un literal hecho sólo de estas palabras
// es una lista de clases, no texto: "flex items-center gap-2 rounded-2xl border"
// pasa cualquier filtro basado en longitud o espacios.
const TW = new Set([
  'flex','grid','block','inline','hidden','relative','absolute','fixed','sticky','static',
  'items','justify','content','self','gap','space','order','basis','grow','shrink','table',
  'rounded','border','bg','text','font','leading','tracking','shadow','opacity','ring',
  'outline','cursor','select','pointer','touch','overflow','whitespace','truncate','underline',
  'transition','duration','ease','translate','scale','rotate','transform','filter','backdrop',
  'divide','placeholder','caret','accent','appearance','resize','scroll','will','columns',
  'aspect','object','align','caption','list','line','italic','normal','bold','semibold',
  'medium','light','thin','black','white','auto','full','screen','none','visible','invisible',
  'collapse','isolate','mix','snap','break','sr','not','group','peer','top','bottom','left',
  'right','inset','from','via','to','hover','focus','active','disabled','aria','has',
  // clases propias del proyecto
  'sys','chip','orb','glass','safe','tabular','uppercase','lowercase','capitalize','glow',
]);

/** Un token es "de marcado" si es una utilidad, un kebab-case, un número u operador. */
function isMarkupToken(token) {
  if (/^[\d.,%&|!?+*]+$/.test(token)) return true;
  if (token.includes(':') || token.includes('[') || token.includes('/')) return true;
  if (/^[a-z]+(-[a-z0-9]+)+$/.test(token)) return true;
  return TW.has(token.toLowerCase());
}

export function looksLikeProse(raw) {
  const t = String(raw).replace(/\s+/g, ' ').trim();
  if (t.length < 4) return null;
  if (NOISE.test(t)) return null;

  // Prosa = al menos dos palabras alfabéticas de 3+ letras que no sean utilidades.
  // Es conservador a propósito: prefiere no revisar una cadena corta ("No data")
  // antes que ahogarse en listas de clases. Las cadenas cortas importantes están
  // cubiertas por MUST_BE_TRANSLATED.
  // OJO: isMarkupToken va sobre el token CRUDO. Una versión anterior le pasaba el
  // token sin dígitos, así que "gap-2" llegaba como "gap-" y ya no matcheaba el
  // patrón kebab-case: todas las listas de clases de Tailwind pasaban el filtro.
  const qualifying = t.split(' ').filter((w) => {
    const clean = w.replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ]+$/g, '');
    return clean.length >= 3 && !isMarkupToken(w);
  });
  if (qualifying.length < 2) return null;

  return t;
}

export function extractUiStrings(srcRoot) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'i18n' || entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.jsx')) {
        files.push(full);
      }
    }
  };
  walk(srcRoot);

  const found = new Map();
  const add = (raw, where) => {
    const t = looksLikeProse(raw);
    if (t && !found.has(t)) found.set(t, path.relative(srcRoot, where));
  };

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    // De className/style/testid solo salen clases de Tailwind y CSS.
    const src = raw
      .replace(/className\s*=\s*(".*?"|\{[^{}]*\})/gs, ' ')
      .replace(/style\s*=\s*\{.*?\}\}/gs, ' ')
      .replace(/data-testid\s*=\s*(".*?"|\{[^{}]*\})/gs, ' ');

    for (const m of src.matchAll(/>\s*([^<>{}]*?[A-Za-z][^<>{}]*?)\s*</g)) add(m[1], file);
    for (const m of src.matchAll(/[{(?:,]\s*'([^'\n]{4,160})'/g)) add(m[1], file);
    for (const m of src.matchAll(/[{(?:,]\s*"([^"\n]{4,160})"/g)) add(m[1], file);
    for (const m of src.matchAll(/(?:placeholder|title|aria-label|alt)\s*=\s*["']([^"']{4,160})["']/g)) add(m[1], file);
    for (const m of src.matchAll(/`([^`${]*[A-Za-z][^`${]{3,})\$\{/g)) add(m[1], file);
  }

  return found;
}

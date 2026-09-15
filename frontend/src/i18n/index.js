import es from './locales/es.js';
import pt from './locales/pt.js';
import ru from './locales/ru.js';
import zh from './locales/zh.js';
import fa from './locales/fa.js';
import ar from './locales/ar.js';

/**
 * Traductor de interfaz, solo para el frontend.
 *
 * El inglés es el idioma fuente: vive en el JSX. Cada locale es un diccionario
 * plano "texto en inglés -> texto traducido" y el LanguageProvider reemplaza los
 * nodos de texto del DOM por coincidencia exacta. Así no hace falta tocar los 84
 * componentes ni pasar una función t() por toda la app.
 *
 * Costo: si cambiás un string en un componente, hay que cambiarlo en los 6
 * diccionarios. i18n.test.js avisa cuando falta una clave.
 */
export const DICTIONARIES = { es, pt, ru, zh, fa, ar };

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', native: 'English', rtl: false },
  { code: 'es', label: 'Español', native: 'Español', rtl: false },
  { code: 'pt', label: 'Português', native: 'Português', rtl: false },
  { code: 'ru', label: 'Ruso', native: 'Русский', rtl: false },
  { code: 'zh', label: 'Chino', native: '中文', rtl: false },
  { code: 'fa', label: 'Farsi', native: 'فارسی', rtl: true },
  { code: 'ar', label: 'Árabe', native: 'العربية', rtl: true },
];

export const DEFAULT_LANGUAGE = 'en';
export const LANGUAGE_STORAGE_KEY = 'tk_language';

export const isRtl = (code) => SUPPORTED_LANGUAGES.find((l) => l.code === code)?.rtl ?? false;

export const isSupported = (code) => SUPPORTED_LANGUAGES.some((l) => l.code === code);

/**
 * El diccionario de un idioma, o null para inglés (no hay nada que traducir).
 */
export function dictionaryFor(code) {
  if (!code || code === DEFAULT_LANGUAGE) return null;
  return DICTIONARIES[code] || null;
}

/**
 * Normaliza para la búsqueda: colapsa espacios y recorta. No toca mayúsculas,
 * porque "Trade" y "trade" son claves distintas en la UI.
 */
export function normalizeKey(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/** Traduce una cadena si el diccionario la conoce; si no, la devuelve igual. */
export function translateText(text, dict) {
  if (!dict) return text;
  const key = normalizeKey(text);
  if (!key) return text;
  return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : text;
}

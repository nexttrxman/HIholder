import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  dictionaryFor,
  isRtl,
  isSupported,
  translateText,
} from './index.js';

/**
 * Traductor de interfaz en tiempo de ejecución.
 *
 * En vez de pasar una función t() por los 84 componentes, se reemplazan los
 * nodos de texto del DOM por coincidencia exacta contra el diccionario del
 * idioma activo, y un MutationObserver repite el trabajo sobre lo que React
 * vuelve a renderizar.
 *
 * El texto original de cada nodo se guarda en un WeakMap: al cambiar de idioma
 * (incluso de vuelta a inglés) se recalcula desde el original, así que nunca se
 * acumulan traducciones sobre traducciones.
 */
const LanguageContext = createContext({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => {},
  dir: 'ltr',
  languages: SUPPORTED_LANGUAGES,
});

export function useLanguage() {
  return useContext(LanguageContext);
}

function readStoredLanguage() {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isSupported(stored) ? stored : DEFAULT_LANGUAGE;
  } catch (e) {
    return DEFAULT_LANGUAGE;
  }
}

/** Nodos que no deben traducirse nunca. */
function shouldSkip(node) {
  const parent = node.parentElement;
  if (!parent) return true;
  const tag = parent.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'NOSCRIPT') return true;
  // Los nombres de idioma del selector se muestran en su propio idioma.
  if (parent.closest('[data-no-translate]')) return true;
  return false;
}

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(readStoredLanguage);

  // Texto original por nodo. Tiene que vivir FUERA del effect: si se creara
  // adentro, cada cambio de idioma arrancaría con un mapa vacío y tomaría el
  // texto traducido como si fuera el original (al volver a inglés, o al pasar de
  // un idioma a otro, ya no habría forma de recuperar el inglés).
  const originalsRef = useRef(null);
  if (!originalsRef.current) originalsRef.current = new WeakMap();

  const dir = isRtl(language) ? 'rtl' : 'ltr';

  const setLanguage = useCallback((code) => {
    const next = isSupported(code) ? code : DEFAULT_LANGUAGE;
    setLanguageState(next);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch (e) {
      /* privacidad/almacenamiento bloqueado: el idioma dura hasta recargar */
    }
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const root = document.documentElement;
    root.lang = language;
    root.dir = dir;

    const dict = dictionaryFor(language);
    // WeakMap de {original, traducido} para no retener nodos que React descarta.
    const originals = originalsRef.current;

    const apply = (node) => {
      const current = node.nodeValue;
      if (current == null) return;
      // Guardamos {original, traducido}, no solo el original. Saber EXACTAMENTE
      // qué escribimos es lo único que permite distinguirlo de un texto nuevo de
      // React sin adivinar: comparar contra el diccionario actual no alcanza,
      // porque al pasar de español a ruso el texto en pantalla es español y el
      // diccionario ruso no lo reconoce como propio.
      const rec = originals.get(node);

      if (!dict) {
        // Volvimos al idioma fuente: restaurar el original si lo teníamos.
        if (rec && current !== rec.original) node.nodeValue = rec.original;
        originals.delete(node);
        return;
      }

      const stillOurs = rec !== undefined && current === rec.translated;
      const original = stillOurs ? rec.original : current;
      const target = translateText(original, dict);

      if (target === original) {
        // No es una cadena traducible. No guardar NADA: si guardáramos el valor
        // actual como "original", el próximo update de React sobre este nodo se
        // revertiría contra él.
        originals.delete(node);
        return;
      }

      if (current !== target) node.nodeValue = target;
      originals.set(node, { original, translated: target });
    };

    const walk = (from) => {
      const walker = document.createTreeWalker(from, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          shouldSkip(node) || !node.nodeValue?.trim()
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      let node = walker.nextNode();
      while (node) {
        apply(node);
        node = walker.nextNode();
      }
    };

    walk(document.body);

    // React re-renderiza al cambiar de pestaña, al llegar datos del backend y en
    // cada animación: sin esto el texto volvería al inglés.
    // Las mutaciones se ACUMULAN. El primer intento procesaba solo las del
    // primer callback y descartaba el resto con un `if (queued) return`: todo lo
    // que React renderizaba mientras había un requestAnimationFrame en vuelo se
    // quedaba sin traducir hasta el próximo cambio.
    let pending = [];
    let queued = false;
    const observer = new MutationObserver((mutations) => {
      pending.push(...mutations);
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const batch = pending;
        pending = [];
        for (const m of batch) {
          if (m.type === 'characterData') {
            if (m.target.nodeType === Node.TEXT_NODE && !shouldSkip(m.target)) apply(m.target);
          } else {
            for (const added of m.addedNodes) {
              if (added.nodeType === Node.TEXT_NODE) {
                if (!shouldSkip(added)) apply(added);
              } else if (added.nodeType === Node.ELEMENT_NODE) {
                walk(added);
              }
            }
          }
        }
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => observer.disconnect();
  }, [language, dir]);

  const value = useMemo(
    () => ({ language, setLanguage, dir, languages: SUPPORTED_LANGUAGES }),
    [language, setLanguage, dir]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export default LanguageProvider;

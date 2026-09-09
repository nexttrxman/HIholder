import { useEffect, useRef, useState } from 'react';
import { Check, Globe } from 'lucide-react';
import { useLanguage } from '@/i18n/LanguageProvider';

/**
 * Selector de idioma sobre el avatar.
 *
 * Los nombres de idioma van en su propio idioma y con data-no-translate, para
 * que el traductor no los toque al cambiar de lengua.
 */
export function LanguageSwitcher() {
  const { language, setLanguage, languages } = useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const active = languages.find((l) => l.code === language);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref} data-no-translate>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Language"
        aria-expanded={open}
        data-testid="language-switcher"
        className="absolute -top-1 -left-1 z-20 w-5 h-5 rounded-full bg-app-bg border border-brand-teal/40 flex items-center justify-center shadow-glow-teal active:scale-90 transition-transform"
      >
        <Globe className="w-3 h-3 text-brand-mint" />
      </button>

      {open && (
        <div
          className="absolute top-7 left-0 z-30 w-40 rounded-2xl glass-card overflow-hidden py-1 shadow-glow-teal"
          data-testid="language-menu"
        >
          {languages.map((l) => {
            const selected = l.code === language;
            return (
              <button
                key={l.code}
                type="button"
                onClick={() => {
                  setLanguage(l.code);
                  setOpen(false);
                }}
                data-testid={`language-option-${l.code}`}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors ${
                  selected ? 'text-brand-mint bg-brand-teal/10' : 'text-white/70 hover:text-white'
                }`}
              >
                <span className="flex flex-col leading-tight">
                  <span className="font-medium">{l.native}</span>
                  {l.label !== l.native && (
                    <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-dim">
                      {l.label}
                    </span>
                  )}
                </span>
                {selected && <Check className="w-3.5 h-3.5 text-brand-mint shrink-0" />}
              </button>
            );
          })}
          <p className="px-3 pt-1.5 pb-1 font-mono text-[8px] uppercase tracking-[0.16em] text-ink-dim">
            {active?.native}
          </p>
        </div>
      )}
    </div>
  );
}

export default LanguageSwitcher;

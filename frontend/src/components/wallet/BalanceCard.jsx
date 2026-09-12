import { useState } from 'react';
import { motion } from 'framer-motion';
import { Info } from 'lucide-react';

export function BalanceCard({ 
  asset, 
  amount,
  label,
  icon,
  onWithdraw,
  onDeposit,
  onSend,
  // Envío interno entre usuarios. La opción se muestra desde ahora para que la
  // UI no cambie cuando se habilite, pero todavía no hay endpoint en el Worker,
  // así que arranca apagada (INTERNAL_TRANSFER_ENABLED en services/api.js).
  // Apagada de verdad: el botón no hace nada y queda atenuado; la única
  // explicación es el circulito de información al lado de la palabra Send.
  sendDisabled = false,
  showActions = true
}) {
  const isUSDT = asset === 'USDT';
  const color = isUSDT ? 'brand-green' : 'brand-red';
  const low = asset.toLowerCase();
  const [hintOpen, setHintOpen] = useState(false);

  // El circulito no puede ser un <button> adentro del Send: un botón anidado es
  // HTML inválido. Es un span con role="button" que frena el clic antes de que
  // llegue al Send (stopPropagation), así abrir la explicación nunca cuenta
  // como apretar el botón.
  const toggleHint = (e) => {
    e.stopPropagation();
    setHintOpen((v) => !v);
  };

  return (
    <motion.div
      className="glass-card rounded-2xl p-5"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      data-testid={`balance-card-${low}`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          {icon && (
            <div className={`w-10 h-10 rounded-full bg-${color}/10 flex items-center justify-center shrink-0`}>
              {/* Acepta un componente SVG o, por compatibilidad, una URL. */}
              {typeof icon === 'string' ? (
                <img src={icon} alt={asset} className="w-6 h-6" />
              ) : (
                icon
              )}
            </div>
          )}
          <div>
            <p className="sys-label">{label || asset}</p>
            <p className="text-2xl font-bold text-white mt-1">
              {isUSDT ? '$' : ''}{amount.toFixed(2)}
              {!isUSDT && <span className="text-sm text-white/40 ml-1">TRX</span>}
            </p>
          </div>
        </div>
      </div>

      {showActions && (
        <div className="flex gap-2 mt-4">
          {onDeposit && (
            <button
              onClick={onDeposit}
              data-testid={`deposit-${low}-btn`}
              className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm font-medium text-white/80 hover:bg-white/10 active:scale-95 transition-all"
            >
              Deposit
            </button>
          )}
          {onWithdraw && (
            <button
              onClick={onWithdraw}
              data-testid={`withdraw-${low}-btn`}
              className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm font-medium text-white/80 hover:bg-white/10 active:scale-95 transition-all"
            >
              Withdraw
            </button>
          )}
          {onSend && (
            <div className="relative flex-1">
              <button
                type="button"
                // Apagado no es disabled: un botón disabled vuelve agujero negro
                // los clics de sus hijos y el circulito no podría abrir su aviso.
                // El Send apagado simplemente no tiene onClick y queda atenuado.
                onClick={sendDisabled ? undefined : onSend}
                aria-disabled={sendDisabled || undefined}
                data-testid={`send-${low}-btn`}
                className={`w-full py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm font-medium text-white/80 transition-all ${
                  sendDisabled
                    ? 'opacity-40 cursor-not-allowed'
                    : 'hover:bg-white/10 active:scale-95'
                }`}
              >
                <span className="inline-flex items-center justify-center gap-1.5">
                  Send
                  {sendDisabled && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={toggleHint}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') toggleHint(e);
                      }}
                      aria-label="Send to other users — coming soon."
                      aria-expanded={hintOpen}
                      data-testid={`send-${low}-info`}
                      className="w-4 h-4 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-white/60 active:scale-90"
                    >
                      <Info className="w-2.5 h-2.5" />
                    </span>
                  )}
                </span>
              </button>

              {sendDisabled && hintOpen && (
                <p
                  role="tooltip"
                  data-testid={`send-${low}-hint`}
                  className="absolute bottom-full right-0 mb-2 w-44 p-2.5 rounded-xl bg-ink-deep border border-white/10 text-[11px] leading-snug text-white/70 shadow-xl z-20"
                >
                  Send to other users — coming soon.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

export default BalanceCard;

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Info } from 'lucide-react';
import soonLogo from '@/assets/soon-logo.png';

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
  // así que arranca deshabilitada (INTERNAL_TRANSFER_ENABLED en services/api.js).
  // "Deshabilitada" no es un botón muerto: al apretarlo sale el cartel del logo
  // explicando que viene pronto. Cuando se habilite, este prop pasa a false y
  // el botón llama a onSend como cualquier otro.
  sendDisabled = false,
  showActions = true
}) {
  const isUSDT = asset === 'USDT';
  const color = isUSDT ? 'brand-green' : 'brand-red';
  const low = asset.toLowerCase();
  const [soonOpen, setSoonOpen] = useState(false);

  const handleSend = () => {
    if (sendDisabled) {
      setSoonOpen(true);
    } else {
      onSend?.();
    }
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
            <button
              type="button"
              onClick={handleSend}
              data-testid={`send-${low}-btn`}
              className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm font-medium text-white/80 hover:bg-white/10 active:scale-95 transition-all"
            >
              {/* El circulito va al lado de la palabra Send, adentro del botón:
                  el cartel que abre el clic ya es la explicación, así que no
                  hace falta un tooltip aparte (ni hover, que en el teléfono
                  no existe). */}
              <span className="inline-flex items-center justify-center gap-1.5">
                Send
                {sendDisabled && (
                  <Info
                    data-testid={`send-${low}-info`}
                    className="w-3.5 h-3.5 text-white/40"
                  />
                )}
              </span>
            </button>
          )}
        </div>
      )}

      {/* Cartel de "coming soon". Va por portal: el padre es un motion.div con
          transform, y un fixed adentro quedaría anclado al padre en vez de a la
          pantalla. */}
      {soonOpen &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            data-testid={`send-${low}-soon-overlay`}
            className="fixed inset-0 z-50 flex items-center justify-center p-6"
            onClick={() => setSoonOpen(false)}
          >
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
            <div
              data-testid={`send-${low}-soon-card`}
              className="relative w-full max-w-[260px] rounded-3xl bg-[#F5F7FA] p-4 text-center shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={soonLogo}
                alt="Coming soon"
                data-testid={`send-${low}-soon-logo`}
                className="w-full rounded-2xl"
              />
              <p className="mt-3 text-[13px] leading-snug text-black/70">
                Send to other users — coming soon.
              </p>
              <button
                type="button"
                onClick={() => setSoonOpen(false)}
                data-testid={`send-${low}-soon-close`}
                className="mt-3 w-full py-2.5 rounded-xl bg-[#12161f] text-white text-sm font-medium active:scale-95 transition-all"
              >
                OK
              </button>
            </div>
          </div>,
          document.body
        )}
    </motion.div>
  );
}

export default BalanceCard;

import { motion } from 'framer-motion';

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
  sendDisabled = false,
  showActions = true
}) {
  const isUSDT = asset === 'USDT';
  const color = isUSDT ? 'brand-green' : 'brand-red';
  
  return (
    <motion.div
      className="glass-card rounded-2xl p-5"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      data-testid={`balance-card-${asset.toLowerCase()}`}
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
              data-testid={`deposit-${asset.toLowerCase()}-btn`}
              className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm font-medium text-white/80 hover:bg-white/10 active:scale-95 transition-all"
            >
              Deposit
            </button>
          )}
          {onWithdraw && (
            <button
              onClick={onWithdraw}
              data-testid={`withdraw-${asset.toLowerCase()}-btn`}
              className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm font-medium text-white/80 hover:bg-white/10 active:scale-95 transition-all"
            >
              Withdraw
            </button>
          )}
          {onSend && (
            <button
              onClick={onSend}
              disabled={sendDisabled}
              aria-disabled={sendDisabled}
              data-testid={`send-${asset.toLowerCase()}-btn`}
              className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm font-medium text-white/80 hover:bg-white/10 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/5 disabled:active:scale-100"
            >
              Send{sendDisabled && <span className="ml-1 text-white/40">· Soon</span>}
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}

export default BalanceCard;

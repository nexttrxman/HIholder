import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWallet } from '@/contexts/WalletContext';
import { claimReward } from '@/services/api';

const TETHER_ICON = '/tether.png';

// Duración del hold: random entre 6 y 18 segundos
const randomDuration = () => Math.floor(Math.random() * 13) + 6;

export function HoldButton() {
  const {
    remainingHolds,
    getResetTime,
    refreshUser,
    setUser,
  } = useWallet();

  // Estado del botón
  const [status, setStatus] = useState('idle');
  // idle | holding | claimable | claiming | done | blocked

  const [progress, setProgress] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [prizeAmount, setPrizeAmount] = useState(0);
  const [showPrize, setShowPrize] = useState(false);
  const [showRipple, setShowRipple] = useState(false);

  // Refs para el timer (no re-renderizan)
  const startTsRef = useRef(null);   // timestamp inicio
  const durationRef = useRef(0);     // duración en ms
  const rafRef = useRef(null);       // requestAnimationFrame id
  const claimingRef = useRef(false); // guard para evitar doble claim
  const touchHandledRef = useRef(false); // evita doble disparo touch+click

  // Vibración via Telegram SDK (silencioso si no está disponible)
  const vibrate = useCallback((type) => {
    try {
      const hf = window?.Telegram?.WebApp?.HapticFeedback;
      if (!hf) return;
      if (type === 'success') hf.notificationOccurred('success');
      else if (type === 'error') hf.notificationOccurred('error');
      else hf.impactOccurred('medium');
    } catch (_) {}
  }, []);

  // Loop de animación — usa refs para no tener problema de closures
  const tick = useCallback(() => {
    const now = Date.now();
    const elapsed = now - startTsRef.current;
    const total = durationRef.current;
    const remaining = total - elapsed;

    if (remaining <= 0) {
      setProgress(1);
      setCountdown(0);
      setStatus('claimable');
      vibrate('success');
      return; // para el loop
    }

    setProgress(elapsed / total);
    setCountdown(Math.ceil(remaining / 1000));
    rafRef.current = requestAnimationFrame(tick);
  }, [vibrate]);

  // Cleanup siempre al desmontar
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Iniciar hold
  const startHold = useCallback(() => {
    if (status !== 'idle' || remainingHolds <= 0) {
      vibrate('error');
      return;
    }

    const duration = randomDuration() * 1000; // a ms
    startTsRef.current = Date.now();
    durationRef.current = duration;

    setProgress(0);
    setCountdown(Math.ceil(duration / 1000));
    setStatus('holding');
    vibrate('impact');

    // Arrancar el loop
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [status, remainingHolds, tick, vibrate]);

  // Claim al servidor
  const handleClaim = useCallback(async () => {
    if (status !== 'claimable' || claimingRef.current) return;
    claimingRef.current = true;
    setStatus('claiming');
    vibrate('impact');

    try {
      const result = await claimReward();
      const prize = result?.prize ?? 0;

      setPrizeAmount(prize);
      setShowRipple(true);
      setStatus('done');
      vibrate('success');

      setTimeout(() => setShowPrize(true), 200);

      // Refrescar datos del servidor
      await refreshUser();

      // Reset UI a los 2.5s
      setTimeout(() => {
        setShowPrize(false);
        setShowRipple(false);
        setProgress(0);
        setStatus('idle');
        claimingRef.current = false;
      }, 2500);
    } catch (err) {
      console.error('Claim error:', err);
      vibrate('error');
      setStatus('claimable');
      claimingRef.current = false;
    }
  }, [status, refreshUser, vibrate]);

  // Handler unificado para click y touch — evita doble disparo
  const handlePress = useCallback((e) => {
    if (e.type === 'touchstart') {
      touchHandledRef.current = true;
      e.preventDefault(); // evita que genere click después
    } else if (e.type === 'click' && touchHandledRef.current) {
      touchHandledRef.current = false;
      return; // ya fue manejado por touchstart
    } else {
      touchHandledRef.current = false;
    }

    if (status === 'claimable') {
      handleClaim();
    } else if (status === 'idle') {
      startHold();
    }
  }, [status, handleClaim, startHold]);

  // Valores derivados
  const resetTime = getResetTime();
  const isBlocked = remainingHolds <= 0;
  const isHolding = status === 'holding';
  const isClaimable = status === 'claimable';
  const isClaiming = status === 'claiming';
  const isDone = status === 'done';
  const isDisabled = isBlocked || isClaiming || isDone;

  // SVG ring
  const radius = 90;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  // Texto del estado
  const statusText = {
    idle: 'Hold to earn',
    holding: countdown > 0 ? `${countdown}s` : 'Waiting...',
    claimable: '⭐ Tap to claim!',
    claiming: 'Claiming...',
    done: '✓ Done!',
  }[status] ?? '';

  return (
    <div className="relative flex flex-col items-center" data-testid="hold-section">

      {/* Título */}
      <div className="text-center mb-2">
        <h2 className="font-display text-lg font-semibold text-white">Hold to Earn</h2>
        <p className="text-xs text-white/40 mt-1">
          {isClaimable ? 'Tap to claim your prize!' : 'Hold the button to get your prize'}
        </p>
      </div>

      {/* Indicador de holds restantes */}
      <div className="flex items-center gap-2 mb-6" data-testid="holds-remaining">
        <span className="text-xs text-white/50">Remaining</span>
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={`w-2 h-2 rounded-full transition-colors duration-300 ${
                i < remainingHolds ? 'bg-brand-green' : 'bg-white/10'
              }`}
            />
          ))}
        </div>
        {resetTime && (
          <span className="text-xs text-brand-red ml-2">Resets {resetTime}</span>
        )}
      </div>

      {/* Botón */}
      <div className="relative w-56 h-56 flex items-center justify-center">

        {/* Glow */}
        <div
          className="absolute inset-0 rounded-full transition-opacity duration-500"
          style={{
            opacity: isHolding || isClaimable ? 1 : 0,
            background: isClaimable
              ? 'radial-gradient(circle, rgba(0,230,118,0.3) 0%, transparent 70%)'
              : 'radial-gradient(circle, rgba(0,230,118,0.15) 0%, transparent 70%)',
          }}
        />

        {/* SVG ring */}
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 204 204">
          <circle cx="102" cy="102" r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
          <circle
            cx="102" cy="102" r={radius}
            fill="none"
            stroke={isBlocked ? 'rgba(255,80,80,0.4)' : '#00E676'}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={isBlocked ? 0 : strokeDashoffset}
            style={{
              transition: 'stroke-dashoffset 0.05s linear',
              filter: (isHolding || isClaimable) ? 'drop-shadow(0 0 8px rgba(0,230,118,0.6))' : 'none',
              transform: 'rotate(-90deg)',
              transformOrigin: '50% 50%',
            }}
          />
        </svg>

        {/* Ripple */}
        <AnimatePresence>
          {showRipple && (
            <motion.div
              className="absolute inset-0 rounded-full border-2 border-brand-green"
              initial={{ scale: 1, opacity: 0.8 }}
              animate={{ scale: 2.2, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.7 }}
            />
          )}
        </AnimatePresence>

        {/* Botón principal */}
        <motion.button
          data-testid="hold-button"
          className={[
            'relative w-44 h-44 rounded-full overflow-hidden',
            'select-none transition-all duration-300',
            isDisabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer active:scale-95',
            isHolding ? 'shadow-[0_0_60px_rgba(0,230,118,0.3)]' : '',
            isClaimable ? 'shadow-[0_0_90px_rgba(0,230,118,0.55)] ring-2 ring-brand-green/40' : '',
          ].join(' ')}
          onClick={handlePress}
          onTouchStart={handlePress}
          whileTap={!isDisabled ? { scale: 0.92 } : {}}
          disabled={isDisabled}
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <img
            src={TETHER_ICON}
            alt="Hold to Earn"
            className="w-full h-full object-cover pointer-events-none"
            draggable={false}
          />

          {/* Overlay oscuro cuando está bloqueado */}
          {isBlocked && (
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
              <span className="text-xs text-white/60 font-medium px-2 text-center">Come back in {resetTime}</span>
            </div>
          )}
        </motion.button>

        {/* Label de estado */}
        <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap">
          <span className={[
            'text-sm font-semibold px-4 py-1 rounded-full',
            (status === 'done') ? 'bg-brand-green/20 text-brand-green' : '',
            (status === 'claimable') ? 'bg-brand-green/25 text-brand-green animate-pulse' : '',
            (status === 'claiming') ? 'text-white/50' : '',
            (status === 'holding') ? 'text-white/70' : '',
            (status === 'idle' && !isBlocked) ? 'text-white/40' : '',
            isBlocked ? 'text-brand-red/70' : '',
          ].join(' ')}>
            {isBlocked ? `Resets ${resetTime}` : statusText}
          </span>
        </div>

        {/* Premio flotante */}
        <AnimatePresence>
          {showPrize && (
            <motion.div
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
              initial={{ scale: 0.6, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: -55 }}
              exit={{ opacity: 0, y: -90, scale: 0.8 }}
              transition={{ duration: 0.45, ease: 'easeOut' }}
            >
              <div className="bg-brand-green/20 backdrop-blur-sm px-6 py-3 rounded-2xl border border-brand-green/30">
                <span className="font-display text-2xl font-bold text-brand-green">
                  +${prizeAmount.toFixed(4)}
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default HoldButton;

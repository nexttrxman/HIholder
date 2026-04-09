import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWallet } from '@/contexts/WalletContext';
import { useTelegram } from '@/hooks/useTelegram';

const TETHER_ICON = '/tether.png';

// Dimensiones — todo derivado de BUTTON_SIZE para mantener sincronía
const BUTTON_SIZE = 220;   // px — tamaño del botón interno
const RING_GAP = 10;       // px — espacio entre borde del botón y el ring
const RING_STROKE = 5;     // px — grosor del trazo
const SVG_SIZE = BUTTON_SIZE + (RING_GAP + RING_STROKE) * 2; // 260px total
const CX = SVG_SIZE / 2;
const RADIUS = BUTTON_SIZE / 2 + RING_GAP + RING_STROKE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function HoldButton() {
  const {
    canHold,
    claim,
    HOLD_DURATION,
    remainingHolds,
    getResetTime,
  } = useWallet();
  const { vibrate } = useTelegram();

  const [isHolding, setIsHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('hold');
  const [showPrize, setShowPrize] = useState(false);
  const [prizeAmount, setPrizeAmount] = useState(0);
  const [showRipple, setShowRipple] = useState(false);

  const timerRef = useRef(null);
  const startTimeRef = useRef(null);
  const frameRef = useRef(null);
  const completedRef = useRef(false);

  const calculatePrize = () => Math.floor(Math.random() * 7 + 2) / 100;

  const updateProgress = useCallback(() => {
    if (!startTimeRef.current) return;
    const elapsed = Date.now() - startTimeRef.current;
    const newProgress = Math.min(elapsed / HOLD_DURATION, 1);
    setProgress(newProgress);
    const remaining = Math.ceil((HOLD_DURATION - elapsed) / 1000);
    if (remaining > 0 && elapsed < HOLD_DURATION) setStatus(`${remaining}`);
    if (elapsed < HOLD_DURATION) {
      frameRef.current = requestAnimationFrame(updateProgress);
    }
  }, [HOLD_DURATION]);

  const onHoldComplete = useCallback(async () => {
    if (completedRef.current) return;
    completedRef.current = true;
    vibrate('success');
    setStatus('done');
    setShowRipple(true);
    const prize = calculatePrize();
    setPrizeAmount(prize);
    await claim(prize);
    setTimeout(() => {
      setShowPrize(true);
      setTimeout(() => {
        setShowPrize(false);
        setShowRipple(false);
        setProgress(0);
        setStatus('hold');
        completedRef.current = false;
      }, 2000);
    }, 300);
  }, [claim, vibrate]);

  const stopHold = useCallback(() => {
    setIsHolding(false);
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (frameRef.current) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
    startTimeRef.current = null;
    if (!completedRef.current) {
      setProgress(0);
      setStatus('hold');
    }
  }, []);

  const startHold = useCallback(() => {
    if (!canHold() || remainingHolds <= 0) {
      vibrate('error');
      setStatus('wait');
      setTimeout(() => setStatus('hold'), 1500);
      return;
    }
    vibrate('impact');
    setIsHolding(true);
    setStatus('holding');
    completedRef.current = false;
    startTimeRef.current = Date.now();
    frameRef.current = requestAnimationFrame(updateProgress);
    timerRef.current = setTimeout(() => {
      onHoldComplete();
      stopHold();
    }, HOLD_DURATION);
  }, [canHold, remainingHolds, vibrate, updateProgress, onHoldComplete, stopHold, HOLD_DURATION]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
  }, []);

  const strokeDashoffset = CIRCUMFERENCE * (1 - progress);
  const resetTime = getResetTime();
  const isDisabled = remainingHolds <= 0 && !!resetTime;

  return (
    <div className="relative flex flex-col items-center" data-testid="hold-section">
      {/* Título */}
      <div className="text-center mb-2">
        <h2 className="font-display text-lg font-semibold text-white">Hold to Earn</h2>
        <p className="text-xs text-white/40 mt-1">Hold the button to get your prize</p>
      </div>

      {/* Dots de holds restantes */}
      <div className="flex items-center gap-2 mb-8" data-testid="holds-remaining">
        <span className="text-xs text-white/50">Remaining</span>
        <div className="flex gap-1">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className={`w-2 h-2 rounded-full transition-colors ${
                i < remainingHolds ? 'bg-brand-green' : 'bg-white/10'
              }`}
            />
          ))}
        </div>
        {resetTime && (
          <span className="text-xs text-brand-red ml-2">Resets in {resetTime}</span>
        )}
      </div>

      {/* Contenedor — tamaño exacto del SVG */}
      <div
        className="relative flex items-center justify-center"
        style={{ width: SVG_SIZE, height: SVG_SIZE }}
      >
        {/* Glow de fondo */}
        <div
          className="absolute inset-0 rounded-full pointer-events-none transition-opacity duration-300"
          style={{
            opacity: isHolding ? 1 : 0,
            background: 'radial-gradient(circle, rgba(0,230,118,0.18) 0%, transparent 70%)',
          }}
        />

        {/* SVG ring — ocupa todo el contenedor */}
        <svg
          className="absolute inset-0"
          width={SVG_SIZE}
          height={SVG_SIZE}
          viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
          style={{ transform: 'rotate(-90deg)' }}
        >
          {/* Track */}
          <circle
            cx={CX} cy={CX} r={RADIUS}
            fill="none"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={RING_STROKE}
          />
          {/* Progreso */}
          <circle
            cx={CX} cy={CX} r={RADIUS}
            fill="none"
            stroke="#00E676"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={strokeDashoffset}
            style={{
              transition: 'stroke-dashoffset 0.05s linear',
              filter: isHolding ? 'drop-shadow(0 0 6px rgba(0,230,118,0.7))' : 'none',
            }}
          />
        </svg>

        {/* Ripple al completar */}
        <AnimatePresence>
          {showRipple && (
            <motion.div
              className="absolute rounded-full border-2 border-brand-green pointer-events-none"
              style={{ width: BUTTON_SIZE, height: BUTTON_SIZE }}
              initial={{ scale: 1, opacity: 0.8 }}
              animate={{ scale: 1.6, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.7 }}
            />
          )}
        </AnimatePresence>

        {/* Botón principal */}
        <motion.button
          data-testid="hold-button"
          className={[
            'relative rounded-full overflow-hidden select-none',
            'transition-shadow duration-300',
            isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
            isHolding ? 'shadow-[0_0_70px_rgba(0,230,118,0.35)]' : '',
          ].join(' ')}
          style={{ width: BUTTON_SIZE, height: BUTTON_SIZE }}
          onMouseDown={!isDisabled ? startHold : undefined}
          onMouseUp={stopHold}
          onMouseLeave={stopHold}
          onTouchStart={!isDisabled ? startHold : undefined}
          onTouchEnd={stopHold}
          whileTap={!isDisabled ? { scale: 0.94 } : {}}
          disabled={isDisabled}
        >
          <img
            src={TETHER_ICON}
            alt="Hold to Earn"
            className="w-full h-full object-cover pointer-events-none"
            draggable={false}
          />
        </motion.button>

        {/* Label de estado */}
        <div className="absolute -bottom-9 left-1/2 -translate-x-1/2 whitespace-nowrap">
          <span className={[
            'text-sm font-semibold px-4 py-1 rounded-full',
            status === 'done' ? 'bg-brand-green/20 text-brand-green' : '',
            status === 'wait' ? 'bg-brand-red/20 text-brand-red' : '',
            status === 'hold' ? 'text-white/50' : '',
            status === 'holding' ? 'text-white/70' : '',
          ].join(' ')}>
            {status === 'hold' && 'Hold to earn'}
            {status === 'holding' && 'Holding...'}
            {status === 'done' && '✓ Done!'}
            {status === 'wait' && 'Wait...'}
            {!['hold', 'holding', 'done', 'wait'].includes(status) && `${status}s`}
          </span>
        </div>

        {/* Premio flotante */}
        <AnimatePresence>
          {showPrize && (
            <motion.div
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
              initial={{ scale: 0.5, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: -70 }}
              exit={{ scale: 0.8, opacity: 0, y: -110 }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            >
              <div className="bg-brand-green/20 backdrop-blur-sm px-6 py-3 rounded-2xl border border-brand-green/30">
                <span className="font-display text-2xl font-bold text-brand-green">
                  +${prizeAmount.toFixed(2)}
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

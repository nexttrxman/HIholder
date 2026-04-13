import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWallet } from '@/contexts/WalletContext';
import { useTelegram } from '@/hooks/useTelegram';

const TETHER_ICON = '/tether.png';

export function HoldButton() {
  const { 
    canHold, 
    claim, 
    HOLD_DURATION,
    remainingHolds,
    getResetTime 
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
  const isCompletedRef = useRef(false);

  const calculatePrize = () => {
    return Math.floor(Math.random() * 7 + 2) / 100;
  };

  const stopHold = useCallback(() => {
    setIsHolding(false);
    
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    
    startTimeRef.current = null;
    
    if (!isCompletedRef.current) {
      setProgress(0);
      setStatus('hold');
    }
  }, []);

  const updateProgress = useCallback(() => {
    if (!startTimeRef.current) return;
    
    const elapsed = Date.now() - startTimeRef.current;
    const newProgress = Math.min(elapsed / HOLD_DURATION, 1);
    setProgress(newProgress);

    const remaining = Math.ceil((HOLD_DURATION - elapsed) / 1000);
    if (remaining > 0 && elapsed < HOLD_DURATION) {
      setStatus(`${remaining}`);
    }

    if (elapsed < HOLD_DURATION && !isCompletedRef.current) {
      frameRef.current = requestAnimationFrame(updateProgress);
    }
  }, [HOLD_DURATION]);

  const onHoldComplete = useCallback(async () => {
    isCompletedRef.current = true;
    vibrate('success');
    setProgress(1);
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
        isCompletedRef.current = false;
      }, 2000);
    }, 300);
  }, [claim, vibrate]);

  const startHold = useCallback(() => {
    if (!canHold() || remainingHolds <= 0) {
      vibrate('error');
      setStatus('wait');
      setTimeout(() => setStatus('hold'), 1500);
      return;
    }

    isCompletedRef.current = false;
    vibrate('impact');
    setIsHolding(true);
    setStatus('3');
    setProgress(0);
    startTimeRef.current = Date.now();
    
    frameRef.current = requestAnimationFrame(updateProgress);

    timerRef.current = setTimeout(() => {
      onHoldComplete();
      stopHold();
    }, HOLD_DURATION);
  }, [canHold, remainingHolds, vibrate, updateProgress, onHoldComplete, HOLD_DURATION, stopHold]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const radius = 88;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  const resetTime = getResetTime();
  const isDisabled = remainingHolds <= 0 && resetTime;

  return (
    <div className="relative flex flex-col items-center" data-testid="hold-section">
      <div className="text-center mb-2">
        <h2 className="font-display text-lg font-semibold text-white">Hold to Earn</h2>
        <p className="text-xs text-white/40 mt-1">Hold the button to get your prize</p>
      </div>

      <div className="flex items-center gap-2 mb-4" data-testid="holds-remaining">
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

      <div className="relative w-52 h-52 flex items-center justify-center">
        <div className={`
          absolute inset-0 rounded-full 
          transition-opacity duration-300
          ${isHolding ? 'opacity-100' : 'opacity-0'}
        `}
        style={{
          background: 'radial-gradient(circle, rgba(0,230,118,0.15) 0%, transparent 70%)',
        }}
        />

        <svg 
          className="absolute inset-0 w-full h-full"
          viewBox="0 0 200 200"
          style={{ transform: 'rotate(-90deg)' }}
        >
          <circle
            cx="100"
            cy="100"
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="6"
          />
          <circle
            cx="100"
            cy="100"
            r={radius}
            fill="none"
            stroke="#00E676"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            style={{
              transition: 'stroke-dashoffset 0.1s linear',
              filter: isHolding ? 'drop-shadow(0 0 8px rgba(0,230,118,0.6))' : 'none',
            }}
          />
        </svg>

        <AnimatePresence>
          {showRipple && (
            <motion.div
              className="absolute inset-0 rounded-full border-2 border-brand-green"
              initial={{ scale: 1, opacity: 1 }}
              animate={{ scale: 1.5, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.6 }}
            />
          )}
        </AnimatePresence>

        <motion.button
          data-testid="hold-button"
          className={`
            relative w-40 h-40 rounded-full
            flex items-center justify-center
            select-none cursor-pointer
            overflow-hidden
            ${isDisabled ? 'opacity-50 cursor-not-allowed' : ''}
          `}
          onMouseDown={!isDisabled ? startHold : undefined}
          onMouseUp={stopHold}
          onMouseLeave={stopHold}
          onTouchStart={!isDisabled ? startHold : undefined}
          onTouchEnd={stopHold}
          whileTap={!isDisabled ? { scale: 0.95 } : {}}
          disabled={isDisabled}
        >
          <img 
            src={TETHER_ICON} 
            alt="Hold to Earn"
            className="w-full h-full object-cover pointer-events-none rounded-full"
            draggable={false}
          />
        </motion.button>

        <AnimatePresence>
          {showPrize && (
            <motion.div
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
              initial={{ scale: 0.5, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: -60 }}
              exit={{ scale: 0.8, opacity: 0, y: -100 }}
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

      <div className="mt-3 text-center">
        <span className={`
          text-sm font-semibold px-4 py-1.5 rounded-full inline-block
          ${status === 'done' ? 'bg-brand-green/20 text-brand-green' : ''}
          ${status === 'wait' ? 'bg-brand-red/20 text-brand-red' : ''}
          ${status === 'hold' ? 'text-white/50' : ''}
          ${!isNaN(parseInt(status)) ? 'text-white/70' : ''}
        `}>
          {status === 'hold' && 'Hold to earn'}
          {status === 'done' && '✓ Done!'}
          {status === 'wait' && 'Wait...'}
          {!isNaN(parseInt(status)) && `${status}s`}
        </span>
      </div>
    </div>
  );
}

export default HoldButton;

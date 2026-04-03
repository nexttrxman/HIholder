import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWallet } from '@/contexts/WalletContext';
import { useTelegram } from '@/hooks/useTelegram';

// Tether icon URL - local asset
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

  // Calculate prize (random between 0.02 and 0.08)
  const calculatePrize = () => {
    return Math.floor(Math.random() * 7 + 2) / 100; // 0.02 to 0.08
  };

  // Animation frame for smooth progress
  const updateProgress = useCallback(() => {
    if (!startTimeRef.current) return;
    
    const elapsed = Date.now() - startTimeRef.current;
    const newProgress = Math.min(elapsed / HOLD_DURATION, 1);
    setProgress(newProgress);

    // Update status
    const remaining = Math.ceil((HOLD_DURATION - elapsed) / 1000);
    if (remaining > 0 && elapsed < HOLD_DURATION) {
      setStatus(`${remaining}s`);
    }

    if (elapsed < HOLD_DURATION) {
      frameRef.current = requestAnimationFrame(updateProgress);
    }
  }, [HOLD_DURATION]);

  // Handle hold complete
  const onHoldComplete = useCallback(async () => {
    vibrate('success');
    setStatus('done');
    setShowRipple(true);
    
    const prize = calculatePrize();
    setPrizeAmount(prize);
    
    // Claim reward
    await claim(prize);
    
    // Show prize animation
    setTimeout(() => {
      setShowPrize(true);
      setTimeout(() => {
        setShowPrize(false);
        setShowRipple(false);
        setProgress(0);
        setStatus('hold');
      }, 2000);
    }, 300);
  }, [claim, vibrate]);

  // Start holding
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
    startTimeRef.current = Date.now();
    
    // Start progress animation
    frameRef.current = requestAnimationFrame(updateProgress);

    // Set completion timer
    timerRef.current = setTimeout(() => {
      onHoldComplete();
      stopHold();
    }, HOLD_DURATION);
  }, [canHold, remainingHolds, vibrate, updateProgress, onHoldComplete, HOLD_DURATION]);

  // Stop holding
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
    
    // Only reset if not completed
    if (status !== 'done') {
      setProgress(0);
      setStatus('hold');
    }
  }, [status]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  // SVG arc calculations
  const radius = 90;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  const resetTime = getResetTime();
  const isDisabled = remainingHolds <= 0 && resetTime;

  return (
    <div className="relative flex flex-col items-center" data-testid="hold-section">
      {/* Title */}
      <div className="text-center mb-2">
        <h2 className="font-display text-lg font-semibold text-white">Hold to Earn</h2>
        <p className="text-xs text-white/40 mt-1">Hold the button to get your prize</p>
      </div>

      {/* Remaining holds indicator */}
      <div className="flex items-center gap-2 mb-6" data-testid="holds-remaining">
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

      {/* Hold Button Container */}
      <div className="relative w-56 h-56 flex items-center justify-center">
        {/* Background glow */}
        <div className={`
          absolute inset-0 rounded-full 
          transition-opacity duration-300
          ${isHolding ? 'opacity-100' : 'opacity-0'}
        `}
        style={{
          background: 'radial-gradient(circle, rgba(0,230,118,0.15) 0%, transparent 70%)',
        }}
        />

        {/* Progress Ring */}
        <svg 
          className="absolute inset-0 w-full h-full progress-ring"
          viewBox="0 0 204 204"
        >
          {/* Background ring */}
          <circle
            cx="102"
            cy="102"
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.05)"
            strokeWidth="4"
          />
          {/* Progress ring */}
          <circle
            cx="102"
            cy="102"
            r={radius}
            fill="none"
            stroke={progress >= 1 ? '#00E676' : '#00E676'}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            className="transition-all duration-75"
            style={{
              filter: isHolding ? 'drop-shadow(0 0 8px rgba(0,230,118,0.5))' : 'none',
            }}
          />
        </svg>

        {/* Ripple Effect */}
        <AnimatePresence>
          {showRipple && (
            <motion.div
              className="absolute inset-0 rounded-full border-2 border-brand-green"
              initial={{ scale: 1, opacity: 1 }}
              animate={{ scale: 2, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.6 }}
            />
          )}
        </AnimatePresence>

        {/* Main Button */}
        <motion.button
          data-testid="hold-button"
          className={`
            relative w-44 h-44 rounded-full
            flex flex-col items-center justify-center
            select-none cursor-pointer
            transition-shadow duration-300
            overflow-hidden
            ${isDisabled ? 'opacity-50 cursor-not-allowed' : ''}
            ${isHolding ? 'shadow-[0_0_60px_rgba(0,230,118,0.3)]' : ''}
          `}
          onMouseDown={!isDisabled ? startHold : undefined}
          onMouseUp={stopHold}
          onMouseLeave={stopHold}
          onTouchStart={!isDisabled ? startHold : undefined}
          onTouchEnd={stopHold}
          whileTap={!isDisabled ? { scale: 0.92 } : {}}
          disabled={isDisabled}
        >
          {/* Tether Button Image */}
          <img 
            src={TETHER_ICON} 
            alt="Hold to Earn"
            className="w-full h-full object-cover pointer-events-none"
            draggable={false}
          />
          
        </motion.button>

        {/* Status indicator below button */}
        <div className="absolute -bottom-8 left-1/2 -translate-x-1/2">
          <span className={`
            text-sm font-semibold px-4 py-1 rounded-full
            ${status === 'done' ? 'bg-brand-green/20 text-brand-green' : ''}
            ${status === 'wait' ? 'bg-brand-red/20 text-brand-red' : ''}
            ${status === 'hold' ? 'text-white/50' : ''}
            ${status === 'holding' ? 'text-white/70' : ''}
            ${status !== 'hold' && status !== 'holding' && status !== 'done' && status !== 'wait' ? 'text-white/70' : ''}
          `}>
            {status === 'hold' && 'Hold to earn'}
            {status === 'holding' && `${status}...`}
            {status === 'done' && '✓ Done!'}
            {status === 'wait' && 'Wait...'}
            {status !== 'hold' && status !== 'holding' && status !== 'done' && status !== 'wait' && `${status}s left`}
          </span>
        </div>

        {/* Prize Animation */}
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
    </div>
  );
}

export default HoldButton;

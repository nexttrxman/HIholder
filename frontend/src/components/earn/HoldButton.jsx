import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWallet } from '@/contexts/WalletContext';
import { useTelegram } from '@/hooks/useTelegram';
import { Clock, AlertTriangle } from 'lucide-react';

const TETHER_ICON = '/tether.png';

export function HoldButton({ onClaimReady }) {
  const { 
    canHold, 
    doHold, 
    HOLD_DURATION,
    remainingHolds,
    holdsCompleted,
    pendingClaim,
    getCycleResetTime,
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
    
    // Register hold with backend
    const result = await doHold(prize);
    
    setTimeout(() => {
      setShowPrize(true);
      setTimeout(() => {
        setShowPrize(false);
        setShowRipple(false);
        setProgress(0);
        setStatus('hold');
        isCompletedRef.current = false;
        
        // If claim ready, notify parent
        if (result.success && result.claim) {
          vibrate('success');
          onClaimReady?.(result.claim);
        }
      }, 2000);
    }, 300);
  }, [doHold, vibrate, onClaimReady]);

  const startHold = useCallback(() => {
    if (!canHold() || remainingHolds <= 0) {
      vibrate('error');
      if (pendingClaim) {
        setStatus('claim!');
      } else {
        setStatus('wait');
      }
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
  }, [canHold, remainingHolds, pendingClaim, vibrate, updateProgress, onHoldComplete, HOLD_DURATION, stopHold]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const radius = 88;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  const resetTime = getCycleResetTime();
  const isDisabled = !canHold() || (remainingHolds <= 0 && !pendingClaim);
  const hasPendingClaim = !!pendingClaim;

  return (
    <div className="relative flex flex-col items-center" data-testid="hold-section">
      <div className="text-center mb-2">
        <h2 className="font-display text-lg font-semibold text-white">Hold to Earn</h2>
        <p className="text-xs text-white/40 mt-1">
          {hasPendingClaim 
            ? 'Cycle complete! Claim your reward below' 
            : 'Complete 3 holds to unlock your reward'}
        </p>
      </div>

      {/* Progress dots */}
      <div className="flex items-center gap-3 mb-4" data-testid="holds-remaining">
        <div className="flex gap-2">
          {[1, 2, 3].map((num) => (
            <div
              key={num}
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                num <= holdsCompleted 
                  ? 'bg-brand-green text-black' 
                  : 'bg-white/10 text-white/40'
              }`}
            >
              {num}
            </div>
          ))}
        </div>
      </div>

      {/* Pending claim warning */}
      {hasPendingClaim && (
        <motion.div
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-yellow-500/10 border border-yellow-500/30 mb-4"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <AlertTriangle className="w-4 h-4 text-yellow-500" />
          <span className="text-xs text-yellow-500">Claim before time expires!</span>
        </motion.div>
      )}

      {/* Hold button container */}
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
            stroke={hasPendingClaim ? '#EAB308' : '#00E676'}
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
            ${isDisabled && !hasPendingClaim ? 'opacity-50 cursor-not-allowed' : ''}
            ${hasPendingClaim ? 'ring-4 ring-yellow-500/50 animate-pulse' : ''}
          `}
          onMouseDown={!isDisabled ? startHold : undefined}
          onMouseUp={stopHold}
          onMouseLeave={stopHold}
          onTouchStart={!isDisabled ? startHold : undefined}
          onTouchEnd={stopHold}
          whileTap={!isDisabled ? { scale: 0.95 } : {}}
          disabled={isDisabled && !hasPendingClaim}
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

      {/* Status text */}
      <div className="mt-3 text-center">
        <span className={`
          text-sm font-semibold px-4 py-1.5 rounded-full inline-block
          ${status === 'done' ? 'bg-brand-green/20 text-brand-green' : ''}
          ${status === 'wait' || status === 'claim!' ? 'bg-yellow-500/20 text-yellow-500' : ''}
          ${status === 'hold' ? 'text-white/50' : ''}
          ${!isNaN(parseInt(status)) ? 'text-white/70' : ''}
        `}>
          {status === 'hold' && (hasPendingClaim ? 'Claim your reward!' : 'Hold to earn')}
          {status === 'done' && '✓ Done!'}
          {status === 'wait' && 'Wait...'}
          {status === 'claim!' && 'Claim first!'}
          {!isNaN(parseInt(status)) && `${status}s`}
        </span>
      </div>

      {/* Cycle reset timer */}
      {resetTime && !hasPendingClaim && holdsCompleted === 0 && (
        <div className="flex items-center gap-1 mt-2 text-xs text-white/40">
          <Clock className="w-3 h-3" />
          <span>New cycle in {resetTime}</span>
        </div>
      )}
    </div>
  );
}

export default HoldButton;

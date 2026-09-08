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
  // Full-screen burst fired when a hold completes. Holds the button centre in
  // viewport coordinates so the nova radiates from where the finger was.
  const [nova, setNova] = useState(null);

  const buttonRef = useRef(null);
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

    // NOVA: overlay the whole screen, centred on the button.
    const rect = buttonRef.current?.getBoundingClientRect?.();
    setNova({
      x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
      y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2,
      gold: !!pendingClaim,
    });
    setTimeout(() => setNova(null), 1100);
    
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
        <h2 className="font-display text-lg font-bold tracking-tight text-white text-glow-teal">Hold to Earn</h2>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-dim mt-1.5">
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
                  ? 'bg-brand-green text-black shadow-glow-teal' 
                  : 'bg-white/[0.06] text-white/35 border border-white/[0.07]'
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
          className="chip chip-gold !px-4 !py-2 !text-[11px] mb-4 shadow-glow-gold"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <AlertTriangle className="w-4 h-4" />
          <span>Claim before time expires!</span>
        </motion.div>
      )}

      {/* ============================================
          NOVA — full-screen burst when a hold completes
          ============================================ */}
      {/* No AnimatePresence here on purpose: the layers below fade themselves
          out, and an exit animation would keep the overlay mounted after the
          burst is over. */}
      {nova && (
        <motion.div
          className="fixed inset-0 z-[70] pointer-events-none"
          data-testid="hold-nova"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 1.05, ease: 'easeOut' }}
          aria-hidden
        >
            {/* wash over the whole screen */}
            <motion.div
              className="absolute inset-0"
              initial={{ opacity: 0.9 }}
              animate={{ opacity: 0 }}
              transition={{ duration: 0.9, ease: 'easeOut' }}
              style={{
                background: `radial-gradient(circle 70vmax at ${nova.x}px ${nova.y}px, ${
                  nova.gold ? 'rgba(255,209,102,0.30)' : 'rgba(87,214,200,0.28)'
                } 0%, ${
                  nova.gold ? 'rgba(255,209,102,0.10)' : 'rgba(87,214,200,0.09)'
                } 35%, transparent 70%)`,
              }}
            />
            {/* two shockwaves */}
            {[0, 0.14].map((delay, i) => (
              <motion.span
                key={i}
                className="absolute rounded-full border"
                style={{
                  left: nova.x,
                  top: nova.y,
                  borderColor: nova.gold ? 'rgba(255,209,102,0.75)' : 'rgba(140,242,219,0.7)',
                  boxShadow: nova.gold
                    ? '0 0 40px rgba(255,209,102,0.45)'
                    : '0 0 40px rgba(87,214,200,0.4)',
                }}
                initial={{ width: 40, height: 40, x: -20, y: -20, opacity: 0.95, borderWidth: 3 }}
                animate={{ width: '190vmax', height: '190vmax', x: '-95vmax', y: '-95vmax', opacity: 0, borderWidth: 1 }}
                transition={{ duration: 0.95, delay, ease: 'easeOut' }}
              />
          ))}
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
          background: 'radial-gradient(circle, rgba(87,214,200,0.18) 0%, transparent 70%)',
        }}
        />

        <svg
          className="absolute inset-0 w-full h-full"
          viewBox="0 0 200 200"
          /* overflow visible: an SVG filter region is a rectangle, so the
             ring's glow used to get cut off in a box. */
          style={{ transform: 'rotate(-90deg)', overflow: 'visible' }}
        >
          <circle
            cx="100"
            cy="100"
            r={radius}
            fill="none"
            stroke="rgba(233,255,251,0.08)"
            strokeWidth="6"
          />
          <circle
            cx="100"
            cy="100"
            r={radius}
            fill="none"
            stroke={hasPendingClaim ? '#ffd166' : '#57d6c8'}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            style={{
              transition: 'stroke-dashoffset 0.1s linear',
              filter: isHolding
                ? `drop-shadow(0 0 10px ${hasPendingClaim ? 'rgba(255,209,102,0.65)' : 'rgba(87,214,200,0.65)'})`
                : 'none',
            }}
          />
        </svg>

        <AnimatePresence>
          {showRipple && (
            <motion.div
              className="absolute inset-0 rounded-full border-2 border-brand-mint"
              initial={{ scale: 1, opacity: 1 }}
              animate={{ scale: 1.5, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.6 }}
            />
          )}
        </AnimatePresence>

        <motion.button
          ref={buttonRef}
          data-testid="hold-button"
          className={`
            relative w-40 h-40 rounded-full
            flex items-center justify-center
            select-none cursor-pointer
            ${isDisabled && !hasPendingClaim ? 'opacity-50 cursor-not-allowed' : ''}
            ${hasPendingClaim ? 'ring-4 ring-brand-gold/40 animate-pulse shadow-glow-gold' : 'shadow-glow-teal'}
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
              <div className="px-6 py-3 rounded-2xl bg-brand-gold/15 backdrop-blur-md border border-brand-gold/35 shadow-glow-gold">
                <span className="font-display text-2xl font-bold text-brand-gold text-glow-gold">
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
          chip !text-[11px] !px-4 !py-1.5 inline-flex
          ${status === 'done' ? 'chip-teal' : ''}
          ${status === 'wait' || status === 'claim!' ? 'chip-gold' : ''}
          ${status === 'hold' ? '!text-white/55' : ''}
          ${!isNaN(parseInt(status)) ? 'chip-blue sys-value' : ''}
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
        <div className="flex items-center justify-center gap-1.5 mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim">
          <Clock className="w-3 h-3" />
          <span>New cycle in {resetTime}</span>
        </div>
      )}
    </div>
  );
}

export default HoldButton;

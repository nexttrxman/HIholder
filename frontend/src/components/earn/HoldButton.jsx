import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWallet } from '@/contexts/WalletContext';
import { useTelegram } from '@/hooks/useTelegram';
import { startHold, claimReward } from '@/services/api';

// Tether icon URL - local asset
const TETHER_ICON = '/tether.png';

export function HoldButton() {
  const { 
    user,
    setUser,
    refreshUser,
    remainingHolds,
    getResetTime,
  } = useWallet();
  const { vibrate } = useTelegram();

  // Hold state
  const [holdActive, setHoldActive] = useState(false);
  const [progress, setProgress] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [holdDuration, setHoldDuration] = useState(0);
  const [expiresAt, setExpiresAt] = useState(null);
  const [status, setStatus] = useState('hold'); // hold | holding | claimable | done | wait | blocked
  const [showPrize, setShowPrize] = useState(false);
  const [prizeAmount, setPrizeAmount] = useState(0);
  const [showRipple, setShowRipple] = useState(false);
  const [loading, setLoading] = useState(false);

  const frameRef = useRef(null);
  const resetCheckRef = useRef(null);

  // Animation frame - actualiza progress y countdown cada 100ms
  const updateProgress = useCallback(() => {
    if (!expiresAt) return;
    const now = Date.now();
    const remaining = new Date(expiresAt).getTime() - now;
    
    if (remaining > 0) {
      const pct = 1 - remaining / (holdDuration * 1000);
      setProgress(Math.min(pct, 1));
      setCountdown(Math.ceil(remaining / 1000));
      frameRef.current = requestAnimationFrame(updateProgress);
    } else {
      // Hold expirado - listo para claim
      setProgress(1);
      setCountdown(0);
      setStatus('claimable');
      vibrate('success');
    }
  }, [expiresAt, holdDuration, vibrate]);

  // Auto-reset check: cuando holds_reset_at pasa, refresca user
  useEffect(() => {
    if (user?.holds_count >= 3 && user?.holds_reset_at) {
      const resetMs = new Date(user.holds_reset_at).getTime() - Date.now();
      if (resetMs > 0) {
        setStatus('blocked');
        resetCheckRef.current = setTimeout(async () => {
          await refreshUser();
          setStatus('hold');
        }, resetMs);
      } else {
        // Ya paso el reset, refrescar inmediatamente
        refreshUser();
        setStatus('hold');
      }
    } else if (status === 'blocked') {
      setStatus('hold');
    }
    return () => {
      if (resetCheckRef.current) clearTimeout(resetCheckRef.current);
    };
  }, [user?.holds_count, user?.holds_reset_at]);

  // Arrancar progress animation cuando hay hold activo
  useEffect(() => {
    if (holdActive && expiresAt) {
      frameRef.current = requestAnimationFrame(updateProgress);
    }
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [holdActive, expiresAt, updateProgress]);

  // START HOLD - llama al servidor que asigna duracion random
  const handleStartHold = useCallback(async () => {
    if (loading || remainingHolds <= 0) {
      vibrate('error');
      setStatus('wait');
      setTimeout(() => setStatus(remainingHolds > 0 ? 'hold' : 'blocked'), 1500);
      return;
    }

    try {
      setLoading(true);
      vibrate('impact');
      setStatus('holding');

      const result = await startHold();

      if (!result.ok) throw new Error('startHold failed');

      if (result.alreadyActive) {
        // Ya habia un hold activo - retomar
        setHoldDuration(result.duration);
        setExpiresAt(result.expiresAt);
        setHoldActive(true);
        setCountdown(Math.ceil(result.remainingMs / 1000));
      } else {
        setHoldDuration(result.duration);
        setExpiresAt(result.expiresAt);
        setHoldActive(true);
        setCountdown(result.duration);
      }

      // Refrescar user para actualizar holds_count en UI
      await refreshUser();
    } catch (err) {
      console.error('startHold error:', err);
      vibrate('error');
      setStatus('hold');
    } finally {
      setLoading(false);
    }
  }, [loading, remainingHolds, vibrate, refreshUser]);

  // CLAIM - el servidor calcula el premio, NO lo mandamos nosotros
  const handleClaim = useCallback(async () => {
    if (status !== 'claimable' || loading) return;

    try {
      setLoading(true);
      vibrate('impact');

      const result = await claimReward();

      if (!result.ok) throw new Error('claimReward failed');

      const prize = result.prize || 0;
      setPrizeAmount(prize);
      setShowRipple(true);
      setStatus('done');
      vibrate('success');

      // Mostrar animacion del premio
      setTimeout(() => {
        setShowPrize(true);
        setTimeout(() => {
          setShowPrize(false);
          setShowRipple(false);
          setProgress(0);
          setHoldActive(false);
          setExpiresAt(null);
          setHoldDuration(0);
          setStatus('hold');
        }, 2000);
      }, 300);

      // Refrescar user (actualiza holds_count, total_earned, holds_reset_at)
      await refreshUser();
    } catch (err) {
      console.error('claimReward error:', err);
      vibrate('error');
      setStatus('claimable');
    } finally {
      setLoading(false);
    }
  }, [status, loading, vibrate, refreshUser]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      if (resetCheckRef.current) clearTimeout(resetCheckRef.current);
    };
  }, []);

  // SVG arc calculations
  const radius = 90;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  const resetTime = getResetTime();
  const isBlocked = remainingHolds <= 0 && resetTime;
  const isClaimable = status === 'claimable';
  const isHolding = status === 'holding';

  const handleButtonPress = () => {
    if (isBlocked || loading) return;
    if (isClaimable) {
      handleClaim();
    } else if (!holdActive) {
      handleStartHold();
    }
  };

  return (
    <div className="relative flex flex-col items-center" data-testid="hold-section">
      {/* Title */}
      <div className="text-center mb-2">
        <h2 className="font-display text-lg font-semibold text-white">Hold to Earn</h2>
        <p className="text-xs text-white/40 mt-1">
          {isClaimable ? 'Tap to claim your prize!' : 'Hold the button to get your prize'}
        </p>
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
          ${isHolding || isClaimable ? 'opacity-100' : 'opacity-0'}
        `}
        style={{
          background: isClaimable
            ? 'radial-gradient(circle, rgba(0,230,118,0.25) 0%, transparent 70%)'
            : 'radial-gradient(circle, rgba(0,230,118,0.15) 0%, transparent 70%)',
        }}
        />

        {/* Progress Ring */}
        <svg 
          className="absolute inset-0 w-full h-full progress-ring"
          viewBox="0 0 204 204"
        >
          <circle
            cx="102"
            cy="102"
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.05)"
            strokeWidth="4"
          />
          <circle
            cx="102"
            cy="102"
            r={radius}
            fill="none"
            stroke="#00E676"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            className="transition-all duration-75"
            style={{
              filter: (isHolding || isClaimable) ? 'drop-shadow(0 0 8px rgba(0,230,118,0.5))' : 'none',
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
            ${isBlocked || loading ? 'opacity-50 cursor-not-allowed' : ''}
            ${isHolding ? 'shadow-[0_0_60px_rgba(0,230,118,0.3)]' : ''}
            ${isClaimable ? 'shadow-[0_0_80px_rgba(0,230,118,0.5)]' : ''}
          `}
          onClick={handleButtonPress}
          onTouchStart={(!isBlocked && !loading && !holdActive) ? handleStartHold : undefined}
          onTouchEnd={undefined}
          whileTap={(!isBlocked && !loading) ? { scale: 0.92 } : {}}
          disabled={isBlocked || loading}
        >
          <img 
            src={TETHER_ICON} 
            alt="Hold to Earn"
            className="w-full h-full object-cover pointer-events-none"
            draggable={false}
          />
        </motion.button>

        {/* Status indicator */}
        <div className="absolute -bottom-8 left-1/2 -translate-x-1/2">
          <span className={`
            text-sm font-semibold px-4 py-1 rounded-full
            ${status === 'done' ? 'bg-brand-green/20 text-brand-green' : ''}
            ${status === 'wait' || status === 'blocked' ? 'bg-brand-red/20 text-brand-red' : ''}
            ${status === 'claimable' ? 'bg-brand-green/30 text-brand-green animate-pulse' : ''}
            ${status === 'hold' ? 'text-white/50' : ''}
            ${status === 'holding' ? 'text-white/70' : ''}
          `}>
            {status === 'hold' && 'Hold to earn'}
            {status === 'holding' && (countdown > 0 ? `${countdown}s left` : 'Holding...')}
            {status === 'claimable' && '⭐ Tap to claim!'}
            {status === 'done' && '✓ Done!'}
            {status === 'wait' && 'No holds left'}
            {status === 'blocked' && `Resets in ${resetTime}`}
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

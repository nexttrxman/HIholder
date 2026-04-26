import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTonConnectUI, useTonWallet } from '@tonconnect/ui-react';
import { useWallet } from '@/contexts/WalletContext';
import { useTelegram } from '@/hooks/useTelegram';
import { 
  Clock, 
  Wallet, 
  CheckCircle, 
  AlertTriangle, 
  Loader2,
  X,
  ExternalLink 
} from 'lucide-react';

export function ClaimModal({ isOpen, onClose, claim }) {
  const { verifyClaim, treasuryWallet, tonFee, refreshData } = useWallet();
  const { vibrate } = useTelegram();
  const [tonConnectUI] = useTonConnectUI();
  const wallet = useTonWallet();

  const [step, setStep] = useState('info'); // info, connecting, paying, verifying, success, expired
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [error, setError] = useState(null);
  const [txHash, setTxHash] = useState(null);

  // Calculate seconds remaining
  useEffect(() => {
    if (!claim?.expires_at) return;

    const updateTimer = () => {
      const diff = new Date(claim.expires_at) - new Date();
      const secs = Math.max(0, Math.floor(diff / 1000));
      setSecondsRemaining(secs);
      
      if (secs <= 0) {
        setStep('expired');
        vibrate('error');
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [claim?.expires_at, vibrate]);

  // Format time
  const formatTime = (secs) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins}:${s.toString().padStart(2, '0')}`;
  };

  // Handle wallet connection
  const handleConnect = useCallback(async () => {
    setStep('connecting');
    setError(null);
    
    try {
      await tonConnectUI.openModal();
    } catch (err) {
      setError('Failed to open wallet');
      setStep('info');
    }
  }, [tonConnectUI]);

  // Handle payment
  const handlePay = useCallback(async () => {
    if (!wallet || !claim) return;
    
    setStep('paying');
    setError(null);
    vibrate('impact');

    try {
      // Create transaction
      const transaction = {
        validUntil: Math.floor(Date.now() / 1000) + 300, // 5 minutes
        messages: [
          {
            address: treasuryWallet,
            amount: (tonFee * 1e9).toString(), // Convert to nanoTON
            payload: btoa(`CLAIM:${claim.claim_id}`), // Base64 encoded comment
          },
        ],
      };

      const result = await tonConnectUI.sendTransaction(transaction);
      
      if (result?.boc) {
        // Extract tx hash from BOC (simplified - in production use proper parsing)
        const hash = btoa(result.boc).slice(0, 64);
        setTxHash(hash);
        
        // Verify payment
        setStep('verifying');
        const verifyResult = await verifyClaim(claim.claim_id, hash);
        
        if (verifyResult.success) {
          setStep('success');
          vibrate('success');
        } else {
          setError(verifyResult.error || 'Verification failed');
          setStep('info');
        }
      }
    } catch (err) {
      console.error('Payment error:', err);
      setError(err.message || 'Payment failed');
      setStep('info');
      vibrate('error');
    }
  }, [wallet, claim, treasuryWallet, tonFee, tonConnectUI, verifyClaim, vibrate]);

  // Handle close
  const handleClose = useCallback(() => {
    if (step === 'success') {
      refreshData();
    }
    onClose();
    // Reset state
    setTimeout(() => {
      setStep('info');
      setError(null);
      setTxHash(null);
    }, 300);
  }, [step, refreshData, onClose]);

  if (!isOpen || !claim) return null;

  const isUrgent = secondsRemaining < 120; // Less than 2 minutes

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <motion.div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={step !== 'paying' && step !== 'verifying' ? handleClose : undefined}
      />

      <motion.div
        className="relative w-full max-w-md bg-app-surface rounded-t-3xl border-t border-white/10 max-h-[85vh] overflow-hidden"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <h2 className="font-display text-lg font-bold text-white">Claim Reward</h2>
          {step !== 'paying' && step !== 'verifying' && (
            <button onClick={handleClose} className="p-2 -mr-2 text-white/40 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="p-5">
          <AnimatePresence mode="wait">
            {/* Info Step */}
            {step === 'info' && (
              <motion.div
                key="info"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-4"
              >
                {/* Timer */}
                <div className={`flex items-center justify-center gap-2 py-3 px-4 rounded-xl ${
                  isUrgent ? 'bg-red-500/20 border border-red-500/30' : 'bg-white/5 border border-white/10'
                }`}>
                  <Clock className={`w-5 h-5 ${isUrgent ? 'text-red-500' : 'text-white/60'}`} />
                  <span className={`font-mono text-2xl font-bold ${isUrgent ? 'text-red-500' : 'text-white'}`}>
                    {formatTime(secondsRemaining)}
                  </span>
                  <span className="text-xs text-white/40">remaining</span>
                </div>

                {/* Prize Info */}
                <div className="text-center py-4">
                  <p className="text-white/50 text-sm mb-1">Your Reward</p>
                  <p className="text-4xl font-bold text-brand-green font-display">
                    ${claim.total_prize.toFixed(2)}
                  </p>
                  <p className="text-xs text-white/40 mt-1">USDT (internal balance)</p>
                </div>

                {/* Fee Info */}
                <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-white/50">Claim Fee</span>
                    <span className="text-white font-semibold">{tonFee} TON</span>
                  </div>
                  <p className="text-xs text-white/40">
                    A small TON fee is required to validate your claim.
                  </p>
                </div>

                {/* Error */}
                {error && (
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30">
                    <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
                    <span className="text-sm text-red-500">{error}</span>
                  </div>
                )}

                {/* Action Button */}
                {!wallet ? (
                  <button
                    onClick={handleConnect}
                    className="w-full py-4 rounded-2xl bg-[#0098EA] text-white font-bold flex items-center justify-center gap-2 hover:bg-[#0098EA]/90 active:scale-95 transition-all"
                  >
                    <Wallet className="w-5 h-5" />
                    Connect TON Wallet
                  </button>
                ) : (
                  <button
                    onClick={handlePay}
                    className="w-full py-4 rounded-2xl bg-brand-green text-black font-bold flex items-center justify-center gap-2 hover:bg-brand-green/90 active:scale-95 transition-all"
                  >
                    Pay {tonFee} TON & Claim
                  </button>
                )}

                {wallet && (
                  <p className="text-xs text-center text-white/40">
                    Connected: {wallet.account.address.slice(0, 8)}...{wallet.account.address.slice(-6)}
                  </p>
                )}
              </motion.div>
            )}

            {/* Connecting Step */}
            {step === 'connecting' && (
              <motion.div
                key="connecting"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="py-12 text-center"
              >
                <Loader2 className="w-12 h-12 mx-auto text-[#0098EA] animate-spin mb-4" />
                <p className="text-white font-semibold">Connecting wallet...</p>
                <p className="text-sm text-white/40 mt-1">Approve in your wallet app</p>
              </motion.div>
            )}

            {/* Paying Step */}
            {step === 'paying' && (
              <motion.div
                key="paying"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="py-12 text-center"
              >
                <Loader2 className="w-12 h-12 mx-auto text-brand-green animate-spin mb-4" />
                <p className="text-white font-semibold">Sending payment...</p>
                <p className="text-sm text-white/40 mt-1">Confirm transaction in your wallet</p>
              </motion.div>
            )}

            {/* Verifying Step */}
            {step === 'verifying' && (
              <motion.div
                key="verifying"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="py-12 text-center"
              >
                <Loader2 className="w-12 h-12 mx-auto text-brand-green animate-spin mb-4" />
                <p className="text-white font-semibold">Verifying payment...</p>
                <p className="text-sm text-white/40 mt-1">This may take a few seconds</p>
              </motion.div>
            )}

            {/* Success Step */}
            {step === 'success' && (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="py-8 text-center"
              >
                <motion.div
                  className="w-20 h-20 mx-auto mb-4 rounded-full bg-brand-green/20 flex items-center justify-center"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', delay: 0.1 }}
                >
                  <CheckCircle className="w-10 h-10 text-brand-green" />
                </motion.div>
                <h3 className="text-2xl font-bold text-white mb-2">Claimed!</h3>
                <p className="text-4xl font-bold text-brand-green font-display mb-2">
                  +${claim.total_prize.toFixed(2)}
                </p>
                <p className="text-sm text-white/50">Added to your internal balance</p>

                <button
                  onClick={handleClose}
                  className="mt-6 w-full py-4 rounded-2xl bg-white/10 text-white font-semibold hover:bg-white/20 active:scale-95 transition-all"
                >
                  Done
                </button>
              </motion.div>
            )}

            {/* Expired Step */}
            {step === 'expired' && (
              <motion.div
                key="expired"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="py-8 text-center"
              >
                <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center">
                  <Clock className="w-10 h-10 text-red-500" />
                </div>
                <h3 className="text-xl font-bold text-white mb-2">Claim Expired</h3>
                <p className="text-sm text-white/50 mb-6">
                  You didn't claim in time. Complete 3 more holds to get a new claim.
                </p>
                <button
                  onClick={handleClose}
                  className="w-full py-4 rounded-2xl bg-white/10 text-white font-semibold hover:bg-white/20 active:scale-95 transition-all"
                >
                  Start New Cycle
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

export default ClaimModal;

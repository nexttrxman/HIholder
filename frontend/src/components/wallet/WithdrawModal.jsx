import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, AlertTriangle, Check, Loader2 } from 'lucide-react';
import { useWallet } from '@/contexts/WalletContext';
import { useTelegram } from '@/hooks/useTelegram';
import { requestWithdraw } from '@/services/api';

const TETHER_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMzkuNDMgMjk1LjI3Ij48cGF0aCBmaWxsPSIjNTBBRjk1IiBkPSJNNjIuMTUgMS40NWwtNjIuMTUgMTE4LjIgNzIuMDMgNDAuNTRoMTk1LjI4bDcyLjA0LTQwLjU0TDI3Ny4xOSAxLjQ1SDYyLjE1eiIvPjxwYXRoIGZpbGw9IiNGRkYiIGQ9Ik0xOTEuMTkgMTQ0LjhjLTMuMTkuMjctMTkuNzYgMS40Ny0yMS41NSAxLjQ3cy0xOC4zNi0xLjItMjEuNTUtMS40N2MtNDIuNTEtMy41NS03NC40Ny0xNC45OS03NC40Ny0yOC43NXMzMS45Ni0yNS4yIDc0LjQ3LTI4Ljc1djQ1Ljc1YzMuMjMuMjMgMTguNTMgMS40NSAyMS42OCAxLjQ1czE4LjIzLTEuMjggMjEuNDItMS40NXYtNDUuNzVjNDIuNDYgMy41NSA3NC4zOCAxNS4wMiA3NC4zOCAyOC43NXMtMzEuOTIgMjUuMi03NC4zOCAyOC43NXptMC02MS41OHYtNDAuNTRoNTcuNzl2LTI4LjQ5aC0xNTguNnYyOC40OWg1Ny43OXY0MC41NGMtNDguMjUgNC4yLTg0LjQ5IDE4Ljg2LTg0LjQ5IDM2LjMyczM2LjI0IDMyLjEyIDg0LjQ5IDM2LjMydjExNS40Nmg0My4wMnYtMTE1LjQ2YzQ4LjE4LTQuMiA4NC4zNS0xOC44NSA4NC4zNS0zNi4zMnMtMzYuMTctMzIuMTItODQuMzUtMzYuMzJ6Ii8+PC9zdmc+';
const TRX_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHBhdGggZmlsbD0iI0VGMDAyNyIgZD0iTTE2IDBjOC44MzcgMCAxNiA3LjE2MyAxNiAxNnMtNy4xNjMgMTYtMTYgMTZTMCAyNC44MzcgMCAxNiA3LjE2MyAwIDE2IDB6Ii8+PHBhdGggZmlsbD0iI0ZGRiIgZD0iTTIxLjkzMiA5LjkxM0w3Ljc1IDcuNjg3bDcuMDk5IDE3LjU4NiA5LjcwNi0xMi42MzgtMi42MjMtMi43MjJ6bS0uNzM0IDMuMjU2bC01LjY5MyA3LjM5NC00LjcxLTExLjY3NyA5LjM2NiAxLjUzNi0uOTYzIDIuNzQ3eiIvPjwvc3ZnPg==';

// Validation helpers
const isValidTronAddress = (address) => {
  return address && address.length === 34 && address.startsWith('T');
};

export function WithdrawModal({ isOpen, onClose, initialAsset = 'USDT' }) {
  const { usdtBalance, trxBalance } = useWallet();
  const { vibrate } = useTelegram();

  const [step, setStep] = useState(1);
  const [asset, setAsset] = useState(initialAsset);
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const balance = asset === 'USDT' ? usdtBalance : trxBalance;
  const minWithdraw = asset === 'USDT' ? 5 : 10;
  const networkFee = 1.5; // TRX

  const resetForm = () => {
    setStep(1);
    setAmount('');
    setAddress('');
    setError(null);
    setResult(null);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSetMax = () => {
    const maxAmount = asset === 'USDT' 
      ? Math.max(0, balance) 
      : Math.max(0, balance - networkFee);
    setAmount(maxAmount.toFixed(2));
  };

  const validateStep2 = () => {
    const numAmount = parseFloat(amount);
    
    if (!amount || isNaN(numAmount) || numAmount <= 0) {
      setError('Enter a valid amount');
      return false;
    }
    
    if (numAmount < minWithdraw) {
      setError(`Minimum withdrawal is ${minWithdraw} ${asset}`);
      return false;
    }
    
    if (numAmount > balance) {
      setError('Insufficient balance');
      return false;
    }
    
    if (!isValidTronAddress(address)) {
      setError('Enter a valid TRON address (starts with T, 34 characters)');
      return false;
    }
    
    setError(null);
    return true;
  };

  const handleContinue = () => {
    if (step === 2 && !validateStep2()) {
      vibrate('error');
      return;
    }
    vibrate('impact');
    setStep(step + 1);
  };

  const handleBack = () => {
    setError(null);
    setStep(step - 1);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError(null);
    vibrate('impact');

    try {
      const result = await requestWithdraw({
        asset,
        amount: parseFloat(amount),
        toAddress: address,
      });

      if (result.ok) {
        setResult(result);
        vibrate('success');
        setStep(4); // Success step
      } else {
        throw new Error(result.message || 'Withdrawal failed');
      }
    } catch (err) {
      setError(err.message);
      vibrate('error');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      {/* Backdrop */}
      <motion.div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={handleClose}
      />

      {/* Modal */}
      <motion.div
        className="relative w-full max-w-md bg-app-surface rounded-t-3xl border-t border-white/10 max-h-[85vh] overflow-y-auto"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        data-testid="withdraw-modal"
      >
        {/* Header */}
        <div className="sticky top-0 bg-app-surface/95 backdrop-blur-sm border-b border-white/5 px-4 py-4 flex items-center gap-3 z-10">
          {step > 1 && step < 4 && (
            <button onClick={handleBack} className="p-2 -ml-2 text-white/60 hover:text-white">
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <h2 className="font-display text-lg font-semibold text-white flex-1">
            {step === 1 && 'Select Asset'}
            {step === 2 && 'Withdrawal Details'}
            {step === 3 && 'Confirm'}
            {step === 4 && 'Submitted'}
          </h2>
          <button 
            onClick={handleClose}
            className="text-white/40 hover:text-white text-sm"
          >
            Close
          </button>
        </div>

        <div className="p-4">
          {/* Step 1: Select Asset */}
          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-3"
              >
                <button
                  onClick={() => { setAsset('USDT'); setStep(2); vibrate('impact'); }}
                  data-testid="select-usdt"
                  className={`w-full p-4 rounded-2xl border transition-all flex items-center gap-4 ${
                    asset === 'USDT' 
                      ? 'bg-brand-green/10 border-brand-green/30' 
                      : 'bg-white/5 border-white/10 hover:bg-white/10'
                  }`}
                >
                  <img src={TETHER_ICON} alt="USDT" className="w-10 h-10" />
                  <div className="flex-1 text-left">
                    <p className="font-semibold text-white">USDT</p>
                    <p className="text-sm text-white/50">Tether USD</p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-white">${usdtBalance.toFixed(2)}</p>
                    <p className="text-xs text-white/40">Available</p>
                  </div>
                </button>

                <button
                  onClick={() => { setAsset('TRX'); setStep(2); vibrate('impact'); }}
                  data-testid="select-trx"
                  className={`w-full p-4 rounded-2xl border transition-all flex items-center gap-4 ${
                    asset === 'TRX' 
                      ? 'bg-brand-red/10 border-brand-red/30' 
                      : 'bg-white/5 border-white/10 hover:bg-white/10'
                  }`}
                >
                  <img src={TRX_ICON} alt="TRX" className="w-10 h-10" />
                  <div className="flex-1 text-left">
                    <p className="font-semibold text-white">TRX</p>
                    <p className="text-sm text-white/50">TRON</p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-white">{trxBalance.toFixed(2)}</p>
                    <p className="text-xs text-white/40">Available</p>
                  </div>
                </button>
              </motion.div>
            )}

            {/* Step 2: Amount & Address */}
            {step === 2 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                {/* Amount Input */}
                <div>
                  <label className="text-xs text-white/40 uppercase tracking-wider mb-2 block">
                    Amount
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      data-testid="withdraw-amount"
                      className="w-full p-4 pr-20 rounded-xl bg-white/5 border border-white/10 text-white text-lg font-semibold placeholder:text-white/20 focus:outline-none focus:border-white/30"
                    />
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                      <span className="text-white/40">{asset}</span>
                      <button
                        onClick={handleSetMax}
                        className="text-xs px-2 py-1 rounded-lg bg-white/10 text-brand-green hover:bg-white/20"
                      >
                        MAX
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-white/40 mt-2">
                    Available: {asset === 'USDT' ? '$' : ''}{balance.toFixed(2)} {asset}
                    <span className="text-white/30 ml-2">• Min: {minWithdraw} {asset}</span>
                  </p>
                </div>

                {/* Address Input */}
                <div>
                  <label className="text-xs text-white/40 uppercase tracking-wider mb-2 block">
                    To Address (TRON)
                  </label>
                  <input
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="TXyz..."
                    data-testid="withdraw-address"
                    className="w-full p-4 rounded-xl bg-white/5 border border-white/10 text-white font-mono text-sm placeholder:text-white/20 focus:outline-none focus:border-white/30"
                  />
                </div>

                {/* Network Fee Info */}
                <div className="p-3 rounded-xl bg-white/5 border border-white/10">
                  <div className="flex justify-between text-sm">
                    <span className="text-white/50">Network Fee</span>
                    <span className="text-white">~{networkFee} TRX</span>
                  </div>
                </div>

                {/* Error */}
                {error && (
                  <div className="p-3 rounded-xl bg-brand-red/10 border border-brand-red/20 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-brand-red flex-shrink-0" />
                    <span className="text-sm text-brand-red">{error}</span>
                  </div>
                )}

                <button
                  onClick={handleContinue}
                  data-testid="withdraw-continue"
                  className="w-full py-4 rounded-2xl bg-white text-black font-bold hover:bg-gray-200 active:scale-95 transition-all"
                >
                  Continue
                </button>
              </motion.div>
            )}

            {/* Step 3: Confirm */}
            {step === 3 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                <div className="p-5 rounded-2xl bg-white/5 border border-white/10 space-y-4">
                  <div className="flex justify-between">
                    <span className="text-white/50">Asset</span>
                    <span className="text-white font-semibold">{asset}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/50">Amount</span>
                    <span className="text-white font-semibold">
                      {asset === 'USDT' ? '$' : ''}{parseFloat(amount).toFixed(2)} {asset}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/50">To Address</span>
                    <span className="text-white font-mono text-sm">
                      {address.slice(0, 8)}...{address.slice(-6)}
                    </span>
                  </div>
                  <div className="border-t border-white/10 pt-4 flex justify-between">
                    <span className="text-white/50">Network Fee</span>
                    <span className="text-white">~{networkFee} TRX</span>
                  </div>
                </div>

                {/* Backend Notice */}
                <div className="p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-yellow-500/80">
                    <strong>Note:</strong> Final confirmation requires backend validation. 
                    Your request will be processed and confirmed shortly.
                  </p>
                </div>

                {error && (
                  <div className="p-3 rounded-xl bg-brand-red/10 border border-brand-red/20 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-brand-red flex-shrink-0" />
                    <span className="text-sm text-brand-red">{error}</span>
                  </div>
                )}

                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                  data-testid="withdraw-submit"
                  className="w-full py-4 rounded-2xl bg-white text-black font-bold hover:bg-gray-200 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    'Confirm Withdrawal'
                  )}
                </button>
              </motion.div>
            )}

            {/* Step 4: Success */}
            {step === 4 && (
              <motion.div
                key="step4"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-center py-8"
              >
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-brand-green/20 flex items-center justify-center">
                  <Check className="w-8 h-8 text-brand-green" />
                </div>
                <h3 className="font-display text-xl font-semibold text-white mb-2">
                  Request Submitted
                </h3>
                <p className="text-sm text-white/50 mb-6">
                  Your withdrawal request is being processed. You can track its status in History.
                </p>
                <button
                  onClick={handleClose}
                  data-testid="withdraw-done"
                  className="w-full py-4 rounded-2xl bg-white/10 border border-white/10 text-white font-semibold hover:bg-white/20 active:scale-95 transition-all"
                >
                  Done
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

export default WithdrawModal;

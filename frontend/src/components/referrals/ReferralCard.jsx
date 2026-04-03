import { useWallet } from '@/contexts/WalletContext';
import { useTelegram } from '@/hooks/useTelegram';
import { CopyButton } from '@/components/shared/CopyButton';
import { Share2, Users, Coins, AlertCircle } from 'lucide-react';
import { motion } from 'framer-motion';

export function ReferralCard() {
  const { 
    referralLink, 
    totalRefs, 
    trxFromRefs, 
    referralPool,
    uid 
  } = useWallet();
  const { share, vibrate } = useTelegram();

  const poolPercentage = (referralPool.remaining / referralPool.total) * 100;
  const isPoolLow = poolPercentage < 30;

  const handleShare = () => {
    vibrate('impact');
    share(uid);
  };

  return (
    <div className="space-y-4" data-testid="referral-section">
      {/* Pool Status - Urgency Banner */}
      <motion.div
        className={`p-4 rounded-2xl border ${
          isPoolLow 
            ? 'bg-brand-red/10 border-brand-red/30' 
            : 'bg-white/5 border-white/10'
        }`}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Coins className={`w-5 h-5 ${isPoolLow ? 'text-brand-red' : 'text-brand-green'}`} />
            <span className="font-semibold text-white">Referral Pool</span>
          </div>
          {isPoolLow && (
            <span className="text-xs px-2 py-1 rounded-full bg-brand-red/20 text-brand-red animate-pulse font-semibold">
              Running Low!
            </span>
          )}
        </div>

        {/* Pool Progress Bar */}
        <div className="w-full h-3 rounded-full bg-white/5 overflow-hidden mb-2">
          <motion.div
            className={`h-full rounded-full ${
              isPoolLow 
                ? 'bg-gradient-to-r from-brand-red to-red-400' 
                : 'bg-gradient-to-r from-brand-green to-emerald-400'
            }`}
            initial={{ width: 0 }}
            animate={{ width: `${poolPercentage}%` }}
            transition={{ duration: 1, ease: 'easeOut' }}
            style={{
              boxShadow: isPoolLow 
                ? '0 0 12px rgba(255,42,58,0.6)' 
                : '0 0 12px rgba(0,230,118,0.4)',
            }}
          />
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-white/50">Remaining</span>
          <span className={`font-bold ${isPoolLow ? 'text-brand-red' : 'text-brand-green'}`}>
            {referralPool.remaining.toLocaleString()} TRX
          </span>
        </div>
        <p className="text-xs text-white/30 mt-1">
          out of {referralPool.total.toLocaleString()} TRX total pool
        </p>
      </motion.div>

      {/* Your Stats */}
      <div className="grid grid-cols-2 gap-3">
        <motion.div
          className="glass-card rounded-2xl p-4 text-center"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Users className="w-6 h-6 text-brand-green mx-auto mb-2" />
          <p className="text-2xl font-bold text-white">{totalRefs}</p>
          <p className="text-xs text-white/40">Friends Invited</p>
        </motion.div>

        <motion.div
          className="glass-card rounded-2xl p-4 text-center"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
        >
          <Coins className="w-6 h-6 text-brand-green mx-auto mb-2" />
          <p className="text-2xl font-bold text-white">{trxFromRefs.toFixed(2)}</p>
          <p className="text-xs text-white/40">TRX Earned</p>
        </motion.div>
      </div>

      {/* Referral Link Card */}
      <motion.div
        className="glass-card rounded-2xl p-5"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <h3 className="font-display text-lg font-semibold text-white mb-1">
          Invite Friends
        </h3>
        <p className="text-sm text-white/50 mb-4">
          Earn <span className="text-brand-green font-semibold">2 TRX</span> for each friend who joins
        </p>

        {/* Link Display */}
        <div className="p-3 rounded-xl bg-white/5 border border-white/10 mb-4">
          <p className="text-xs text-white/40 mb-1">Your referral link</p>
          <code className="text-sm text-brand-green break-all" data-testid="referral-link">
            {referralLink}
          </code>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <CopyButton text={referralLink} label="Copy Link" className="flex-1" />
          <button
            onClick={handleShare}
            data-testid="share-btn"
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-brand-green text-black font-semibold hover:bg-brand-green/90 active:scale-95 transition-all"
          >
            <Share2 className="w-4 h-4" />
            Share
          </button>
        </div>
      </motion.div>

      {/* How it works */}
      <motion.div
        className="p-4 rounded-xl bg-white/[0.02] border border-white/5"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
      >
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-white/40 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-white/70 mb-1">How it works</p>
            <ol className="text-xs text-white/40 space-y-1">
              <li>1. Share your link with friends</li>
              <li>2. They join and start earning</li>
              <li>3. You get 2 TRX per active referral</li>
              <li>4. Rewards come from the limited pool</li>
            </ol>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export default ReferralCard;

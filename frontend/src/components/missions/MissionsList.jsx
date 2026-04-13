import { useState } from 'react';
import { useWallet } from '@/contexts/WalletContext';
import { useTelegram } from '@/hooks/useTelegram';
import { Trophy, Users, Check, Clock, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

const missions = [
  {
    id: 'daily_hold',
    title: 'Daily Holder',
    description: 'Complete 3 holds today',
    reward: 0.10,
    rewardAsset: 'USDT',
    type: 'daily',
    maxProgress: 3,
    getProgress: (ctx) => ctx.holdsCount,
  },
  {
    id: 'weekly_referral',
    title: 'Social Butterfly',
    description: 'Invite 5 friends this week',
    reward: 0.50,
    rewardAsset: 'USDT',
    type: 'weekly',
    maxProgress: 5,
    getProgress: (ctx) => Math.min(ctx.totalRefs, 5),
  },
  {
    id: 'first_deposit',
    title: 'First Deposit',
    description: 'Make your first deposit',
    reward: 1.00,
    rewardAsset: 'TRX',
    type: 'one_time',
    maxProgress: 1,
    getProgress: () => 0,
  },
  {
    id: 'big_earner',
    title: 'Big Earner',
    description: 'Earn $10 total from holds',
    reward: 2.00,
    rewardAsset: 'USDT',
    type: 'milestone',
    maxProgress: 10,
    getProgress: (ctx) => Math.min(ctx.totalEarned, 10),
  },
];

function MissionCard({ mission, context, index, onClaim, claimedMissions }) {
  const [isClaiming, setIsClaiming] = useState(false);
  const progress = mission.getProgress(context);
  const isComplete = progress >= mission.maxProgress;
  const isClaimed = claimedMissions.includes(mission.id);
  const progressPercentage = (progress / mission.maxProgress) * 100;

  const handleClaim = async () => {
    if (!isComplete || isClaimed || isClaiming) return;
    setIsClaiming(true);
    await onClaim(mission);
    setIsClaiming(false);
  };

  return (
    <motion.div
      className={`glass-card rounded-2xl p-4 ${isComplete && !isClaimed ? 'border-brand-green/30' : ''} ${isClaimed ? 'opacity-60' : ''}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.1 }}
      data-testid={`mission-${mission.id}`}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
            isClaimed ? 'bg-brand-green/20' : isComplete ? 'bg-brand-green/20' : 'bg-white/5'
          }`}>
            {isClaimed ? (
              <Check className="w-5 h-5 text-brand-green" />
            ) : mission.type === 'daily' ? (
              <Trophy className="w-5 h-5 text-white/40" />
            ) : (
              <Users className="w-5 h-5 text-white/40" />
            )}
          </div>
          <div>
            <h4 className="font-semibold text-white text-sm">{mission.title}</h4>
            <p className="text-xs text-white/40">{mission.description}</p>
          </div>
        </div>
        <span className={`text-xs px-2 py-1 rounded-full ${
          mission.type === 'daily' ? 'bg-blue-500/10 text-blue-400' :
          mission.type === 'weekly' ? 'bg-purple-500/10 text-purple-400' :
          mission.type === 'milestone' ? 'bg-yellow-500/10 text-yellow-400' :
          'bg-white/5 text-white/40'
        }`}>
          {mission.type === 'daily' && 'Daily'}
          {mission.type === 'weekly' && 'Weekly'}
          {mission.type === 'one_time' && 'One-time'}
          {mission.type === 'milestone' && 'Milestone'}
        </span>
      </div>

      <div className="mb-3">
        <div className="w-full h-2 rounded-full bg-white/5 overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${isClaimed || isComplete ? 'bg-brand-green' : 'bg-white/20'}`}
            initial={{ width: 0 }}
            animate={{ width: `${progressPercentage}%` }}
            transition={{ duration: 0.5, delay: index * 0.1 }}
          />
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-xs text-white/40">
            {progress}/{mission.maxProgress}
          </span>
          <span className="text-xs text-brand-green font-semibold">
            +{mission.rewardAsset === 'USDT' ? '$' : ''}{mission.reward.toFixed(2)} {mission.rewardAsset}
          </span>
        </div>
      </div>

      <button
        onClick={handleClaim}
        disabled={!isComplete || isClaimed || isClaiming}
        className={`w-full py-2.5 rounded-xl text-sm font-medium transition-all flex items-center justify-center gap-2 ${
          isClaimed
            ? 'bg-brand-green/20 text-brand-green cursor-default'
            : isComplete
            ? 'bg-brand-green text-black hover:bg-brand-green/90 active:scale-95'
            : 'bg-white/5 text-white/30 cursor-not-allowed'
        }`}
        data-testid={`claim-${mission.id}`}
      >
        {isClaiming ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Claiming...
          </>
        ) : isClaimed ? (
          <>
            <Check className="w-4 h-4" />
            Claimed
          </>
        ) : isComplete ? (
          'Claim Reward'
        ) : (
          'In Progress'
        )}
      </button>
    </motion.div>
  );
}

export function MissionsList() {
  const walletContext = useWallet();
  const { vibrate } = useTelegram();
  const [claimedMissions, setClaimedMissions] = useState([]);

  const handleClaim = async (mission) => {
    vibrate('success');
    
    // Simulate claim - in production this would call the backend
    await new Promise(resolve => setTimeout(resolve, 800));
    
    setClaimedMissions(prev => [...prev, mission.id]);
    
    // Update balance in context (mock)
    // In production: await claimMissionReward(mission.id)
  };

  return (
    <div className="space-y-4" data-testid="missions-list">
      <div className="flex items-center gap-3 p-4 rounded-2xl bg-gradient-to-r from-brand-green/10 to-transparent border border-brand-green/20">
        <Clock className="w-5 h-5 text-brand-green" />
        <div>
          <p className="text-sm font-medium text-white">Daily missions reset at midnight UTC</p>
          <p className="text-xs text-white/40">Complete missions to earn bonus rewards</p>
        </div>
      </div>

      <div className="space-y-3">
        {missions.map((mission, index) => (
          <MissionCard 
            key={mission.id} 
            mission={mission} 
            context={walletContext}
            index={index}
            onClaim={handleClaim}
            claimedMissions={claimedMissions}
          />
        ))}
      </div>
    </div>
  );
}

export default MissionsList;

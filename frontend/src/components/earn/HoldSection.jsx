import { useWallet } from '@/contexts/WalletContext';
import { HoldButton } from './HoldButton';
import { Trophy, Users } from 'lucide-react';

export function HoldSection() {
  const { wins, totalRefs } = useWallet();

  return (
    <section className="px-4 py-6" data-testid="hold-section-wrapper">
      {/* Stats Row */}
      <div className="flex justify-center gap-8 mb-6">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-brand-green/10 flex items-center justify-center">
            <Trophy className="w-4 h-4 text-brand-green" />
          </div>
          <div>
            <p className="text-xs text-white/40">Rewards</p>
            <p className="text-sm font-semibold text-white">{wins}</p>
          </div>
        </div>
        
        <div className="w-px h-10 bg-white/10" />
        
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-brand-red/10 flex items-center justify-center">
            <Users className="w-4 h-4 text-brand-red" />
          </div>
          <div>
            <p className="text-xs text-white/40">Invites</p>
            <p className="text-sm font-semibold text-white">{totalRefs}</p>
          </div>
        </div>
      </div>

      {/* Hold Button */}
      <HoldButton />
    </section>
  );
}

export default HoldSection;

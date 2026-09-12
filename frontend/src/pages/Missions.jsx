import { MissionsList } from '@/components/missions/MissionsList';
import { CheckInCard } from '@/components/missions/CheckInCard';
import { SocialMissions } from '@/components/missions/SocialMissions';

export function MissionsPage() {
  return (
    <div className="px-4 py-4 pb-8" data-testid="missions-page">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold text-white">Missions</h1>
        <p className="text-sm text-white/50 mt-1">Complete tasks to earn extra rewards</p>
      </div>

      {/* Daily check-in first: it is the one action the user can always take. */}
      <div className="mb-4">
        <CheckInCard />
      </div>

      {/* Misiones sociales one-time (canal/comunidad). La verificacion la hace
          el Worker contra Telegram; van antes que las clasicas porque son las
          unicas que pagan de verdad hoy. */}
      <div className="mb-4">
        <SocialMissions />
      </div>

      <MissionsList />
    </div>
  );
}

export default MissionsPage;

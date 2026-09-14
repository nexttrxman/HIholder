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

      {/* Misiones reales (v3.3): sociales de Telegram, de progreso (holds,
          referidos, ganancias) y manuales (First Deposit). Todas las verifica
          el Worker contra la base; la lista demo client-side se elimino. */}
      <div className="mb-4">
        <SocialMissions />
      </div>
    </div>
  );
}

export default MissionsPage;

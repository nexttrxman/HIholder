import { MissionsList } from '@/components/missions/MissionsList';

export function MissionsPage() {
  return (
    <div className="px-4 py-4 pb-8" data-testid="missions-page">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold text-white">Missions</h1>
        <p className="text-sm text-white/50 mt-1">Complete tasks to earn extra rewards</p>
      </div>

      <MissionsList />
    </div>
  );
}

export default MissionsPage;

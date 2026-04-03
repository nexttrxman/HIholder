import { ReferralCard } from '@/components/referrals/ReferralCard';

export function ReferralsPage() {
  return (
    <div className="px-4 py-4 pb-8" data-testid="referrals-page">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold text-white">Invite Friends</h1>
        <p className="text-sm text-white/50 mt-1">Share and earn from a limited pool of 50,000 TRX</p>
      </div>

      <ReferralCard />
    </div>
  );
}

export default ReferralsPage;

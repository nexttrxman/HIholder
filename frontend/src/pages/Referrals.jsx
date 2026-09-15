import { AlertTriangle } from 'lucide-react';
import { ReferralCard } from '@/components/referrals/ReferralCard';
import { REFERRAL_LINK_MODE } from '@/services/api';

export function ReferralsPage() {
  return (
    <div className="px-4 py-4 pb-8" data-testid="referrals-page">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold text-white">Invite Friends</h1>
        <p className="text-sm text-white/50 mt-1">Share and earn from a limited pool of 50,000 TRX</p>
      </div>

      {/* Sin VITE_TELEGRAM_APP_NAME el link sale como ?start=, que abre el chat
          del bot: el start_param nunca llega a la Mini App y el referido no se
          registra. Mejor decirlo acá que descubrirlo cuando no pagan. */}
      {REFERRAL_LINK_MODE !== 'startapp' && (
        <div
          className="mb-4 flex items-start gap-2.5 rounded-2xl bg-brand-gold/[0.07] border border-brand-gold/25 px-4 py-3"
          data-testid="referral-config-warning"
        >
          <AlertTriangle className="w-4 h-4 text-brand-gold shrink-0 mt-0.5" />
          <p className="text-[11px] leading-relaxed text-white/70">
            Referral links are being generated in <code className="text-brand-gold">?start=</code> form,
            which opens the bot chat instead of the app — invites will not be tracked.
            Set <code className="text-brand-gold">VITE_TELEGRAM_APP_NAME</code> and rebuild.
          </p>
        </div>
      )}

      <ReferralCard />
    </div>
  );
}

export default ReferralsPage;

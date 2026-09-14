import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CalendarCheck, Flame, Gift, Loader2, Check } from 'lucide-react';

import { checkinStatus, dailyCheckin } from '@/services/api';
import { useWallet } from '@/contexts/WalletContext';
import { CHECKIN_CONFIG } from '@/lib/checkin';
import { ClaimModal } from '@/components/earn/ClaimModal';

const EMPTY = {
  checked_in_today: false,
  streak: 0,
  days_this_week: 0,
  days_for_weekly: CHECKIN_CONFIG.DAYS_FOR_WEEKLY,
  days_to_weekly: CHECKIN_CONFIG.DAYS_FOR_WEEKLY,
  weekly_complete: false,
  daily_reward: CHECKIN_CONFIG.DAILY_REWARD_USDT,
  weekly_bonus: CHECKIN_CONFIG.WEEKLY_BONUS_USDT,
  weekly_claim: null,
};

/**
 * Daily check-in with a weekly prize (v3.3).
 *
 * One tap a day credits 0.15 USDT + 500 KEEP (fijos). Al 7mo dia de la semana
 * ISO se abre un CLAIM semanal (1.5 USDT + 2000 KEEP) que se cobra pagando
 * 0.15 TON via TonConnect, igual que el claim del hold; si no se cobra antes
 * del lunes 00:00 UTC, se pierde. El estado vive en Supabase (checkins +
 * claims) a traves del worker, con un mirror de localStorage en el dev preview.
 */
export function CheckInCard() {
  const { pushLocalTransaction, refreshData } = useWallet();
  const [status, setStatus] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reward, setReward] = useState(null);
  const [error, setError] = useState('');
  // v3.3: claim semanal (1.5 USDT + 2000 KEEP) cobrable via TonConnect.
  const [weeklyClaim, setWeeklyClaim] = useState(null);
  const [claimOpen, setClaimOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await checkinStatus();
      if (res?.ok !== false) {
        setStatus({ ...EMPTY, ...res });
        setWeeklyClaim(res?.weekly_claim || null);
      }
    } catch (err) {
      setError('Could not load your check-in status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCheckIn = async () => {
    if (busy || status.checked_in_today) return;
    setBusy(true);
    setError('');
    setReward(null);
    try {
      const res = await dailyCheckin();
      if (!res?.ok) {
        setError(res?.error === 'already_checked_in' ? 'Already checked in today' : 'Check-in failed');
        await load();
        return;
      }

      setStatus({ ...EMPTY, ...res });
      const weekly = Number(res.weekly_bonus) || 0;
      const total = Number(res.credited) || status.daily_reward + weekly;
      // v3.3: el diario paga 500 KEEP fijos; el semanal ya no acredita nada
      // aca (se cobra por el claim con TonConnect).
      const keep = (Number(res.keep_reward) || 0) + (Number(res.keep_weekly) || 0);
      setReward({ total, weekly, keep });

      // Dia 7: se abrio el claim semanal — ofrecer el cobro enseguida.
      const wc = res.weekly_claim
        || (res.weekly_claim_id
          ? {
              claim_id: res.weekly_claim_id,
              expires_at: res.weekly_claim_expires,
              total_prize: CHECKIN_CONFIG.WEEKLY_BONUS_USDT,
              ton_fee: 0.15,
              keep_bonus: CHECKIN_CONFIG.WEEKLY_KEEP,
            }
          : null);
      if (wc) {
        setWeeklyClaim(wc);
        setClaimOpen(true);
      }

      pushLocalTransaction({
        id: `checkin_${Date.now()}`,
        type: 'reward',
        asset: 'USDT',
        amount: total,
        status: 'confirmed',
        timestamp: Date.now(),
        description: weekly > 0 ? 'Daily check-in + weekly bonus' : 'Daily check-in reward',
      });
      if (keep > 0) {
        pushLocalTransaction({
          id: `checkin_keep_${Date.now()}`,
          type: 'reward',
          asset: 'KEEP',
          amount: keep,
          status: 'confirmed',
          timestamp: Date.now(),
          description: 'Daily check-in KEEP reward',
        });
      }
      refreshData?.();
    } catch (err) {
      setError('Check-in failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const days = status.days_for_weekly || CHECKIN_CONFIG.DAYS_FOR_WEEKLY;
  const done = Math.min(status.days_this_week || 0, days);
  const pct = (done / days) * 100;

  return (
    <div className="glass-card rounded-3xl p-5" data-testid="checkin-card">
      {/* header */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-brand-teal/12 border border-brand-teal/20">
            <CalendarCheck className="w-5 h-5 text-brand-teal" />
          </div>
          <div>
            <h3 className="font-display text-base font-bold text-white leading-tight">
              Daily Check-In
            </h3>
            <p className="text-xs text-ink-dim mt-0.5">
              {`+${status.daily_reward.toFixed(2)} USDT · ${CHECKIN_CONFIG.DAILY_KEEP} KEEP a day`}
            </p>
          </div>
        </div>

        <div
          className="chip chip-gold flex items-center gap-1"
          data-testid="checkin-streak"
          title="Consecutive days"
        >
          <Flame className="w-3.5 h-3.5" />
          <span className="sys-value">{status.streak}</span>
          <span>day{status.streak === 1 ? '' : 's'}</span>
        </div>
      </div>

      {/* week dots */}
      <div className="mb-2" data-testid="checkin-days">
        <div className="flex justify-between gap-1.5">
          {Array.from({ length: days }).map((_, i) => {
            const filled = i < done;
            const isWeeklyDay = i === days - 1;
            return (
              <div
                key={i}
                data-testid={`checkin-day-${i}`}
                data-filled={filled ? 'true' : 'false'}
                className={`
                  flex-1 h-9 rounded-xl flex items-center justify-center
                  border transition-all
                  ${filled
                    ? isWeeklyDay
                      ? 'bg-brand-gold/20 border-brand-gold/40 shadow-glow-gold'
                      : 'bg-brand-teal/18 border-brand-teal/35'
                    : 'bg-white/[0.03] border-white/[0.07]'}
                `}
              >
                {isWeeklyDay ? (
                  <Gift className={`w-4 h-4 ${filled ? 'text-brand-gold' : 'text-ink-dim/60'}`} />
                ) : filled ? (
                  <Check className="w-4 h-4 text-brand-mint" strokeWidth={3} />
                ) : (
                  <span className="font-mono text-[10px] text-ink-dim/50">{i + 1}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* weekly progress */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="sys-label">Weekly prize</span>
          <span className="font-mono text-[11px] text-brand-gold" data-testid="checkin-progress">
            {done}/{days} · +{status.weekly_bonus.toFixed(2)} USDT + {CHECKIN_CONFIG.WEEKLY_KEEP} KEEP
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${
              status.weekly_complete
                ? 'bg-gradient-to-r from-brand-gold to-[#f2a93b]'
                : 'bg-gradient-to-r from-brand-teal to-brand-mint'
            }`}
            initial={false}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          />
        </div>
      </div>

      {/* v3.3: claim semanal pendiente — se cobra con TonConnect (0.15 TON) */}
      {weeklyClaim && (
        <button
          type="button"
          onClick={() => setClaimOpen(true)}
          data-testid="claim-weekly-button"
          className="w-full mb-3 py-3.5 rounded-2xl font-bold flex items-center justify-center gap-2 bg-brand-gold text-black shadow-glow-gold hover:brightness-110 transition-all active:scale-[0.98]"
        >
          <Gift className="w-4 h-4" />
          Claim weekly prize · +{Number(weeklyClaim.total_prize).toFixed(2)} USDT + {CHECKIN_CONFIG.WEEKLY_KEEP} KEEP
        </button>
      )}

      {/* action */}
      <button
        type="button"
        onClick={handleCheckIn}
        disabled={busy || loading || status.checked_in_today}
        data-testid="checkin-button"
        className={`
          w-full py-3.5 rounded-2xl font-bold flex items-center justify-center gap-2
          transition-all active:scale-[0.98] disabled:cursor-not-allowed
          ${status.checked_in_today
            ? 'bg-brand-teal/12 border border-brand-teal/25 text-brand-mint'
            : 'bg-brand-teal text-black shadow-glow-teal hover:brightness-110'}
        `}
      >
        {busy ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Checking in...
          </>
        ) : status.checked_in_today ? (
          <>
            <Check className="w-4 h-4" strokeWidth={3} />
            Checked in today
          </>
        ) : (
          <>
            <CalendarCheck className="w-4 h-4" />
            Check in
          </>
        )}
      </button>

      {/* feedback */}
      <AnimatePresence>
        {reward && (
          <motion.p
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-3 text-center font-mono text-xs text-brand-gold"
            data-testid="checkin-reward"
          >
            +{reward.total.toFixed(2)} USDT
            {reward.weekly > 0 ? ` · weekly bonus +${reward.weekly.toFixed(2)}` : ''}
            {reward.keep > 0 ? ` · +${reward.keep.toLocaleString('en-US')} KEEP` : ''}
          </motion.p>
        )}
      </AnimatePresence>

      {error && (
        <p className="mt-3 text-center text-xs text-brand-red" data-testid="checkin-error">
          {error}
        </p>
      )}

      {/* Reutiliza el modal del hold: misma mecánica (0.15 TON al treasury
          con el claim_id de comentario y verificacion on-chain). Se monta
          solo al abrirlo: el modal usa hooks de TonConnect y no debe
          arrastrar ese provider mientras nadie lo necesita. */}
      {claimOpen && weeklyClaim && (
        <ClaimModal
          isOpen
          onClose={() => {
            setClaimOpen(false);
            load();
            refreshData?.();
          }}
          claim={weeklyClaim}
        />
      )}
    </div>
  );
}

export default CheckInCard;

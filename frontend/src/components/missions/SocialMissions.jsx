import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Check, ExternalLink, Loader2, Megaphone } from 'lucide-react';
import { getSocialMissions, verifySocialMission, KEEP_REWARDS } from '@/services/api';
import { useTelegram } from '@/hooks/useTelegram';
import { useWallet } from '@/contexts/WalletContext';

// Misiones sociales one-time (v3.1). La verificacion de Telegram la hace el
// Worker preguntando a la Bot API; aca solo se muestra el estado y se dispara
// el verify. Los titulos y descripciones vienen de social_missions en la base:
// agregar una mision es un INSERT, no un deploy.

function SocialMissionCard({ mission, done, onVerified, index }) {
  const { vibrate } = useTelegram();
  const [state, setState] = useState(done ? 'done' : 'idle');
  const [error, setError] = useState(null);

  const handleVerify = async () => {
    if (state === 'done' || state === 'verifying') return;
    setState('verifying');
    setError(null);
    try {
      const res = await verifySocialMission(mission.id);
      if (res?.ok) {
        vibrate('success');
        setState('done');
        onVerified?.(mission);
      } else {
        vibrate('error');
        setState('idle');
        setError(res?.error || 'Failed');
      }
    } catch (err) {
      // apiCall levanta el `error` del Worker tal cual ('Not joined yet',
      // 'Check failed. Try again.'), asi el usuario ve la causa real.
      vibrate('error');
      setState('idle');
      setError(err?.message || 'Failed');
    }
  };

  return (
    <motion.div
      className={`glass-card rounded-2xl p-4 ${state === 'done' ? 'opacity-70' : ''}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06 }}
      data-testid={`social-mission-${mission.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
            state === 'done' ? 'bg-brand-green/20' : 'bg-white/5'
          }`}>
            {state === 'done' ? (
              <Check className="w-5 h-5 text-brand-green" />
            ) : (
              <Megaphone className="w-5 h-5 text-white/40" />
            )}
          </div>
          <div className="min-w-0">
            <h4 className="font-semibold text-white text-sm truncate">{mission.title}</h4>
            {mission.description && (
              <p className="text-xs text-white/40 truncate">{mission.description}</p>
            )}
            <p className="text-xs text-brand-green font-semibold mt-0.5">
              {`+$${Number(mission.reward).toFixed(2)} USDT · ${KEEP_REWARDS.mission.min}–${KEEP_REWARDS.mission.max} KEEP`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <a
            href={mission.url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`open-${mission.id}`}
            className="w-9 h-9 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-white/60 hover:bg-white/10 active:scale-95 transition-all"
            aria-label="Open"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
          <button
            type="button"
            onClick={handleVerify}
            disabled={state === 'done' || state === 'verifying'}
            data-testid={`verify-${mission.id}`}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2 ${
              state === 'done'
                ? 'bg-brand-green/20 text-brand-green cursor-default'
                : 'bg-brand-teal text-black hover:bg-brand-teal/90 active:scale-95'
            }`}
          >
            {state === 'verifying' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : state === 'done' ? (
              <><Check className="w-4 h-4" /> Done</>
            ) : (
              'Verify'
            )}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-2 text-xs text-brand-red" data-testid={`error-${mission.id}`}>
          {error}
        </p>
      )}
    </motion.div>
  );
}

export function SocialMissions() {
  const { refreshData } = useWallet();
  const [missions, setMissions] = useState([]);
  const [completed, setCompleted] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    getSocialMissions().then((res) => {
      if (!alive) return;
      setMissions(res?.missions || []);
      setCompleted(res?.completed || []);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  const handleVerified = useCallback((mission) => {
    setCompleted((prev) => (prev.includes(mission.id) ? prev : [...prev, mission.id]));
    // El premio entra al saldo: que la wallet lo refleje sin recargar.
    refreshData?.();
  }, [refreshData]);

  if (loaded && missions.length === 0) return null;
  if (!loaded) return null;

  return (
    <div className="space-y-3" data-testid="social-missions">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-base font-bold text-white">Social</h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim">
          One-time
        </span>
      </div>
      {missions.map((m, i) => (
        <SocialMissionCard
          key={m.id}
          mission={m}
          done={completed.includes(m.id)}
          onVerified={handleVerified}
          index={i}
        />
      ))}
    </div>
  );
}

export default SocialMissions;

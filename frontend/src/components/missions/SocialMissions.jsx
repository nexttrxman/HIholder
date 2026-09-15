import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Check, ExternalLink, Loader2, Megaphone, Clock } from 'lucide-react';
import { getSocialMissions, verifySocialMission, shareToStory, KEEP_REWARDS } from '@/services/api';
import { useTelegram } from '@/hooks/useTelegram';
import { useWallet } from '@/contexts/WalletContext';

// Misiones (v3.1 Telegram, v3.3 reales). La verificacion la hace SIEMPRE el
// Worker: Telegram (getChatMember), progreso (holds/referidos/ganancias en la
// base), revisión automática desde la wallet (First Deposit) o revisión manual
// solo para acciones que no se pueden comprobar en cadena. Los títulos,
// descripciones y premios vienen de social_missions: agregar una misión de
// Telegram es un INSERT, no un deploy.

const REPEAT_LABEL = { daily: 'Daily', weekly: 'Weekly' };

function rewardLabel(mission, keepMin, keepMax) {
  const usdt = `+$${Number(mission.reward).toFixed(2)} USDT`;
  const keep = mission.reward_keep != null
    ? `+${Number(mission.reward_keep).toLocaleString('en-US')} KEEP`
    : `+${keepMin}–${keepMax} KEEP`;
  return `${usdt} · ${keep}`;
}

function SocialMissionCard({ mission, done, pending, keepMin, keepMax, onVerified, index }) {
  const { vibrate } = useTelegram();
  const { uid } = useWallet();
  const isAutomatic = mission.verify === 'automatic' || mission.verify === 'deposit';
  const [state, setState] = useState(
    done ? 'done' : pending ? 'pending' : isAutomatic ? 'automatic' : 'idle'
  );
  const [error, setError] = useState(null);

  const isProgress = mission.verify === 'progress';
  const current = Number(mission.current || 0);
  const goal = Number(mission.goal || 0);
  const progressReady = !isProgress || current >= goal;

  const handleVerify = async () => {
    if (isAutomatic || state === 'done' || state === 'pending' || state === 'verifying') return;
    if (isProgress && !progressReady) return;
    setState('verifying');
    setError(null);
    try {
      const res = await verifySocialMission(mission.id);
      if (res?.ok && res?.pending) {
        // Mision manual: queda en revision hasta que el admin la apruebe.
        // v3.4: si es de "compartir", abrimos ademas el selector de Telegram.
        // Como no se puede verificar una historia/post, el admin aprueba a mano.
        vibrate('success');
        // v3.4: sube la FOTO del bot a su historia (no un reenvio de link).
        if (mission.share_text) shareToStory(uid, mission.share_text);
        setState('pending');
        return;
      }
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
      // 'Progress not complete'...), asi el usuario ve la causa real.
      vibrate('error');
      setState('idle');
      setError(err?.message || 'Failed');
    }
  };

  const buttonLabel = mission.share_text
    ? 'Share on Telegram'
    : isAutomatic
      ? 'Automatic review'
      : mission.verify === 'manual'
        ? 'Request review'
        : 'Verify';

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
            state === 'done' ? 'bg-brand-green/20' : state === 'pending' ? 'bg-brand-gold/15' : 'bg-white/5'
          }`}>
            {state === 'done' ? (
              <Check className="w-5 h-5 text-brand-green" />
            ) : state === 'pending' || state === 'automatic' ? (
              <Clock className="w-5 h-5 text-brand-gold" />
            ) : (
              <Megaphone className="w-5 h-5 text-white/40" />
            )}
          </div>
          <div className="min-w-0">
            <h4 className="font-semibold text-white text-sm flex items-center gap-2">
              {mission.title}
              {REPEAT_LABEL[mission.repeat] && (
                <span
                  className="font-mono text-[9px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-full bg-brand-teal/10 text-brand-teal border border-brand-teal/20"
                  data-testid={`repeat-${mission.id}`}
                >
                  {REPEAT_LABEL[mission.repeat]}
                </span>
              )}
            </h4>
            {mission.description && (
              <p className="text-xs text-white/40 mt-0.5">{mission.description}</p>
            )}
            <p className="text-xs text-brand-green font-semibold mt-0.5" data-testid={`reward-${mission.id}`}>
              {rewardLabel(mission, keepMin, keepMax)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {mission.url ? (
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
          ) : null}
          <button
            type="button"
            onClick={handleVerify}
            disabled={isAutomatic || state === 'done' || state === 'pending' || state === 'verifying' || (isProgress && !progressReady)}
            data-testid={`verify-${mission.id}`}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2 ${
              state === 'done'
                ? 'bg-brand-green/20 text-brand-green cursor-default'
                : state === 'pending'
                  ? 'bg-brand-gold/15 text-brand-gold cursor-default'
                  : isAutomatic
                    ? 'bg-white/5 text-brand-gold cursor-default'
                    : isProgress && !progressReady
                      ? 'bg-white/5 text-ink-dim cursor-not-allowed'
                      : 'bg-brand-teal text-black hover:bg-brand-teal/90 active:scale-95'
            }`}
          >
            {state === 'verifying' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : state === 'done' ? (
              <><Check className="w-4 h-4" /> Done</>
            ) : state === 'pending' ? (
              <>Under review</>
            ) : (
              buttonLabel
            )}
          </button>
        </div>
      </div>

      {/* v3.3: barra de progreso real (la mide el Worker contra la base). */}
      {isProgress && state !== 'done' && (
        <div className="mt-3" data-testid={`progress-${mission.id}`}>
          <div className="flex items-center justify-between mb-1">
            <span className="font-mono text-[10px] text-ink-dim">
              {Math.min(current, goal)}/{goal}
            </span>
          </div>
          <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className={`h-full rounded-full ${progressReady ? 'bg-brand-green' : 'bg-brand-teal'}`}
              style={{ width: `${Math.min(100, goal > 0 ? (current / goal) * 100 : 0)}%` }}
            />
          </div>
        </div>
      )}

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
  const [pending, setPending] = useState([]);
  const [keepRange, setKeepRange] = useState({ min: KEEP_REWARDS.mission.min, max: KEEP_REWARDS.mission.max });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    getSocialMissions().then((res) => {
      if (!alive) return;
      setMissions(res?.missions || []);
      setCompleted(res?.completed || []);
      setPending(res?.pending || []);
      if (res?.keep_min != null && res?.keep_max != null) {
        setKeepRange({ min: Number(res.keep_min), max: Number(res.keep_max) });
      }
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
        <h3 className="font-display text-base font-bold text-white">Missions</h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim">
          Earn USDT + KEEP
        </span>
      </div>
      {missions.map((m, i) => (
        <SocialMissionCard
          key={m.id}
          mission={m}
          done={completed.includes(m.id)}
          pending={pending.includes(m.id)}
          keepMin={keepRange.min}
          keepMax={keepRange.max}
          onVerified={handleVerified}
          index={i}
        />
      ))}
    </div>
  );
}

export default SocialMissions;

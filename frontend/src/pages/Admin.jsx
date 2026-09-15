import { useCallback, useEffect, useState } from 'react';
import { Check, X, RefreshCw, Lock, Inbox, ArrowUpRight } from 'lucide-react';
import {
  adminListMissionRequests,
  adminApproveMission,
  adminRejectMission,
  adminListWithdrawals,
  adminResolveWithdrawal,
  adminListDeposits,
  adminResolveDeposit,
} from '@/services/api';

// Panel de admin (v3.3). Vive en #TKadminTK (ruta no publicada) y NO forma
// parte de la Mini App: funciona en un navegador comun, fuera de Telegram, y autentica con el
// secreto ADMIN_TOKEN del Worker (header x-admin-token). El token se guarda en
// sessionStorage: al cerrar la pestana hay que volver a ponerlo.
//
// Dos colas manuales:
//   1. Misiones de revision humana (First Deposit): el usuario pidio el premio
//      y aca se aprueba (paga 1 USDT + 3000 KEEP) o se rechaza.
//   2. Retiros pendientes: se pagan on-chain a mano y aca se marca paid/rejected.

const TOKEN_KEY = 'tk_admin_token_v1';

function readToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

const fmtDate = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '');

export function AdminPage() {
  const [token, setToken] = useState(readToken);
  const [tokenInput, setTokenInput] = useState('');
  const [tab, setTab] = useState('missions');
  const [missions, setMissions] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [deposits, setDeposits] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const refresh = useCallback(async (tk = token) => {
    if (!tk) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const [m, w, d] = await Promise.all([
        adminListMissionRequests(tk),
        adminListWithdrawals(tk),
        adminListDeposits(tk),
      ]);
      setMissions(m?.requests || []);
      setWithdrawals(w?.requests || []);
      setDeposits(d?.deposits || []);
    } catch (err) {
      setError(err?.message || 'Request failed');
      if (/Unauthorized/.test(err?.message || '')) {
        // Token revocado o mal escrito: volver al login sin dejarlo guardado.
        try { window.sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
        setToken('');
      }
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) refresh(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const saveToken = (e) => {
    e.preventDefault();
    const tk = tokenInput.trim();
    if (!tk) return;
    try {
      window.sessionStorage.setItem(TOKEN_KEY, tk);
    } catch (err) {
      /* ignore */
    }
    setToken(tk);
    setTokenInput('');
  };

  const act = async (fn, okMsg) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      setInfo(okMsg);
      await refresh();
    } catch (err) {
      setError(err?.message || 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" data-testid="admin-login">
        <form onSubmit={saveToken} className="glass-card rounded-3xl p-6 w-full max-w-sm space-y-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-brand-teal/12 border border-brand-teal/20">
              <Lock className="w-5 h-5 text-brand-teal" />
            </div>
            <h1 className="font-display text-lg font-bold text-white">Admin</h1>
          </div>
          <p className="text-xs text-white/50">
            Enter the ADMIN_TOKEN configured on the Worker.
          </p>
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="ADMIN_TOKEN"
            data-testid="admin-token-input"
            className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white text-sm font-mono outline-none focus:border-brand-teal/50"
          />
          <button
            type="submit"
            className="w-full py-3 rounded-xl bg-brand-teal text-black font-bold text-sm active:scale-[0.98] transition-all"
          >
            Enter
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-6 pb-16 max-w-2xl mx-auto" data-testid="admin-page">
      <div className="flex items-center justify-between mb-5">
        <h1 className="font-display text-xl font-bold text-white">Admin queue</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => refresh()}
            data-testid="admin-refresh"
            className="p-2 rounded-xl bg-white/5 border border-white/10 text-white/60 active:scale-95 transition-all"
            aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => {
              try { window.sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
              setToken('');
            }}
            className="p-2 rounded-xl bg-white/5 border border-white/10 text-white/60 active:scale-95 transition-all"
            aria-label="Log out"
          >
            <Lock className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {[['missions', 'Mission requests'], ['deposits', 'Deposits'], ['withdrawals', 'Withdrawals']].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            data-testid={`admin-tab-${id}`}
            className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
              tab === id
                ? 'bg-brand-teal text-black'
                : 'bg-white/5 text-white/60 border border-white/10'
            }`}
          >
            {label}
            {id === 'missions' && missions.length > 0 ? ` (${missions.length})` : ''}
            {id === 'deposits' && deposits.length > 0 ? ` (${deposits.length})` : ''}
            {id === 'withdrawals' && withdrawals.length > 0 ? ` (${withdrawals.length})` : ''}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-3 text-xs text-brand-red" data-testid="admin-error">{error}</p>
      )}
      {info && (
        <p className="mb-3 text-xs text-brand-green" data-testid="admin-info">{info}</p>
      )}

      {tab === 'missions' && (
        <div className="space-y-3" data-testid="admin-missions">
          {missions.length === 0 && (
            <div className="glass-card rounded-2xl p-6 text-center text-sm text-white/40 flex flex-col items-center gap-2">
              <Inbox className="w-6 h-6" />
              No pending mission requests
            </div>
          )}
          {missions.map((r) => (
            <div key={`${r.user_id}:${r.mission_id}`} className="glass-card rounded-2xl p-4" data-testid={`admin-mission-${r.user_id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white truncate">
                    {r.first_name || r.username || 'User'}
                    {r.username ? <span className="text-white/40 font-normal"> @{r.username}</span> : null}
                  </p>
                  <p className="text-xs text-white/50 font-mono">{r.user_id}</p>
                  <p className="text-xs text-brand-gold font-semibold mt-1">
                    {r.title} · +${Number(r.reward_usdt).toFixed(2)} USDT + {Number(r.reward_keep || 0).toLocaleString('en-US')} KEEP
                  </p>
                  <p className="text-[10px] text-white/30 mt-0.5">Requested {fmtDate(r.requested_at)}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act(
                      () => adminApproveMission(token, r.user_id, r.mission_id),
                      `Approved ${r.title} for ${r.user_id}`
                    )}
                    data-testid={`approve-${r.user_id}`}
                    className="p-2.5 rounded-xl bg-brand-green/15 text-brand-green border border-brand-green/25 active:scale-95 transition-all disabled:opacity-50"
                    aria-label="Approve"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act(
                      () => adminRejectMission(token, r.user_id, r.mission_id),
                      `Rejected ${r.title} for ${r.user_id}`
                    )}
                    data-testid={`reject-${r.user_id}`}
                    className="p-2.5 rounded-xl bg-brand-red/15 text-brand-red border border-brand-red/25 active:scale-95 transition-all disabled:opacity-50"
                    aria-label="Reject"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'deposits' && (
        <div className="space-y-3" data-testid="admin-deposits">
          {deposits.length === 0 && (
            <div className="glass-card rounded-2xl p-6 text-center text-sm text-white/40 flex flex-col items-center gap-2">
              <Inbox className="w-6 h-6" />
              No pending deposits
            </div>
          )}
          {deposits.map((d) => (
            <div key={d.id} className="glass-card rounded-2xl p-4" data-testid={`admin-deposit-${d.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-semibold text-white">
                    {Number(d.amount)} TON
                    <span className="text-white/40 font-normal text-xs"> · {d.status}</span>
                  </p>
                  <p className="text-[10px] text-white/35">Chain evidence</p>
                  <p className="text-xs text-white/55 font-mono break-all">Hash: {d.tx_hash}</p>
                  <p className="text-xs text-white/55 font-mono break-all">Source: {d.from_address}</p>
                  <p className="text-xs text-brand-gold font-mono break-all">Comment: {d.comment || '(empty)'}</p>
                  <p className="text-[10px] text-white/30">Received {fmtDate(d.tx_timestamp)}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      // eslint-disable-next-line no-alert
                      const code = window.prompt('Deposit code for this user:');
                      if (!code) return;
                      act(
                        () => adminResolveDeposit(token, d.id, 'credited', { code: code.trim() }),
                        `Credited ${d.amount} TON`
                      );
                    }}
                    data-testid={`deposit-credit-${d.id}`}
                    className="p-2.5 rounded-xl bg-brand-green/15 text-brand-green border border-brand-green/25 active:scale-95 transition-all disabled:opacity-50"
                    aria-label="Credit deposit"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act(
                      () => adminResolveDeposit(token, d.id, 'rejected', { note: 'Rejected by admin' }),
                      `Rejected deposit ${d.tx_hash}`
                    )}
                    data-testid={`deposit-reject-${d.id}`}
                    className="p-2.5 rounded-xl bg-brand-red/15 text-brand-red border border-brand-red/25 active:scale-95 transition-all disabled:opacity-50"
                    aria-label="Reject deposit"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'withdrawals' && (
        <div className="space-y-3" data-testid="admin-withdrawals">
          {withdrawals.length === 0 && (
            <div className="glass-card rounded-2xl p-6 text-center text-sm text-white/40 flex flex-col items-center gap-2">
              <Inbox className="w-6 h-6" />
              No pending withdrawals
            </div>
          )}
          {withdrawals.map((r) => (
            <div key={r.id} className="glass-card rounded-2xl p-4" data-testid={`admin-wd-${r.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">
                    {Number(r.amount)} {r.asset}
                    <span className="text-white/40 font-normal text-xs"> · fee {Number(r.fee_trx)} TRX</span>
                  </p>
                  <p className="text-xs text-white/50 font-mono">{r.user_id}</p>
                  <p className="text-[11px] text-brand-teal/80 font-mono break-all flex items-center gap-1 mt-1">
                    <ArrowUpRight className="w-3 h-3 shrink-0" />
                    {r.to_address}
                  </p>
                  <p className="text-[10px] text-white/30 mt-0.5">Created {fmtDate(r.created_at)}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      // eslint-disable-next-line no-alert
                      const tx = window.prompt('TX hash of the on-chain payment:');
                      if (!tx) return;
                      act(
                        () => adminResolveWithdrawal(token, r.id, 'paid', tx.trim()),
                        `Marked ${r.amount} ${r.asset} as paid`
                      );
                    }}
                    data-testid={`wd-paid-${r.id}`}
                    className="p-2.5 rounded-xl bg-brand-green/15 text-brand-green border border-brand-green/25 active:scale-95 transition-all disabled:opacity-50"
                    aria-label="Mark paid"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act(
                      () => adminResolveWithdrawal(token, r.id, 'rejected', null, 'Rejected by admin'),
                      `Rejected withdrawal for ${r.user_id}`
                    )}
                    data-testid={`wd-reject-${r.id}`}
                    className="p-2.5 rounded-xl bg-brand-red/15 text-brand-red border border-brand-red/25 active:scale-95 transition-all disabled:opacity-50"
                    aria-label="Reject"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default AdminPage;

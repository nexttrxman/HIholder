import { useWallet } from '@/contexts/WalletContext';

export function Header() {
  const { user, usdtBalance, trxBalance } = useWallet();

  const getInitials = () => {
    if (!user) return '?';
    const first = user.first_name?.[0] || '';
    const last = user.last_name?.[0] || '';
    return (first + last).toUpperCase() || user.username?.[0]?.toUpperCase() || '?';
  };

  return (
    <header
      className="flex items-center justify-between px-4 py-3 safe-area-top"
      data-testid="header"
    >
      {/* Identity */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="relative">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-teal/35 via-brand-blue/25 to-transparent flex items-center justify-center border border-brand-teal/25 shadow-glow-teal overflow-hidden">
            {user?.photo_url ? (
              <img src={user.photo_url} alt="Avatar" className="w-full h-full rounded-full object-cover" />
            ) : (
              <span className="font-mono text-xs font-medium text-brand-mint">{getInitials()}</span>
            )}
          </div>
          <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-brand-teal border-2 border-app-bg" />
        </div>

        <div className="min-w-0">
          <h1 className="font-display text-sm font-bold tracking-tight text-white">TronKeeper</h1>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-dim truncate">
            {user?.username ? `@${user.username}` : 'Console online'}
          </p>
        </div>
      </div>

      {/* Balance */}
      <div className="text-right flex-shrink-0">
        <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-dim mb-0.5">Balance</p>
        <p className="sys-value text-lg font-medium text-white text-glow-teal tabular-nums">
          ${usdtBalance.toFixed(2)}
        </p>
        <p className="sys-value text-[10px] text-ink-dim tabular-nums">{trxBalance.toFixed(2)} TRX</p>
      </div>
    </header>
  );
}

export default Header;

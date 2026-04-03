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
    <header className="flex items-center justify-between px-4 py-3 safe-area-top" data-testid="header">
      {/* Avatar + Name */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-red/30 to-brand-green/30 flex items-center justify-center border border-white/10">
          {user?.photo_url ? (
            <img 
              src={user.photo_url} 
              alt="Avatar" 
              className="w-full h-full rounded-full object-cover"
            />
          ) : (
            <span className="text-sm font-bold text-white/80">{getInitials()}</span>
          )}
        </div>
        <div>
          <h1 className="font-display text-sm font-semibold text-white">
            TronKeeper
          </h1>
          <p className="text-xs text-white/40">
            {user?.username ? `@${user.username}` : 'Welcome'}
          </p>
        </div>
      </div>

      {/* Quick Balance */}
      <div className="text-right">
        <div className="flex items-baseline gap-1">
          <span className="text-lg font-bold text-white">${usdtBalance.toFixed(2)}</span>
        </div>
        <p className="text-xs text-white/40">{trxBalance.toFixed(2)} TRX</p>
      </div>
    </header>
  );
}

export default Header;

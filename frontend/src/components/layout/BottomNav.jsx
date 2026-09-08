import { Home, Wallet, Target, Users, CandlestickChart } from 'lucide-react';

// History is no longer a tab: it lives inside Wallet -> Activity.
// Trade sits in the middle of the bar.
const navItems = [
  { id: 'home', icon: Home, label: 'Home' },
  { id: 'missions', icon: Target, label: 'Missions' },
  { id: 'trade', icon: CandlestickChart, label: 'Trade' },
  { id: 'referrals', icon: Users, label: 'Invite' },
  { id: 'wallet', icon: Wallet, label: 'Wallet' },
];

export function BottomNav({ activeTab, onTabChange }) {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50"
      data-testid="bottom-nav"
    >
      <div className="max-w-md mx-auto px-3 pb-3 safe-area-bottom">
        <div
          className="
            backdrop-blur-2xl
            bg-app-surface/75
            border border-white/[0.08]
            rounded-console
            px-2 py-1.5
            flex justify-between items-center
            shadow-console
          "
        >
          {navItems.map(({ id, icon: Icon, label }) => {
            const isActive = activeTab === id;
            const isCenter = id === 'trade';

            return (
              <button
                key={id}
                onClick={() => onTabChange(id)}
                data-testid={`nav-${id}`}
                className={`
                  relative flex flex-col items-center justify-center
                  flex-1 py-1.5 px-1 rounded-2xl transition-all
                  ${isActive ? 'text-brand-mint' : 'text-ink-dim/70 hover:text-white/70'}
                `}
              >
                <div
                  className={`
                    relative p-2 rounded-xl transition-all
                    ${isActive ? 'bg-brand-teal/12 shadow-glow-teal' : ''}
                    ${isCenter && !isActive ? 'text-white/50' : ''}
                  `}
                >
                  <Icon className="w-5 h-5" strokeWidth={isActive ? 2.4 : 1.8} />
                </div>
                <span
                  className={`
                    font-mono text-[9px] uppercase tracking-[0.14em] mt-0.5
                    ${isActive ? 'text-brand-mint' : 'text-ink-dim/70'}
                  `}
                >
                  {label}
                </span>
                {isActive && (
                  <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-6 h-[2px] rounded-full bg-brand-teal shadow-glow-teal" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

export default BottomNav;

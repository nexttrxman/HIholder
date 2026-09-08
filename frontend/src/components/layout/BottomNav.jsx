import { Home, Wallet, Target, Users, CandlestickChart } from 'lucide-react';

// History is no longer a tab: it lives inside Wallet -> Activity.
// Trade sits in the middle of the bar and reads as the primary action.
const navItems = [
  { id: 'home', icon: Home, label: 'Home' },
  { id: 'missions', icon: Target, label: 'Missions' },
  { id: 'trade', icon: CandlestickChart, label: 'Trade' },
  { id: 'referrals', icon: Users, label: 'Invite' },
  { id: 'wallet', icon: Wallet, label: 'Wallet' },
];

/**
 * @param {boolean} claimPending  a reward is waiting to be claimed. The Home
 *   tab then pulses gold — the same cue the hold button uses — so the user is
 *   pulled back before the 15 minutes run out.
 */
export function BottomNav({ activeTab, onTabChange, claimPending = false }) {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50"
      data-testid="bottom-nav"
    >
      <div className="max-w-md mx-auto px-3 pb-3 safe-area-bottom">
        <div
          className="
            relative
            backdrop-blur-2xl
            bg-app-surface/75
            border border-white/[0.08]
            rounded-console
            px-2 pt-1.5 pb-1.5
            flex justify-between items-end
            shadow-console
          "
        >
          {navItems.map(({ id, icon: Icon, label }) => {
            const isActive = activeTab === id;
            const isTrade = id === 'trade';
            const isHomeClaim = id === 'home' && claimPending;

            // ---- TRADE: raised key, embossed like a physical console key ----
            if (isTrade) {
              return (
                <button
                  key={id}
                  onClick={() => onTabChange(id)}
                  data-testid={`nav-${id}`}
                  aria-label="Trade"
                  className="relative flex flex-col items-center justify-center flex-1 -mt-7 group"
                >
                  <span
                    className={`
                      relative flex items-center justify-center
                      h-14 w-14 rounded-[1.35rem]
                      bg-gradient-to-b from-brand-mint via-brand-teal to-[#2b9d92]
                      border border-brand-mint/50
                      shadow-[inset_0_2px_1px_rgba(233,255,251,0.55),inset_0_-4px_8px_rgba(4,16,22,0.45),0_12px_22px_-8px_rgba(87,214,200,0.65)]
                      transition-all duration-150
                      ${isActive ? 'translate-y-0 brightness-110' : 'translate-y-0 group-hover:brightness-105'}
                      group-active:translate-y-[2px]
                      group-active:shadow-[inset_0_2px_6px_rgba(4,16,22,0.5),0_4px_10px_-6px_rgba(87,214,200,0.5)]
                    `}
                    data-testid="trade-key"
                  >
                    {/* specular highlight across the top face */}
                    <span className="pointer-events-none absolute inset-x-2 top-1 h-3 rounded-full bg-white/45 blur-[3px]" />
                    <Icon className="relative w-6 h-6 text-[#041016]" strokeWidth={2.4} />
                  </span>
                  <span
                    className={`
                      font-mono text-[9px] uppercase tracking-[0.14em] mt-1
                      ${isActive ? 'text-brand-mint' : 'text-brand-teal/80'}
                    `}
                  >
                    {label}
                  </span>
                </button>
              );
            }

            return (
              <button
                key={id}
                onClick={() => onTabChange(id)}
                data-testid={`nav-${id}`}
                data-claim-pending={isHomeClaim ? 'true' : undefined}
                className={`
                  relative flex flex-col items-center justify-center
                  flex-1 py-1.5 px-1 rounded-2xl transition-all
                  ${isHomeClaim ? 'text-brand-gold' : isActive ? 'text-brand-mint' : 'text-ink-dim/70 hover:text-white/70'}
                `}
              >
                <div
                  className={`
                    relative p-2 rounded-xl transition-all
                    ${isHomeClaim ? 'bg-brand-gold/15 shadow-glow-gold animate-pulse' : ''}
                    ${!isHomeClaim && isActive ? 'bg-brand-teal/12 shadow-glow-teal' : ''}
                  `}
                >
                  <Icon
                    className="w-5 h-5"
                    strokeWidth={isActive || isHomeClaim ? 2.4 : 1.8}
                  />
                </div>
                <span
                  className={`
                    font-mono text-[9px] uppercase tracking-[0.14em] mt-0.5
                    ${isHomeClaim ? 'text-brand-gold' : isActive ? 'text-brand-mint' : 'text-ink-dim/70'}
                  `}
                >
                  {label}
                </span>
                {isHomeClaim ? (
                  <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-6 h-[2px] rounded-full bg-brand-gold shadow-glow-gold" />
                ) : isActive ? (
                  <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-6 h-[2px] rounded-full bg-brand-teal shadow-glow-teal" />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

export default BottomNav;

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
                  className="relative flex flex-col items-center justify-center flex-1 -mt-3.5 group"
                >
                  {/* Raised key: a dark glass face with a teal tint and a soft
                      emboss. Deliberately quiet — it should read as the primary
                      tab without shouting. */}
                  <span
                    className={`
                      relative flex items-center justify-center
                      h-12 w-12 rounded-2xl
                      bg-gradient-to-b from-brand-teal/22 to-brand-teal/[0.06]
                      border transition-all duration-150
                      shadow-[inset_0_1px_0_rgba(233,255,251,0.14),inset_0_-2px_4px_rgba(4,16,22,0.4),0_6px_14px_-10px_rgba(87,214,200,0.45)]
                      group-active:translate-y-[1px]
                      group-active:shadow-[inset_0_1px_3px_rgba(4,16,22,0.45)]
                      ${isActive ? 'border-brand-teal/45' : 'border-white/[0.1]'}
                    `}
                    data-testid="trade-key"
                  >
                    <Icon
                      className={`w-5 h-5 ${isActive ? 'text-brand-mint' : 'text-brand-teal/90'}`}
                      strokeWidth={isActive ? 2.2 : 1.9}
                    />
                  </span>
                  <span
                    className={`
                      font-mono text-[9px] uppercase tracking-[0.14em] mt-1
                      ${isActive ? 'text-brand-mint' : 'text-ink-dim/70'}
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

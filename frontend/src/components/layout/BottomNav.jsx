import { Home, Wallet, Target, Users, Clock } from 'lucide-react';

const navItems = [
  { id: 'home', icon: Home, label: 'Home' },
  { id: 'missions', icon: Target, label: 'Missions' },
  { id: 'referrals', icon: Users, label: 'Invite' },
  { id: 'history', icon: Clock, label: 'History' },
  { id: 'wallet', icon: Wallet, label: 'Wallet' },
];

export function BottomNav({ activeTab, onTabChange }) {
  return (
    <nav 
      className="fixed bottom-0 left-0 right-0 z-50"
      data-testid="bottom-nav"
    >
      <div className="max-w-md mx-auto">
        <div className="
          backdrop-blur-2xl bg-app-bg/90 
          border-t border-white/[0.08] 
          px-2 py-2 
          flex justify-between items-center
          safe-area-bottom
        ">
          {navItems.map(({ id, icon: Icon, label }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                onClick={() => onTabChange(id)}
                data-testid={`nav-${id}`}
                className={`
                  flex flex-col items-center justify-center
                  flex-1 py-2 px-1
                  rounded-xl transition-all
                  ${isActive 
                    ? 'text-white' 
                    : 'text-white/40 hover:text-white/60'
                  }
                `}
              >
                <div className={`
                  relative p-2 rounded-xl transition-all
                  ${isActive ? 'bg-white/10' : ''}
                `}>
                  <Icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 2} />
                  {isActive && (
                    <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-brand-green" />
                  )}
                </div>
                <span className={`
                  text-[10px] mt-1 font-medium
                  ${isActive ? 'text-white' : 'text-white/40'}
                `}>
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

export default BottomNav;

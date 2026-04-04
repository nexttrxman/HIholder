import { useState, useEffect } from 'react';
import { WalletProvider, useWallet } from '@/contexts/WalletContext';
import { PageContainer } from '@/components/layout/PageContainer';
import { BottomNav } from '@/components/layout/BottomNav';
import { WithdrawModal } from '@/components/wallet/WithdrawModal';
import { LoadingState } from '@/components/shared/LoadingState';
import { AnimatePresence, motion } from 'framer-motion';

// Pages
import { HomePage } from '@/pages/Home';
import { WalletPage } from '@/pages/Wallet';
import { MissionsPage } from '@/pages/Missions';
import { ReferralsPage } from '@/pages/Referrals';
import { HistoryPage } from '@/pages/History';

import '@/App.css';

function AppContent() {
  const { loading, error } = useWallet();
  const [activeTab, setActiveTab] = useState('home');
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAsset, setWithdrawAsset] = useState('USDT');

  const handleOpenWithdraw = (asset = 'USDT') => {
    setWithdrawAsset(asset);
    setWithdrawOpen(true);
  };

  const handleNavigate = (tab) => {
    setActiveTab(tab);
  };

  // Show loading screen
  if (loading) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="w-16 h-16 mx-auto mb-6 relative">
              <div className="absolute inset-0 rounded-full border-2 border-white/10" />
              <div className="absolute inset-0 rounded-full border-2 border-t-brand-green border-r-transparent border-b-transparent border-l-transparent animate-spin" />
              <img 
                src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMzkuNDMgMjk1LjI3Ij48cGF0aCBmaWxsPSIjNTBBRjk1IiBkPSJNNjIuMTUgMS40NWwtNjIuMTUgMTE4LjIgNzIuMDMgNDAuNTRoMTk1LjI4bDcyLjA0LTQwLjU0TDI3Ny4xOSAxLjQ1SDYyLjE1eiIvPjxwYXRoIGZpbGw9IiNGRkYiIGQ9Ik0xOTEuMTkgMTQ0LjhjLTMuMTkuMjctMTkuNzYgMS40Ny0yMS41NSAxLjQ3cy0xOC4zNi0xLjItMjEuNTUtMS40N2MtNDIuNTEtMy41NS03NC40Ny0xNC45OS03NC40Ny0yOC43NXMzMS45Ni0yNS4yIDc0LjQ3LTI4Ljc1djQ1Ljc1YzMuMjMuMjMgMTguNTMgMS40NSAyMS42OCAxLjQ1czE4LjIzLTEuMjggMjEuNDItMS40NXYtNDUuNzVjNDIuNDYgMy41NSA3NC4zOCAxNS4wMiA3NC4zOCAyOC43NXMtMzEuOTIgMjUuMi03NC4zOCAyOC43NXptMC02MS41OHYtNDAuNTRoNTcuNzl2LTI4LjQ5aC0xNTguNnYyOC40OWg1Ny43OXY0MC41NGMtNDguMjUgNC4yLTg0LjQ5IDE4Ljg2LTg0LjQ5IDM2LjMyczM2LjI0IDMyLjEyIDg0LjQ5IDM2LjMydjExNS40Nmg0My4wMnYtMTE1LjQ2YzQ4LjE4LTQuMiA4NC4zNS0xOC44NSA4NC4zNS0zNi4zMnMtMzYuMTctMzIuMTItODQuMzUtMzYuMzJ6Ii8+PC9zdmc+" 
                alt="Loading"
                className="absolute inset-2 w-12 h-12"
              />
            </div>
            <h1 className="font-display text-xl font-bold text-white mb-2">TronKeeper</h1>
            <p className="text-sm text-white/40">Loading your wallet...</p>
          </div>
        </div>
      </PageContainer>
    );
  }

  // Show error state
  if (error) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center min-h-screen px-6">
          <div className="text-center">
            <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-brand-red/10 flex items-center justify-center">
              <span className="text-3xl">⚠️</span>
            </div>
            <h1 className="font-display text-xl font-bold text-white mb-2">Connection Error</h1>
            <p className="text-sm text-white/50 mb-6">{error}</p>
            <button 
              onClick={() => window.location.reload()}
              className="px-6 py-3 rounded-xl bg-white text-black font-semibold hover:bg-gray-200 active:scale-95 transition-all"
            >
              Try Again
            </button>
          </div>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Page Content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.15 }}
        >
          {activeTab === 'home' && (
            <HomePage 
              onNavigate={handleNavigate} 
              onOpenWithdraw={() => handleOpenWithdraw()}
            />
          )}
          {activeTab === 'wallet' && (
            <WalletPage onOpenWithdraw={handleOpenWithdraw} />
          )}
          {activeTab === 'missions' && <MissionsPage />}
          {activeTab === 'referrals' && <ReferralsPage />}
          {activeTab === 'history' && <HistoryPage />}
        </motion.div>
      </AnimatePresence>

      {/* Bottom Navigation */}
      <BottomNav activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Withdraw Modal */}
      <AnimatePresence>
        {withdrawOpen && (
          <WithdrawModal
            isOpen={withdrawOpen}
            onClose={() => setWithdrawOpen(false)}
            initialAsset={withdrawAsset}
          />
        )}
      </AnimatePresence>
    </PageContainer>
  );
}

function App() {
  return (
    <WalletProvider>
      <AppContent />
    </WalletProvider>
  );
}

export default App;

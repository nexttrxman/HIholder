import { useState, useEffect } from 'react';
import { TonConnectUIProvider } from '@tonconnect/ui-react';
import { WalletProvider, useWallet } from '@/contexts/WalletContext';
import { PageContainer } from '@/components/layout/PageContainer';
import { BottomNav } from '@/components/layout/BottomNav';
import { WithdrawModal } from '@/components/wallet/WithdrawModal';
import { ClaimModal } from '@/components/earn/ClaimModal';
import { AnimatePresence, motion } from 'framer-motion';

// Pages
import { HomePage } from '@/pages/Home';
import { WalletPage } from '@/pages/Wallet';
import { MissionsPage } from '@/pages/Missions';
import { ReferralsPage } from '@/pages/Referrals';
import { HistoryPage } from '@/pages/History';

import '@/App.css';

// TonConnect manifest - update with your app info
const manifestUrl = 'https://raw.githubusercontent.com/AntipressTeam/TonConnectManifest/main/tonkeeper.json';

function AppContent() {
  const { loading, error, pendingClaim } = useWallet();
  const [activeTab, setActiveTab] = useState('home');
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAsset, setWithdrawAsset] = useState('USDT');
  const [claimModalOpen, setClaimModalOpen] = useState(false);
  const [activeClaim, setActiveClaim] = useState(null);

  // Open claim modal when pending claim exists
  useEffect(() => {
    if (pendingClaim && !claimModalOpen) {
      setActiveClaim(pendingClaim);
    }
  }, [pendingClaim, claimModalOpen]);

  const handleOpenWithdraw = (asset = 'USDT') => {
    setWithdrawAsset(asset);
    setWithdrawOpen(true);
  };

  const handleNavigate = (tab) => {
    setActiveTab(tab);
  };

  const handleClaimReady = (claim) => {
    setActiveClaim(claim);
    setClaimModalOpen(true);
  };

  const handleOpenClaim = () => {
    if (pendingClaim) {
      setActiveClaim(pendingClaim);
      setClaimModalOpen(true);
    }
  };

  // Loading screen
  if (loading) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="w-16 h-16 mx-auto mb-6 relative">
              <div className="absolute inset-0 rounded-full border-2 border-white/10" />
              <div className="absolute inset-0 rounded-full border-2 border-t-brand-green border-r-transparent border-b-transparent border-l-transparent animate-spin" />
            </div>
            <h1 className="font-display text-xl font-bold text-white mb-2">TronKeeper</h1>
            <p className="text-sm text-white/40">Loading...</p>
          </div>
        </div>
      </PageContainer>
    );
  }

  // Error screen
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
              onClaimReady={handleClaimReady}
              onOpenClaim={handleOpenClaim}
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

      {/* Claim Modal */}
      <AnimatePresence>
        {claimModalOpen && activeClaim && (
          <ClaimModal
            isOpen={claimModalOpen}
            onClose={() => setClaimModalOpen(false)}
            claim={activeClaim}
          />
        )}
      </AnimatePresence>
    </PageContainer>
  );
}

function App() {
  return (
    <TonConnectUIProvider manifestUrl={manifestUrl}>
      <WalletProvider>
        <AppContent />
      </WalletProvider>
    </TonConnectUIProvider>
  );
}

export default App;

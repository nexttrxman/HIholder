import { useState } from 'react';
import { useWallet } from '@/contexts/WalletContext';
import { BalanceCard } from '@/components/wallet/BalanceCard';
import { DepositInfo } from '@/components/wallet/DepositInfo';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp } from 'lucide-react';

const TETHER_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMzkuNDMgMjk1LjI3Ij48cGF0aCBmaWxsPSIjNTBBRjk1IiBkPSJNNjIuMTUgMS40NWwtNjIuMTUgMTE4LjIgNzIuMDMgNDAuNTRoMTk1LjI4bDcyLjA0LTQwLjU0TDI3Ny4xOSAxLjQ1SDYyLjE1eiIvPjxwYXRoIGZpbGw9IiNGRkYiIGQ9Ik0xOTEuMTkgMTQ0LjhjLTMuMTkuMjctMTkuNzYgMS40Ny0yMS41NSAxLjQ3cy0xOC4zNi0xLjItMjEuNTUtMS40N2MtNDIuNTEtMy41NS03NC40Ny0xNC45OS03NC40Ny0yOC43NXMzMS45Ni0yNS4yIDc0LjQ3LTI4Ljc1djQ1Ljc1YzMuMjMuMjMgMTguNTMgMS40NSAyMS42OCAxLjQ1czE4LjIzLTEuMjggMjEuNDItMS40NXYtNDUuNzVjNDIuNDYgMy41NSA3NC4zOCAxNS4wMiA3NC4zOCAyOC43NXMtMzEuOTIgMjUuMi03NC4zOCAyOC43NXptMC02MS41OHYtNDAuNTRoNTcuNzl2LTI4LjQ5aC0xNTguNnYyOC40OWg1Ny43OXY0MC41NGMtNDguMjUgNC4yLTg0LjQ5IDE4Ljg2LTg0LjQ5IDM2LjMyczM2LjI0IDMyLjEyIDg0LjQ5IDM2LjMydjExNS40Nmg0My4wMnYtMTE1LjQ2YzQ4LjE4LTQuMiA4NC4zNS0xOC44NSA4NC4zNS0zNi4zMnMtMzYuMTctMzIuMTItODQuMzUtMzYuMzJ6Ii8+PC9zdmc+';
const TRX_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHBhdGggZmlsbD0iI0VGMDAyNyIgZD0iTTE2IDBjOC44MzcgMCAxNiA3LjE2MyAxNiAxNnMtNy4xNjMgMTYtMTYgMTZTMCAyNC44MzcgMCAxNiA3LjE2MyAwIDE2IDB6Ii8+PHBhdGggZmlsbD0iI0ZGRiIgZD0iTTIxLjkzMiA5LjkxM0w3Ljc1IDcuNjg3bDcuMDk5IDE3LjU4NiA5LjcwNi0xMi42MzgtMi42MjMtMi43MjJ6bS0uNzM0IDMuMjU2bC01LjY5MyA3LjM5NC00LjcxLTExLjY3NyA5LjM2NiAxLjUzNi0uOTYzIDIuNzQ3eiIvPjwvc3ZnPg==';

export function WalletPage({ onOpenWithdraw }) {
  const { usdtBalance, trxBalance, totalEarned } = useWallet();
  const [showDeposit, setShowDeposit] = useState(true);

  return (
    <div className="px-4 py-4 pb-8" data-testid="wallet-page">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold text-white">Wallet</h1>
        <p className="text-sm text-white/50 mt-1">Manage your balances</p>
      </div>

      {/* Total Balance Hero */}
      <motion.div
        className="glass-card rounded-3xl p-6 mb-6 text-center"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <p className="text-xs text-white/40 uppercase tracking-wider mb-2">Total Balance</p>
        <div className="flex items-baseline justify-center gap-1">
          <span className="text-4xl font-bold text-white font-display">${usdtBalance.toFixed(2)}</span>
          <span className="text-lg text-brand-green">USDT</span>
        </div>
        <p className="text-sm text-white/40 mt-2">+ {trxBalance.toFixed(2)} TRX</p>
      </motion.div>

      {/* Balance Cards */}
      <div className="space-y-3 mb-6">
        <BalanceCard
          asset="USDT"
          amount={usdtBalance}
          label="Tether USD"
          icon={TETHER_ICON}
          onWithdraw={() => onOpenWithdraw('USDT')}
        />
        <BalanceCard
          asset="TRX"
          amount={trxBalance}
          label="TRON"
          icon={TRX_ICON}
          onWithdraw={() => onOpenWithdraw('TRX')}
        />
      </div>

      {/* Deposit Section Toggle */}
      <button
        onClick={() => setShowDeposit(!showDeposit)}
        data-testid="toggle-deposit"
        className="w-full flex items-center justify-between p-4 rounded-xl bg-white/5 border border-white/10 mb-3"
      >
        <span className="font-semibold text-white">Deposit Information</span>
        {showDeposit ? (
          <ChevronUp className="w-5 h-5 text-white/40" />
        ) : (
          <ChevronDown className="w-5 h-5 text-white/40" />
        )}
      </button>

      <AnimatePresence>
        {showDeposit && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <DepositInfo />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default WalletPage;

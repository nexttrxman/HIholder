import { TransactionList } from '@/components/transactions/TransactionList';

export function HistoryPage() {
  return (
    <div className="px-4 py-4 pb-8" data-testid="history-page">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold text-white">History</h1>
        <p className="text-sm text-white/50 mt-1">Your transaction history</p>
      </div>

      <TransactionList />
    </div>
  );
}

export default HistoryPage;

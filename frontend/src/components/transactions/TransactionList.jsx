import { useState, useEffect } from 'react';
import { useWallet } from '@/contexts/WalletContext';
import { TransactionItem } from './TransactionItem';
import { LoadingState } from '@/components/shared/LoadingState';
import { EmptyState } from '@/components/shared/EmptyState';
import { Clock } from 'lucide-react';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'trades', label: 'Trades' },
  { id: 'deposit', label: 'Deposits' },
  { id: 'withdraw', label: 'Withdrawals' },
  { id: 'reward', label: 'Rewards' },
];

const TRADE_TYPES = ['buy', 'sell'];

export function TransactionList() {
  const { transactions, loadingTransactions, loadTransactions } = useWallet();
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  const filteredTransactions = transactions.filter((tx) => {
    if (filter === 'all') return true;
    if (filter === 'trades') return TRADE_TYPES.includes(tx.type);
    return tx.type === filter;
  });

  if (loadingTransactions && transactions.length === 0) {
    return <LoadingState message="Loading transactions..." />;
  }

  return (
    <div data-testid="transaction-list">
      {/* Filters */}
      <div className="flex gap-2 mb-4 overflow-x-auto pb-2 -mx-4 px-4">
        {FILTERS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setFilter(id)}
            data-testid={`filter-${id}`}
            className={`
              px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-all
              ${filter === id
                ? 'bg-white text-black'
                : 'bg-white/5 text-white/60 hover:bg-white/10'
              }
            `}
          >
            {label}
          </button>
        ))}
      </div>

      {/* List */}
      {filteredTransactions.length === 0 ? (
        <EmptyState
          icon={Clock}
          title={filter === 'all' ? 'No activity yet' : 'Nothing here yet'}
          description={
            filter === 'all'
              ? 'Hold to earn your first reward, or open a demo trade — everything shows up here.'
              : 'Try another filter.'
          }
        />
      ) : (
        <div className="space-y-2">
          {filteredTransactions.map((tx, index) => (
            <TransactionItem key={tx.id} transaction={tx} index={index} />
          ))}
        </div>
      )}

      <div className="mt-6 p-3 rounded-xl bg-white/5 border border-white/10 text-center">
        <p className="text-xs text-white/40">
          Rewards, deposits, withdrawals and demo trades in one ledger.
        </p>
      </div>
    </div>
  );
}

export default TransactionList;

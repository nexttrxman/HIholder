import { Inbox } from 'lucide-react';

export function EmptyState({ 
  icon: Icon = Inbox, 
  title = 'No data', 
  description = 'Nothing to show here yet.',
  action = null 
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center" data-testid="empty-state">
      <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
        <Icon className="w-8 h-8 text-white/30" />
      </div>
      <h3 className="text-lg font-semibold text-white/80 mb-1">{title}</h3>
      <p className="text-sm text-white/40 max-w-[240px]">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export default EmptyState;

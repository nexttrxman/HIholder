export function LoadingState({ message = 'Loading...' }) {
  return (
    <div className="flex flex-col items-center justify-center py-12" data-testid="loading-state">
      <div className="relative w-12 h-12">
        <div className="absolute inset-0 rounded-full border-2 border-white/10" />
        <div className="absolute inset-0 rounded-full border-2 border-t-brand-green border-r-transparent border-b-transparent border-l-transparent animate-spin" />
      </div>
      <p className="mt-4 text-sm text-white/50">{message}</p>
    </div>
  );
}

export function LoadingSkeleton({ className = '' }) {
  return (
    <div 
      className={`animate-pulse bg-white/5 rounded-xl ${className}`}
      data-testid="loading-skeleton"
    />
  );
}

export default LoadingState;

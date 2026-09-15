import { Component } from 'react';

/**
 * Catches render errors so a broken page can never leave the user staring at a
 * blank/dark screen. The failure is reported on screen instead, with the real
 * message, which also makes field bugs diagnosable from a phone.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    // Surface it in the console too, for anyone with devtools open.
    console.error('[TronKeeper] render error:', error, info?.componentStack);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="px-4 py-6" data-testid="error-boundary">
        <div className="glass-card rounded-console p-5">
          <p className="sys-label mb-2">System fault</p>
          <h2 className="font-display text-lg font-bold text-white mb-3">
            This screen crashed
          </h2>
          <pre
            className="mb-4 whitespace-pre-wrap break-words rounded-2xl bg-black/40 border border-brand-red/25 p-3 font-mono text-[11px] leading-relaxed text-brand-red"
            data-testid="error-boundary-message"
          >
            {String(error?.message || error)}
          </pre>
          {info?.componentStack ? (
            <pre className="mb-4 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-black/30 border border-white/[0.07] p-3 font-mono text-[10px] leading-relaxed text-ink-dim">
              {info.componentStack.trim()}
            </pre>
          ) : null}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => this.setState({ error: null, info: null })}
              className="flex-1 py-3 rounded-2xl bg-brand-teal text-black font-bold shadow-glow-teal active:scale-95 transition-all"
              data-testid="error-boundary-retry"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="flex-1 py-3 rounded-2xl bg-white/[0.06] border border-white/[0.09] text-white font-semibold active:scale-95 transition-all"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;

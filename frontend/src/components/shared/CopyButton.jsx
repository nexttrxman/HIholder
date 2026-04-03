import { Copy, Check } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useTelegram } from '@/hooks/useTelegram';

export function CopyButton({ text, label = 'Copy', className = '' }) {
  const { copied, copy } = useCopyToClipboard();
  const { vibrate } = useTelegram();

  const handleCopy = () => {
    copy(text);
    vibrate('success');
  };

  return (
    <button
      onClick={handleCopy}
      data-testid="copy-btn"
      className={`
        flex items-center justify-center gap-2 px-4 py-2
        rounded-xl bg-white/5 border border-white/10
        text-sm font-medium text-white/80
        active:scale-95 transition-all
        hover:bg-white/10
        ${copied ? 'text-brand-green border-brand-green/30' : ''}
        ${className}
      `}
    >
      {copied ? (
        <>
          <Check className="w-4 h-4" />
          <span>Copied!</span>
        </>
      ) : (
        <>
          <Copy className="w-4 h-4" />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}

export default CopyButton;

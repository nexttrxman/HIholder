import { hapticFeedback, shareReferralLink, getTelegramUser } from '@/services/api';

/**
 * Hook to access Telegram WebApp features
 */
export function useTelegram() {
  const user = getTelegramUser();

  const vibrate = (type = 'impact') => {
    hapticFeedback(type);
  };

  const share = (uid) => {
    shareReferralLink(uid);
  };

  const isTelegramWebApp = () => {
    return !!(typeof window !== 'undefined' && window.Telegram?.WebApp);
  };

  return {
    user,
    vibrate,
    share,
    isTelegramWebApp: isTelegramWebApp(),
  };
}

export default useTelegram;

import { describe, it, expect, vi, afterEach } from 'vitest';
import { shareToStory, buildReferralLink, SHARE_STORY_IMAGE } from '@/services/api';

// v3.4: las misiones de compartir suben la FOTO del bot a la historia del
// usuario con WebApp.shareToStory (Bot API 7.8+), NO un reenvio de link.
// Telegram descarga la imagen de una URL publica (la que sirve Pages) y el
// link de referido viaja como sticker (widget_link, que solo ven Premium).

describe('shareToStory', () => {
  afterEach(() => { delete window.Telegram; });

  it('abre el editor de historias con la foto publica + caption + sticker de referido', () => {
    const tgShare = vi.fn();
    window.Telegram = { WebApp: { shareToStory: tgShare } };

    const used = shareToStory('U123', 'caption de prueba');

    expect(used).toBe(true);
    expect(tgShare).toHaveBeenCalledTimes(1);
    const [mediaUrl, params] = tgShare.mock.calls[0];
    // URL absoluta y publica: Telegram la descarga del dominio del app.
    expect(mediaUrl).toBe(new URL(SHARE_STORY_IMAGE, window.location.origin).href);
    expect(mediaUrl).toMatch(/\/share-story\.jpg$/);
    expect(params.text).toBe('caption de prueba');
    expect(params.widget_link.url).toBe(buildReferralLink('U123'));
    expect(params.widget_link.name).toBe('TronKeeper');
  });

  it('sin shareToStory (cliente viejo) cae al selector de link+texto', () => {
    const openTelegramLink = vi.fn();
    window.Telegram = { WebApp: { openTelegramLink } };

    const used = shareToStory('U123', 'hola');

    expect(used).toBe(false);
    expect(openTelegramLink).toHaveBeenCalledTimes(1);
    const url = openTelegramLink.mock.calls[0][0];
    expect(url.startsWith('https://t.me/share/url?')).toBe(true);
    expect(url).toContain(encodeURIComponent(buildReferralLink('U123')));
    expect(url).toContain(encodeURIComponent('hola'));
  });

  it('sin Telegram (navegador comun) usa window.open', () => {
    const open = vi.fn();
    const prev = window.open;
    window.open = open;
    try {
      expect(shareToStory('U1', 'x')).toBe(false);
    } finally {
      window.open = prev;
    }
    expect(open).toHaveBeenCalledTimes(1);
  });
});

/**
 * @boostbossai/lumi-telegram
 *
 * Convert an ad payload from POST /v1/ad-request into Telegram Bot API
 * message and inline-keyboard objects. Pure transform — no network
 * calls, no dependencies. Compatible with the official Telegram Bot API
 * (works alongside `node-telegram-bot-api`, `grammy`, `telegraf`, etc.).
 *
 * Usage with grammy:
 *   import { toTelegramMessage } from "@boostbossai/lumi-telegram";
 *
 *   const r = await fetch("https://boostboss.ai/v1/ad-request", { ... });
 *   const { ad } = await r.json();
 *   if (ad) {
 *     const m = toTelegramMessage(ad);
 *     await ctx.reply(m.text, m.options);
 *     fetch(ad.impression_url).catch(() => {});
 *   }
 */

/** Subset of /v1/ad-request response.ad we consume. */
export interface Ad {
  ad_id:            string;
  auction_id?:      string | null;
  type?:            string;
  headline:         string;
  body?:            string;
  image_url?:       string | null;
  cta_label?:       string;
  click_url:        string;
  impression_url?:  string | null;
  disclosure_label?: string;
}

/** Telegram inline keyboard markup with one URL button. */
export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
}

/** Result of toTelegramMessage(): pass `text` and `options` to ctx.reply. */
export interface TelegramMessage {
  text:    string;
  options: {
    parse_mode:                "HTML";
    disable_web_page_preview:  boolean;
    reply_markup:              TelegramInlineKeyboard;
  };
}

/**
 * Convert ad → Telegram-shaped {text, options} pair. The text uses HTML
 * parse mode (Telegram's most reliable) with the disclosure label and
 * headline bolded. The CTA renders as an inline-keyboard URL button —
 * cleaner UX than a raw link in body text.
 */
export function toTelegramMessage(ad: Ad): TelegramMessage {
  const lines: string[] = [];
  lines.push(`<i>${escapeHtml(ad.disclosure_label || "Sponsored")}</i>`);
  lines.push(`<b>${escapeHtml(ad.headline)}</b>`);
  if (ad.body) lines.push(escapeHtml(ad.body));

  return {
    text: lines.join("\n"),
    options: {
      parse_mode:               "HTML",
      disable_web_page_preview: true,
      reply_markup:             toTelegramInlineKeyboard(ad),
    },
  };
}

/**
 * Convert ad → inline keyboard markup containing one URL button (the CTA).
 * Useful when you want to attach the keyboard to an existing message
 * without rebuilding the whole message body.
 */
export function toTelegramInlineKeyboard(ad: Ad): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: ad.cta_label || "Learn more", url: ad.click_url }],
    ],
  };
}

/**
 * Minimal HTML escape for Telegram-safe text. Telegram's HTML parse mode
 * only requires <, >, and & to be escaped (no quote escaping needed).
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

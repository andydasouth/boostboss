/**
 * @boostbossai/lumi-discord
 *
 * Convert an ad payload from POST /v1/ad-request into Discord-native
 * embed and component objects. Compatible with discord.js v14 + Discord
 * REST API v10. Pure transform — no network calls, no dependencies.
 *
 * Usage:
 *   import { toDiscordEmbed, toDiscordComponents } from "@boostbossai/lumi-discord";
 *
 *   const r = await fetch("https://boostboss.ai/v1/ad-request", {
 *     method: "POST",
 *     headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
 *     body: JSON.stringify({ context: userQuery, format: "embed", platform: "discord" }),
 *   });
 *   const { ad } = await r.json();
 *   if (ad) {
 *     await message.reply({
 *       content: aiResponse,
 *       embeds: [toDiscordEmbed(ad)],
 *       components: [toDiscordComponents(ad)],
 *     });
 *     // Fire impression beacon (fire-and-forget)
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

/** Discord embed object (discord.js APIEmbed compatible). */
export interface DiscordEmbed {
  title:        string;
  description?: string;
  url?:         string;
  image?:       { url: string };
  footer?:      { text: string };
  color?:       number;
  timestamp?:   string;
}

/** Discord component object (action row containing a link button). */
export interface DiscordActionRow {
  type: 1;
  components: Array<{
    type:  2;
    style: 5;
    label: string;
    url:   string;
  }>;
}

const PINK_HEX = 0xFF2D78; // Boost Boss accent

/**
 * Convert ad → Discord embed object. Pass to `message.reply({ embeds: [...] })`.
 * Disclosure label goes in the footer (Discord's standard pattern for
 * sponsorship attribution).
 */
export function toDiscordEmbed(ad: Ad): DiscordEmbed {
  const embed: DiscordEmbed = {
    title:       truncate(ad.headline, 256),
    description: ad.body ? truncate(ad.body, 4096) : undefined,
    url:         ad.click_url,
    footer:      { text: ad.disclosure_label || "Sponsored" },
    color:       PINK_HEX,
    timestamp:   new Date().toISOString(),
  };
  if (ad.image_url) embed.image = { url: ad.image_url };
  return embed;
}

/**
 * Convert ad → Discord ActionRow with a single link button. Pass to
 * `message.reply({ components: [...] })`. The button takes the user
 * directly to the click_url, which is already a tracking redirect.
 */
export function toDiscordComponents(ad: Ad): DiscordActionRow {
  return {
    type: 1, // ActionRow
    components: [{
      type:  2,                                   // Button
      style: 5,                                   // Link
      label: truncate(ad.cta_label || "Learn more", 80),
      url:   ad.click_url,
    }],
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

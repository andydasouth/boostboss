/**
 * @boostbossai/lumi-slack
 *
 * Convert an ad payload from POST /v1/ad-request into Slack Block Kit
 * objects. Pure transform — no network calls, no dependencies.
 * Compatible with Slack's Web API (`chat.postMessage`), Bolt apps, and
 * any framework that consumes Block Kit JSON.
 *
 * Usage:
 *   import { toSlackBlocks } from "@boostbossai/lumi-slack";
 *
 *   const r = await fetch("https://boostboss.ai/v1/ad-request", { ... });
 *   const { ad } = await r.json();
 *   if (ad) {
 *     await client.chat.postMessage({
 *       channel: channelId,
 *       text:    aiResponse,           // fallback for notifications
 *       blocks:  toSlackBlocks(ad),
 *     });
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

/** Slack Block Kit block (subset — what we emit). */
export type SlackBlock =
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> }
  | { type: "section"; text: { type: "mrkdwn"; text: string }; accessory?: SlackImageAccessory }
  | { type: "image"; image_url: string; alt_text: string }
  | { type: "actions"; elements: Array<{ type: "button"; text: { type: "plain_text"; text: string }; url: string; style?: "primary" | "danger" }> };

interface SlackImageAccessory {
  type:      "image";
  image_url: string;
  alt_text:  string;
}

/** Slack legacy attachment shape (for older integrations). */
export interface SlackAttachment {
  fallback:    string;
  color:       string;
  title:       string;
  title_link:  string;
  text?:       string;
  image_url?:  string;
  footer:      string;
  ts:          number;
}

const SLACK_PRIMARY_COLOR = "#FF2D78";

/**
 * Convert ad → array of Block Kit blocks. Order:
 *   1. Context (disclosure label, small grey text)
 *   2. Section (headline + body, with image accessory if present)
 *   3. Actions (CTA as a primary-style link button)
 */
export function toSlackBlocks(ad: Ad): SlackBlock[] {
  const disclosure = ad.disclosure_label || "Sponsored";
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_${escapeMrkdwn(disclosure)}_` }],
  });

  const sectionText = ad.body
    ? `*${escapeMrkdwn(ad.headline)}*\n${escapeMrkdwn(ad.body)}`
    : `*${escapeMrkdwn(ad.headline)}*`;

  const sectionBlock: SlackBlock = {
    type: "section",
    text: { type: "mrkdwn", text: sectionText },
  };
  if (ad.image_url) {
    (sectionBlock as { accessory?: SlackImageAccessory }).accessory = {
      type:      "image",
      image_url: ad.image_url,
      alt_text:  ad.headline,
    };
  }
  blocks.push(sectionBlock);

  blocks.push({
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: ad.cta_label || "Learn more" },
      url:  ad.click_url,
      style: "primary",
    }],
  });

  return blocks;
}

/**
 * Convert ad → legacy Slack attachment shape. Useful when posting via
 * incoming webhooks or older Slack integrations that don't render
 * Block Kit cleanly. Modern apps should prefer toSlackBlocks().
 */
export function toSlackAttachment(ad: Ad): SlackAttachment {
  return {
    fallback:   ad.headline,
    color:      SLACK_PRIMARY_COLOR,
    title:      ad.headline,
    title_link: ad.click_url,
    text:       ad.body,
    image_url:  ad.image_url || undefined,
    footer:     ad.disclosure_label || "Sponsored",
    ts:         Math.floor(Date.now() / 1000),
  };
}

/** Slack mrkdwn requires <, >, and & to be escaped. Same as Telegram HTML. */
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

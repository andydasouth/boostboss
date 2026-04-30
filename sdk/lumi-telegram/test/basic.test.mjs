import { test } from "node:test";
import assert from "node:assert/strict";
const { toTelegramMessage, toTelegramInlineKeyboard } = await import("../dist/index.js");

const sampleAd = {
  ad_id:            "cmp_abc",
  auction_id:       "auc_xyz",
  type:             "image",
  headline:         "Test headline",
  body:             "Test body",
  image_url:        "https://example.com/img.png",
  cta_label:        "Learn more",
  click_url:        "https://example.com/click",
  impression_url:   "https://example.com/impression",
  disclosure_label: "Sponsored",
};

test("toTelegramMessage produces text + options", () => {
  const m = toTelegramMessage(sampleAd);
  assert.match(m.text, /Sponsored/);
  assert.match(m.text, /<b>Test headline<\/b>/);
  assert.match(m.text, /Test body/);
  assert.equal(m.options.parse_mode, "HTML");
  assert.equal(m.options.disable_web_page_preview, true);
});

test("toTelegramMessage HTML-escapes special chars", () => {
  const m = toTelegramMessage({ ...sampleAd, headline: "Foo & <bar>" });
  assert.match(m.text, /Foo &amp; &lt;bar&gt;/);
});

test("toTelegramInlineKeyboard wraps CTA as URL button", () => {
  const k = toTelegramInlineKeyboard(sampleAd);
  assert.equal(k.inline_keyboard.length, 1);
  assert.equal(k.inline_keyboard[0].length, 1);
  assert.equal(k.inline_keyboard[0][0].text, "Learn more");
  assert.equal(k.inline_keyboard[0][0].url, sampleAd.click_url);
});

test("toTelegramInlineKeyboard falls back to 'Learn more' when cta_label missing", () => {
  const k = toTelegramInlineKeyboard({ ...sampleAd, cta_label: undefined });
  assert.equal(k.inline_keyboard[0][0].text, "Learn more");
});

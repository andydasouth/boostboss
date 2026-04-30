import { test } from "node:test";
import assert from "node:assert/strict";
const { toDiscordEmbed, toDiscordComponents } = await import("../dist/index.js");

const sampleAd = {
  ad_id:            "cmp_abc",
  auction_id:       "auc_xyz",
  type:             "image",
  headline:         "Test headline",
  body:             "Test body",
  image_url:        "https://example.com/img.png",
  cta_label:        "Learn more",
  click_url:        "https://example.com/click?bbx_auc=auc_xyz",
  impression_url:   "https://example.com/impression",
  disclosure_label: "Sponsored",
};

test("toDiscordEmbed produces valid embed shape", () => {
  const e = toDiscordEmbed(sampleAd);
  assert.equal(e.title, "Test headline");
  assert.equal(e.description, "Test body");
  assert.equal(e.url, sampleAd.click_url);
  assert.deepEqual(e.image, { url: sampleAd.image_url });
  assert.deepEqual(e.footer, { text: "Sponsored" });
  assert.equal(typeof e.color, "number");
  assert.match(e.timestamp ?? "", /\d{4}-\d{2}-\d{2}T/);
});

test("toDiscordEmbed truncates long headline to 256 chars", () => {
  const long = "A".repeat(400);
  const e = toDiscordEmbed({ ...sampleAd, headline: long });
  assert.ok(e.title.length <= 256);
});

test("toDiscordEmbed omits image when no image_url", () => {
  const e = toDiscordEmbed({ ...sampleAd, image_url: null });
  assert.equal(e.image, undefined);
});

test("toDiscordComponents produces ActionRow with link button", () => {
  const c = toDiscordComponents(sampleAd);
  assert.equal(c.type, 1);
  assert.equal(c.components.length, 1);
  assert.equal(c.components[0].type, 2);
  assert.equal(c.components[0].style, 5);
  assert.equal(c.components[0].label, "Learn more");
  assert.equal(c.components[0].url, sampleAd.click_url);
});

test("toDiscordComponents truncates label to 80 chars", () => {
  const c = toDiscordComponents({ ...sampleAd, cta_label: "A".repeat(120) });
  assert.ok(c.components[0].label.length <= 80);
});

test("toDiscordComponents falls back to 'Learn more' when cta_label missing", () => {
  const c = toDiscordComponents({ ...sampleAd, cta_label: undefined });
  assert.equal(c.components[0].label, "Learn more");
});

import { test } from "node:test";
import assert from "node:assert/strict";
const { toSlackBlocks, toSlackAttachment } = await import("../dist/index.js");

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

test("toSlackBlocks emits context + section + actions", () => {
  const blocks = toSlackBlocks(sampleAd);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, "context");
  assert.equal(blocks[1].type, "section");
  assert.equal(blocks[2].type, "actions");
});

test("toSlackBlocks includes disclosure in context block", () => {
  const blocks = toSlackBlocks(sampleAd);
  assert.match(blocks[0].elements[0].text, /Sponsored/);
});

test("toSlackBlocks attaches image as section accessory", () => {
  const blocks = toSlackBlocks(sampleAd);
  assert.deepEqual(blocks[1].accessory, {
    type: "image", image_url: sampleAd.image_url, alt_text: sampleAd.headline,
  });
});

test("toSlackBlocks omits accessory when no image_url", () => {
  const blocks = toSlackBlocks({ ...sampleAd, image_url: null });
  assert.equal(blocks[1].accessory, undefined);
});

test("toSlackBlocks button label falls back to 'Learn more' when cta_label missing", () => {
  const blocks = toSlackBlocks({ ...sampleAd, cta_label: undefined });
  assert.equal(blocks[2].elements[0].text.text, "Learn more");
});

test("toSlackBlocks escapes mrkdwn special chars", () => {
  const blocks = toSlackBlocks({ ...sampleAd, headline: "Foo & <bar>" });
  assert.match(blocks[1].text.text, /Foo &amp; &lt;bar&gt;/);
});

test("toSlackAttachment produces legacy attachment shape", () => {
  const a = toSlackAttachment(sampleAd);
  assert.equal(a.title, sampleAd.headline);
  assert.equal(a.title_link, sampleAd.click_url);
  assert.equal(a.image_url, sampleAd.image_url);
  assert.equal(a.footer, "Sponsored");
  assert.equal(typeof a.ts, "number");
});

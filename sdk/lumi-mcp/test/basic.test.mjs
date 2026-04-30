// Basic smoke test for @boostbossai/lumi-mcp.
// Run with: node --test test/*.test.mjs
// Mocks global fetch so we don't hit the live API in CI.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// We import the built artifact so this test verifies what npm consumers see.
const { LumiMCP, ERROR_CODES, Ad } = await import("../dist/index.js");

const realFetch = globalThis.fetch;

// Map of URL → response (object will be JSON.stringified, status defaults to 200).
let mockResponses = new Map();
let lastRequest = null;

function mockFetch(url, init) {
  lastRequest = { url, init };
  const handler = mockResponses.get(url) || mockResponses.get("*");
  if (!handler) {
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  }
  if (typeof handler === "function") return handler(url, init);
  const status = handler.status ?? 200;
  const body = typeof handler.body === "string" ? handler.body : JSON.stringify(handler.body);
  return Promise.resolve(new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  }));
}

before(() => { globalThis.fetch = mockFetch; });
after(()  => { globalThis.fetch = realFetch; });

test("constructor validates required options", () => {
  assert.throws(() => new LumiMCP({}), TypeError);
  assert.throws(() => new LumiMCP({ publisherId: "p" }), TypeError);
  assert.throws(() => new LumiMCP({ apiKey: "k" }), TypeError);
  // Both present → should construct without throwing
  const ok = new LumiMCP({ publisherId: "pub_test", apiKey: "sk_test" });
  assert.ok(ok instanceof LumiMCP);
});

test("fetchAd: empty context emits 'error' and resolves null", async () => {
  const lumi = new LumiMCP({ publisherId: "pub_test", apiKey: "sk_test" });
  let captured = null;
  lumi.on("error", (e) => { captured = e; });
  const ad = await lumi.fetchAd({ context: "" });
  assert.equal(ad, null);
  assert.ok(captured, "error event should have fired");
  assert.equal(captured.code, "BBX_BAD_REQUEST");
});

test("fetchAd: success path returns Ad and emits impression", async () => {
  mockResponses = new Map([
    ["https://boostboss.ai/api/mcp", {
      body: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              sponsored: {
                campaign_id: "cmp_abc",
                headline: "Hello world",
                subtext: "this is a test",
                cta_label: "Try it",
                cta_url: "https://example.com/click",
                disclosure_label: "Sponsored",
                tracking: {
                  impression: "https://boostboss.ai/api/track?event=impression&x=1",
                  click:      "https://boostboss.ai/api/track?event=click&x=1",
                },
              },
              auction: { auction_id: "auc_xyz", winning_price_cpm: 12.5, intent_match_score: 0.7 },
            }),
          }],
        },
      },
    }],
    ["https://boostboss.ai/api/track?event=impression&x=1", { body: { ok: true } }],
  ]);

  const lumi = new LumiMCP({ publisherId: "pub_test", apiKey: "sk_test" });
  const events = [];
  lumi.on("impression", (e) => events.push(["impression", e]));
  lumi.on("no_fill",    (e) => events.push(["no_fill", e]));
  lumi.on("error",      (e) => events.push(["error", e]));

  const ad = await lumi.fetchAd({ context: "I want to set up Stripe billing" });
  assert.ok(ad instanceof Ad);
  assert.equal(ad.headline, "Hello world");
  assert.equal(ad.adId, "cmp_abc");
  assert.equal(ad.auctionId, "auc_xyz");
  assert.equal(ad.disclosureLabel, "Sponsored");
  assert.equal(ad.intentMatchScore, 0.7);
  // Allow microtask flush for the impression event
  await new Promise((r) => setTimeout(r, 5));
  const imp = events.find(([n]) => n === "impression");
  assert.ok(imp, "impression event should have fired");
  assert.equal(imp[1].adId, "cmp_abc");
});

test("fetchAd: no_fill path returns null + emits no_fill", async () => {
  mockResponses = new Map([
    ["https://boostboss.ai/api/mcp", {
      body: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: JSON.stringify({ sponsored: null, reason: "no_campaigns" }) }],
        },
      },
    }],
  ]);

  const lumi = new LumiMCP({ publisherId: "pub_test", apiKey: "sk_test" });
  let nf = null;
  lumi.on("no_fill", (e) => { nf = e; });
  const ad = await lumi.fetchAd({ context: "test" });
  assert.equal(ad, null);
  assert.ok(nf, "no_fill should have fired");
  assert.equal(nf.context, "test");
});

test("fetchAd: HTTP 401 → BBX_AUTH error event, returns null", async () => {
  mockResponses = new Map([
    ["https://boostboss.ai/api/mcp", { status: 401, body: "unauthorised" }],
  ]);
  const lumi = new LumiMCP({ publisherId: "pub_test", apiKey: "bad_key" });
  let err = null;
  lumi.on("error", (e) => { err = e; });
  const ad = await lumi.fetchAd({ context: "test" });
  assert.equal(ad, null);
  assert.ok(err);
  assert.equal(err.code, ERROR_CODES.AUTH);
});

test("fetchAd: bearer token + X-Lumi-Source header set on request", async () => {
  mockResponses = new Map([
    ["https://boostboss.ai/api/mcp", {
      body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ sponsored: null }) }] } },
    }],
  ]);
  const lumi = new LumiMCP({ publisherId: "pub_test", apiKey: "sk_live_xxx" });
  await lumi.fetchAd({ context: "test" });
  const headers = lastRequest.init.headers;
  assert.equal(headers["Authorization"], "Bearer sk_live_xxx");
  assert.equal(headers["X-Lumi-Source"], "mcp");
});

test("Ad.toMCPBlock includes disclosure label and CTA", async () => {
  mockResponses = new Map([
    ["https://boostboss.ai/api/mcp", {
      body: {
        jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({
          sponsored: {
            campaign_id: "c1", headline: "Big news", cta_label: "Click here",
            cta_url: "https://example.com/x", disclosure_label: "Sponsored",
          },
          auction: { auction_id: "a1" },
        }) }] },
      },
    }],
  ]);
  const lumi = new LumiMCP({ publisherId: "pub_test", apiKey: "sk_test" });
  const ad = await lumi.fetchAd({ context: "x" });
  const block = ad.toMCPBlock();
  assert.equal(block.type, "text");
  assert.match(block.text, /Sponsored/);
  assert.match(block.text, /Big news/);
  assert.match(block.text, /Click here/);
  assert.match(block.text, /https:\/\/example\.com\/x/);
  assert.equal(block._meta.boostboss.adId, "c1");
  assert.equal(block._meta.boostboss.auctionId, "a1");
});

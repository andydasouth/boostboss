// Basic smoke test for @boostbossai/lumi-sdk core (Lumi class).
// Run with: node --test test/*.test.mjs
//
// Mocks `fetch` and a minimal DOM (document, Image) so the test
// runs in plain Node without jsdom. Verifies the wire shape, the
// emitted events, and the slot lifecycle.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// ── Minimal DOM shim ─────────────────────────────────────────────
const elements = new Map();
function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    classList: new Set(),
    style: {},
    attributes: new Map(),
    _innerHTML: "",
    parentNode: null,
    setAttribute(k, v) { this.attributes.set(k, v); },
    getAttribute(k) { return this.attributes.get(k); },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter(c => c !== child);
      child.parentNode = null;
      return child;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener() {},
    removeEventListener() {},
    onerror: null,
    set innerHTML(v) { this._innerHTML = v; this.children = []; },
    get innerHTML() { return this._innerHTML; },
    set src(v) { this._src = v; },
    get src() { return this._src; },
    set href(v) { this._href = v; },
    get href() { return this._href; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    set className(v) {
      this.classList.clear();
      String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
    },
    get className() { return [...this.classList].join(" "); },
  };
  // make classList have add/remove/contains
  const set = el.classList;
  set.add = function (...args) { args.forEach(a => Set.prototype.add.call(this, a)); };
  set.remove = function (...args) { args.forEach(a => Set.prototype.delete.call(this, a)); };
  set.contains = function (a) { return Set.prototype.has.call(this, a); };
  return el;
}

const documentShim = {
  head:  makeEl("head"),
  body:  makeEl("body"),
  createElement: (tag) => makeEl(tag),
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  querySelector: (sel) => elements.get(sel) ?? null,
  getElementById: (id) => null,
};

globalThis.document = documentShim;
globalThis.Image = function (w, h) { return makeEl("img"); };
globalThis.HTMLElement = function () {};
globalThis.Element = function () {};

// Stub navigator if absent (Node 18+ has it; older may not)
if (typeof globalThis.navigator === "undefined") {
  globalThis.navigator = { language: "en-US" };
}

// ── Mock fetch ───────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let mockResponses = new Map();
let lastRequest = null;

function mockFetch(url, init) {
  lastRequest = { url, init };
  const handler = mockResponses.get(url) || mockResponses.get("*");
  if (!handler) return Promise.resolve(new Response("Not Found", { status: 404 }));
  if (typeof handler === "function") return handler(url, init);
  const status = handler.status ?? 200;
  const body = typeof handler.body === "string" ? handler.body : JSON.stringify(handler.body);
  return Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));
}

before(() => { globalThis.fetch = mockFetch; });
after(()  => { globalThis.fetch = realFetch; });

// Import after globals are set
const { Lumi, ERROR_CODES } = await import("../dist/index.js");

// ── Tests ────────────────────────────────────────────────────────

test("constructor validates required options", () => {
  assert.throws(() => new Lumi({}), TypeError);
  // Both arms — no publisherId throws
  assert.throws(() => new Lumi({ apiBase: "https://x" }), TypeError);
  // OK
  const ok = new Lumi({ publisherId: "pub_test" });
  assert.ok(ok instanceof Lumi);
});

test("render: returns null when target selector doesn't match", async () => {
  const lumi = new Lumi({ publisherId: "pub_test" });
  let captured = null;
  lumi.on("error", (e) => { captured = e; });
  const ad = await lumi.render("#nonexistent");
  assert.equal(ad, null);
  assert.ok(captured);
  assert.equal(captured.code, ERROR_CODES.BAD_REQUEST);
});

test("render: success path returns Ad and emits impression", async () => {
  mockResponses = new Map([
    ["https://boostboss.ai/api/mcp", {
      body: {
        jsonrpc: "2.0", id: 1,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              sponsored: {
                campaign_id: "cmp_abc",
                headline: "Hi",
                subtext: "world",
                cta_label: "Try",
                cta_url: "https://example.com/click",
                disclosure_label: "Sponsored",
                tracking: {
                  impression: "https://boostboss.ai/api/track?event=impression",
                  click:      "https://boostboss.ai/api/track?event=click",
                },
              },
              auction: { auction_id: "auc_xyz" },
            }),
          }],
        },
      },
    }],
  ]);

  const lumi = new Lumi({ publisherId: "pub_test" });
  const events = [];
  lumi.on("impression", (e) => events.push(e));
  lumi.on("error",      (e) => events.push({ kind: "error", ...e }));

  const slot = makeEl("div");
  elements.set("#main-slot", slot);

  const ad = await lumi.render("#main-slot", { format: "banner", context: "test" });
  assert.ok(ad);
  assert.equal(ad.adId, "cmp_abc");
  assert.equal(ad.headline, "Hi");
  assert.equal(events.length, 1);
  assert.equal(events[0].adId, "cmp_abc");
  assert.equal(events[0].format, "banner");
});

test("render: bearer header X-Lumi-Source: npm-sdk is sent", async () => {
  mockResponses = new Map([
    ["https://boostboss.ai/api/mcp", {
      body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ sponsored: null }) }] } },
    }],
  ]);
  const lumi = new Lumi({ publisherId: "pub_test" });
  const slot = makeEl("div");
  elements.set("#header-slot", slot);
  await lumi.render("#header-slot", { context: "x" });
  assert.equal(lastRequest.init.headers["X-Lumi-Source"], "npm-sdk");
});

test("render: no_fill emits no_fill event and returns null", async () => {
  mockResponses = new Map([
    ["https://boostboss.ai/api/mcp", {
      body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ sponsored: null, reason: "no_campaigns" }) }] } },
    }],
  ]);
  const lumi = new Lumi({ publisherId: "pub_test" });
  let nf = null;
  lumi.on("no_fill", (e) => { nf = e; });
  const slot = makeEl("div");
  elements.set("#nf-slot", slot);
  const ad = await lumi.render("#nf-slot", { context: "stuff" });
  assert.equal(ad, null);
  assert.ok(nf);
  assert.equal(nf.context, "stuff");
  assert.equal(nf.reason, "no_campaigns");
});

test("render: HTTP 401 → BBX_AUTH error event", async () => {
  mockResponses = new Map([
    ["https://boostboss.ai/api/mcp", { status: 401, body: "unauthorised" }],
  ]);
  const lumi = new Lumi({ publisherId: "pub_test" });
  let err = null;
  lumi.on("error", (e) => { err = e; });
  const slot = makeEl("div");
  elements.set("#auth-slot", slot);
  const ad = await lumi.render("#auth-slot", { context: "x" });
  assert.equal(ad, null);
  assert.ok(err);
  assert.equal(err.code, ERROR_CODES.AUTH);
});

test("destroy: tears down without error and prevents subsequent render", async () => {
  const lumi = new Lumi({ publisherId: "pub_test" });
  lumi.destroy();
  const ad = await lumi.render("#anywhere");
  assert.equal(ad, null);
});

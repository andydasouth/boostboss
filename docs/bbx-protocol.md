# BBX Protocol — v1 (Draft)

**Status:** Draft, owner: BoostBoss core team
**Last updated:** 2026-04-26
**Scope:** The wire protocol between Lumi SDK, BBX (auction), and bidders (internal SuperBoost campaigns today; external networks later).

> **Reality alignment** — Much of this spec already ships. The v1 surface is *not* a fresh `/v1/*` namespace; it is the existing endpoints in `api/`:
>
> - `POST /api/mcp` (JSON-RPC 2.0, `tools/call get_sponsored_content`) is the MCP-native ad request surface. The `params` payload uses the `ad_request` shape below.
> - `POST /api/rtb` (OpenRTB 2.6) is the DSP-supply bidding surface. External networks plug in here.
> - `GET /api/track` (1×1 pixel) and `POST /api/track` (JSON) are the event-tracking surface.
>
> This document describes the *protocol* (shapes, semantics, contracts). Section 16 maps each section to the actual file in the repo.

---

## 1. What BBX Is

BBX is the auction layer that sits between **publishers** (apps that embed Lumi SDK to monetize agent / chat / tool surfaces) and **demand** (SuperBoost advertisers today; AdMob / Meta / Unity / external networks later).

Three actors. One contract.

```
┌──────────────┐   ad_request     ┌─────────────┐  bidder_request  ┌─────────────────┐
│  Lumi SDK    │ ───────────────▶ │     BBX     │ ───────────────▶ │ Bidder: Benna   │
│ (publisher)  │                  │  (auction)  │                  │ + SuperBoost    │
│              │ ◀─────────────── │             │ ◀─────────────── │ (internal)      │
│              │   ad_response    │             │  bidder_response │                 │
└──────┬───────┘                  └──────┬──────┘                  └─────────────────┘
       │  events (imp/click/conv)        │
       └────────────────────────────────▶│
                                         │
                                  ┌──────▼──────┐
                                  │ Settlement  │
                                  │ (charge,    │
                                  │  credit,    │
                                  │  train)     │
                                  └─────────────┘
```

A single auction has four phases:

1. **Request** — SDK fires `POST /v1/ad_request` with placement + context.
2. **Auction** — BBX filters eligible bidders, calls each `bidder_request` in parallel, picks the winner under first-price + reserve-floor rules.
3. **Serve** — BBX returns `ad_response` to SDK with the winning creative plus signed tracking URLs.
4. **Settle** — SDK fires `POST /v1/events` for impression / click / conversion / dismiss; BBX charges advertiser, credits publisher, feeds outcome back to Benna.

Latency budget for phases 1–3: **p95 < 250 ms**, hard cutoff `tmax_ms` from the SDK (default 250 ms).

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Publisher** | App or MCP server author who has registered with BoostBoss and embedded Lumi SDK. Identified by `publisher_id`. |
| **App** | A single product the publisher operates (e.g., "Cursor", "claude-desktop-extension"). Identified by `app_id`. |
| **Placement** | A specific monetizable slot within an app (e.g., "chat_inline_default", "tool_result_sponsored"). Identified by `placement_id`. |
| **Surface** | The kind of UI the placement lives in: `chat`, `tool_response`, `sidebar`, `loading_screen`, `status_line`. |
| **Format** | The shape of the creative: `card_inline`, `tool_result_sponsored`, `sidebar_unit`, `interstitial`, `banner`. |
| **Intent token** | A short string describing what the user / agent is currently doing. Examples: `"billing_integration"`, `"debug_py"`, `"travel_booking"`. The advertiser-side analog of a search keyword. |
| **Active tool** | An MCP server currently connected in the agent session. Identified by its canonical name (`stripe-mcp`, `quickbooks-mcp`). Can be bid against. |
| **Auction ID** | Opaque ID minted by BBX per `ad_request`. Returned to SDK and embedded inside signed tracking URLs so postbacks can be tied back to the auction. |
| **Bidder** | Anything BBX asks for a price. Today: the internal Benna bidder over SuperBoost campaigns. Future: AdMob, Meta, custom MCP-native networks. |
| **eCPM** | Effective revenue per 1,000 impressions, in USD. The unit of price across the protocol. |
| **No-fill** | Auction completed but no creative is being served (no eligible bidder, all bids below floor, tmax exceeded). |

---

## 3. Endpoints (v1)

| Method | Path | Caller | Purpose |
|---|---|---|---|
| `POST` | `/api/mcp` (JSON-RPC `tools/call get_sponsored_content`) | Lumi SDK in MCP host | Open an auction for one impression opportunity. |
| `POST` | `/api/rtb` (OpenRTB 2.6 BidRequest) | External DSP | Buy-side auction surface for DSP integrations. |
| `POST` | `/api/track` (or `GET` 1×1 pixel) | Lumi SDK / web pixel | Report impression / click / conversion / dismiss / error. |
| `POST` | `/v1/bidders/{bidder_id}/bid` *(planned)* | BBX → bidder | Internal bidder API. Today this is in-process inside Benna. |

All endpoints accept and return `application/json; charset=utf-8`. Money values on the wire today are NUMERIC dollars (e.g. `5.00`). Internal accounting uses `numeric(12,4)` precision. *Planned change:* migrate the wire to integer **micro-USD** (`USD * 1_000_000`) to avoid floating-point drift; tracked under §14 open items.

Auth:
- **Publisher (SDK):** `developer_api_key` field in the JSON-RPC `params`, matched against `developers.api_key`.
- **Advertiser API:** Supabase auth session for campaign management (`auth.uid() = campaigns.advertiser_id`).
- **DSP (RTB):** `Authorization: Bearer <seat_api_key>` matched against `dsp_seats.api_key`.

---

## 4. `POST /v1/ad_request`

Opens the auction. Called once per impression opportunity.

### 4.1 Request schema

```json
{
  "v": 1,
  "request_id": "01J7Q9V8F5K6T3W2X1Y0Z4A5B6",
  "ts": "2026-04-26T08:46:12.341Z",

  "publisher": {
    "publisher_id": "pub_8a7d6e",
    "app_id":       "app_cursor_main",
    "sdk_version":  "lumi/0.4.2"
  },

  "placement": {
    "placement_id": "plc_chat_inline_default",
    "format":       "card_inline",
    "surface":      "chat",
    "host":         "cursor",
    "size":         { "max_chars": 280, "max_lines": 4 }
  },

  "context": {
    "intent_tokens": ["billing_integration", "saas", "stripe"],
    "active_tools":  ["stripe-mcp", "quickbooks-mcp"],
    "session": {
      "session_id":   "sess_a4b1c2",
      "turn":         12,
      "duration_ms":  482000
    },
    "host_metadata": { "ide": "cursor", "language": "typescript" }
  },

  "user": {
    "anonymous_id": "uuh_2f6e9c4d",
    "geo":    { "country": "US", "region": "CA" },
    "device": { "type": "desktop", "os": "macos" },
    "lang":   "en"
  },

  "safety": {
    "categories_excluded": ["adult", "gambling", "political"],
    "max_iab_rating":      "T"
  },

  "auction": {
    "tmax_ms":   250,
    "currency":  "USD",
    "floor_cpm_micros": 1500000
  }
}
```

Field notes:

- **`request_id`** — ULID minted client-side, idempotent.
- **`anonymous_id`** — opaque hash from the SDK; never PII. Used for frequency capping only.
- **`intent_tokens`** — what the agent / user is currently doing. The SDK is responsible for extracting these (a separate doc covers extraction recipes per host). Advertisers bid against these directly.
- **`active_tools`** — canonical MCP server names. `stripe-mcp` is the high-value example.
- **`floor_cpm_micros`** — reserve set by the publisher for this placement. Required.
- **`tmax_ms`** — hard timeout. BBX returns no-fill if exceeded.

### 4.2 Response schema (filled)

```json
{
  "v": 1,
  "request_id": "01J7Q9V8F5K6T3W2X1Y0Z4A5B6",
  "auction_id": "ach_01J7Q9VAB7M3R0H2Q1P5N4D8KE",
  "served":     true,

  "ad": {
    "creative_id":     "cr_stripe_billing_v3",
    "campaign_id":     "cmp_stripe_q2_billing",
    "advertiser_name": "Stripe",
    "format":          "card_inline",
    "render": {
      "headline":  "Stripe Billing for AI agents",
      "body":      "Native MCP for invoicing and tax. One line of setup.",
      "cta":       { "text": "Try free", "url": "https://stripe.com/billing-mcp?utm_source=bbx" },
      "image_url": null,
      "label":     "Sponsored"
    }
  },

  "tracking": {
    "impression_url": "https://bbx.boostboss.ai/v1/events?auc=ach_01J7Q9VAB7M3R0H2Q1P5N4D8KE&t=imp&sig=BkQ9...",
    "click_url":      "https://bbx.boostboss.ai/v1/events?auc=ach_01J7Q9VAB7M3R0H2Q1P5N4D8KE&t=click&sig=Cf2P...",
    "dismiss_url":    "https://bbx.boostboss.ai/v1/events?auc=ach_01J7Q9VAB7M3R0H2Q1P5N4D8KE&t=dismiss&sig=Hz7M..."
  },

  "auction": {
    "winning_price_cpm_micros": 18400000,
    "currency":   "USD",
    "expires_at": "2026-04-26T08:51:12.341Z"
  }
}
```

### 4.3 Response schema (no-fill)

```json
{
  "v": 1,
  "request_id": "01J7Q9V8F5K6T3W2X1Y0Z4A5B6",
  "served":     false,
  "no_fill_reason": "below_floor"
}
```

Allowed `no_fill_reason` values: `below_floor`, `no_eligible_bidder`, `tmax_exceeded`, `budget_exhausted`, `frequency_capped`, `safety_blocked`, `internal_error`.

The SDK MUST handle `served: false` by rendering nothing (or the publisher's house creative, if configured). It MUST NOT retry the same `request_id`.

---

## 5. Tracking Macros

The `tracking.*` URLs in `ad_response` are pre-signed. The SDK fires them as opaque blobs; it MUST NOT modify the query string. Each URL contains:

| Param | Meaning |
|---|---|
| `auc` | Auction ID |
| `t`   | Event type: `imp`, `click`, `conv`, `dismiss`, `err` |
| `sig` | HMAC-SHA256 over `auc + t + ts_window` keyed with the BBX server secret |
| `ts`  | Optional issuance timestamp; URLs expire 1 hour after issuance |

This makes events forge-resistant: an advertiser can't fabricate clicks from outside, and the SDK can't double-bill. Replay protection is enforced server-side by the `auction_id` having an idempotency record.

For conversions (web), advertisers paste the BBX pixel on their landing page. The pixel reads `?bbx_auc=` from the click-through URL (`utm_source=bbx&bbx_auc=ach_...&bbx_sig=...`), then POSTs to `/v1/events` with the conversion metadata.

For in-agent conversions (SDK-side, e.g., "the user actually invoked the sponsored MCP tool after clicking"), the SDK can fire a `conversion` event keyed to the same `auction_id` within the 7-day attribution window.

---

## 6. `POST /v1/events`

All post-auction events. Idempotent on `(auction_id, type)`.

### 6.1 Generic envelope

```json
{
  "v": 1,
  "auction_id": "ach_01J7Q9VAB7M3R0H2Q1P5N4D8KE",
  "type":       "impression",
  "ts":         "2026-04-26T08:46:13.910Z",
  "sig":        "BkQ9...",
  "metadata":   { /* type-specific */ }
}
```

If the URL was minted by BBX (the SDK's normal path), the SDK can `GET` the prebuilt URL instead of POSTing — both are accepted. POST is used when extra metadata is attached (clicks with viewport info; conversions with order value).

### 6.2 Event types

#### `impression`
Fired when the creative is rendered and visible.
```json
{ "type": "impression",
  "metadata": { "viewable_ms": 1200, "viewport_pct": 100 } }
```

#### `click`
Fired when the user activates the CTA.
```json
{ "type": "click",
  "metadata": { "click_position": "cta", "modifier_keys": [] } }
```

#### `dismiss`
Fired when the user explicitly closes / hides the unit. Used for frequency capping and Benna training.
```json
{ "type": "dismiss",
  "metadata": { "method": "x_button" | "swipe" | "auto_after_ms" } }
```

#### `conversion`
Fired when the advertiser's success criterion is met. May come from the web pixel OR from the SDK (for in-agent conversions).
```json
{ "type": "conversion",
  "metadata": {
    "conversion_type": "signup" | "purchase" | "tool_invoke" | "lead",
    "value_micros":    2999000,
    "currency":        "USD",
    "external_id":     "stripe_user_a4b1c2"
  } }
```

#### `error`
Fired if the SDK failed to render after winning.
```json
{ "type": "error",
  "metadata": { "code": "creative_load_failed", "detail": "image 404" } }
```

A creative load error refunds the advertiser (no impression billed) and the auction is marked `served=false` retroactively.

### 6.3 Idempotency rules

- An `impression` posted twice for the same `auction_id` is recorded once. Second POST returns `200 {"deduplicated": true}`.
- A `click` is recorded once even if the user double-clicks.
- A `conversion` is recorded once per `(auction_id, conversion_type)`. Multiple conversion *types* against one auction are allowed (signup → purchase later).
- The 7-day attribution window applies for conversions.

---

## 7. Internal Bidder Protocol — `POST /v1/bidders/{bidder_id}/bid`

Called by BBX to every eligible bidder in parallel during phase 2. Day one we have one bidder: `benna_superboost`. The shape is OpenRTB-inspired so external networks (`google_admob`, `meta_audience`, etc.) can be added via configuration only.

### 7.1 `bidder_request`

```json
{
  "v":          1,
  "auction_id": "ach_01J7Q9VAB7M3R0H2Q1P5N4D8KE",
  "tmax_ms":    180,

  "imp": {
    "placement_id":    "plc_chat_inline_default",
    "format":          "card_inline",
    "surface":         "chat",
    "host":            "cursor",
    "floor_cpm_micros":1500000,
    "currency":        "USD",
    "size":            { "max_chars": 280, "max_lines": 4 }
  },

  "context": {
    "intent_tokens": ["billing_integration", "saas", "stripe"],
    "active_tools":  ["stripe-mcp", "quickbooks-mcp"],
    "host_metadata": { "ide": "cursor", "language": "typescript" }
  },

  "user": {
    "anonymous_id": "uuh_2f6e9c4d",
    "geo":   { "country": "US", "region": "CA" },
    "device": { "type": "desktop", "os": "macos" },
    "lang":   "en"
  },

  "safety": {
    "categories_excluded": ["adult", "gambling", "political"],
    "max_iab_rating":      "T"
  }
}
```

Note: bidders never see `publisher_id` or `app_id`. They see the placement, the context, and a hashed user id. This is intentional — it keeps the auction insulated from publisher-specific demand-side games.

### 7.2 `bidder_response` (bid)

```json
{
  "auction_id": "ach_01J7Q9VAB7M3R0H2Q1P5N4D8KE",
  "bid": {
    "campaign_id":      "cmp_stripe_q2_billing",
    "creative_id":      "cr_stripe_billing_v3",
    "price_cpm_micros": 18400000,
    "currency":         "USD",
    "render": {
      "headline":  "Stripe Billing for AI agents",
      "body":      "Native MCP for invoicing and tax. One line of setup.",
      "cta":       { "text": "Try free", "url_template": "https://stripe.com/billing-mcp?utm_source=bbx&bbx_auc={AUC}&bbx_sig={SIG}" },
      "image_url": null,
      "label":     "Sponsored",
      "advertiser_name": "Stripe"
    },
    "expires_in_ms": 300000
  }
}
```

`url_template` may contain `{AUC}` and `{SIG}` macros that BBX substitutes before returning to the SDK. This lets BBX bind the click attribution to the specific auction without the bidder having to.

### 7.3 `bidder_response` (no-bid)

```json
{
  "auction_id": "ach_01J7Q9VAB7M3R0H2Q1P5N4D8KE",
  "no_bid":     true,
  "reason":     "no_eligible_campaign" | "below_floor" | "budget_exhausted" | "filtered_safety" | "tmax_exceeded"
}
```

A bidder that doesn't respond before `tmax_ms` is treated as `tmax_exceeded`.

---

## 8. Auction Mechanics

**Style:** First-price sealed-bid.

**Resolution order:**

1. **Eligibility filter** (BBX-side, before any bidder is called):
   - Format / surface match
   - Geo allow-list
   - Safety categories
   - Frequency cap (per `anonymous_id` × campaign, sliding window)
   - Daily budget remaining
   - Account balance ≥ floor
2. **Parallel `bidder_request`** to all surviving bidders.
3. **Collect responses** until `tmax_ms` elapses. Late responses are dropped.
4. **Apply floor:** any bid below `floor_cpm_micros` is discarded.
5. **Pick winner:** highest `price_cpm_micros`. Ties broken by lower-latency response, then by `auction_id` hash.
6. **Mint signed tracking URLs**, return `ad_response`.

**Charge model:** Winner pays their own bid (first-price). The SDK's `ad_response.auction.winning_price_cpm_micros` reports it for transparency / dashboards.

**Floor source of truth:** publishers set placement floors; advertisers see the prevailing floor at bid-build time.

---

## 9. Benna v0 Scoring (the only bidder on day one)

Benna's price for a single eligible campaign:

```
price_cpm = advertiser_bid_cpm
          × placement_baseline_ctr
          × geo_multiplier
          × format_multiplier
          × intent_match_score
          × safety_multiplier
```

Where:

- **`advertiser_bid_cpm`** — what the advertiser is willing to pay at most.
- **`placement_baseline_ctr`** — historical CTR for this `placement_id` (default 1.0 for cold start).
- **`geo_multiplier`** — table-driven, per-country (US=1.0, EM=0.2, etc.).
- **`format_multiplier`** — `card_inline`=1.0, `tool_result_sponsored`=1.4, `sidebar_unit`=0.6, `interstitial`=1.2 (we'll tune from data).
- **`intent_match_score`** — `cosine(embedding(intent_tokens), embedding(campaign.targeting_tokens))`, clipped to `[0.2, 1.5]`. Embeddings are pre-computed for campaigns; bid-time we embed the request's `intent_tokens` and look them up. Cache hits should dominate after warm-up.
- **`safety_multiplier`** — 0 if any excluded category overlaps, else 1.

Intent-embedding model: `text-embedding-3-small` (OpenAI). Cached in Redis keyed by token-set hash.

**Exploration budget:** Benna picks a randomly-shuffled candidate (instead of the heuristic top) on `EPSILON = 0.05` of auctions for the first 30 days, so we collect outcome data on cold campaigns. After that, exploration shrinks.

---

## 10. Latency Budget

| Phase | Budget | Notes |
|---|---|---|
| Network ingress + auth | 20 ms | Edge function + Redis-backed token check |
| Eligibility filter | 30 ms | Hot data in Redis (campaigns, freq caps, balances) |
| Parallel `bidder_request` | 150 ms | tmax_ms minus overhead |
| Resolution + signing | 20 ms | First-price pick + HMAC mint |
| Network egress | 30 ms | |
| **Total (p95)** | **~250 ms** | hard cutoff in SDK |

If we miss budget, ad_response is `served: false, no_fill_reason: "tmax_exceeded"` — the SDK shouldn't block the agent / chat surface waiting on us.

Infra notes:
- Auction handler runs on Vercel Edge Runtime.
- Hot path data in Upstash Redis (campaigns by targeting key, frequency counters, balance, embeddings cache).
- Postgres (Supabase) is the source of truth and the write target of `/v1/events`. Auction itself reads only from Redis.

---

## 11. Errors

Top-level error shape (any endpoint):

```json
{
  "error": {
    "code":    "invalid_placement",
    "message": "placement_id 'plc_x' is not registered for app_id 'app_y'",
    "request_id": "01J7Q9V8F5K6T3W2X1Y0Z4A5B6",
    "retryable":  false
  }
}
```

| `code` | HTTP | Retryable | Cause |
|---|---|---|---|
| `unauthorized` | 401 | no | Bad / missing bearer |
| `invalid_request` | 400 | no | Schema violation |
| `invalid_placement` | 400 | no | Placement not registered or paused |
| `rate_limited` | 429 | yes (with backoff) | Per-publisher QPS exceeded |
| `internal_error` | 500 | yes | BBX bug / infra blip |
| `service_unavailable` | 503 | yes | Maintenance / capacity |

The SDK MUST treat 5xx as no-fill and continue.

---

## 12. Versioning

- Path-prefixed: `/v1/...`. Breaking changes get `/v2/...`.
- Field-additive changes are non-breaking and ship without a version bump. Unknown fields MUST be ignored by both sides.
- Removing a field requires a new major version.
- The on-wire `"v": 1` field exists so consumers can disambiguate when they see a request out-of-band (e.g., in a log or replay).

---

## 13. Security

- **Publisher key rotation:** publisher dashboard exposes "rotate SDK key"; old key has 24-hour grace period.
- **Tracking signatures:** HMAC-SHA256 over `auction_id || event_type || issued_at` with a server secret. URLs expire 1 hour after issuance for non-conversion events; conversions accept up to 7 days.
- **PII:** `anonymous_id` is the only user identifier on the wire. It is a salted hash of the host-app's session id, never a stable cross-app identifier. Geo is at country/region granularity — never lat/long.
- **Brand safety:** advertiser-side category exclusions are enforced server-side at eligibility; publishers can additionally block specific advertisers / categories on the placement record.

---

## 14. Open Questions / TBD

These are deliberately deferred from v1. Notes here so we don't lose track.

1. **Multi-creative campaigns.** Today one campaign returns one creative. Do we allow campaigns with N creatives and let Benna A/B at bid time? Probable yes in v1.1.
2. **Intent-token taxonomy.** Today the SDK passes free-form strings. Should we maintain a curated taxonomy advertisers bid against (like Google's keyword categories), or stay free-form with embedding match? Leaning free-form + curated suggestions.
3. **External bidder onboarding.** OpenRTB-style for `google_admob`-class networks vs. native shape for MCP-native networks. Probably both; the bidder interface accommodates either.
4. **Server-to-server (S2S) conversion postbacks.** Defined above but the advertiser-side helper code (a Stripe / Segment / PostHog-style adapter) is not yet drafted.
5. **Reporting cardinality.** How fine-grained do publisher dashboards report? Per-placement-per-day is the floor; per-placement-per-intent_token is interesting but cardinality-heavy.
6. **Currency.** USD only on day one. Multi-currency handled in v1.2.

---

## 15. Reference: full happy-path round-trip

For a single high-intent impression (developer in Cursor, building a billing flow, Stripe MCP connected):

```
1. SDK → BBX
   POST /v1/ad_request
   { intent_tokens: ["billing_integration", "saas", "stripe"],
     active_tools:  ["stripe-mcp", "quickbooks-mcp"],
     placement: "plc_chat_inline_default",
     floor_cpm_micros: 1500000 }

2. BBX → benna_superboost
   POST /v1/bidders/benna_superboost/bid
   { ...same context, no publisher_id... }

3. benna_superboost → BBX
   { bid: { campaign_id: "cmp_stripe_q2_billing",
            price_cpm_micros: 18400000,
            render: { ... } } }

4. BBX → SDK
   { served: true,
     ad: { headline, body, cta },
     tracking: { impression_url, click_url, dismiss_url },
     auction: { winning_price_cpm_micros: 18400000 } }

5. SDK renders. User sees the unit. SDK fires impression_url.
6. User clicks. SDK fires click_url, navigates the user.
7. User signs up at Stripe. Stripe's BBX pixel fires conversion.
8. BBX settles: charges advertiser $18.40/1000, credits publisher
   $15.64/1000 (after 15% BBX take rate, per `BBX_TAKE_RATE` env var
   in `api/track.js`), feeds outcome to Benna.
```

That's the whole protocol.

---

## Appendix A. Schemas as TypeScript types

For implementers. Source of truth is the JSON above; this is a convenience.

```typescript
type AdRequest = {
  v: 1;
  request_id: string;          // ULID
  ts: string;                  // ISO-8601
  publisher: { publisher_id: string; app_id: string; sdk_version: string };
  placement: {
    placement_id: string;
    format: "card_inline" | "tool_result_sponsored" | "sidebar_unit" | "interstitial" | "banner";
    surface: "chat" | "tool_response" | "sidebar" | "loading_screen" | "status_line";
    host: string;
    size?: { max_chars?: number; max_lines?: number; max_px?: number };
  };
  context: {
    intent_tokens: string[];
    active_tools: string[];
    session?: { session_id: string; turn?: number; duration_ms?: number };
    host_metadata?: Record<string, string>;
  };
  user: {
    anonymous_id: string;
    geo: { country: string; region?: string };
    device?: { type: "desktop" | "mobile" | "web" | "cli"; os?: string };
    lang?: string;
  };
  safety?: { categories_excluded?: string[]; max_iab_rating?: string };
  auction: { tmax_ms: number; currency: "USD"; floor_cpm_micros: number };
};

type AdResponse =
  | {
      v: 1;
      request_id: string;
      auction_id: string;
      served: true;
      ad: {
        creative_id: string;
        campaign_id: string;
        advertiser_name: string;
        format: AdRequest["placement"]["format"];
        render: {
          headline?: string;
          body?: string;
          cta?: { text: string; url: string };
          image_url?: string | null;
          label: "Sponsored";
        };
      };
      tracking: { impression_url: string; click_url: string; dismiss_url: string };
      auction: { winning_price_cpm_micros: number; currency: "USD"; expires_at: string };
    }
  | {
      v: 1;
      request_id: string;
      served: false;
      no_fill_reason:
        | "below_floor" | "no_eligible_bidder" | "tmax_exceeded"
        | "budget_exhausted" | "frequency_capped" | "safety_blocked"
        | "internal_error";
    };

type EventPayload = {
  v: 1;
  auction_id: string;
  type: "impression" | "click" | "conversion" | "dismiss" | "error";
  ts: string;
  sig: string;
  metadata?: Record<string, unknown>;
};
```

---

## 16. Reality map — spec → repo

| Section | Spec concept | What ships today | File |
|---|---|---|---|
| §4 | `POST /v1/ad_request` | `POST /api/mcp` (JSON-RPC, `tools/call get_sponsored_content`) | `api/mcp.js` |
| §4 | OpenRTB-shaped supply | `POST /api/rtb` (OpenRTB 2.6 BidRequest) | `api/rtb.js` |
| §6 | `POST /v1/events` | `GET /api/track` (pixel) and `POST /api/track` | `api/track.js` |
| §7 | Internal bidder API | In-process inside `benna.js` (no HTTP today) | `api/benna.js` |
| §8 | Auction mechanics | First-price + reserve, atomic budget via `bbx_deduct_campaign_budget` RPC | `api/_lib/ledger.js` |
| §9 | Benna scoring | `bid_usd = target_cpa × p_convert × (1 + ε)`, signal weights hardcoded | `api/benna.js` |
| §10 | Latency budget | Edge runtime not yet enabled; Vercel Node functions today | (planned) |
| §13 | Take rate | 15% via `BBX_TAKE_RATE` env var (default `0.15`) | `api/track.js:16` |

The schema migration `db/04_bbx_mcp_extensions.sql` adds the MCP-native targeting columns (`target_intent_tokens`, `target_active_tools`, `target_host_apps`, `target_surfaces`), the `placements` registry, and the auction-keyed columns on `events`. After it's applied, the wire shapes in §4–§7 are fully expressible against the existing tables — no further schema work is needed before §16 is ticked.

---

*End of v1 draft. Comments inline as PR discussion.*

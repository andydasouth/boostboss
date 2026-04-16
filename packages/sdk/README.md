# @boostbossai/lumi-sdk

The Lumi SDK — monetize your AI app with **context-aware, native sponsored content** ranked in real time by [Benna](https://benna.ai).

```bash
npm install @boostbossai/lumi-sdk
```

## Three lines to ship

```js
const bb = require("@boostbossai/lumi-sdk");
const ad = await bb.getSponsoredContent({ context: "user is debugging a python traceback", host: "cursor.com" });
if (ad.sponsored) render(ad.sponsored);
```

That's it. You get a Benna-ranked recommendation shaped for your MCP surface, plus a full attribution object (`p_click`, `p_convert`, signal contributions) you can log for observability.

## Why publishers use it

Web and mobile ad stacks were built for pages and apps — not tool calls. Lumi SDK is built on [MCP](https://modelcontextprotocol.io/) from day one, so every bid is ranked against the signals that actually matter in AI surfaces: user intent, tool about to be called, host app, session length. The result is an ad that feels native to Cursor, Claude, Raycast, or Perplexity instead of a banner glued on top.

Publishers take **85% of cleared revenue**. Boost Boss keeps 15% as the exchange take rate.

## Three ways to integrate

### 1. Direct API call — any runtime

Use this when you want full control over when and where an ad appears.

```js
const { BoostBoss } = require("@boostbossai/lumi-sdk");

const bb = new BoostBoss({
  apiKey: process.env.BB_API_KEY,
  region: "us-west",
  onEvent: (name, payload) => console.log("[bb]", name, payload),
});

const { sponsored, benna } = await bb.getSponsoredContent({
  context: userContext.summary,
  host: "cursor.com",
  format: "native",
  sessionLenMin: 45,
});

// Benna attribution — use for logging or reporting
// benna = { model_version, bid_usd, p_click, p_convert, signal_contributions, ... }

if (sponsored) {
  showToUser(sponsored);
  bb.trackEvent("impression", sponsored.campaign_id);
}
```

### 2. Browser renderer — drop-in UI

Ship a polished unit with one call — no CSS, no markup.

```js
import { getSponsoredContent } from "@boostbossai/lumi-sdk";
import { renderAd } from "@boostbossai/lumi-sdk/renderer";

const ad = await getSponsoredContent({ context: "fastapi + sqlalchemy tutorial" });
renderAd(ad, { format: "corner" });     // bottom-right popover
renderAd(ad, { format: "banner", mount: "#ad-slot" });  // inline banner
renderAd(ad, { format: "video" });       // muted autoplay with skip
```

The renderer injects scoped styles once, wires up the impression/click/close beacons, and gracefully no-ops when `sponsored` is null.

### 3. MCP middleware — zero plumbing

Wrap your existing MCP server and the `get_sponsored_content` tool shows up automatically in `tools/list`. The host app can now call it the same way it calls your tools.

```js
const { withBoostBoss } = require("@boostbossai/lumi-sdk/mcp");

const server = withBoostBoss(myMcpServer, {
  apiKey: process.env.BB_API_KEY,
  gate: (req) => req.params?.arguments?.user_tier !== "enterprise",
});
```

See [`examples/mcp-server.js`](./examples/mcp-server.js) for a complete drop-in.

## Response shape

```ts
{
  sponsored: {
    campaign_id: "cam_…",
    type: "image" | "video" | "native",
    headline: "Ship a FastAPI app in 90 seconds",
    subtext: "Deploy with one command. Free tier included.",
    media_url: "https://cdn.boostboss.ai/…",
    cta_label: "Try the free tier",
    cta_url: "https://…",
    tracking: { impression, click, close, video_complete },
  } | null,
  benna: {
    model_version: "benna-rc3-2026.04.14",
    bid_usd: 8.42,
    effective_bid_usd: 9.68,
    p_click: 0.031,
    p_convert: 0.006,
    signal_contributions: { "intent=debug_py": 0.34, "host=cursor.com": 0.18, … },
    latency_ms: 4.2,
    candidates_considered: 17,
  }
}
```

## Configuration

Every option is optional. Sensible defaults work for a read-only demo without any key.

| Option        | Default                         | Notes                                               |
|---------------|---------------------------------|-----------------------------------------------------|
| `apiKey`      | `process.env.BB_API_KEY`        | Required for live revenue attribution                |
| `endpoint`    | `https://boostboss.ai/api/mcp`  | Override for staging or proxies                      |
| `region`      | `"global"`                      | `us`, `eu`, `apac`, `latam`, or `global`             |
| `language`    | `"en"`                          | `en`, `zh`, `es`, `ja`, `ko`                          |
| `timeoutMs`   | `3000`                          | SDK hard-caps latency, never blocks your UI          |
| `sessionId`   | generated                       | Pass a stable ID to frequency-cap a user             |
| `onEvent`     | —                               | Lifecycle hook — useful for telemetry                |

## Graceful degradation

The SDK **never throws on a bad network**. A failed fetch returns `{ sponsored: null, reason: "fetch_failed" }` so your host app keeps working. That's intentional — the ad surface is the last thing that should ever break a developer tool.

## Compliance

Boost Boss publishes an IAB-compliant [`sellers.json`](https://boostboss.ai/sellers.json). Publishers running the SDK should mirror our [`ads.txt`](https://boostboss.ai/ads.txt) template at the root of their domain to declare Boost Boss as an authorized seller.

## Links

- Docs: <https://boostboss.ai/docs>
- Status: <https://status.boostboss.ai>
- Benna ranking engine: <https://benna.ai>
- `sellers@boostboss.ai` · `sdk@boostboss.ai`

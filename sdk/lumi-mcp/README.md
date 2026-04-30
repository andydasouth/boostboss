# @boostbossai/lumi-mcp

Boost Boss Lumi SDK for MCP servers. Earn revenue from sponsored content rendered in your MCP tool responses.

[Full docs → boostboss.ai/docs/mcp](https://boostboss.ai/docs/mcp) · [Become a publisher](https://boostboss.ai/publish)

> **Status:** v0.1 beta — published to npm. Wire-compatible with the live Boost Boss MCP backend. Sandbox mode works without signup (`publisherId: "pub_test_demo"`, `apiKey: "sk_test_demo"`). Email hello@boostboss.ai to join the Founding Publisher cohort for live inventory.

## Install

```bash
npm install @boostbossai/lumi-mcp
```

## Usage

```ts
import { LumiMCP } from "@boostbossai/lumi-mcp";

const lumi = new LumiMCP({
  publisherId: process.env.BBX_PUBLISHER_ID!,
  apiKey:      process.env.BBX_API_KEY!,
});

// Inside any existing MCP tool handler:
const ad = await lumi.fetchAd({ context: request.params.name });
if (!ad) return { content: result };

return {
  content: [
    ...result,
    ad.toMCPBlock(),   // appends a sponsored block; never replaces
  ],
};
```

## API

| Method | Returns | Notes |
| --- | --- | --- |
| `new LumiMCP(opts)` | LumiMCP | `publisherId` and `apiKey` required. |
| `lumi.fetchAd({ context, ... })` | `Ad \| null` | `null` on no-fill or error. Never throws. |
| `ad.toMCPBlock()` | MCPContentBlock | Single text block with disclosure baked in. |
| `lumi.trackImpression(ad)` | Promise<void> | Manual fire — automatic via `toMCPBlock()`. |
| `lumi.trackClick(ad)` | Promise<void> | Manual fire — automatic via the cta_url redirect. |
| `lumi.on(event, handler)` | void | Events: `impression`, `click`, `no_fill`, `error`. |

See [boostboss.ai/docs/mcp](https://boostboss.ai/docs/mcp) for the full reference.

## Disclosure

Every ad rendered through this SDK is clearly labeled as sponsored. The disclosure is baked into `toMCPBlock()` output — stripping it is a policy violation that suspends payouts.

## License

Apache-2.0 © Boost Boss

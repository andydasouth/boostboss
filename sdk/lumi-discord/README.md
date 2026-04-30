# @boostbossai/lumi-discord

Helper for Discord bots using the Boost Boss REST API. Converts the response from `POST /v1/ad-request` into Discord-native embed and component objects.

[Full docs → boostboss.ai/docs/rest-api](https://boostboss.ai/docs/rest-api)

## Install

```bash
npm install @boostbossai/lumi-discord
```

## Usage

```ts
import { toDiscordEmbed, toDiscordComponents } from "@boostbossai/lumi-discord";

// Inside your bot's response handler:
const r = await fetch("https://boostboss.ai/v1/ad-request", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.BBX_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    context: userQuery,
    format: "embed",
    platform: "discord",
  }),
});
const { ad } = await r.json();

if (ad) {
  await message.reply({
    content: aiResponse,
    embeds:     [toDiscordEmbed(ad)],
    components: [toDiscordComponents(ad)],
  });
  // Fire impression beacon (fire-and-forget)
  fetch(ad.impression_url).catch(() => {});
}
```

## API

| Function | Returns | Notes |
| --- | --- | --- |
| `toDiscordEmbed(ad)` | discord.js `APIEmbed` | Disclosure goes in footer; truncates headline to 256 chars. |
| `toDiscordComponents(ad)` | ActionRow with link button | Button label truncated to 80 chars per Discord limits. |

## License

Apache-2.0 © Boost Boss

# @boostbossai/lumi-telegram

Helper for Telegram bots using the Boost Boss REST API. Converts the response from `POST /v1/ad-request` into Telegram-native message and inline-keyboard objects.

[Full docs → boostboss.ai/docs/rest-api](https://boostboss.ai/docs/rest-api)

## Install

```bash
npm install @boostbossai/lumi-telegram
```

## Usage (with grammy)

```ts
import { toTelegramMessage } from "@boostbossai/lumi-telegram";

bot.on("message", async (ctx) => {
  const aiResponse = await yourAI(ctx.message.text);

  const r = await fetch("https://boostboss.ai/v1/ad-request", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.BBX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ context: ctx.message.text, format: "embed", platform: "telegram" }),
  });
  const { ad } = await r.json();

  await ctx.reply(aiResponse);
  if (ad) {
    const m = toTelegramMessage(ad);
    await ctx.reply(m.text, m.options);
    fetch(ad.impression_url).catch(() => {});
  }
});
```

## API

| Function | Returns | Notes |
| --- | --- | --- |
| `toTelegramMessage(ad)` | `{ text, options }` | Disclosure italicized, headline bolded, CTA as inline-keyboard button. HTML parse mode. |
| `toTelegramInlineKeyboard(ad)` | `InlineKeyboardMarkup` | Standalone keyboard for attaching to existing messages. |

## License

Apache-2.0 © Boost Boss

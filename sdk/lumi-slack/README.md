# @boostbossai/lumi-slack

Helper for Slack bots using the Boost Boss REST API. Converts the response from `POST /v1/ad-request` into Slack Block Kit blocks (or legacy attachments).

[Full docs → boostboss.ai/docs/rest-api](https://boostboss.ai/docs/rest-api)

## Install

```bash
npm install @boostbossai/lumi-slack
```

## Usage

```ts
import { toSlackBlocks } from "@boostbossai/lumi-slack";
import { WebClient } from "@slack/web-api";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

async function reply(channel, userQuery) {
  const aiResponse = await yourAI(userQuery);

  const r = await fetch("https://boostboss.ai/v1/ad-request", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.BBX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ context: userQuery, format: "embed", platform: "slack" }),
  });
  const { ad } = await r.json();

  await slack.chat.postMessage({ channel, text: aiResponse });
  if (ad) {
    await slack.chat.postMessage({
      channel,
      text:   ad.headline,        // notification fallback
      blocks: toSlackBlocks(ad),
    });
    fetch(ad.impression_url).catch(() => {});
  }
}
```

## API

| Function | Returns | Notes |
| --- | --- | --- |
| `toSlackBlocks(ad)` | `SlackBlock[]` | Context (disclosure) + section (headline + body, image as accessory) + actions (CTA as primary button). |
| `toSlackAttachment(ad)` | legacy attachment | For incoming-webhook / older integrations. Modern apps should prefer `toSlackBlocks`. |

## License

Apache-2.0 © Boost Boss

# Boost Boss Strategy — The Free Launch Network

_Status: agreed direction 2026-07-03 (Andy + Elon). Supersedes the two-sided
"recruit publishers, then advertisers" launch model. No code until Andy
green-lights the build sequence. Owners: Benna (product), Peter (eng)._

## Thesis (one line)

**Stop selling ads. Give AI product developers free distribution, where every
dev is simultaneously the promoter and the inventory, metered by earned
credits — and let the credit economy quietly become the business.**

## Why we're pivoting

The classic ad-network model is a two-sided cold start: recruit supply
(publishers) and demand (advertisers) and pray they arrive together. We have
neither a big checkbook nor a captive audience, so it was structurally doomed.
Field learning confirmed it: **AI devs will not pay upfront for "maybe"
traffic.** The failure is the *model*, not the marketing. AppLovin/Product-Hunt
framings target traditional app devs who feel launch urgency and will pay — our
audience is different.

## The model

Boost Boss is a **free, intent-matched launch network for AI products.** Think
"Product Hunt that never ends — but free, reciprocal, and relevant." Every AI
dev who joins to promote themselves *also* becomes a surface that serves ads.
The network therefore has value at **user #1** — no chicken-and-egg.

## The core loop (one account, one product)

1. Dev lands on "**Launch your AI product where AI users already are. Free.**"
2. Signs up once; writes their launch (name, pitch, link, creative) — a
   Product-Hunt-style post that is also their ad campaign.
3. Installs the Lumi SDK on their surface (per door). They are now inventory.
4. Merged, X-style dashboard: **Promote** (your campaign) + **Earn** (credits
   from what you serve). No "advertiser vs publisher" choice is ever shown.

## The credit economy (the load-bearing mechanic)

- **1 impression you serve = 1 credit earned. 1 impression of your ad shown =
  1 credit spent.** ("Show one, get one shown.")
- **Generous starter grant on signup** (~1,000 credits) — solves the cold start
  *and* the pre-launch dev with zero traffic. Platform-minted. This is the
  single biggest growth lever; be generous.
- **Two currencies, one-way convertible.** *Credits* (earned; power the free
  loop). *Cash* (bought, or paid out). **Cash → credits allowed; credits → cash
  never.** That one-way valve kills arbitrage and any fraud-to-money pipeline.
- **Promotions that exceed live inventory queue**, paced by intent match. The
  network never breaks — it fills as fast as real impressions allow.
- **No reserve tax / splits at launch.** Keep it 1:1 + starter grants. Network
  size beats monetization now; tighten only if inflation/abuse appears.

## Free vs. paid (where the money is)

- **Free forever:** reciprocal, fair-share reach — earn by serving, spend to
  promote. Basic analytics.
- **Paid:** buy credits with cash to *amplify beyond earned share* + priority
  placement + premium formats + guaranteed impressions + cash-out on verified
  surfaces. **External advertisers are just buyers of credits — same pool, no
  separate system.** So the free network *manufactures the inventory we later
  sell.* Free users are the unpaid supply engine.

## The one non-negotiable rule

**Credits are earned ONLY on verified, real, human, intent-matched impressions.**
No credits from sandbox, self-traffic, or bots. This is what stops the network
becoming a 2010 traffic-exchange hall of mirrors — and it makes the resulting
traffic real enough to sell for cash later. Enforced by the intent layer +
verify badges + recon that already exist. In this framing, this rule *is* the
moat.

## Positioning / front door

- Headline: **"Launch your AI product where AI users already are. Free."**
- Hook (reciprocity): "Show a few relevant ads in your app; we show your product
  across the whole network of AI apps. Free. Powered by intent, not spam."
- Flips the pitch from "buy ads" (money → resistance) to "join a free launch
  network" (no money, mutual benefit). Built-in viral loop: every promoter wants
  more surfaces to promote on, so they recruit.

## Build sequence (phased — validate the flywheel before over-building)

- **Phase 0 — Repackage (not rebuild).** Merge the two dashboards into one
  "Promote + Earn" account. Swap the money gate for a **credit gate**. Reframe
  the landing to "launch free." (Reuses: unified account model, promote-loop
  credits, both-side SDKs, intent auction, MoR/payouts.)
- **Phase 1 — Seed & validate.** You + Fissbot + ~10 AI devs, generous starter
  grants. Watch three numbers: (a) do impressions actually flow, (b) is
  intent-match relevant, (c) do promotions get filled?
- **Phase 2 — Growth loop.** Referral bonus: invite a dev → both get credits.
- **Phase 3 — Monetize.** Only after real traffic exists: turn on cash
  credit-purchase + premium earner tier + external advertisers buying into the
  pool. Do not build the paid layer until the free flywheel spins.

## Open decisions (numbers to set)

1. Starter-grant size + whether it's time-boxed ("launch week") or permanent.
2. Credit earn rate (start 1:1; revisit only on inflation/abuse).
3. Cash→credit price (sets the effective CPM external advertisers pay).
4. Verify/fraud threshold before an impression earns a credit.

## The risk to watch

Early traffic will be **dev-to-dev** (AI devs seeing each other's launches), not
end-consumers. That's fine for the dev-tools category and for bootstrapping — but
be honest in copy: sell "**get discovered by the people building the AI
ecosystem**" (true day one), not "reach real consumers" (only true once consumer
apps join and bring their end-users).

## What does NOT change

The SDKs, the auction, the intent layer, the dashboards. This is a **repackage**:
merge dashboards, swap money-gate → credit-gate, flip the front door. The infra
already supports it.

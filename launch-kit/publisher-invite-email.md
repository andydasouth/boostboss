# First Publisher Invite — Draft Templates

Pick ONE of these depending on your relationship with the recipient. All three are tested structures: short, respectful of time, concrete value, easy yes/no.

---

## Template 1 — Short personal DM (for friends, acquaintances, Twitter mutuals)

Best for: someone you know who runs an AI product you've personally used.

> Hey [name],
>
> I built an ad network for AI products — your users see context-relevant sponsored content inside Claude/GPT responses, you earn 85% of the spend. Like AdSense but for AI chat, MCP servers, and agents.
>
> I've been running it in production on my own product (fissbot.chat) and it's working clean: impressions, attribution, revenue, all live. No latency hit to chat responses.
>
> Would you want to be my 2nd publisher? Would take ~10 minutes to install the SDK; I'd personally walk you through it on a call if easier.
>
> npm install @boostbossai/lumi-sdk · docs at https://boostboss.ai/developer
>
> — Andy

Send on Twitter DM, iMessage, WhatsApp, or Slack.

---

## Template 2 — Warm email (for founders you've exchanged emails with)

Subject: `Ad network for [their product]? 10 min install, 85% rev share`

> Hi [name],
>
> Saw [their product] is generating real AI-response volume. Wanted to show you Boost Boss — an ad network built specifically for AI products.
>
> The short version: publishers install our Lumi SDK (one npm package, ~7 lines of code), and their AI responses get context-relevant sponsored content — like AdSense, but native to chat. Publisher keeps 85% of ad spend.
>
> I've been eating my own dogfood — running it on fissbot.chat for the past week. Everything I'd want to see as an operator is working: real impressions, per-message attribution, publisher dashboard, no latency impact (SDK call runs in parallel to Claude/GPT).
>
> I'm personally onboarding my first ~10 publishers (you'd be #2). That means concierged setup: 15-min call where I walk you through install + help you pick ad formats. After that you have a real revenue stream with zero ongoing ops.
>
> Reply "yes" and I'll send a calendar link. Reply "not now" and I'll never bother you again.
>
> Best,
> Andy
>
> ---
> boostboss.ai  ·  npm install @boostbossai/lumi-sdk

---

## Template 3 — Cold outreach (for strangers / cold list)

Subject: `Quick question about monetizing [product name]`

> Hi [name],
>
> I run Boost Boss — an ad network for AI products. Saw [their product] and I think you'd be a strong fit.
>
> Quick specifics:
>
> - Publishers install via `npm install @boostbossai/lumi-sdk` (zero dependencies, Apache-2.0)
> - Sponsored content appears inline with AI responses, context-matched, labeled clearly
> - Publisher earns 85% of ad spend (industry is usually 60–70%)
> - Our own product (fissbot.chat) is running it in production right now
> - I'm personally onboarding the first 10 publishers — 15 min call, free
>
> Would you be open to a quick call or even just a few emails to see if it fits? No pitch-deck, no BS — I'll show you the dashboard, the code, and the numbers.
>
> Andy
> andy@boostboss.ai  ·  https://boostboss.ai

---

## Who to invite first (priority list)

The first 10 publishers define the inventory story. Pick them for LEARNING, not scale. You want people who will:
1. Actually install the SDK (not just say yes)
2. Give honest feedback about rough edges
3. Be small enough that a 1-person ad network can concierge them

**Best categories:**
- Indie AI product builders you follow on Twitter/X (10k–50k users)
- MCP server authors (already in the AI developer ecosystem, they get it immediately)
- AI Chrome extension makers (high volume, monetization-curious)
- Niche chatbots (legal AI, health AI, finance AI) — narrow demand, high-value users
- Coding assistants and agents (your audience overlaps with dev tools that advertise)

**Avoid for first 10:**
- Very large publishers (they'll want SLAs, contracts, security review — not ready)
- Non-English products (your current ad demand is US/EN)
- Products with zero users (you learn nothing from them)

---

## Call script (for the 15-min onboarding call)

When the first publisher says yes, here's how to run the call:

### Minute 0–2: Context
"I built Boost Boss as a solo operator. You're my #2 publisher. The goal of this call is two things: get you live so you start earning, and you tell me every single rough edge so I can fix it before publisher #3."

### Minute 2–8: Shared-screen install
Walk them through:
1. Sign up at boostboss.ai/signup → copy API key
2. `npm install @boostbossai/lumi-sdk` in their project
3. Paste the 7-line integration into their AI response endpoint
4. Add `BB_API_KEY` to their Vercel/Netlify/Render env
5. Redeploy

### Minute 8–11: Dashboard walkthrough
- Show them boostboss.ai/developer
- Point out format toggles + income estimates
- Have them toggle one format (see "$XXX" estimate move)
- Send a test chat → show impression appearing in dashboard within 5 seconds

### Minute 11–14: What breaks / what feels weird
Ask these exact questions:
1. "What's the first thing that felt confusing?"
2. "What's the first thing you'd want to customize that the dashboard doesn't let you?"
3. "Would you refer another AI product builder to this today, honestly?"

Listen. Write down every answer. Don't defend. These answers are the roadmap.

### Minute 14–15: Close
"Give it a week. I'll check in Monday. If anything breaks, email andy@boostboss.ai or text me. If nothing breaks, I'll send a revenue report with your first week's numbers."

Hang up. Fix the top 3 issues they flagged before publisher #3.

---

## Followup email (send 24h before their weekly check-in)

Subject: `Your first week on Boost Boss — [$X.XX earned]`

> Hey [name],
>
> Your [N] chat interactions this week served [X] impressions and earned **$[Y.YY]**. Top format: [native/image/video]. Click-through rate: [Z%].
>
> Few things I shipped this week based on feedback from you and [other publisher]:
> - [Thing 1]
> - [Thing 2]
>
> Anything feel rough? Anything you'd want me to build next?
>
> — Andy

---

## If they say no

Reply:
> No problem at all — appreciate the honest reply. If anything changes (or you see an AI product that might be a fit), shoot me a line. andy@boostboss.ai
>
> Good luck with [their product].

Don't argue. Don't "one more thing." Don't follow up unless they do. Your time is more valuable spent on publishers who said yes.

# External demand & supply integration — the two rails

_Status: architecture note. Written 2026-07-03. Describes how outside ad
platforms would connect to BBX, why there are two separate integration paths,
and what is built vs. dormant vs. "later"._

## TL;DR

There are **two integration rails, for two different partner types**, and they
must not be conflated:

| | **MCP harness** (control plane) | **OpenRTB socket** (data plane) |
|---|---|---|
| Endpoint | `api/mcp-advertiser.js` (`/api/mcp-advertiser`) | `api/rtb.js` (`/api/rtb`) |
| Protocol | MCP / JSON-RPC 2.0 | OpenRTB 2.6 (+ Native 1.2) |
| For whom | A single advertiser or their AI agent | Another ad platform / DSP / mediation stack |
| Volume | Low, conversational, human/agent-in-the-loop | High-QPS, sub-100ms, machine-to-machine |
| Auth | `bb_live_` API key (Bearer) | DSP **seat** credential (`dsp_seats` / `seats.js`) |
| Job | Manage *your own* campaigns/creatives/budget | Bid programmatically across many impressions |

An outside ads distributor **does not** integrate through the MCP harness — the
harness is the wrong abstraction and throughput for a demand firehose. They
integrate through the **OpenRTB socket**, which already exists.

## The OpenRTB socket is already built

`api/rtb.js` is a standards-compliant **OpenRTB 2.6 adapter**:

- `POST /api/rtb` — BidRequest in, BidResponse out. The auction is
  Benna-scored and ranked against first-party campaigns.
- `GET /api/rtb?op=win|loss|status` — win/loss notice callbacks + adapter
  metadata.
- `dsp_seats` table + `api/_lib/seats.js` — scaffolding to register external
  buyer **seats** (the standard way a DSP authenticates into an exchange).

Per its own header, it exists so "outside DSPs (Trade Desk, DV360, custom
mediation stacks) bid into BBX the same way they bid into any OpenRTB
exchange." So the socket is not a from-scratch build — it's built and
**currently dormant by product decision** (BBX serves Boost Boss's own demand
only; see the Performance / BBX-only decision).

## Two directions (don't mix them up)

1. **External _demand_ wants to buy our supply** — another network brings
   advertisers and wants to reach our publisher inventory. They connect as a
   **buy-side seat** and bid via OpenRTB into `/api/rtb`. Effect: more
   competition/fill for our publishers.
2. **External _supply_ wants our demand** — another SSP/publisher plugs their
   inventory in so Boost Boss advertisers fill it. That's a **supply-side**
   integration: the **Lumi SDK** if they're an AI surface, or an OpenRTB
   supply hookup otherwise.

## The strategic caveat (why this stays "later")

An external OpenRTB bidder shows up **without MCP intent context** — it bids on
cookies/blind signals like any commodity exchange. That is exactly what Boost
Boss differentiates *against* ("we see intent, they see cookies"). So when the
socket is opened to external demand, the natural shape is:

- **First-party, intent-rich demand stays primary.**
- **External OpenRTB demand is a backfill / secondary tier** that only wins
  when it out-bids the intent-scored first-party pool.

This preserves the intent-accuracy moat while still monetizing spare inventory.

## What "later" actually involves (not a rebuild)

The plumbing exists; turning it on is mostly operational + policy:

- **Seat onboarding + auth** — issue seat credentials, per-seat rate limits.
- **Tiering** — wire external bids as a backfill tier below first-party.
- **Quality/compliance** — creative review, category/brand-safety filters,
  fraud checks on external demand.
- **Business terms** — take rate on external demand, payment/settlement.
- **A decision to lift the BBX-only gate.**

Until that's the goal, BBX stays first-party-only and the OpenRTB socket
remains available for smoke-tests but closed to production external demand.

## Related

- `api/rtb.js` — the OpenRTB 2.6 adapter (the socket).
- `api/mcp-advertiser.js` — the demand-side MCP harness (the control plane).
- `api/_lib/seats.js`, `dsp_seats` — external buyer seat scaffolding.
- `docs/bbx-protocol.md` — BBX auction/protocol details.

# Boost Boss — Product-Change Handoff (Elon/CEO session, 2026-07-04)

Continuation brief. Everything below happened in one session that began as a strategy
conversation with "Elon the CEO" and turned into a full console redesign. A new chat can
resume from here.

---

## 1. The strategy (why we changed the product)

**Position:** Boost Boss is the **user-acquisition network for AI products** — "AppLovin for AI,
not AdSense for AI." Demand-first ("get users for your AI product"), not supply-first
("monetize your app"). See `docs/strategy-user-acquisition-network.md` (+ `strategy-free-launch-network.md`).

Key pillars (from a cited competitive teardown this session):
- Every funded rival (Koah, Imprezia, Elo, AgentVine, Nexad, ProRata, ZeroClick) is a **supply-side monetization pipe**. The **demand-first + closed-credit-loop** quadrant is empty. **Koah** (~$26M) is the real threat — one reframe away.
- **The moat = the *enforced* loop** (AppLovin's real secret): to promote for FREE you must HOST (install the SDK); cash is the only way to promote without hosting. **Currently messaging only — NOT enforced in the backend yet.**
- **Long-tail wedge:** aggregate the thousands of tiny AI apps Koah won't court.
- Funny-money phase is intentional bootstrap; first real cash advertiser is the milestone.

---

## 2. The console redesign (what we built)

Unified dashboard lives at **`/console`** (canonical URL; `/ads/dashboard`, `/publish/dashboard`
redirect to it). One file: **`public/advertiser.html`**. Topbar: "Boost Boss Developer Console".

**The product model (Andy's framing):** no advertiser side, no campaign builder. The dev does
**two actions** — *upload creatives* + *install the SDK* — then **reads data**. Everything else is
data tabs. Light/clean modern dashboard, dark theme, X-style data.

### Final nav IA
- **Grow:** Overview · My Ads · Credits
- **Earn:** Install SDK · Earnings · Payouts
- **Developer:** Developer
- **Account**
- Hidden-but-in-DOM (routes kept, `display:none`): My Product (`products`), Reach (`pilot`), Campaigns, Placements, Usage (`billing`).

### Tab → route → meaning
| Tab | route (data-shell-section) | What it is |
|---|---|---|
| Overview | `home` | "Your growth" account overview: causation strip (Credits earned→spent→balance) + loop CTAs + stat cards |
| My Ads | `creatives` | Upload ad assets (brand kit/headlines/body/image/video). Has the **"Placement coverage"** widget = the 3–5→37 unlock UI |
| Credits | `boosts` | The currency ledger (earned/spent/balance) |
| Install SDK | `integrations` | 4-door install (Computer/Browser/Extension/Mobile) |
| Earnings | `performance` | X-style contribution→earning grid, **Credits earned** leads; delta chips; inventory-fill |
| Payouts | `payouts` | PayPal payout info (simplified — MoR→ad-credit convert cards hidden) |
| Developer | `api` | API keys / MCP harness / webhooks |

### What changed this session (chronological)
- Merged advertiser + publisher dashboards into the one file; rebranded to "Boost Boss"; `/console` canonical.
- Nav reframed → minimal growth-console; then regrouped into **Grow / Earn** by relevancy.
- **Removed advertiser machinery from nav:** My Product (affiliate) + Reach (campaign builder) hidden.
- **Removed Benna from the UI** — the "Benna Engine" cockpit on Home is `display:none` (kept in DOM so its loader never null-refs); "Benna optimization" section removed from Earnings; "Powered by Benna" stripped; visible Benna copy reworded. Engine still runs silently in the backend.
- **Rebranded currency Boosts → Credits** in ALL visible copy. **Internal names unchanged** (route `boosts`, `?action=boosts`, `api/_lib/boost_credits.js`, element IDs like `home-boosts-earned`/`perfBoostsEarned`) so nothing breaks.
- Renamed tabs: Home→Overview, Creatives→My Ads, Boosts→Credits, Install→Install SDK, Analytics→Earnings, Money→Payouts.
- Payouts simplified (hid the "convert to ad credit / create campaign" cards).
- **Theme fixes:** brightened sidebar category labels (`#A7ABB8`); fixed the global auto-darken rule in `dashboard-polish.css` from `#1B1D22` → `#13131E` so Payouts + My Ads cards match every other tab (standard card = `rgb(19,19,30)` = `#13131E`).

---

## 3. Deployed vs pending
- Almost everything is deployed (git push origin HEAD:main; verified live via screenshots).
- **PENDING (last change, deploy block already handed to Andy):** `public/dashboard-polish.css` card-color fix (`#1B1D22`→`#13131E`). Confirm it's pushed; then verify Payouts/My Ads cards compute `rgb(19,19,30)`.

---

## 4. Open threads / next steps (not yet done)
1. **Home "account overview" redesign** — Andy wants Home laid out like the X analytics screenshot: date range up top + the two-sided story (how your ads do on *others'* surfaces = earnings; how far *your* product reached). Discussed, not built.
2. **Loop enforcement in the backend** — "install SDK to unlock 37 / 3–5 free" is copy only. The gate that makes free distribution *require* hosting is the actual moat and doesn't exist yet.
3. **Signup hook + landing** (the "outward" phase) — PH-simple "list your product" signup → 3–5 free placements; landing reframe to "List your AI product. Get users. Free." Front door (`boostboss.ai`) still sells the old two-sided model.
4. **Reach / My Product page headers** still say "Boost Ads" / "Affiliate" (hidden pages, low priority).
5. **Publisher-only account** on `/console` not smoke-tested (bridge added in `checkSession`).

---

## 5. Working constraints (important)
- **THE GATE:** never `git push`/deploy autonomously. Hand Andy a `git add/commit/push origin HEAD:main` block; wait for "pushed"; then screenshot-verify.
- **`advertiser.html` is fragile** (blank-page history). Before every deploy: run the inline-`<script>` parse check (baseline = exactly **1** pre-existing failure — "Unexpected identifier 'the'"). Follow Route-3 rule (VALID_ROUTES + section + CSS allowlist) for new routes. **Hide, don't delete** (display:none) when retiring nav items so JS wiring / IDs survive.
- **Verify pattern:** Chrome MCP → navigate to `/console#/<route>` → `cmd+shift+r` hard reload → screenshot. Use `javascript_tool` for computed-style checks.
- **Style:** aggressive simplification; light/clean; X-style data; minimal action, mostly data.
- Currency is "Credits" to users; "Boost(s)" only survives in internal code/routes/IDs and the "Boost Boss" brand name.

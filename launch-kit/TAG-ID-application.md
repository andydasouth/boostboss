# TAG-ID Application — Boost Boss

**What it is:** A TAG-ID (Trustworthy Accountability Group identifier) is a free industry credential that identifies your ad network as a verified, non-fraudulent seller. It's referenced in your `sellers.json` (Boost Boss already has a placeholder) and in programmatic bid requests so DSPs like Trade Desk, DV360, and Amazon DSP will spend money on your inventory. Without it, major demand won't connect.

**Where:** https://www.tagtoday.net/registrycompany  
**Cost:** Free  
**Lead time:** 1–2 weeks for approval

---

## Before you start

You'll need:
- A business entity (LLC, Corp, or sole proprietor) — you need a legal name and address
- A business email (andy@boostboss.ai would be ideal; a @gmail.com works but looks less professional)
- Your DUNS number (see DUNS-application.md — apply in parallel, takes similar time)

---

## Step-by-step

### 1. Go to https://www.tagtoday.net/registrycompany

Click **"Apply for TAG Registration"** or the "Register Your Company" button.

### 2. Pick the right category

You're applying as a **Direct Seller** (also called "Seller" or "SSP / Ad Tech Platform"). Not a publisher, not a DSP.

In the application form, your role is:
- Primary: **Ad Network / SSP (Supply-Side Platform)**
- Secondary: **Ad Exchange** (because BBX is an RTB exchange)

### 3. Business details to provide

| Field | Your answer |
|---|---|
| Company Legal Name | _Your LLC or Corp name_ — e.g., "Boost Boss AI Inc." or "Andy Da LLC" |
| DBA | Boost Boss |
| Business Type | LLC / Corp / Sole Proprietor |
| Formed In | State/country where registered |
| Primary Domain | boostboss.ai |
| Business Address | _Your business address_ |
| Business Phone | _Your number_ |
| Employee Count | 1 (yourself) |
| Annual Revenue | Under $1M (pre-revenue is fine) |
| Years in Business | < 1 year |

### 4. Role-specific questions (Ad Network)

You'll be asked questions about your platform. Here's a tested draft:

**What does your platform do?**
> Boost Boss operates an AI-native ad network that serves sponsored content inside AI applications and MCP (Model Context Protocol) servers. Publishers (AI product developers) install our Lumi SDK via npm, which injects context-relevant sponsored content into AI responses. Advertisers create campaigns via our self-serve dashboard; campaigns go through creative policy review before serving. Revenue flows from advertiser → Boost Boss → publisher at an 85/15 split.

**What's your inventory?**
> Native, image, corner, video, and fullscreen ad units served inside AI chat interfaces, MCP tool responses, and AI-powered applications. All placements are contextual (matched to user's current AI task) and rendered with clear "Sponsored · via Boost Boss" labeling.

**How do you prevent fraud?**
> 1. Creative policy review (automated check for blocked IAB categories, blocklisted advertiser domains, HTTPS-only CTA URLs, length limits)
> 2. Rate-limited impression tracking (per-session deduplication)
> 3. First-price auction with server-side budget deduction (no client-side manipulation possible)
> 4. Publisher API keys scoped per account; events require api_key → UUID resolution
> 5. All impression/click events persisted to append-only events table for audit
> 6. Benna (our ranking layer) tracks click-through-rate patterns to flag anomalous traffic

**How are advertisers vetted?**
> Self-serve signup with creative policy review on each campaign. First campaign from new advertisers is auto-approved if creative passes policy; subsequent campaigns go through manual review. Advertiser domain recorded on every campaign for brand-safety checks.

**How are publishers vetted?**
> Self-serve signup with publisher domain recorded per account. Publishers must configure which ad formats they accept via dashboard; impressions are attributed to a specific publisher UUID on every event. Payout gated on Stripe Connect onboarding (KYC via Stripe).

### 5. Certifications to request

Check **all** of:
- Certified Against Fraud (CAF) — required for most programmatic demand
- Certified Against Malware (if offered)
- Brand Safety Certified (if offered)

Each adds ~1–2 weeks to approval but dramatically improves demand quality.

### 6. Upload these documents

- Privacy policy (https://boostboss.ai/privacy — create one if not live; tell me if you want a template)
- Terms of service (https://boostboss.ai/terms — same)
- A screenshot of your ads.txt file (https://boostboss.ai/ads.txt already exists, good)
- Your sellers.json (https://boostboss.ai/sellers.json already exists — you'll update the TAG-ID in it once approved)

### 7. Submit and wait

You'll get an email confirming receipt. Approval emails usually land in 7–14 days. Once approved:

1. You get a TAG-ID like `pub-XXXXXXXXXXXXXXXX`
2. Update `public/sellers.json` — replace `"pending-tag-certification-2026"` with your real TAG-ID
3. Redeploy Vercel
4. Email major DSPs (Trade Desk, Amazon) letting them know you're CAF certified — this is how you open the door to their demand

---

## What to say if they ask for proof of scale

You don't need scale to get TAG-ID — it's a gating credential, not a performance one. If they ask about volume:
> We're a launched network with live publishers and advertisers. Our first publisher (Fissbot) is running sponsored content in production; we're onboarding additional publishers during our controlled launch phase.

That's truthful and accurate right now.

---

## Status tracker

- [ ] Form legal entity (if not done)
- [ ] Apply for DUNS (parallel — see DUNS-application.md)
- [ ] Submit TAG-ID application
- [ ] Receive confirmation email from TAG
- [ ] Receive approval (~7–14 days)
- [ ] Get TAG-ID string
- [ ] Update `public/sellers.json`
- [ ] Redeploy
- [ ] Email DSPs to request onboarding

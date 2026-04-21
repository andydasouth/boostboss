# DUNS Number Application — Boost Boss

**What it is:** A DUNS Number (Data Universal Numbering System) is a free 9-digit business identifier from Dun & Bradstreet. Ad-tech platforms like Trade Desk, Google DV360, and the IAB OpenRTB spec require it in bid requests. Without it, premium demand won't connect to you even if you're TAG-certified.

**Where:** https://www.dnb.com/duns-number/get-a-duns.html  
**Cost:** Free (DON'T pay for "expedited" service — it's unnecessary marketing)  
**Lead time:** 5–30 business days (usually ~2 weeks)

---

## Before you start

You'll need:
- A business legal entity (LLC, Corp, or sole proprietor with registered DBA)
- Proof of business: one of (EIN letter, state business registration, business bank account statement, utility bill at business address)
- Business address (same as TAG application — must match)
- Business phone number (answered or voicemail with business name is fine)
- A second way to be contacted (email + phone)

Sole proprietors: you can apply with your own name + address, but strongly recommend registering a DBA ("Doing Business As") with your state first. It looks more credible and prevents your personal address from appearing publicly in business lookups.

---

## Step-by-step

### 1. Go to https://www.dnb.com/duns-number/get-a-duns.html

Click **"Get your free DUNS Number"**.

### 2. Pick "Get a new DUNS Number"

If you've never had one, you want **"I need a new D-U-N-S Number"**. If you accidentally applied before, use "Look up existing" first.

### 3. Ignore the upsells

D&B will try to sell you paid add-ons ($229 "expedited" service, $150 "premium profile", etc.). **Skip all of them.** The free track is the same credential, just slower.

### 4. Fill the form

| Field | Your answer |
|---|---|
| Business Name (Legal) | _Your LLC/Corp exact name_ |
| Trade Name / DBA | Boost Boss |
| Physical Address | _Must be a real address — PO box not accepted_ |
| Phone | _Answered line or business voicemail_ |
| Email | andy@boostboss.ai (or your business email) |
| Website | https://boostboss.ai |
| Year Started | 2026 |
| Business Type | LLC / Corporation / Sole Proprietorship (pick yours) |
| Employees | 1 |
| Annual Revenue | _Actual or $0 if pre-revenue_ |

### 5. Industry classification (SIC/NAICS codes)

Pick these when prompted:

**Primary NAICS:** `541511` — Custom Computer Programming Services  
**Secondary NAICS:** `519130` — Internet Publishing and Broadcasting  
**Tertiary NAICS:** `541810` — Advertising Agencies

(You can only pick one sometimes — go with 519130 if forced to pick one, as it's the closest to "ad network / digital publishing".)

**Primary SIC:** `7372` — Prepackaged Software  
**Secondary SIC:** `7311` — Advertising Services

### 6. Business description (if asked)

> Boost Boss operates an AI-native advertising network. We build supply-side infrastructure that lets AI products (chatbots, AI agents, MCP servers) monetize via context-relevant sponsored content while providing self-serve campaign management to advertisers.

### 7. Verify your business

D&B may ask for ONE of:
- EIN confirmation letter (from IRS)
- State business registration certificate
- Business bank statement (account must be in business name)
- Utility bill at business address (in business name)

Upload whichever you have. If you're a sole proprietor without formal business registration, your personal tax records + a business bank account statement usually works.

### 8. Submit and wait

You'll get a confirmation email with a case number. Track status at:
https://www.dnb.com/duns-number/lookup.html

Approval timeline:
- **5–10 business days:** D&B reviews your documents
- **10–30 business days:** You get an email with your 9-digit DUNS number

### 9. Once you have the number

1. Update `public/sellers.json` — there should be a `duns` field; replace `"pending-duns-application"` with your number
2. Redeploy Vercel
3. Keep the DUNS number handy — you'll paste it into most DSP onboarding forms

---

## FAQ

**"Do I need an LLC?"**
No, but it's strongly recommended. Sole proprietors can get a DUNS, but banks and DSPs trust incorporated businesses more. An LLC costs ~$100 in most US states and takes a day online via LegalZoom, Stripe Atlas (best for software), or your state's Secretary of State website.

**"What if they reject me?"**
Rare for legitimate businesses. The most common rejection is address mismatch (address doesn't match EIN/state records). Fix: make sure your address on D&B matches exactly what's on your state business registration.

**"Can I get expedited approval?"**
Only by paying — which is a waste. Start now so the 2-week clock runs in the background while you focus on product.

---

## Status tracker

- [ ] Form legal entity (recommended if sole proprietor)
- [ ] Gather proof-of-business documents
- [ ] Submit DUNS application at dnb.com
- [ ] Receive case number
- [ ] Upload verification documents (if requested)
- [ ] Receive DUNS number (~14 days)
- [ ] Update `public/sellers.json`
- [ ] Redeploy

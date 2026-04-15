const { createClient } = require("@supabase/supabase-js");

/**
 * Boost Boss — Billing API
 *
 * POST /api/billing?action=create_checkout   → Stripe checkout for advertiser deposit
 * POST /api/billing?action=create_connect    → Stripe Connect onboarding for developer payouts
 * POST /api/billing?action=webhook           → Stripe webhook handler
 * GET  /api/billing?action=balance&id=xxx    → Get advertiser balance
 * GET  /api/billing?action=earnings&key=xxx  → Get developer earnings
 *
 * NOTE: Stripe integration requires STRIPE_SECRET_KEY env var.
 * For MVP, this provides the API structure. Add Stripe keys when ready.
 */
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const action = req.query.action || req.body?.action;
    const stripeKey = process.env.STRIPE_SECRET_KEY;

    // ── Advertiser: Get balance ──
    if (action === "balance" && req.method === "GET") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "Missing advertiser id" });

      const { data, error } = await supabase
        .from("advertisers")
        .select("balance, company_name")
        .eq("id", id)
        .single();

      if (error) return res.status(404).json({ error: "Advertiser not found" });
      return res.json({ balance: data.balance, company_name: data.company_name });
    }

    // ── Developer: Get earnings summary ──
    if (action === "earnings" && req.method === "GET") {
      const { key } = req.query;
      if (!key) return res.status(400).json({ error: "Missing developer api key" });

      const { data: dev } = await supabase
        .from("developers")
        .select("id, total_earnings, app_name, revenue_share_pct")
        .eq("api_key", key)
        .single();

      if (!dev) return res.status(404).json({ error: "Developer not found" });

      // Get pending payout amount
      const { data: pendingEvents } = await supabase
        .from("events")
        .select("developer_payout")
        .eq("developer_id", dev.id)
        .gt("developer_payout", 0);

      const pendingTotal = (pendingEvents || []).reduce((sum, e) => sum + parseFloat(e.developer_payout || 0), 0);

      return res.json({
        app_name: dev.app_name,
        total_earnings: dev.total_earnings,
        pending_payout: pendingTotal.toFixed(2),
        revenue_share_pct: dev.revenue_share_pct,
        payout_threshold: 100.00,
        next_payout_date: getNextPayoutDate(),
      });
    }

    // ── Advertiser: Create Stripe Checkout (deposit funds) ──
    if (action === "create_checkout" && req.method === "POST") {
      if (!stripeKey) {
        return res.json({
          message: "Stripe not configured yet. Add STRIPE_SECRET_KEY to Vercel env vars.",
          demo_mode: true,
          checkout_url: null,
        });
      }

      const stripe = require("stripe")(stripeKey);
      const { advertiser_id, amount, email } = req.body;

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: "Boost Boss Ad Credits",
              description: `$${amount} deposit to your Boost Boss ad account`,
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        }],
        mode: "payment",
        success_url: `https://boostboss.ai/advertiser?deposit=success&amount=${amount}`,
        cancel_url: "https://boostboss.ai/advertiser?deposit=cancelled",
        customer_email: email,
        metadata: { advertiser_id, amount },
      });

      return res.json({ checkout_url: session.url });
    }

    // ── Developer: Stripe Connect Onboarding ──
    if (action === "create_connect" && req.method === "POST") {
      if (!stripeKey) {
        return res.json({
          message: "Stripe not configured yet. Add STRIPE_SECRET_KEY to Vercel env vars.",
          demo_mode: true,
          onboarding_url: null,
        });
      }

      const stripe = require("stripe")(stripeKey);
      const { developer_id, email } = req.body;

      // Create connected account
      const account = await stripe.accounts.create({
        type: "express",
        email,
        capabilities: { transfers: { requested: true } },
        metadata: { developer_id },
      });

      // Create onboarding link
      const link = await stripe.accountLinks.create({
        account: account.id,
        refresh_url: "https://boostboss.ai/developer?stripe=refresh",
        return_url: "https://boostboss.ai/developer?stripe=connected",
        type: "account_onboarding",
      });

      return res.json({ onboarding_url: link.url, stripe_account_id: account.id });
    }

    // ── Stripe Webhook (payment completed) ──
    if (action === "webhook" && req.method === "POST") {
      if (!stripeKey) return res.json({ received: true, demo_mode: true });

      const event = req.body;

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const advertiserId = session.metadata?.advertiser_id;
        const amount = parseFloat(session.metadata?.amount || 0);

        if (advertiserId && amount > 0) {
          // Add to advertiser balance
          const { data: adv } = await supabase
            .from("advertisers")
            .select("balance")
            .eq("id", advertiserId)
            .single();

          if (adv) {
            await supabase
              .from("advertisers")
              .update({ balance: parseFloat(adv.balance) + amount })
              .eq("id", advertiserId);
          }
        }
      }

      return res.json({ received: true });
    }

    return res.status(400).json({ error: "Unknown action" });

  } catch (err) {
    console.error("[Billing Error]", err);
    return res.status(500).json({ error: err.message });
  }
};

function getNextPayoutDate() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return next.toISOString().split("T")[0];
}

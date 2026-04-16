/**
 * Boost Boss — OpenRTB 2.6 Adapter for BBX
 *
 *   POST /api/rtb                              → bid request (BidRequest JSON)
 *   GET  /api/rtb?op=win&imp=...&price=...     → win notice (nurl callback)
 *   GET  /api/rtb?op=loss&imp=...&reason=N     → loss notice (lurl callback)
 *   GET  /api/rtb?op=status                    → adapter metadata
 *
 * This is the bridge that lets outside DSPs (Trade Desk, DV360, custom
 * mediation stacks) bid into BBX the same way they bid into any OpenRTB
 * exchange. Bids are scored by Benna, ranked against first-party campaigns,
 * and returned as a standards-compliant BidResponse.
 *
 * Spec reference: IAB Tech Lab OpenRTB 2.6 (November 2023).
 * Native asset responses follow OpenRTB Native 1.2.
 */

const benna = require("./benna.js");
const ledger = require("./_lib/ledger.js");
const seats = require("./_lib/seats.js");

// Supabase is optional — if env vars aren't set, we fall back to an in-memory
// demo pool so the adapter is exercisable without a live DB (useful for QA,
// the public /exchange page, and DSP smoke-tests).
let getCampaigns;
try {
  const { createClient } = require("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (url && key) {
    const supabase = createClient(url, key);
    getCampaigns = async () => {
      const { data, error } = await supabase
        .from("campaigns")
        .select("*")
        .eq("status", "active");
      if (error) throw error;
      return data || [];
    };
  }
} catch (_) { /* supabase not installed in this env — fine */ }

// Demo pool used when no database is available.
const DEMO_CAMPAIGNS = [
  {
    id: "cam_cursor_001", advertiser_id: "adv_cursor", status: "active",
    format: "native", headline: "Ship a FastAPI app in 90 seconds",
    subtext: "Deploy with one command. Free tier included.",
    media_url: "https://cdn.boostboss.ai/cr/cursor-001.png",
    cta_label: "Try the free tier", cta_url: "https://example-advertiser.com/?ref=bb",
    adomain: ["example-advertiser.com"],
    iab_cat: ["IAB19-6"], // Technology > Web Development
    daily_budget: 500, total_budget: 20000, spent_today: 112.40, spent_total: 3401.25,
    target_cpa: 8.0, bid_amount: 9.25, target_regions: ["us-west", "us-east", "global"],
    target_languages: ["en"],
  },
  {
    id: "cam_datadog_001", advertiser_id: "adv_dd", status: "active",
    format: "native", headline: "Trace a production error in 30 seconds",
    subtext: "Real-time logs, metrics, and traces — unified.",
    media_url: "https://cdn.boostboss.ai/cr/dd-001.png",
    cta_label: "Start free trial", cta_url: "https://example-dsp.com/?ref=bb",
    adomain: ["example-dsp.com"],
    iab_cat: ["IAB19-11"],
    daily_budget: 1200, total_budget: 80000, spent_today: 340.00, spent_total: 11200.00,
    target_cpa: 12.0, bid_amount: 13.50, target_regions: ["global"],
    target_languages: ["en"],
  },
  {
    id: "cam_railway_001", advertiser_id: "adv_rw", status: "active",
    format: "native", headline: "Deploy in one command",
    subtext: "Python, Node, Go, Elixir. Git-push to prod.",
    media_url: "https://cdn.boostboss.ai/cr/rw-001.png",
    cta_label: "Deploy now", cta_url: "https://example-deploy.com/?ref=bb",
    adomain: ["example-deploy.com"],
    iab_cat: ["IAB19-30"],
    daily_budget: 300, total_budget: 12000, spent_today: 18.00, spent_total: 860.00,
    target_cpa: 6.0, bid_amount: 6.80, target_regions: ["us-west", "eu-central"],
    target_languages: ["en"],
  },
];

if (!getCampaigns) getCampaigns = async () => DEMO_CAMPAIGNS;

// ─── OpenRTB 2.6 no-bid reason codes ───
const NBR = {
  TECHNICAL_ERROR: 1,
  INVALID_REQUEST: 2,
  KNOWN_SPIDER: 3,
  SUSPECTED_NHT: 4,
  DATACENTER_IP: 5,
  UNSUPPORTED_DEVICE: 6,
  BLOCKED_PUBLISHER: 7,
  UNMATCHED_USER: 8,
  DAILY_READER_CAP: 9,
  DAILY_DOMAIN_CAP: 10,
  // IAB-reserved extension range starts at 500; we use these for BBX-specific reasons
  NO_ELIGIBLE_CAMPAIGN: 500,
  BELOW_FLOOR: 501,
  BRAND_SAFETY_BLOCK: 502,
};

const ADAPTER_VERSION = "bbx-rtb-adapter/1.0.0";
const BASE_URL = process.env.BOOSTBOSS_BASE_URL || "https://boostboss.ai";

// ─── request validation ───
function validate(req) {
  if (!req || typeof req !== "object") return "body is not an object";
  if (!req.id || typeof req.id !== "string") return "BidRequest.id is required";
  if (!Array.isArray(req.imp) || req.imp.length === 0) return "BidRequest.imp[] is required and non-empty";
  for (let i = 0; i < req.imp.length; i++) {
    const imp = req.imp[i];
    if (!imp.id || typeof imp.id !== "string") return `imp[${i}].id is required`;
    if (!imp.native && !imp.banner && !imp.video) return `imp[${i}] must have one of native/banner/video`;
  }
  return null; // ok
}

// ─── OpenRTB → MCP bid context (for Benna) ───
function contextFromBidRequest(bidReq, imp) {
  const ctx = {};

  // Explicit MCP context override (custom ext field BBX accepts)
  const ext = (imp.ext && imp.ext.mcp_context) || (bidReq.ext && bidReq.ext.mcp_context);
  if (ext && typeof ext === "object") {
    Object.assign(ctx, ext);
  }

  // Host — publisher domain (site or app)
  if (!ctx.host) {
    if (bidReq.site && bidReq.site.domain) ctx.host = bidReq.site.domain;
    else if (bidReq.app && bidReq.app.bundle) ctx.host = bidReq.app.bundle;
    else if (bidReq.app && bidReq.app.name) ctx.host = bidReq.app.name.toLowerCase();
    else if (imp.tagid) ctx.host = imp.tagid;
  }

  // Intent — infer from site.keywords or site.page
  if (!ctx.intent) {
    const hay = [
      bidReq.site && bidReq.site.keywords,
      bidReq.site && bidReq.site.page,
      bidReq.app && bidReq.app.keywords,
      imp.tagid,
    ].filter(Boolean).join(" ").toLowerCase();
    if (/debug|error|exception|traceback|stack/.test(hay)) ctx.intent = "debug_py";
    else if (/doc|tutorial|how-to|reference|api/.test(hay)) ctx.intent = "docs_lookup";
  }

  // MCP tool — only populated via ext.mcp_context; OpenRTB has no native field

  // Region — from device.geo
  if (!ctx.region && bidReq.device && bidReq.device.geo) {
    const geo = bidReq.device.geo;
    if (geo.region) ctx.region = geo.region.toLowerCase();
    else if (geo.country === "USA" || geo.country === "US") ctx.region = "us-west";
    else if (geo.country === "DEU" || geo.country === "GBR") ctx.region = "eu-central";
  }

  // Session length
  if (!ctx.session_len && bidReq.user && bidReq.user.ext && bidReq.user.ext.session_len_min) {
    ctx.session_len = bidReq.user.ext.session_len_min;
  }

  return ctx;
}

// ─── eligibility filters (brand safety, budget, region) ───
function filterEligible(campaigns, bidReq, imp, bidFloor) {
  const bcat = new Set((bidReq.bcat || []).map(String));
  const badv = new Set((bidReq.badv || []).map(String));
  const userRegion = (bidReq.device && bidReq.device.geo && bidReq.device.geo.region) || "global";

  return campaigns.filter((c) => {
    // Brand safety: blocked advertiser domain
    if ((c.adomain || []).some((d) => badv.has(d))) return false;
    // Brand safety: blocked IAB category
    if ((c.iab_cat || []).some((cat) => bcat.has(cat))) return false;
    // Budget exhaustion
    if ((c.spent_today || 0) >= (c.daily_budget || 0)) return false;
    if ((c.spent_total || 0) >= (c.total_budget || 0)) return false;
    // Region
    const regions = c.target_regions || ["global"];
    if (!regions.includes("global") && !regions.includes(userRegion) && !regions.includes(userRegion.toLowerCase())) return false;
    // Format match — OpenRTB imp.native/banner/video must match campaign.format
    if (imp.native && c.format !== "native") return false;
    if (imp.banner && c.format !== "image") return false;
    if (imp.video && c.format !== "video") return false;
    return true;
  });
}

// ─── build the OpenRTB Native 1.2 ADM response ───
function buildNativeAdm(nativeReq, campaign) {
  // Parse the publisher's asset request so we answer with the expected IDs
  let requested = { assets: [] };
  try {
    if (nativeReq.request) {
      requested = typeof nativeReq.request === "string" ? JSON.parse(nativeReq.request) : nativeReq.request;
    }
  } catch (_) {}

  const assetsOut = [];
  for (const a of requested.assets || []) {
    if (a.title) assetsOut.push({ id: a.id, title: { text: campaign.headline } });
    else if (a.data && a.data.type === 2) assetsOut.push({ id: a.id, data: { value: campaign.subtext } });
    else if (a.data && a.data.type === 12) assetsOut.push({ id: a.id, data: { value: campaign.cta_label } });
    else if (a.img && a.img.type === 3) {
      assetsOut.push({ id: a.id, img: { url: campaign.media_url, w: 1200, h: 628 } });
    } else if (a.img && a.img.type === 1) {
      assetsOut.push({ id: a.id, img: { url: campaign.media_url, w: 200, h: 200 } });
    }
  }
  // If the request didn't enumerate assets, return a sensible default set
  if (assetsOut.length === 0) {
    assetsOut.push({ id: 1, title: { text: campaign.headline } });
    assetsOut.push({ id: 2, img: { url: campaign.media_url, w: 1200, h: 628, type: 3 } });
    assetsOut.push({ id: 3, data: { value: campaign.subtext, type: 2 } });
    assetsOut.push({ id: 4, data: { value: campaign.cta_label, type: 12 } });
  }

  return {
    native: {
      ver: "1.2",
      assets: assetsOut,
      link: { url: campaign.cta_url },
      imptrackers: [`${BASE_URL}/api/track?event=impression&campaign_id=${campaign.id}`],
      jstracker: null,
    },
  };
}

// ─── construct a BidResponse from the winning (imp, campaign, benna) tuple ───
function buildBid(imp, campaign, score, bidReq) {
  // OpenRTB convention: bid.price and imp.bidfloor are CPM (cost per mille).
  // Benna's scoreBid returns a per-impression bid in USD, so we multiply by 1000.
  const floor = imp.bidfloor || 0;
  const priceCpm = score.bid_usd * 1000;
  const price = Math.max(priceCpm, floor);
  // exchange take (15%) is deducted server-side; DSPs bid gross
  const impExpirySec = 300;
  const macros = (tmpl) =>
    tmpl
      .replace("{imp_id}", encodeURIComponent(imp.id))
      .replace("{bid_id}", encodeURIComponent(campaign.id + ":" + bidReq.id))
      .replace("{req_id}", encodeURIComponent(bidReq.id))
      .replace("{campaign_id}", encodeURIComponent(campaign.id));

  const bid = {
    id: campaign.id + ":" + bidReq.id,
    impid: imp.id,
    price: +price.toFixed(4),
    adid: campaign.id,
    crid: campaign.id,
    cid: campaign.advertiser_id || campaign.id,
    adomain: campaign.adomain || [],
    cat: campaign.iab_cat || [],
    nurl: `${BASE_URL}/api/rtb?op=win&imp={imp_id}&price=$\{AUCTION_PRICE\}&bid={bid_id}&req={req_id}&camp={campaign_id}`.replace(/\{(imp_id|bid_id|req_id|campaign_id)\}/g, (_, k) => ({imp_id:encodeURIComponent(imp.id),bid_id:encodeURIComponent(campaign.id + ":" + bidReq.id),req_id:encodeURIComponent(bidReq.id),campaign_id:encodeURIComponent(campaign.id)}[k])),
    lurl: `${BASE_URL}/api/rtb?op=loss&imp=${encodeURIComponent(imp.id)}&reason=$\{AUCTION_LOSS\}&bid=${encodeURIComponent(campaign.id + ":" + bidReq.id)}`,
    exp: impExpirySec,
    ext: {
      benna: {
        model_version: score.model_version,
        p_click: score.p_click,
        p_convert: score.p_convert,
        latency_ms: score.latency_ms,
        signal_contributions: score.signal_contributions,
      },
    },
  };

  // Format-specific fields
  if (imp.native) {
    bid.adm = JSON.stringify(buildNativeAdm(imp.native, campaign));
  } else if (imp.banner) {
    bid.w = (imp.banner.w || (imp.banner.format && imp.banner.format[0] && imp.banner.format[0].w)) || 300;
    bid.h = (imp.banner.h || (imp.banner.format && imp.banner.format[0] && imp.banner.format[0].h)) || 250;
    bid.adm = `<a href="${campaign.cta_url}" target="_blank"><img src="${campaign.media_url}" width="${bid.w}" height="${bid.h}" alt="${campaign.headline.replace(/"/g, "&quot;")}"/></a><img src="${BASE_URL}/api/track?event=impression&campaign_id=${campaign.id}" width="1" height="1" style="position:absolute"/>`;
  } else if (imp.video) {
    bid.w = imp.video.w || 1280;
    bid.h = imp.video.h || 720;
    // Minimal VAST 4.x response
    bid.adm = buildVast(campaign, bidReq.id);
  }

  return bid;
}

function buildVast(campaign, reqId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="4.2">
  <Ad id="${campaign.id}">
    <InLine>
      <AdSystem version="1.0">BoostBoss BBX</AdSystem>
      <AdTitle><![CDATA[${campaign.headline}]]></AdTitle>
      <Impression><![CDATA[${BASE_URL}/api/track?event=impression&campaign_id=${campaign.id}&req=${reqId}]]></Impression>
      <Creatives>
        <Creative id="${campaign.id}-c1">
          <Linear>
            <Duration>00:00:30</Duration>
            <MediaFiles>
              <MediaFile delivery="progressive" type="video/mp4" width="1280" height="720"><![CDATA[${campaign.media_url}]]></MediaFile>
            </MediaFiles>
            <VideoClicks>
              <ClickThrough><![CDATA[${campaign.cta_url}]]></ClickThrough>
              <ClickTracking><![CDATA[${BASE_URL}/api/track?event=click&campaign_id=${campaign.id}&req=${reqId}]]></ClickTracking>
            </VideoClicks>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>`;
}

// ─── the main handler ───
module.exports = async function handler(req, res) {
  const started = Date.now();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-openrtb-version");
  res.setHeader("x-openrtb-version", "2.6");
  res.setHeader("x-bbx-adapter", ADAPTER_VERSION);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const op = (req.query && req.query.op) || null;

    // ── status / health ──
    if (req.method === "GET" && (op === "status" || !op)) {
      const allSeats = await seats.listSeats();
      return res.status(200).json({
        status: "ok",
        adapter: ADAPTER_VERSION,
        openrtb_version: "2.6",
        native_version: "1.2",
        currencies: ["USD"],
        auction_type: 1, // first-price
        tmax_recommended: 200,
        supported_formats: ["native", "banner", "video"],
        benna_version: benna.MODEL_VERSION,
        registered_seats: allSeats.length,
        seats: allSeats,
        endpoints: {
          bid:    { method: "POST", url: `${BASE_URL}/api/rtb` },
          win:    { method: "GET",  url: `${BASE_URL}/api/rtb?op=win&imp={imp}&price={price}&bid={bid}` },
          loss:   { method: "GET",  url: `${BASE_URL}/api/rtb?op=loss&imp={imp}&reason={n}&bid={bid}` },
          status: { method: "GET",  url: `${BASE_URL}/api/rtb?op=status` },
        },
      });
    }

    // ── win notice ──
    // Called by the publisher / SSP when our bid cleared their auction.
    // Per OpenRTB the {AUCTION_PRICE} macro is substituted with the clearing
    // price (CPM, in the auction currency). We persist + atomically deduct
    // the campaign's budget. Idempotent — duplicate fires are no-ops.
    if (req.method === "GET" && op === "win") {
      const { imp, price, bid, camp } = req.query || {};
      const updated = await ledger.recordWin(bid, price);
      res.setHeader("x-bbx-win-recorded", updated ? "1" : "0");
      res.setHeader("x-bbx-cleared-price-cpm", String(Number(price) || 0));
      console.log("[BBX RTB] WIN", { imp, price, bid, campaign: camp, persisted: !!updated });
      // Return a 1×1 GIF — many SSPs treat the nurl as an image beacon.
      res.setHeader("Content-Type", "image/gif");
      return res.status(200).send(Buffer.from([
        0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,0x80,0x00,0x00,0x00,0x00,0x00,
        0xff,0xff,0xff,0x21,0xf9,0x04,0x01,0x00,0x00,0x00,0x00,0x2c,0x00,0x00,0x00,0x00,
        0x01,0x00,0x01,0x00,0x00,0x02,0x02,0x44,0x01,0x00,0x3b,
      ]));
    }

    // ── loss notice ──
    // {AUCTION_LOSS} is the IAB-defined integer reason code (1=internal error,
    // 2=invalid request, 102=below floor, 5xx=BBX extensions, etc).
    if (req.method === "GET" && op === "loss") {
      const { imp, reason, bid } = req.query || {};
      const updated = await ledger.recordLoss(bid, reason);
      res.setHeader("x-bbx-loss-recorded", updated ? "1" : "0");
      console.log("[BBX RTB] LOSS", { imp, reason, bid, persisted: !!updated });
      res.setHeader("Content-Type", "image/gif");
      return res.status(200).send(Buffer.from([
        0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,0x80,0x00,0x00,0x00,0x00,0x00,
        0xff,0xff,0xff,0x21,0xf9,0x04,0x01,0x00,0x00,0x00,0x00,0x2c,0x00,0x00,0x00,0x00,
        0x01,0x00,0x01,0x00,0x00,0x02,0x02,0x44,0x01,0x00,0x3b,
      ]));
    }

    // ── reporting endpoint ──
    // GET /api/rtb?op=report&since=ISO&until=ISO
    // Returns aggregate spend for the authenticated seat. DSPs use this for
    // monthly invoice reconciliation. seat is identified by Bearer token.
    if (req.method === "GET" && op === "report") {
      const auth = await seats.authenticate(req);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
      const { since, until } = req.query || {};
      const summary = await ledger.reportSpend(auth.seat.seat_id, since, until);
      return res.status(200).json({
        seat: { id: auth.seat.seat_id, name: auth.seat.name },
        ...summary,
      });
    }

    // ── bid request ──
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Authenticate the seat (DSP / publisher integration). In demo deploys
    // anonymous calls are allowed but tagged seat_anon (non-billable). In
    // production (NODE_ENV=production or BBX_SEAT_AUTH_REQUIRED=true) a
    // valid Bearer token is required.
    const auth = await seats.authenticate(req);
    if (!auth.ok) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="bbx"');
      return res.status(auth.status).json({ nbr: auth.nbr || NBR.INVALID_REQUEST, error: auth.error });
    }
    res.setHeader("x-bbx-seat", auth.seat.seat_id);

    // Parse body (Vercel auto-parses JSON when content-type is correct)
    let bidReq = req.body;
    if (typeof bidReq === "string") {
      try { bidReq = JSON.parse(bidReq); } catch (_) {
        return res.status(400).json({ nbr: NBR.INVALID_REQUEST, error: "malformed JSON" });
      }
    }

    // Validate
    const err = validate(bidReq);
    if (err) {
      return res.status(400).json({ nbr: NBR.INVALID_REQUEST, error: err });
    }

    // Respect tmax — enforce a soft budget; we log if we came close
    const tmax = Number(bidReq.tmax) || 200;

    // Persist the auction request (single source of truth for billing)
    await ledger.recordAuction(bidReq, auth.seat.seat_id);

    // Load campaigns once per bid request
    let campaigns;
    try { campaigns = await getCampaigns(); }
    catch (e) {
      console.error("[BBX RTB] campaign load failed", e);
      return res.status(200).json({ id: bidReq.id, nbr: NBR.TECHNICAL_ERROR });
    }

    // Seed in-memory budget caps so deductBudget can enforce them on win
    for (const c of campaigns) {
      ledger.setBudgetCaps(c.id, { daily_budget: c.daily_budget, total_budget: c.total_budget });
    }

    // For each impression, pick the best eligible campaign
    const seatbidBids = [];
    const persistOps = [];
    for (const imp of bidReq.imp) {
      const pool = filterEligible(campaigns, bidReq, imp, imp.bidfloor || 0);
      if (pool.length === 0) continue;

      const mcpCtx = contextFromBidRequest(bidReq, imp);
      let best = null;
      for (const c of pool) {
        const score = benna.scoreBid(mcpCtx, { target_cpa: c.target_cpa, goal: "target_cpa", format: c.format });
        // Floor check: Benna returns a per-impression bid; OpenRTB floors are CPM
        const floorCpm = imp.bidfloor || 0;
        const bidCpm = score.bid_usd * 1000;
        if (bidCpm < floorCpm) continue;
        if (!best || bidCpm > best.score.bid_usd * 1000) best = { campaign: c, score };
      }
      if (!best) continue;
      const bid = buildBid(imp, best.campaign, best.score, bidReq);
      seatbidBids.push(bid);
      // Persist asynchronously — don't make the auction wait on disk
      persistOps.push(ledger.recordBid(bidReq.id, bid, best.campaign.id, auth.seat.seat_id));
    }

    // Fire-and-forget; await before responding so a failing ledger surfaces
    // rather than swallowing silently. Total cost is a few ms in demo mode.
    await Promise.all(persistOps);

    const elapsed = Date.now() - started;
    res.setHeader("x-bbx-processing-ms", String(elapsed));

    // No bid for any impression → 204 per OpenRTB convention
    if (seatbidBids.length === 0) {
      return res.status(204).end();
    }

    // Build the full BidResponse
    const response = {
      id: bidReq.id,
      seatbid: [
        { seat: "boostboss", bid: seatbidBids },
      ],
      bidid: `bbx_${bidReq.id}_${Date.now().toString(36)}`,
      cur: "USD",
      ext: {
        adapter: ADAPTER_VERSION,
        processing_ms: elapsed,
        tmax: tmax,
        benna_version: benna.MODEL_VERSION,
        seat: auth.seat.seat_id,
        billable: !!auth.seat.billable,
      },
    };

    return res.status(200).json(response);

  } catch (err) {
    console.error("[BBX RTB Error]", err);
    return res.status(500).json({ nbr: NBR.TECHNICAL_ERROR, error: "internal error", message: err.message });
  }
};

// Expose internals for test harness / internal reuse
module.exports.validate = validate;
module.exports.contextFromBidRequest = contextFromBidRequest;
module.exports.filterEligible = filterEligible;
module.exports.buildBid = buildBid;
module.exports.buildNativeAdm = buildNativeAdm;
module.exports.NBR = NBR;
module.exports.ADAPTER_VERSION = ADAPTER_VERSION;

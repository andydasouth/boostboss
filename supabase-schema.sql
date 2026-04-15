-- ============================================
-- BOOST BOSS — Supabase Database Schema
-- Run this in Supabase SQL Editor
-- ============================================

-- ── Advertisers ──
CREATE TABLE advertisers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  company_name TEXT NOT NULL,
  password_hash TEXT, -- managed by Supabase Auth in production
  balance NUMERIC(12,2) DEFAULT 0.00,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── Developers ──
CREATE TABLE developers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  app_name TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL DEFAULT 'bb_dev_' || substr(md5(random()::text), 1, 24),
  app_id TEXT UNIQUE NOT NULL DEFAULT 'app_' || substr(md5(random()::text), 1, 12),
  revenue_share_pct NUMERIC(5,2) DEFAULT 65.00,
  total_earnings NUMERIC(12,2) DEFAULT 0.00,
  mcp_endpoint TEXT DEFAULT 'https://api.boostboss.ai/api/mcp',
  -- Ad format controls
  format_corner BOOLEAN DEFAULT true,
  format_fullscreen BOOLEAN DEFAULT true,
  format_video BOOLEAN DEFAULT true,
  format_native BOOLEAN DEFAULT true,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── Campaigns ──
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id UUID REFERENCES advertisers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'in_review' CHECK (status IN ('active', 'paused', 'in_review', 'completed', 'rejected')),
  -- Creative
  format TEXT NOT NULL CHECK (format IN ('image', 'video', 'native')),
  headline TEXT NOT NULL,
  subtext TEXT,
  media_url TEXT,
  poster_url TEXT, -- for video thumbnail
  cta_label TEXT DEFAULT 'Learn More →',
  cta_url TEXT NOT NULL,
  -- Targeting
  target_keywords TEXT[] DEFAULT '{}',
  target_regions TEXT[] DEFAULT '{global}',
  target_languages TEXT[] DEFAULT '{en}',
  -- Budget
  billing_model TEXT DEFAULT 'cpm' CHECK (billing_model IN ('cpm', 'cpc', 'cpv')),
  bid_amount NUMERIC(8,2) DEFAULT 5.00, -- per 1000 for CPM, per click for CPC, per view for CPV
  daily_budget NUMERIC(10,2) DEFAULT 50.00,
  total_budget NUMERIC(12,2) DEFAULT 1000.00,
  spent_today NUMERIC(10,2) DEFAULT 0.00,
  spent_total NUMERIC(12,2) DEFAULT 0.00,
  -- Settings
  skippable_after_sec INT DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── Events (impressions, clicks, etc.) ──
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN ('impression', 'click', 'close', 'skip', 'video_complete')),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  developer_id UUID REFERENCES developers(id) ON DELETE SET NULL,
  session_id TEXT,
  -- Geo & device
  ip_country TEXT DEFAULT 'unknown',
  ip_region TEXT DEFAULT 'unknown',
  ip_city TEXT DEFAULT 'unknown',
  user_language TEXT DEFAULT 'en',
  user_agent TEXT,
  -- Revenue
  cost NUMERIC(8,4) DEFAULT 0.00, -- what advertiser pays
  developer_payout NUMERIC(8,4) DEFAULT 0.00, -- developer's share
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Payouts ──
CREATE TABLE payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id UUID REFERENCES developers(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'paid', 'failed')),
  stripe_transfer_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── Daily aggregates (for fast dashboard queries) ──
CREATE TABLE daily_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  developer_id UUID REFERENCES developers(id) ON DELETE SET NULL,
  impressions INT DEFAULT 0,
  clicks INT DEFAULT 0,
  video_completes INT DEFAULT 0,
  skips INT DEFAULT 0,
  closes INT DEFAULT 0,
  spend NUMERIC(10,2) DEFAULT 0.00,
  developer_earnings NUMERIC(10,2) DEFAULT 0.00,
  UNIQUE(date, campaign_id, developer_id)
);

-- ============================================
-- INDEXES for performance
-- ============================================
CREATE INDEX idx_campaigns_advertiser ON campaigns(advertiser_id);
CREATE INDEX idx_campaigns_status ON campaigns(status);
CREATE INDEX idx_campaigns_keywords ON campaigns USING GIN(target_keywords);
CREATE INDEX idx_events_campaign ON events(campaign_id);
CREATE INDEX idx_events_developer ON events(developer_id);
CREATE INDEX idx_events_created ON events(created_at);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_daily_stats_date ON daily_stats(date);
CREATE INDEX idx_daily_stats_campaign ON daily_stats(campaign_id);
CREATE INDEX idx_daily_stats_developer ON daily_stats(developer_id);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
ALTER TABLE advertisers ENABLE ROW LEVEL SECURITY;
ALTER TABLE developers ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_stats ENABLE ROW LEVEL SECURITY;

-- Public read for active campaigns (MCP server needs this)
CREATE POLICY "Active campaigns are readable" ON campaigns
  FOR SELECT USING (status = 'active');

-- Events can be inserted by API
CREATE POLICY "Events can be inserted" ON events
  FOR INSERT WITH CHECK (true);

-- Public read for daily stats
CREATE POLICY "Stats are readable" ON daily_stats
  FOR SELECT USING (true);

-- Developers can read their own data
CREATE POLICY "Developers read own data" ON developers
  FOR SELECT USING (true);

-- ============================================
-- SEED DATA — Test advertisers, developers, campaigns
-- ============================================

-- Test advertiser
INSERT INTO advertisers (id, email, company_name, balance) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'demo@framer.com', 'Framer', 5000.00),
  ('a0000000-0000-0000-0000-000000000002', 'demo@vercel.com', 'Vercel', 8000.00),
  ('a0000000-0000-0000-0000-000000000003', 'demo@cursor.com', 'Cursor', 3000.00),
  ('a0000000-0000-0000-0000-000000000004', 'demo@notion.so', 'Notion', 6000.00);

-- Test developer
INSERT INTO developers (id, email, app_name, api_key, app_id) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'demo@myaiapp.com', 'MyAI Chat', 'bb_dev_demo_key_001', 'app_demo001'),
  ('d0000000-0000-0000-0000-000000000002', 'demo@openwebui.com', 'Open WebUI', 'bb_dev_demo_key_002', 'app_demo002');

-- Test campaigns
INSERT INTO campaigns (advertiser_id, name, status, format, headline, subtext, media_url, cta_label, cta_url, target_keywords, target_regions, target_languages, billing_model, bid_amount, daily_budget, total_budget, skippable_after_sec) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Framer Landing Pages', 'active', 'image',
   'Build stunning sites — no code needed',
   'Framer · Free for 30 days · 2M+ creators',
   'https://placehold.co/540x304/f97316/ffffff?text=Framer',
   'Try Free →', 'https://framer.com',
   '{landing page,design,website,no-code,UI,builder,startup,frontend}',
   '{global}', '{en,zh,es,ja}',
   'cpc', 0.50, 50.00, 1000.00, 3),

  ('a0000000-0000-0000-0000-000000000002', 'Vercel Deploy', 'active', 'image',
   'Deploy in seconds. Scale forever.',
   'Vercel · Free hobby plan · Netflix, Uber trust us',
   'https://placehold.co/540x304/000000/ffffff?text=Vercel',
   'Deploy Now →', 'https://vercel.com',
   '{deploy,hosting,server,scale,frontend,next.js,react,ship}',
   '{global}', '{en}',
   'cpm', 6.00, 80.00, 2000.00, 3),

  ('a0000000-0000-0000-0000-000000000003', 'Cursor AI IDE', 'active', 'video',
   'Code 10x faster with AI',
   'Cursor · AI-first IDE · 1M+ developers',
   'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
   'Download Free →', 'https://cursor.com',
   '{code,programming,IDE,developer,python,javascript,build,debug,software}',
   '{global}', '{en,zh,ja}',
   'cpv', 0.10, 100.00, 3000.00, 5),

  ('a0000000-0000-0000-0000-000000000004', 'Notion AI Workspace', 'active', 'image',
   'All your work. One tool. AI-powered.',
   'Notion · Free for personal · 30M+ teams',
   'https://placehold.co/540x304/0ea5e9/ffffff?text=Notion+AI',
   'Get Notion Free →', 'https://notion.so',
   '{notes,organize,project,team,wiki,document,plan,manage,productivity}',
   '{global}', '{en,zh,es,ja,ko}',
   'cpc', 0.40, 60.00, 1500.00, 3);

-- Seed some daily stats for dashboard demo
INSERT INTO daily_stats (date, campaign_id, developer_id, impressions, clicks, video_completes, skips, closes, spend, developer_earnings)
SELECT
  (CURRENT_DATE - (d || ' days')::interval)::date,
  c.id,
  'd0000000-0000-0000-0000-000000000001'::uuid,
  (random() * 5000 + 1000)::int,
  (random() * 100 + 20)::int,
  CASE WHEN c.format = 'video' THEN (random() * 50 + 10)::int ELSE 0 END,
  (random() * 30)::int,
  (random() * 200 + 50)::int,
  round((random() * 30 + 5)::numeric, 2),
  round((random() * 20 + 3)::numeric, 2)
FROM generate_series(0, 13) AS d
CROSS JOIN campaigns c;

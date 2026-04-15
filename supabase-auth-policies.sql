-- ============================================
-- BOOST BOSS — Auth RLS Policies
-- Run AFTER the initial schema
-- ============================================

-- Allow advertisers to read/update their own row
CREATE POLICY "Advertisers manage own data" ON advertisers
  FOR ALL USING (auth.uid() = id);

-- Allow developers to read/update their own row
CREATE POLICY "Developers manage own data" ON developers
  FOR ALL USING (auth.uid() = id);

-- Advertisers can manage their own campaigns
CREATE POLICY "Advertisers manage own campaigns" ON campaigns
  FOR ALL USING (advertiser_id = auth.uid());

-- Allow inserts to advertisers/developers for signup
CREATE POLICY "Allow signup inserts for advertisers" ON advertisers
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow signup inserts for developers" ON developers
  FOR INSERT WITH CHECK (true);

-- Events readable by related developer
CREATE POLICY "Developers read own events" ON events
  FOR SELECT USING (developer_id = auth.uid());

-- Payouts readable by developer
CREATE POLICY "Developers read own payouts" ON payouts
  FOR SELECT USING (developer_id = auth.uid());

-- Daily stats readable by related developer
CREATE POLICY "Developers read own daily stats" ON daily_stats
  FOR SELECT USING (developer_id = auth.uid());

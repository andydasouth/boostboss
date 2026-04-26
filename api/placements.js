/**
 * Boost Boss — Publisher Placements API
 *
 * A "placement" is one monetisable slot inside a publisher's app
 * (chat-inline / tool-result / sidebar / etc). Schema lives in
 * db/04_bbx_mcp_extensions.sql §1.
 *
 * Endpoints
 *   GET    /api/placements?developer_id=xxx           list a publisher's placements
 *   GET    /api/placements?developer_id=xxx&id=yyy    fetch one placement
 *   POST   /api/placements                            create
 *   PATCH  /api/placements?id=xxx                     update (floor, freq cap, status)
 *   DELETE /api/placements?id=xxx                     archive (sets status='archived')
 *
 * Two execution modes (matches campaigns.js / track.js conventions):
 *   • PRODUCTION — Supabase
 *   • DEMO       — in-process store, same response shape
 *
 * Auth model:
 *   - Reads / writes are scoped to a developer_id passed in body or query.
 *   - In production this would be enforced by RLS via auth.uid() = developer_id.
 *     The api/_lib service role bypasses RLS, so we re-check ownership in
 *     code on update/archive.
 */

const HAS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
);

let _supabase = null;
function supa() {
  if (_supabase) return _supabase;
  if (!HAS_SUPABASE) return null;
  try {
    const { createClient } = require("@supabase/supabase-js");
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    );
    return _supabase;
  } catch (_) { return null; }
}

// ── Demo store ──────────────────────────────────────────────────────────
const DEMO_PLACEMENTS = new Map();

// Allowed values mirror the SQL CHECK constraints in migration 04.
const ALLOWED_SURFACES = [
  'chat', 'tool_response', 'sidebar', 'loading_screen', 'status_line', 'web',
];
const ALLOWED_FORMATS  = ['image', 'video', 'native', 'text_card'];
const ALLOWED_STATUSES = ['active', 'paused', 'archived'];

function newPlacementId() {
  return 'plc_' + (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '')
    : (Date.now().toString(36) + Math.random().toString(36).slice(2, 14)));
}

function validateBody(b, { partial = false } = {}) {
  const errs = [];
  if (!partial) {
    if (!b.developer_id) errs.push('developer_id is required');
    if (!b.name)         errs.push('name is required');
    if (!b.surface)      errs.push('surface is required');
    if (!b.format)       errs.push('format is required');
  }
  if (b.surface && !ALLOWED_SURFACES.includes(b.surface)) {
    errs.push(`surface must be one of: ${ALLOWED_SURFACES.join(', ')}`);
  }
  if (b.format && !ALLOWED_FORMATS.includes(b.format)) {
    errs.push(`format must be one of: ${ALLOWED_FORMATS.join(', ')}`);
  }
  if (b.status && !ALLOWED_STATUSES.includes(b.status)) {
    errs.push(`status must be one of: ${ALLOWED_STATUSES.join(', ')}`);
  }
  if (b.floor_cpm != null) {
    const f = Number(b.floor_cpm);
    if (!Number.isFinite(f) || f < 0 || f > 1000) {
      errs.push('floor_cpm must be between 0 and 1000');
    }
  }
  if (b.freq_cap_per_user_per_day != null) {
    const n = Number(b.freq_cap_per_user_per_day);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      errs.push('freq_cap_per_user_per_day must be an integer between 1 and 1000');
    }
  }
  return errs;
}

// ── Handler ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('x-placements-mode', HAS_SUPABASE ? 'supabase' : 'demo');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET')    return await handleList(req, res);
    if (req.method === 'POST')   return await handleCreate(req, res);
    if (req.method === 'PATCH')  return await handleUpdate(req, res);
    if (req.method === 'DELETE') return await handleArchive(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Placements] error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
};

async function handleList(req, res) {
  const { developer_id, id, status } = req.query || {};
  if (!developer_id) {
    return res.status(400).json({ error: 'developer_id query param is required' });
  }

  const sb = supa();
  if (sb) {
    let q = sb.from('placements').select('*').eq('developer_id', developer_id);
    if (id)     q = q.eq('id', id);
    if (status) q = q.eq('status', status);
    q = q.order('created_at', { ascending: false });
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (id) {
      const row = (data || [])[0];
      if (!row) return res.status(404).json({ error: 'Placement not found' });
      return res.json({ placement: row });
    }
    return res.json({ placements: data || [] });
  }

  // Demo
  let rows = [...DEMO_PLACEMENTS.values()].filter(p => p.developer_id === developer_id);
  if (id)     rows = rows.filter(p => p.id === id);
  if (status) rows = rows.filter(p => p.status === status);
  if (id) {
    if (rows.length === 0) return res.status(404).json({ error: 'Placement not found' });
    return res.json({ placement: rows[0] });
  }
  return res.json({ placements: rows });
}

async function handleCreate(req, res) {
  const b = req.body || {};
  const errs = validateBody(b);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  const now = new Date().toISOString();
  const row = {
    id: b.id || newPlacementId(),
    developer_id: b.developer_id,
    app_id: b.app_id || 'app_default',
    name: String(b.name).slice(0, 80),
    surface: b.surface,
    format: b.format,
    floor_cpm: b.floor_cpm != null ? Number(b.floor_cpm) : 1.50,
    freq_cap_per_user_per_day: b.freq_cap_per_user_per_day != null
      ? Number(b.freq_cap_per_user_per_day) : 5,
    size_max_chars: b.size_max_chars != null ? Number(b.size_max_chars) : null,
    size_max_lines: b.size_max_lines != null ? Number(b.size_max_lines) : null,
    size_max_px:    b.size_max_px    != null ? Number(b.size_max_px)    : null,
    status: 'active',
    excluded_categories: Array.isArray(b.excluded_categories) ? b.excluded_categories : [],
    excluded_advertisers: Array.isArray(b.excluded_advertisers) ? b.excluded_advertisers : [],
    notes: b.notes || null,
    created_at: now,
    updated_at: now,
  };

  const sb = supa();
  if (sb) {
    const { data, error } = await sb.from('placements').insert(row).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ placement: data });
  }

  DEMO_PLACEMENTS.set(row.id, row);
  return res.status(201).json({ placement: row });
}

async function handleUpdate(req, res) {
  const { id } = req.query || {};
  const b = req.body || {};
  if (!id) return res.status(400).json({ error: 'id query param required' });
  if (!b.developer_id) {
    return res.status(400).json({ error: 'developer_id is required (ownership check)' });
  }

  const errs = validateBody(b, { partial: true });
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });

  // Whitelist of fields the publisher can update.
  const allowed = [
    'name', 'surface', 'format', 'floor_cpm', 'freq_cap_per_user_per_day',
    'size_max_chars', 'size_max_lines', 'size_max_px',
    'status', 'excluded_categories', 'excluded_advertisers', 'notes',
  ];
  const updates = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (b[k] !== undefined) updates[k] = b[k];

  const sb = supa();
  if (sb) {
    // Ownership check first — confirm this developer owns the row before
    // letting the update through. Service role bypasses RLS so we have to
    // gate this in app code.
    const { data: existing, error: e1 } = await sb.from('placements')
      .select('id, developer_id').eq('id', id).maybeSingle();
    if (e1) return res.status(500).json({ error: e1.message });
    if (!existing) return res.status(404).json({ error: 'Placement not found' });
    if (existing.developer_id !== b.developer_id) {
      return res.status(403).json({ error: 'Not your placement' });
    }
    const { data, error } = await sb.from('placements')
      .update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ placement: data });
  }

  const row = DEMO_PLACEMENTS.get(id);
  if (!row) return res.status(404).json({ error: 'Placement not found' });
  if (row.developer_id !== b.developer_id) {
    return res.status(403).json({ error: 'Not your placement' });
  }
  Object.assign(row, updates);
  return res.json({ placement: row });
}

async function handleArchive(req, res) {
  // DELETE = soft-archive (status='archived'). Hard deletes lose history,
  // and existing impressions reference placement_id, so we never hard-delete.
  req.method = 'PATCH';
  req.body = { ...(req.body || {}), status: 'archived' };
  return handleUpdate(req, res);
}

// ── Test exports ───────────────────────────────────────────────────────
module.exports.HAS_SUPABASE = HAS_SUPABASE;
module.exports._DEMO_PLACEMENTS = DEMO_PLACEMENTS;
module.exports._reset = function () { DEMO_PLACEMENTS.clear(); };

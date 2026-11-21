'use strict';
// Moves product photos out of Neon into Cloudinary (free image hosting), so Neon no longer sends photos to visitors.
// Needs ONE setting on Render:  CLOUDINARY_URL  (looks like cloudinary://KEY:SECRET@CLOUDNAME)
const crypto = require('crypto');

const ID_RE = /^[a-f0-9]{16}\.(?:jpg|png|webp)$/;
// Matches /uploads/<id> with or without the website address in front.
const REF_RE = /(?:https?:\/\/[^\s"'<>\\,]*)?\/uploads\/([a-f0-9]{16}\.(?:jpg|png|webp))(?:\?[^\s"'<>\\,]*)?/g;

function parseCloudinaryUrl(v) {
  const m = /^cloudinary:\/\/([^:@\/\s]+):([^@\s]+)@([^\/\s?#]+)/.exec(String(v || '').trim());
  return m ? { key: m[1], secret: m[2], cloud: m[3] } : null;
}

module.exports = function createCloudPhotos(opts) {
  const env = opts.env || process.env;
  const cfg = parseCloudinaryUrl(env.CLOUDINARY_URL);
  const apiBase = String(opts.apiBase || env.CLOUDINARY_API_BASE || 'https://api.cloudinary.com').replace(/\/$/, '');
  const log = opts.log || console;
  const retryMs = opts.retryMs === undefined ? 1500 : opts.retryMs;
  const concurrency = opts.concurrency || 3;
  const getDb = opts.getDb, mem = opts.mem, persist = opts.persist;

  const fresh = () => ({ running: false, phase: 'idle', total: 0, done: 0, failed: 0, failedIds: [], error: '', startedAt: null, finishedAt: null });
  let state = fresh();

  const urlFor = id => `https://res.cloudinary.com/${cfg.cloud}/image/upload/q_auto/caayo/${id}`;
  const flag = () => { try { return opts.getFlag() || {}; } catch { return {}; } };
  const isMoved = () => !!(cfg && flag().cloud === cfg.cloud && flag().movedAt);
  const sign = params => crypto.createHash('sha1').update(Object.keys(params).sort().map(k => k + '=' + params[k]).join('&') + cfg.secret).digest('hex');
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function uploadBuffer(id, buf, mime) {
    const publicId = 'caayo/' + id.replace(/\.[a-z]+$/, '');
    const ts = String(Math.floor(Date.now() / 1000));
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime || 'image/jpeg' }), id);
    form.append('api_key', cfg.key);
    form.append('timestamp', ts);
    form.append('public_id', publicId);
    form.append('overwrite', 'true');
    form.append('signature', sign({ overwrite: 'true', public_id: publicId, timestamp: ts }));
    const r = await fetch(`${apiBase}/v1_1/${cfg.cloud}/image/upload`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok || !j.public_id) throw new Error((j.error && j.error.message) || ('Cloudinary answered ' + r.status));
    return urlFor(id);
  }
  async function withRetry(fn, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) { last = e; if (i < tries - 1) await sleep(retryMs * (i + 1)); }
    }
    throw last;
  }

  // Replaces old /uploads/<id> links with Cloudinary links everywhere in the saved data (products, orders, gifts, banners...).
  function walk(node, ids) {
    let changed = false;
    const fix = s => s.replace(REF_RE, (m, id) => (ids.has(id) ? urlFor(id) : m));
    const each = Array.isArray(node) ? node.keys() : Object.keys(node);
    for (const k of each) {
      const v = node[k];
      if (typeof v === 'string') { if (v.includes('/uploads/')) { const nv = fix(v); if (nv !== v) { node[k] = nv; changed = true; } } }
      else if (v && typeof v === 'object') { if (walk(v, ids)) changed = true; }
    }
    return changed;
  }
  function rewriteRefs(ids) {
    if (!ids.size) return 0;
    let n = 0;
    for (const key of Object.keys(mem)) {
      if (key === 'analytics' || key === 'cloudphotos' || !mem[key] || typeof mem[key] !== 'object') continue;
      if (walk(mem[key], ids)) { persist(key); n++; }
    }
    return n;
  }

  async function run() {
    const db = getDb();
    state.running = true; state.phase = 'listing';
    try {
      const list = await db.query('SELECT id FROM uploads ORDER BY created_at');
      const ids = list.rows.map(r => r.id).filter(id => ID_RE.test(id));
      state.total = ids.length; state.phase = 'moving';
      const okAll = new Set(); let batch = new Set(); let idx = 0;
      const worker = async () => {
        for (;;) {
          const i = idx++; if (i >= ids.length) return;
          const id = ids[i];
          try {
            const gone = await withRetry(async () => {
              const q = await db.query('SELECT mime, data FROM uploads WHERE id=$1', [id]);
              if (!q.rows.length) return true;
              await uploadBuffer(id, q.rows[0].data, q.rows[0].mime);
              return false;
            });
            if (!gone) { okAll.add(id); batch.add(id); }
            state.done++;
            if (batch.size >= 25) { rewriteRefs(batch); batch = new Set(); }
          } catch (e) {
            state.failed++; if (state.failedIds.length < 20) state.failedIds.push(id);
            log.error('Photo move failed for ' + id + ': ' + e.message);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      state.phase = 'finishing';
      rewriteRefs(okAll); // final pass also catches anything saved while the move was running
      if (state.failed === 0) opts.setFlag({ cloud: cfg.cloud, movedAt: new Date().toISOString(), count: okAll.size });
      state.phase = 'done';
    } catch (e) {
      state.error = 'Could not read the photos from Neon: ' + e.message;
      state.phase = 'error';
      log.error(state.error);
    } finally {
      state.running = false; state.finishedAt = Date.now();
    }
  }

  return {
    enabled: !!cfg,
    cloud: cfg ? cfg.cloud : '',
    isMoved,
    urlFor: id => (cfg ? urlFor(id) : ''),
    // New photo from the admin page -> straight to Cloudinary.
    async upload(id, buf, mime) { return withRetry(() => uploadBuffer(id, buf, mime), 2); },
    // A photo had to be saved in Neon instead (Cloudinary was down), so old links must read from Neon again.
    noteFallback() { if (isMoved()) opts.setFlag({}); },
    start() {
      if (!cfg) return { ok: false, error: 'Cloudinary is not connected yet. Add CLOUDINARY_URL on Render first.' };
      if (!getDb()) return { ok: false, error: 'This server is not using the Neon database, so there is nothing to move.' };
      if (state.running) return { ok: false, error: 'Photos are already being moved.' };
      state = fresh(); state.running = true; state.startedAt = Date.now();
      run();
      return { ok: true };
    },
    async status() {
      const out = { configured: !!cfg, cloud: cfg ? cfg.cloud : '', moved: isMoved(), movedInfo: isMoved() ? flag() : null, ...state };
      try {
        const db = getDb();
        if (db) {
          const r = await db.query('SELECT count(*)::int AS n, coalesce(sum(length(data)),0)::bigint AS bytes FROM uploads');
          out.inNeon = Number(r.rows[0].n); out.inNeonMB = Math.round(Number(r.rows[0].bytes) / 1048576 * 10) / 10;
        }
      } catch { out.neonError = 'Neon did not answer (it may be paused).'; }
      return out;
    },
    _parse: parseCloudinaryUrl
  };
};
module.exports.parseCloudinaryUrl = parseCloudinaryUrl;

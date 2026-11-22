'use strict';
// "Win the Influencer Package" challenge: points for friends who sign up with your link (1) and friends who order big (50).
// Points are worked out from the saved users and orders each time (never stored), so they cannot drift out of date.
const crypto = require('crypto');
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULTS = {
  enabled: false, title: 'Win the Influencer Package',
  prize: 'An iPhone (random model from 13 to 16), a microphone, and a ring light with tripod',
  winners: 2, startsAt: '', endsAt: '', minOrder: 20000, ptsSignup: 1, ptsOrder: 5,
  participants: [], excluded: [], approved: [], draw: null,
  prizeItems: []   // [{ name, mode: 'fixed' | 'random', options: [..] }]  one item = one gift in each winner's package
};
const digits = v => String(v || '').replace(/\D/g, '');
const maskName = n => { const p = String(n || 'Customer').trim().split(/\s+/); return (p[0].slice(0, 14) + (p[1] ? ' ' + p[1][0].toUpperCase() + '.' : '')) || 'Customer'; };
const isoOrEmpty = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };
const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

const cleanText = (v, n) => String(v || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
function cleanItems(raw) {
  if (!Array.isArray(raw)) return { items: null };
  if (raw.length > 10) return { error: 'Use at most 10 gifts in a package.' };
  const items = [];
  for (const it of raw) {
    const name = cleanText(it && it.name, 60); if (!name) continue;
    if (it.mode === 'random') {
      const options = [...new Set((Array.isArray(it.options) ? it.options : String(it.options || '').split(/[,\n]/)).map(x => cleanText(x, 40)).filter(Boolean))].slice(0, 12);
      if (options.length < 2) return { error: '"' + name + '" is set to random, so it needs at least 2 choices (for example iPhone 13, iPhone 14).' };
      items.push({ name, mode: 'random', options });
    } else items.push({ name, mode: 'fixed', options: [] });
  }
  return { items };
}
const prizeText = c => c.prizeItems.length
  ? c.prizeItems.map(i => i.mode === 'random' ? i.name + ' (one chosen at random: ' + i.options.join(', ') + ')' : i.name).join(' + ')
  : c.prize;
const rollPackage = c => c.prizeItems.map(i => i.mode === 'random' ? i.options[crypto.randomInt(i.options.length)] : i.name);

module.exports = function createChallenge(o) {
  const now = o.now || (() => Date.now());
  const cancelMs = o.cancelMs || 24 * 3600e3;
  let memo = null, memoAt = 0;
  const cfg = () => { const c = { ...DEFAULTS, ...(o.readCfg() || {}) }; for (const k of ['participants', 'excluded', 'approved', 'prizeItems']) if (!Array.isArray(c[k])) c[k] = []; return c; };
  const save = c => { o.writeCfg(c); memo = null; };
  function phase(c) {
    if (c.draw) return 'drawn';
    if (!c.enabled) return 'off';
    const t = now();
    if (c.startsAt && t < Date.parse(c.startsAt)) return 'soon';
    if (c.endsAt && t > Date.parse(c.endsAt)) return 'ended';
    return 'running';
  }
  // Everything about every participant, worked out fresh (kept for 60 seconds so a busy day does not slow the site).
  function snapshot() {
    if (memo && now() - memoAt < 60e3) return memo;
    const c = cfg(), users = o.readUsers().filter(u => u && u.verified).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const orders = o.readOrders(), from = c.startsAt ? Date.parse(c.startsAt) : 0, to = c.endsAt ? Date.parse(c.endsAt) : Infinity;
    const qualifies = (uid) => orders.some(x => x.userId === uid && x.status === 'paid' && !x.cancelled && !(x.refund && x.refund.status === 'done') && x.paidAt &&
      Date.parse(x.paidAt) >= from && Date.parse(x.paidAt) <= to && now() > Date.parse(x.paidAt) + cancelMs && Number(x.total) >= c.minOrder);
    const rows = c.participants.map(p => {
      const owner = users.find(u => u.id === p.userId) || {}, seenPhone = new Set(), ipTimes = {}, referred = [];
      for (const u of users) {
        if (u.ref !== p.code || u.id === p.userId || String(u.createdAt) < String(p.joinedAt)) continue;
        let reason = '';
        const ph = digits(u.phone), t = Date.parse(u.createdAt) || 0;
        if (c.excluded.includes(u.id)) reason = 'removed by admin';
        else if ((owner.email && owner.email === u.email) || (digits(owner.phone) && digits(owner.phone) === ph)) reason = 'same person as the owner';
        else if (ph && seenPhone.has(ph)) reason = 'phone already used';
        else if (!c.approved.includes(u.id) && u.signupIp && (ipTimes[u.signupIp] || []).filter(x => t - x < 864e5).length >= 2) reason = '3rd sign-up from one connection (needs approval)';
        if (ph) seenPhone.add(ph);
        if (u.signupIp) (ipTimes[u.signupIp] = ipTimes[u.signupIp] || []).push(t);
        referred.push({ id: u.id, name: u.name, email: u.email, phone: u.phone, at: u.createdAt, counted: !reason, reason, ordered: !reason && qualifies(u.id) });
      }
      const signups = referred.filter(r => r.counted).length, bigOrders = referred.filter(r => r.ordered).length;
      return { p, signups, bigOrders, points: p.disqualified ? 0 : signups * c.ptsSignup + bigOrders * c.ptsOrder, referred };
    });
    const sorted = [...rows].sort((a, b) => b.points - a.points || String(a.p.joinedAt).localeCompare(String(b.p.joinedAt)));
    sorted.forEach((r, i) => { r.rank = i + 1; });
    memo = { c, rows, sorted }; memoAt = now(); return memo;
  }
  const publicView = () => {
    const { c, sorted } = snapshot();
    return { enabled: c.enabled, phase: phase(c), title: c.title, prize: prizeText(c), winners: c.winners, startsAt: c.startsAt, endsAt: c.endsAt,
      minOrder: c.minOrder, ptsSignup: c.ptsSignup, ptsOrder: c.ptsOrder, participants: c.participants.length,
      board: sorted.filter(r => r.points > 0 && !r.p.disqualified).slice(0, 10).map(r => ({ name: maskName(r.p.name), points: r.points })),
      winnersList: c.draw ? c.draw.winners.map(w => ({ name: maskName(w.name), points: w.points, gifts: w.package || [] })) : [], serverNow: new Date(now()).toISOString() };
  };
  const meView = uid => {
    const { c, rows } = snapshot(), r = rows.find(x => x.p.userId === uid);
    return r ? { joined: true, code: r.p.code, points: r.points, signups: r.signups, bigOrders: r.bigOrders, rank: r.points > 0 ? r.rank : 0, disqualified: !!r.p.disqualified, won: !!(c.draw && c.draw.winners.some(w => w.userId === uid)) } : { joined: false };
  };
  function join(user) {
    const c = cfg(), ph = phase(c);
    if (ph !== 'running') return { error: ph === 'soon' ? 'The challenge has not started yet.' : 'The challenge is not running right now.' };
    const ex = c.participants.find(p => p.userId === user.id);
    if (ex) return { ok: true };
    const taken = new Set([...c.participants.map(p => p.code), ...(o.takenCodes ? o.takenCodes() : [])]);
    let code; do { code = Array.from({ length: 8 }, () => CHARS[crypto.randomInt(CHARS.length)]).join(''); } while (taken.has(code));
    c.participants.push({ userId: user.id, code, name: String(user.name || 'Customer').slice(0, 60), joinedAt: new Date(now()).toISOString(), disqualified: false });
    save(c); return { ok: true };
  }
  const adminView = () => {
    const { c, sorted } = snapshot();
    return { config: { enabled: c.enabled, title: c.title, prize: c.prize, prizeItems: c.prizeItems, winners: c.winners, startsAt: c.startsAt, endsAt: c.endsAt, minOrder: c.minOrder, ptsSignup: c.ptsSignup, ptsOrder: c.ptsOrder },
      phase: phase(c), draw: c.draw, drawableFrom: c.endsAt ? new Date(Date.parse(c.endsAt) + cancelMs).toISOString() : '',
      participants: sorted.map(r => ({ userId: r.p.userId, name: r.p.name, code: r.p.code, joinedAt: r.p.joinedAt, disqualified: !!r.p.disqualified, points: r.points, signups: r.signups, bigOrders: r.bigOrders, rank: r.rank,
        referred: r.referred.map(x => ({ id: x.id, name: x.name, counted: x.counted, reason: x.reason, ordered: x.ordered, at: x.at })) })) };
  };
  function adminSave(b) {
    const c = cfg();
    Object.assign(c, {
      enabled: b.enabled === true, title: String(b.title || DEFAULTS.title).replace(/[<>]/g, '').trim().slice(0, 80) || DEFAULTS.title,
      prize: String(b.prize || DEFAULTS.prize).replace(/[<>]/g, '').trim().slice(0, 300) || DEFAULTS.prize,
      winners: int(b.winners, 1, 20, c.winners), startsAt: isoOrEmpty(b.startsAt), endsAt: isoOrEmpty(b.endsAt),
      minOrder: int(b.minOrder, 0, 100000000, c.minOrder), ptsSignup: int(b.ptsSignup, 0, 1000, c.ptsSignup), ptsOrder: int(b.ptsOrder, 0, 1000, c.ptsOrder)
    });
    if (c.startsAt && c.endsAt && Date.parse(c.endsAt) <= Date.parse(c.startsAt)) return { error: 'The end date must be after the start date.' };
    const pi = cleanItems(b.prizeItems); if (pi.error) return pi; if (pi.items) c.prizeItems = pi.items;
    save(c); return { ok: true };
  }
  function flag(kind, userId, on) {
    const c = cfg(), id = String(userId || '');
    if (kind === 'disqualify') { const p = c.participants.find(x => x.userId === id); if (!p) return { error: 'Participant not found.' }; p.disqualified = !!on; }
    else if (kind === 'exclude' || kind === 'approve') {
      const k = kind === 'exclude' ? 'excluded' : 'approved', s = new Set(c[k]); on ? s.add(id) : s.delete(id); c[k] = [...s];
    } else return { error: 'Unknown action.' };
    save(c); return { ok: true };
  }
  function draw() {
    const c = cfg();
    if (c.draw) return { error: 'The draw was already done.' };
    if (!c.endsAt) return { error: 'Set an end date first.' };
    const from = Date.parse(c.endsAt) + cancelMs;
    if (now() < from) return { error: 'You can draw after ' + new Date(from).toISOString().slice(0, 16).replace('T', ' ') + ' UTC (24 hours after the end, so late cancellations are counted).' };
    let pool = snapshot().rows.filter(r => r.points > 0 && !r.p.disqualified).map(r => ({ userId: r.p.userId, name: r.p.name, code: r.p.code, points: r.points }));
    if (!pool.length) return { error: 'Nobody has any points yet.' };
    const total = pool.reduce((n, r) => n + r.points, 0), winners = [];
    while (winners.length < c.winners && pool.length) {
      let pick = crypto.randomInt(pool.reduce((n, r) => n + r.points, 0)), i = 0;
      while (pick >= pool[i].points) { pick -= pool[i].points; i++; }
      const w = pool.splice(i, 1)[0]; const u = o.readUsers().find(x => x.id === w.userId) || {};
      winners.push({ ...w, email: u.email || '', phone: u.phone || '', package: rollPackage(c) });
    }
    c.draw = { at: new Date(now()).toISOString(), totalTickets: total, winners };
    save(c); return { ok: true, draw: c.draw };
  }
  function rollGifts() {
    const c = cfg(); if (!c.draw) return { error: 'Draw the winners first.' };
    for (const w of c.draw.winners) w.package = rollPackage(c);
    save(c); return { ok: true };
  }
  const clearDraw = () => { const c = cfg(); c.draw = null; save(c); return { ok: true }; };
  return { publicView, meView, join, adminView, adminSave, flag, draw, rollGifts, clearDraw, phase: () => phase(cfg()), _reset: () => { memo = null; } };
};

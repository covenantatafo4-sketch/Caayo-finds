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
  image: '',       // optional pop-up picture (the shop's own photo or poster)
  prizeItems: []   // [{ name, mode: 'fixed' | 'random', options: [..] }]  one item = one gift in each winner's package
};
const digits = v => String(v || '').replace(/\D/g, '');
// 0803 123 4567, +234 803 123 4567 and 2348031234567 are the same phone: compare the last 10 digits.
const phone10 = v => digits(v).slice(-10);
// a.b+shop@gmail.com and ab@gmail.com are the same inbox.
const normEmail = v => {
  const e = String(v || '').trim().toLowerCase(), at = e.lastIndexOf('@'); if (at < 1) return e;
  let local = e.slice(0, at).split('+')[0], dom = e.slice(at + 1);
  if (dom === 'googlemail.com') dom = 'gmail.com';
  if (dom === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + dom;
};
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'sharklasers.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mailnesia.com', 'tempail.com', 'emailondeck.com', 'mintemail.com', 'moakt.com']);
const CODE_RE = /^[A-Z0-9]{4,12}$/;
const RESERVED = new Set(['CAAYO', 'CAAYOFINDS', 'ADMIN', 'ADMINISTRATOR', 'SUPPORT', 'OFFICIAL', 'STAFF', 'TEAM', 'MODERATOR', 'HELP', 'FREE', 'GIFT', 'GIFTS', 'WINNER', 'WINNERS', 'PRIZE', 'IPHONE', 'TEST', 'TESTING', 'NULL', 'UNDEFINED', 'ADMIN1', 'ROOT', 'SYSTEM', 'PAYSTACK', 'BLACKFRIDAY', 'PROMO', 'CHALLENGE', 'REFERRAL', 'SHOP', 'STORE', 'CUSTOMER']);
const MAX_CODE_CHANGES = 3, DAILY_SIGNUP_CAP = 20;
const maskName = n => { const p = String(n || 'Customer').trim().split(/\s+/); return (p[0].slice(0, 14) + (p[1] ? ' ' + p[1][0].toUpperCase() + '.' : '')) || 'Customer'; };
const isoOrEmpty = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };
const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

const cleanText = (v, n) => String(v || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const cleanImage = v => { const u = String(v || '').trim(); return /^(https:\/\/[^\s<>"']{4,480}|\/uploads\/[a-f0-9]{16}\.(jpg|png|webp))$/.test(u) ? u : ''; };
function cleanItems(raw) {
  if (!Array.isArray(raw)) return { items: null };
  if (raw.length > 10) return { error: 'Use at most 10 gifts in a package.' };
  const items = [];
  for (const it of raw) {
    const name = cleanText(it && it.name, 60); if (!name) continue;
    if (it.mode === 'random') {
      const options = [...new Set((Array.isArray(it.options) ? it.options : String(it.options || '').split(/[,\n]/)).map(x => cleanText(x, 40)).filter(Boolean))].slice(0, 12);
      if (options.length < 2) return { error: '"' + name + '" is set to random, so it needs at least 2 choices (for example iPhone 13, iPhone 14).' };
      items.push({ name, mode: 'random', options, image: cleanImage(it.image) });
    } else items.push({ name, mode: 'fixed', options: [], image: cleanImage(it.image) });
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
  const codesOf = p => [p.code, ...(Array.isArray(p.oldCodes) ? p.oldCodes : [])];
  // Every code that must never be given to someone else: current and old codes of every participant, and the gift-campaign codes.
  const usedCodes = c => { const s = new Set(o.takenCodes ? o.takenCodes() : []); for (const p of c.participants) codesOf(p).forEach(x => s.add(x)); return s; };
  function codeProblem(c, raw, selfId) {
    const code = String(raw || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) return 'Use 4 to 12 letters or numbers only. No spaces or symbols.';
    if (!/[A-Z]/.test(code)) return 'Add at least one letter.';
    if (RESERVED.has(code) || /^CAAYO/.test(code)) return 'This name is reserved. Choose another.';
    const mine = selfId ? c.participants.find(p => p.userId === selfId) : null;
    if (mine && mine.code === code) return 'This is already your name.';
    if (mine && codesOf(mine).includes(code)) return '';   // taking back one of your own old names is fine
    if (usedCodes(c).has(code)) return 'Sorry, someone already uses this name.';
    return '';
  }
  function suggestCode(c, user) {
    const first = String((user && user.name) || '').normalize('NFKD').replace(/[^A-Za-z\s]/g, '').trim().split(/\s+/).filter(Boolean);
    const a = (first[0] || '').toUpperCase().slice(0, 10), b = (first[1] || '').toUpperCase().slice(0, 1);
    const tries = [a, a + b, a.slice(0, 8) + String(crypto.randomInt(10, 100)), a.slice(0, 7) + String(crypto.randomInt(100, 1000)), a.slice(0, 6) + String(crypto.randomInt(1000, 10000))];
    for (const t of tries) if (t.length >= 4 && !codeProblem(c, t, user && user.id)) return t;
    for (let i = 0; i < 50; i++) { const t = 'WIN' + Array.from({ length: 5 }, () => CHARS[crypto.randomInt(CHARS.length)]).join(''); if (!codeProblem(c, t, null)) return t; }
    return '';
  }
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
    // A friend's order counts only when it is real: paid, not cancelled or refunded, past the cancel window, big enough,
    // and not placed with the owner's own phone or email (that is the owner buying for themselves).
    const qualifies = (uid, owner) => orders.some(x => x.userId === uid && x.status === 'paid' && !x.cancelled && !(x.refund && x.refund.status === 'done') && x.paidAt &&
      Date.parse(x.paidAt) >= from && Date.parse(x.paidAt) <= to && now() > Date.parse(x.paidAt) + cancelMs && Number(x.total) >= c.minOrder &&
      !(phone10(owner.phone) && x.customer && phone10(x.customer.phone) === phone10(owner.phone)) &&
      !(normEmail(owner.email) && normEmail(x.email) === normEmail(owner.email)));
    const rows = c.participants.map(p => {
      const owner = users.find(u => u.id === p.userId) || {}, seenPhone = new Set(), seenEmail = new Set(), ipTimes = {}, perDay = {}, referred = [], mine = codesOf(p);
      for (const u of users) {
        if (!mine.includes(String(u.ref || '').toUpperCase()) || u.id === p.userId || String(u.createdAt) < String(p.joinedAt)) continue;
        let reason = '';
        const ph = phone10(u.phone), em = normEmail(u.email), t = Date.parse(u.createdAt) || 0, day = String(u.createdAt).slice(0, 10), dom = em.slice(em.lastIndexOf('@') + 1);
        const needsOk = !c.approved.includes(u.id);
        if (c.excluded.includes(u.id)) reason = 'removed by admin';
        else if ((normEmail(owner.email) && normEmail(owner.email) === em) || (phone10(owner.phone) && phone10(owner.phone) === ph)) reason = 'same person as the owner';
        else if (ph && seenPhone.has(ph)) reason = 'phone already used';
        else if (em && seenEmail.has(em)) reason = 'email already used';
        else if (needsOk && DISPOSABLE.has(dom)) reason = 'temporary email address (needs approval)';
        else if (needsOk && u.signupIp && (ipTimes[u.signupIp] || []).filter(x => t - x < 864e5).length >= 2) reason = '3rd sign-up from one connection (needs approval)';
        else if (needsOk && (perDay[day] || 0) >= DAILY_SIGNUP_CAP) reason = 'more than ' + DAILY_SIGNUP_CAP + ' sign-ups in one day (needs approval)';
        if (ph) seenPhone.add(ph); if (em) seenEmail.add(em);
        if (u.signupIp) (ipTimes[u.signupIp] = ipTimes[u.signupIp] || []).push(t);
        if (!reason || /needs approval/.test(reason)) perDay[day] = (perDay[day] || 0) + (reason ? 0 : 1);
        referred.push({ id: u.id, name: u.name, email: u.email, phone: u.phone, at: u.createdAt, counted: !reason, reason, ordered: !reason && qualifies(u.id, owner) });
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
    return { enabled: c.enabled, phase: phase(c), title: c.title, image: c.image || '', prize: prizeText(c), prizeItems: c.prizeItems.map(i => ({ name: i.name, mode: i.mode, options: i.options, image: i.image || '' })), winners: c.winners, startsAt: c.startsAt, endsAt: c.endsAt,
      minOrder: c.minOrder, ptsSignup: c.ptsSignup, ptsOrder: c.ptsOrder, participants: c.participants.length,
      board: sorted.filter(r => r.points > 0 && !r.p.disqualified).slice(0, 10).map(r => ({ name: maskName(r.p.name), points: r.points })),
      winnersList: c.draw ? c.draw.winners.map(w => ({ name: maskName(w.name), points: w.points, gifts: w.package || [] })) : [], serverNow: new Date(now()).toISOString() };
  };
  const meView = uid => {
    const { c, rows } = snapshot(), r = rows.find(x => x.p.userId === uid);
    return r ? { joined: true, code: r.p.code, changesLeft: Math.max(0, MAX_CODE_CHANGES - (r.p.codeChanges || 0)), points: r.points, signups: r.signups, bigOrders: r.bigOrders, rank: r.points > 0 ? r.rank : 0, disqualified: !!r.p.disqualified, won: !!(c.draw && c.draw.winners.some(w => w.userId === uid)) } : { joined: false };
  };
  function join(user, chosen) {
    const c = cfg(), ph = phase(c);
    if (ph !== 'running') return { error: ph === 'soon' ? 'The challenge has not started yet.' : 'The challenge is not running right now.' };
    const ex = c.participants.find(p => p.userId === user.id);
    if (ex) return { ok: true };
    let code = String(chosen || '').trim().toUpperCase();
    if (code) { const pr = codeProblem(c, code, null); if (pr) return { error: pr }; } else { code = suggestCode(c, user); if (!code) return { error: 'Could not make a name. Try again.' }; }
    c.participants.push({ userId: user.id, code, oldCodes: [], codeChanges: 0, name: String(user.name || 'Customer').slice(0, 60), joinedAt: new Date(now()).toISOString(), disqualified: false });
    save(c); return { ok: true };
  }
  // Change your referral name. Old links keep working and keep your points, and nobody else can ever take an old name.
  function changeCode(user, chosen) {
    const c = cfg(), p = c.participants.find(x => x.userId === user.id);
    if (!p) return { error: 'Join the challenge first.' };
    if (phase(c) !== 'running') return { error: 'The challenge is not running right now.' };
    if (p.disqualified) return { error: 'Your entry was disqualified.' };
    if ((p.codeChanges || 0) >= MAX_CODE_CHANGES) return { error: 'You have used all ' + MAX_CODE_CHANGES + ' name changes.' };
    const code = String(chosen || '').trim().toUpperCase(), pr = codeProblem(c, code, user.id); if (pr) return { error: pr };
    p.oldCodes = [...new Set([...(p.oldCodes || []), p.code])].filter(x => x !== code); p.code = code; p.codeChanges = (p.codeChanges || 0) + 1;
    save(c); return { ok: true };
  }
  const checkCode = (user, raw) => { const c = cfg(), pr = codeProblem(c, raw, user && user.id); return pr ? { ok: false, reason: pr } : { ok: true }; };
  const suggest = user => { const c = cfg(); return { code: suggestCode(c, user) }; };
  const adminView = () => {
    const { c, sorted } = snapshot();
    return { config: { enabled: c.enabled, title: c.title, prize: c.prize, image: c.image || '', prizeItems: c.prizeItems, winners: c.winners, startsAt: c.startsAt, endsAt: c.endsAt, minOrder: c.minOrder, ptsSignup: c.ptsSignup, ptsOrder: c.ptsOrder },
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
    if (b.image !== undefined) c.image = cleanImage(b.image);
    save(c); return { ok: true };
  }
  function flag(kind, userId, on) {
    const c = cfg(), id = String(userId || '');
    if (kind === 'disqualify') { const p = c.participants.find(x => x.userId === id); if (!p) return { error: 'Participant not found.' }; p.disqualified = !!on; }
    else if (kind === 'resetcode') {
      const p = c.participants.find(x => x.userId === id); if (!p) return { error: 'Participant not found.' };
      const nc = suggestCode(c, { id, name: '' }); if (!nc) return { error: 'Could not make a name.' };
      p.oldCodes = [...new Set([...(p.oldCodes || []), p.code])]; p.code = nc;
    }
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
  return { publicView, meView, join, changeCode, checkCode, suggest, hasCode: x => usedCodes(cfg()).has(String(x || '').toUpperCase()), adminView, adminSave, flag, draw, rollGifts, clearDraw, phase: () => phase(cfg()), _reset: () => { memo = null; } };
};

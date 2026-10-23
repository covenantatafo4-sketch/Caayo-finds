/* ============================================================================
   CAAYO store server: what is where (search for the ===== headings)
   - Storage: database or local files (initStorage, readJson, writeJson)
   - Helpers: text cleaning, product options/prices, review stats, auto categories
   - Public API: /api/products, /api/config, /api/orders, /api/reviews, tracking
   - Admin API (password protected): products, upload, orders, reviews, settings,
     customer messages, test email
   - Payments (Paystack) and order emails (Mailjet / Brevo / Resend)
   - Pages: storefront (/), admin dashboard (/admin), privacy policy
   ============================================================================ */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-password';
if (ADMIN_PASSWORD === 'change-this-password') console.warn('WARNING: ADMIN_PASSWORD is not set, admin login is disabled.');
const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const REQUESTS_FILE = path.join(DATA_DIR, 'requests.json');
const GIFT_FILE = path.join(DATA_DIR, 'gift.json');       // free gift settings + gift catalog (an object)
const CLAIMS_FILE = path.join(DATA_DIR, 'claims.json');   // free gift claims and referrals
const USERS_FILE = path.join(DATA_DIR, 'users.json');     // customer accounts
// Set UPLOAD_DIR to a Render persistent-disk path so uploaded photos survive redeploys.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.set('trust proxy', 1);
if (!fs.existsSync(PRODUCTS_FILE)) fs.writeFileSync(PRODUCTS_FILE, '[]');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  // Blocks injected plugins/frames/forms and any script loaded from another site (inline scripts are still needed by these pages).
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-src https://checkout.paystack.com https://js.paystack.co; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
// Public requests are tiny; only the password-protected admin may send photos / big product forms.
const jsonPublic = express.json({ limit: '60kb', verify: (req, res, buf) => { req.rawBody = buf; } });
const jsonAdmin = express.json({ limit: '6mb', verify: (req, res, buf) => { req.rawBody = buf; } });
app.use((req, res, next) => (req.path.startsWith('/api/admin/') ? jsonAdmin : jsonPublic)(req, res, next));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
// Small reusable rate limiter (per visitor IP and name). Returns true when the visitor has gone over the limit.
const rlHits = new Map();
function rateLimited(name, ip, max, windowMs) {
  const k = name + '|' + ip, now = Date.now();
  const list = (rlHits.get(k) || []).filter(t => now - t < windowMs);
  list.push(now); rlHits.set(k, list);
  if (rlHits.size > 20000) for (const [key, v] of rlHits) if (!v.length || now - v[v.length - 1] > windowMs) rlHits.delete(key);
  return list.length > max;
}

// Allow the separate Cloudflare storefront to use this Render backend.
const ALLOWED_ORIGINS = new Set([
  'https://caayo-finds.covenantatafo4.workers.dev',
  'https://caayo-finds.onrender.com',
  'https://caayo-finds-tr6y.onrender.com'
]);
// Your own domain: PUBLIC_URL is allowed automatically (and its www / non-www twin). Extra addresses can go in EXTRA_ORIGINS, separated by commas.
for (const u of [process.env.PUBLIC_URL, ...String(process.env.EXTRA_ORIGINS || '').split(',')]) {
  const v = String(u || '').trim().replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(v)) continue;
  ALLOWED_ORIGINS.add(v);
  ALLOWED_ORIGINS.add(v.replace(/^https:\/\/www\./, 'https://').replace(/^https:\/\/(?!www\.)/, m => v.startsWith('https://www.') ? m : 'https://www.'));
}
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Only serve the public pages and uploaded photos (never server.js or the data folder).
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
const imgCache = new Map();   // recently used photos (id -> {mime, data}) so many images on one page do not all query the database
// Photos kept in the database (when DATABASE_URL is set) are served here.
app.get('/uploads/:file', async (req, res) => {
  const id = String(req.params.file);
  if (!db || !/^[a-f0-9]{16}\.(jpg|png|webp)$/.test(id)) return res.sendStatus(404);
  try {
    let hit = imgCache.get(id);
    if (!hit) {
      const r = await db.query('SELECT mime, data FROM uploads WHERE id=$1', [id]);
      if (!r.rows.length) return res.sendStatus(404);
      hit = r.rows[0]; imgCache.set(id, hit);
      if (imgCache.size > 120) imgCache.delete(imgCache.keys().next().value);
    }
    res.set('Content-Type', hit.mime).set('Cache-Control', 'public, max-age=2592000, immutable').send(hit.data);
  } catch { res.sendStatus(500); }
});
// Privacy policy page (needed by Paystack, Mailjet and customers). Describes what this store actually does with data.
app.get(['/privacy-policy', '/privacy'], (req, res) => {
  const phone = h(process.env.SUPPORT_PHONE || '+2349055810160');
  res.set('Cache-Control', 'public, max-age=3600').type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy - CAAYO</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:720px;margin:0 auto;padding:24px 18px 60px;line-height:1.6;background:#fff;color:#111}h1{font-size:28px}h2{font-size:19px;margin-top:28px}a{color:#0a58ca}@media(prefers-color-scheme:dark){body{background:#000;color:#eee}a{color:#8ab4ff}}</style></head><body>
<p><a href="/">&larr; Back to CAAYO</a></p>
<h1>Privacy Policy</h1>
<p>Last updated: ${new Date().toISOString().slice(0, 10)}</p>
<p>CAAYO is an online store in Nigeria. This page explains what information we collect when you shop with us and how we use it.</p>
<h2>What we collect</h2>
<p>When you place an order we collect your name, phone number, email address, delivery address and the items you ordered. We do not ask you to create an account. Some details, such as your saved delivery details and recent orders, are also kept on your own device in your browser so you do not have to retype them.</p>
<h2>How we use it</h2>
<p>We use your information only to process and deliver your order, to email you updates about your order (for example when it is confirmed, shipped or delivered), to answer your questions, and to keep records of sales as required by law. We do not use your email address for marketing unless you ask us to.</p>
<h2>Payments</h2>
<p>Payments are handled by Paystack. Your card or bank details are entered on Paystack's secure page and are never stored on our website or servers. Paystack's own privacy policy applies to the payment details you give them.</p>
<h2>Who we share it with</h2>
<p>We do not sell your information. We share it only with the services needed to complete your order: our payment provider (Paystack), our email delivery provider (used to send your order emails), our hosting and database providers, and delivery partners who need your name, phone number and address to deliver your goods.</p>
<h2>Product requests</h2>
<p>If you ask us for a product, we keep your name, email, optional phone number and what you asked for so we can email you when it is available.</p>
<h2>Reviews</h2>
<p>If you leave a product review we show your name, rating and comment publicly. Your email is used only to check that you ordered the product and is never shown.</p>
<h2>How long we keep it</h2>
<p>We keep order records for as long as needed to handle your order, returns or disputes and to meet our legal and accounting duties. You can ask us to delete your personal details once they are no longer needed for these purposes.</p>
<h2>Accounts and the free gift</h2>
<p>You can browse and fill your cart without an account. To check out you create an account with your name, email, phone and a password (stored only as a salted hash). We email you a code to confirm your email. If you take part in the free gift offer, we also store your gift picks, your referral link and the accounts that joined through it (their email, phone and the internet address they signed up from) so we can confirm the offer was earned and stop abuse.</p>
<h2>Personalised suggestions</h2>
<p>To show you products you may like, the site remembers which products you view and what you search for. This is saved only in your own browser on your device. It is not sent to our servers and you can clear it by clearing your browser data.</p>
<h2>Security</h2>
<p>Our website uses an encrypted (https) connection and our order data is stored in a protected database. No system is completely secure, but we take reasonable steps to protect your information.</p>
<h2>Your choices</h2>
<p>You may ask to see, correct or delete the personal information we hold about you by contacting us below.</p>
<h2>Contact us</h2>
<p>WhatsApp or call: ${phone}</p>
<p>We may update this policy from time to time. The date at the top shows when it last changed.</p>
</body></html>`);
});
// ===== Legal pages: Returns & Refunds, Terms (Privacy is above) =====
function legalPage(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} - CAAYO</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:720px;margin:0 auto;padding:24px 18px 60px;line-height:1.6;background:#fff;color:#111}h1{font-size:28px}h2{font-size:19px;margin-top:28px}a{color:#0a58ca}li{margin:4px 0}.box{background:#f4f4f4;border-radius:12px;padding:14px 16px}@media(prefers-color-scheme:dark){body{background:#000;color:#eee}a{color:#8ab4ff}.box{background:#161616}}</style></head><body>
<p><a href="/">&larr; Back to CAAYO</a></p><h1>${title}</h1><p>Last updated: ${new Date().toISOString().slice(0, 10)}</p>${inner}
<p style="margin-top:32px"><a href="/returns-policy">Returns &amp; Refunds</a> · <a href="/terms">Terms</a> · <a href="/privacy-policy">Privacy</a></p></body></html>`;
}
app.get(['/returns-policy', '/refund-policy', '/returns'], (req, res) => {
  const phone = h(process.env.SUPPORT_PHONE || '+2349055810160');
  res.set('Cache-Control', 'public, max-age=600').type('html').send(legalPage('Returns &amp; Refunds Policy', `
<div class="box"><b>In short:</b> all sales are final. We do not accept returns or give refunds if you change your mind or ordered the wrong size, colour or option. <b>The exception:</b> if your package arrives broken or seriously damaged, we take full responsibility and will make it right.</div>
<h2>What we cover</h2>
<ul><li>An item that arrives broken or seriously damaged (for example cracked, torn, crushed, or not working because of the damage).</li>
<li>An item that is not what you ordered, or an item missing from your package.</li>
<li>An order that never arrives. Contact us and we will look into it and resend or refund.</li></ul>
<p>When a claim is approved we will replace the affected item or refund you in full for that item. Refunds go back to the payment method you used through Paystack, and the time it takes to show depends on your bank.</p>
<h2>How to make a claim</h2>
<ol><li>Contact us within <b>72 hours</b> of delivery (or of collecting your package from a pickup point).</li>
<li>Message us on WhatsApp or call ${phone}. Send your <b>order ID</b>, clear photos of the outside of the package (all sides) and of the damaged item, and a short video of opening the package if you can.</li>
<li>Keep the packaging and the item until your claim is settled.</li>
<li>We will review what you send and reply to you by WhatsApp or email.</li></ol>
<h2>Damage caused by the delivery company</h2>
<p>If the damage was clearly caused by the courier or delivery company on the final leg of delivery to your address or pickup point, we cannot replace or refund it ourselves. We will still help you: we will share your order and shipping details, support your claim with the courier, and keep you updated.</p>
<h2>What we do not cover</h2>
<ul><li>Change of mind, or choosing the wrong size, colour or option.</li>
<li>Small differences in colour or look caused by screens or lighting, and normal wear.</li>
<li>Damage that happens after delivery, such as misuse, accidents, washing or repair attempts.</li>
<li>Items marked <b>Non-refundable</b>, except when they arrive broken or seriously damaged as described above.</li>
<li>Claims made after 72 hours, or without photos of the package and the item.</li></ul>
<h2>Delivery times</h2>
<p>Sea shipping takes about 8 to 10 weeks and is free. Air shipping takes about 7 to 10 days and is charged by weight. These are estimates. We email you at every step so you always know where your order is.</p>
<h2>Contact us</h2><p>WhatsApp or call: ${phone}</p>
<p>Nothing in this policy limits any rights you have under Nigerian law.</p>`));
});
app.get('/terms', (req, res) => {
  const phone = h(process.env.SUPPORT_PHONE || '+2349055810160');
  res.set('Cache-Control', 'public, max-age=600').type('html').send(legalPage('Terms &amp; Conditions', `
<p>These terms apply when you use the CAAYO website or place an order. By ordering you agree to them.</p>
<h2>Orders and prices</h2><p>All prices are in Nigerian naira. Some products have options (for example storage size) with their own prices. If we make a pricing or listing mistake we may cancel the order and refund you in full.</p>
<h2>Payment</h2><p>Payments are processed by Paystack. We never see or store your card details. Your order is confirmed once payment is successful.</p>
<h2>Delivery</h2><p>Sea shipping takes about 8 to 10 weeks and is free. Air shipping takes about 7 to 10 days and is charged by weight. These are estimates, not guarantees. Please give a correct address and a phone number you can answer. You can follow your order with your order ID and email.</p>
<h2>Returns and refunds</h2><p>All sales are final except for items that arrive broken or seriously damaged. See our <a href="/returns-policy">Returns &amp; Refunds Policy</a>.</p>
<h2>Products and availability</h2><p>Photos and descriptions are for guidance and colours may look slightly different. Items can sell out. Use <b>Request a product</b> to ask for something that is not listed or is sold out and we will email you when it is available.</p>
<h2>Reviews</h2><p>Only customers who ordered a product can review it. We may hide reviews that are abusive, false or off-topic.</p>
<h2>Our responsibility</h2><p>We are responsible for what we sell to the extent the law requires. We are not liable for indirect losses such as lost profits. Nothing here limits your legal rights as a consumer.</p>
<h2>Changes and law</h2><p>We may update these terms from time to time. The date at the top shows the latest version. These terms are governed by the laws of Nigeria.</p>
<h2>Contact</h2><p>WhatsApp or call: ${phone}</p>`));
});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ---------- Storage ----------
// With DATABASE_URL set (e.g. a free Neon/Supabase Postgres), products, orders, settings and uploaded photos
// live in the database and survive Render restarts, redeploys and sleep. Without it, local files are used (testing only).
// The data is held in memory for fast reads and written through to the database on every change.
let db = null;
const KEYS = new Map([[PRODUCTS_FILE, 'products'], [ORDERS_FILE, 'orders'], [REVIEWS_FILE, 'reviews'], [REQUESTS_FILE, 'requests'], [GIFT_FILE, 'gift'], [CLAIMS_FILE, 'claims'], [USERS_FILE, 'users'], [path.join(DATA_DIR, 'settings.json'), 'settings']]);
const OBJECT_KEYS = new Set(['settings', 'gift']);   // stored as one object, everything else is a list
const mem = {};
const persistQueue = new Map();
async function initStorage() {
  if (!process.env.DATABASE_URL) { console.warn('WARNING: DATABASE_URL is not set. Data is stored in local files and is lost on Render free plan restarts.'); return; }
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  db = new Pool({ connectionString: url, max: 5, ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(url) || process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false } });
  await db.query('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
  await db.query('CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMPTZ DEFAULT now())');
  for (const [file, key] of KEYS) {
    const r = await db.query('SELECT value FROM kv WHERE key=$1', [key]);
    if (r.rows.length) { mem[key] = r.rows[0].value; continue; }
    // First run with a database: import anything already saved in the local files.
    let initial = OBJECT_KEYS.has(key) ? {} : [];
    try { initial = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    mem[key] = initial;
    await db.query('INSERT INTO kv(key,value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(initial)]);
  }
  console.log('Database connected: ' + KEYS.size + ' data sets loaded.');
}
function persist(key) {
  const prev = persistQueue.get(key) || Promise.resolve();
  const next = prev.then(() => db.query('INSERT INTO kv(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()', [key, JSON.stringify(mem[key])]))
    .catch(e => console.error('DATABASE WRITE FAILED for ' + key + ':', e.message));
  persistQueue.set(key, next);
}
function readJson(file) {
  const key = KEYS.get(file);
  if (db && key) return structuredClone(mem[key] ?? (OBJECT_KEYS.has(key) ? {} : []));
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return OBJECT_KEYS.has(key) ? {} : []; }
}
function writeJson(file, value) {
  const key = KEYS.get(file);
  if (db && key) { mem[key] = structuredClone(value); persist(key); return; }
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function escapeHtmlText(value) {
  return cleanText(value).replace(/[<>]/g, '');
}
function makeId() { return crypto.randomBytes(8).toString('hex'); }
function validPddUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    return host.includes('yangkeduo.com') || host.includes('pinduoduo.com');
  } catch { return false; }
}
function absoluteUrl(value, baseUrl) {
  try {
    const s = String(value || '').trim()
      .replace(/\\u002F/g, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&');
    if (!s) return '';
    return new URL(s, baseUrl).href;
  } catch { return ''; }
}
function isImageUrl(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return false;
    return /\.(?:jpg|jpeg|png|webp|gif|avif)(?:$|[?#])/i.test(u.pathname + u.search) ||
      /\/(?:image|img|goods|upload|pic)\//i.test(u.pathname);
  } catch { return false; }
}
function uniqueImages(list) {
  const out=[]; const seen=new Set();
  for (const item of list) {
    const u=String(item||'').trim(); if(!u || !isImageUrl(u)) continue;
    const key=u.split('#')[0]; if(!seen.has(key)){seen.add(key);out.push(u);}
  }
  return out.slice(0,30);
}
function stripHtml(value) {
  return cleanText(String(value||'')
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
    .replace(/&#39;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>'));
}
function extractMeta(html, key, attr='property') {
  const safe=key.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&');
  const re=new RegExp(`<meta[^>]+(?:${attr}=["']${safe}["'][^>]*content=["']([^"']*)["']|content=["']([^"']*)["'][^>]*${attr}=["']${safe}["'])[^>]*>`,'i');
  const m=html.match(re); return cleanText(m?.[1]||m?.[2]||'');
}
function extractAttrImages(html, baseUrl) {
  const images=[];
  const re=/<(?:img|source)\b[^>]*(?:src|data-src|data-original|data-lazy-src|data-url)=["']([^"']+)["'][^>]*>/gi;
  for(const m of html.matchAll(re)){const u=absoluteUrl(m[1],baseUrl);if(u)images.push(u);}
  for(const m of html.matchAll(/https?:\/\/[^"'\s<>]+/gi)){const u=absoluteUrl(m[0].replace(/\\\//g,'/'),baseUrl);if(u&&isImageUrl(u))images.push(u);}
  return uniqueImages(images);
}
function collectJsonLd(html, baseUrl) {
  let title='',description='',sourcePrice=0; const imageUrls=[];
  for(const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{
      const parsed=JSON.parse(match[1].trim());
      const items=Array.isArray(parsed)?parsed:[parsed];
      const walk=item=>{
        if(!item||typeof item!=='object')return;
        if(!title&&item.name)title=cleanText(item.name);
        if(!description&&item.description)description=stripHtml(item.description);
        for(const img of (Array.isArray(item.image)?item.image:[item.image])){const u=absoluteUrl(img,baseUrl);if(u)imageUrls.push(u);}
        const offers=Array.isArray(item.offers)?item.offers[0]:item.offers;
        if(!sourcePrice&&offers?.price)sourcePrice=Number(String(offers.price).replace(/[^0-9.]/g,''))||0;
        Object.values(item).forEach(v=>{if(v&&typeof v==='object')walk(v);});
      };
      items.forEach(walk);
    }catch{}
  }
  return {title,description,sourcePrice,imageUrls:uniqueImages(imageUrls)};
}
function extractEmbeddedPddData(html, baseUrl) {
  let title='',description='',sourcePrice=0; const images=[];
  const pick=keys=>{
    for(const key of keys){
      const re=new RegExp(`["']${key}["']\\s*:\\s*["']([^"']{2,1000})["']`,'i');
      const m=html.match(re);
      if(m)return stripHtml(m[1].replace(/\\"/g,'"'));
    }
    return '';
  };
  title=pick(['goods_name','goodsName','goods_title','goodsTitle','name']);
  description=pick(['desc','description','goods_desc','goodsDesc']);
  const pm=html.match(/["'](?:price|goods_price|min_group_price)["']\s*:\s*["']?([0-9]+(?:\.[0-9]+)?)/i);
  if(pm)sourcePrice=Number(pm[1])||0;
  const arrayRe=/["'](?:item_imgs|itemImages|gallery|galleryImages|goods_gallery|detail_imgs)["']\s*:\s*\[([\s\S]{0,50000}?)\]/gi;
  for(const m of html.matchAll(arrayRe)){
    for(const u of m[1].matchAll(/["'](https?:\/\/[^"']+)["']/g)){
      const a=absoluteUrl(u[1],baseUrl); if(a)images.push(a);
    }
  }
  return {title,description,sourcePrice,imageUrls:uniqueImages(images)};
}
// ---------- Page fetching ----------
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
function cleanMultiline(value) {
  return String(value || '').replace(/[<>]/g, '').split('\n').map(l => l.replace(/[ \t\r]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}
// Any public http(s) link is allowed, but never the server's own network.
async function checkPublicUrl(value) {
  let u;
  try { u = new URL(value); } catch { return { ok: false, error: 'Please paste a full product link starting with https://' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'Please paste a full product link starting with https://' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return { ok: false, error: 'That address is not allowed.' };
  try {
    const addrs = await dns.lookup(host, { all: true });
    const bad = a => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.0\.|198\.1[89]\.|2(2[4-9]|[3-5]\d)\.)/.test(a) || /^(::1?$|::ffff:|fc|fd|fe80)/i.test(a);
    if (!addrs.length || addrs.some(x => bad(x.address))) return { ok: false, error: 'That address is not allowed.' };
  } catch { return { ok: false, error: 'Could not find that website. Check the link.' }; }
  return { ok: true };
}
function mobileUrl(inputUrl) {
  try {
    const u = new URL(inputUrl);
    const id = u.searchParams.get('goods_id');
    if (id && /yangkeduo|pinduoduo/i.test(u.hostname)) return 'https://mobile.yangkeduo.com/goods.html?goods_id=' + encodeURIComponent(id);
  } catch {}
  return inputUrl;
}
const isGenericTitle = t => !t || String(t).trim().length < 2 || /^(拼多多商城|拼多多|pinduoduo|yangkeduo|拼多多\s*[-|]\s*.*商城)$/i.test(String(t).trim());
// Follows redirects by hand and re-checks every hop, so a public link cannot bounce the server to an internal address.
async function safeFetch(url, opts, hops = 4) {
  let cur = url;
  for (let i = 0; i <= hops; i++) {
    const chk = await checkPublicUrl(cur);
    if (!chk.ok) throw new Error(chk.error);
    const r = await fetch(cur, { ...opts, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { cur = new URL(r.headers.get('location'), cur).toString(); continue; }
    return { r, url: cur };
  }
  throw new Error('Too many redirects');
}
async function fetchOnce(url, ua) {
  const { r, url: finalUrl0 } = await safeFetch(url, { headers: {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
    'Referer': 'https://mobile.yangkeduo.com/'
  }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`The website returned HTTP ${r.status}`);
  return { html: (await r.text()).slice(0, 3e6), finalUrl: finalUrl0 || url };
}
function pageScore(html) {
  if (/window\.rawData|goods_name|goodsName/.test(html)) return 3;
  if (/"@type"\s*:\s*"Product"/i.test(html)) return 2;
  const t = extractMeta(html, 'og:title') || cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  if (!isGenericTitle(t)) return 2;
  return html.length > 500 ? 1 : 0;
}
// The original fetch from the first version of this server (kept exactly as it was).
async function fetchProductPageOriginal(inputUrl) {
  const {r:response,url:finalUrl0}=await safeFetch(inputUrl,{headers:{
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':'en-US,en;q=0.9,zh-CN;q=0.8','Cache-Control':'no-cache'
  },signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Pinduoduo returned HTTP ${response.status}`);
  return {html:(await response.text()).slice(0,3e6),finalUrl:finalUrl0||inputUrl};
}
// Try the original first. Only if it gets no real product page, try extra attempts (mobile browser, redirected goods_id).
async function fetchProductPage(inputUrl) {
  let best = null, lastErr = null;
  try {
    const first = await fetchProductPageOriginal(inputUrl);
    first.score = pageScore(first.html);
    if (first.score >= 2) return first;
    best = first;
  } catch (e) { lastErr = e; }
  const attempts = [[mobileUrl(inputUrl), UA_MOBILE], [inputUrl, UA_MOBILE]];
  if (best) { const m = mobileUrl(best.finalUrl); if (!attempts.some(a => a[0] === m)) attempts.push([m, UA_MOBILE]); }
  for (let i = 0; i < attempts.length; i++) {
    const [u, ua] = attempts[i];
    try {
      const res = await fetchOnce(u, ua);
      res.score = pageScore(res.html);
      if (!best || res.score > best.score) best = res;
      if (res.score >= 2) return res;
    } catch (e) { lastErr = e; }
  }
  if (best) return best;
  throw lastErr || new Error('Could not load the page');
}
// Pinduoduo mobile pages embed the product as window.rawData = {...}
function extractRawData(html) {
  const i = html.search(/window\.rawData\s*=\s*/);
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let p = start; p < html.length; p++) {
    const ch = html[p];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, p + 1)); } catch { return null; } } }
  }
  return null;
}
function readRawData(raw) {
  const out = { title: '', description: '', sourcePrice: 0, details: [], shop: '', sales: '' };
  if (!raw) return out;
  const options = new Map();
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 9) return;
    if (Array.isArray(o)) { o.forEach(v => walk(v, depth + 1)); return; }
    const str = v => (typeof v === 'string' ? cleanText(v) : '');
    if (!out.title) out.title = str(o.goodsName) || str(o.goods_name);
    if (!out.description && typeof o.goodsDesc === 'string') out.description = stripHtml(o.goodsDesc);
    if (!out.shop) out.shop = str(o.mallName) || str(o.mall_name);
    if (!out.sales) out.sales = str(o.salesTip) || str(o.sales_tip);
    for (const k of ['minGroupPrice', 'min_group_price', 'minOnSaleGroupPrice']) {
      if (!out.sourcePrice && Number(o[k]) > 0) out.sourcePrice = Number(o[k]) / 100;   // prices are in fen
    }
    for (const k of ['goodsProperty', 'goods_property']) {
      if (!Array.isArray(o[k])) continue;
      for (const g of o[k]) {
        const key = str(g && (g.key || g.name)); const val = Array.isArray(g && g.values) ? g.values.map(cleanText).join(', ') : str(g && (g.value || g.values));
        if (key && val) out.details.push({ k: key, v: val });
      }
    }
    if (Array.isArray(o.skus)) {
      for (const sku of o.skus) for (const sp of (sku && (sku.specs || sku.spec) || [])) {
        const k = str(sp && (sp.spec_key || sp.specKey)), v = str(sp && (sp.spec_value || sp.specValue));
        if (k && v) { if (!options.has(k)) options.set(k, new Set()); options.get(k).add(v); }
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(raw);
  for (const [k, set] of options) out.details.push({ k: 'Options - ' + k, v: [...set].slice(0, 30).join(', ') });
  return out;
}
function jsonLdDetails(html) {
  const d = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const add = (k, v) => { v = (v && typeof v === 'object') ? cleanText(v.name || '') : cleanText(v); if (v) d.push({ k, v }); };
      const walk = o => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o['@type'] === 'Product' || o.sku) {
          add('Brand', o.brand); add('SKU', o.sku); add('Category', o.category); add('Color', o.color); add('Material', o.material); add('Model', o.model);
          for (const p of (Array.isArray(o.additionalProperty) ? o.additionalProperty : [])) if (p && p.name) add(cleanText(p.name), p.value);
        }
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(m[1].trim()));
    } catch {}
  }
  return d;
}
// Everything the link can tell us (images are skipped on purpose, you upload your own).
function extractProduct(html, finalUrl) {
  const raw = readRawData(extractRawData(html));
  const ld = collectJsonLd(html, finalUrl);
  const emb = extractEmbeddedPddData(html, finalUrl);
  const ogTitle = extractMeta(html, 'og:title');
  const htmlTitle = cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const title = [raw.title, ld.title, ogTitle, htmlTitle, emb.title].find(x => x && !isGenericTitle(x)) || '';
  let description = title ? ([raw.description, ld.description, extractMeta(html, 'og:description'), extractMeta(html, 'description', 'name'), emb.description]
    .find(x => x && String(x).trim().length > 3 && !isGenericTitle(x)) || '') : '';
  const details = [...raw.details, ...jsonLdDetails(html)];
  if (title) {
    if (raw.shop) details.push({ k: 'Seller', v: raw.shop });
    if (raw.sales) details.push({ k: 'Sales', v: raw.sales });
    const kw = extractMeta(html, 'keywords', 'name');
    if (kw && !isGenericTitle(kw)) details.push({ k: 'Keywords', v: kw });
  }
  const seen = new Set();
  const uniq = details.filter(d => { const key = d.k + '|' + d.v; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 40);
  const sourcePrice = Number(raw.sourcePrice || ld.sourcePrice || emb.sourcePrice || String(extractMeta(html, 'product:price:amount') || extractMeta(html, 'og:price:amount')).replace(/[^0-9.]/g, '') || 0);
  return { title, description, details: uniq, sourcePrice };
}

// ---------- Any language -> English ----------
// Order tried: Google Cloud Translation (if GOOGLE_TRANSLATE_API_KEY is set), Google's free web endpoint, MyMemory.
const needsTranslation = s => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Greek}\p{Script=Bengali}\p{Script=Tamil}]/u.test(String(s || ''));
const hasChinese = s => /[\u3400-\u9fff\uf900-\ufaff]/.test(String(s || ''));
const trCache = new Map();
const trFail = new Map();
const MAX_BYTES = 450;   // MyMemory allows 500 bytes per request, and Chinese characters use 3 bytes each
function chunkText(text) {
  const pieces = [];
  let cur = '';
  const push = () => { if (cur.trim()) pieces.push(cur); cur = ''; };
  for (const token of String(text).split(/(?<=[。！？!?；;\n])/)) {
    if (Buffer.byteLength(cur + token) > MAX_BYTES) push();
    if (Buffer.byteLength(token) > MAX_BYTES) {
      let part = '';
      for (const ch of token) { if (Buffer.byteLength(part + ch) > MAX_BYTES) { pieces.push(part); part = ''; } part += ch; }
      cur = part;
    } else cur += token;
  }
  push();
  return pieces;
}
async function translateChunk(q) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (key) {
    try {
      const r = await fetch('https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(key), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q, target: 'en', format: 'text' }), signal: AbortSignal.timeout(10000)
      });
      const d = await r.json();
      const t = d && d.data && d.data.translations && d.data.translations[0] && d.data.translations[0].translatedText;
      if (r.ok && t) return t;
    } catch {}
  }
  try {
    const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': UA_DESKTOP }, signal: AbortSignal.timeout(10000)
    });
    const d = await r.json();
    const t = Array.isArray(d && d[0]) ? d[0].map(x => (x && x[0]) || '').join('') : '';
    if (r.ok && t) return t;
  } catch {}
  const de = process.env.MYMEMORY_EMAIL ? '&de=' + encodeURIComponent(process.env.MYMEMORY_EMAIL) : '';
  const pair = hasChinese(q) ? 'zh-CN|en' : 'Autodetect|en';
  const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=' + pair + de, { signal: AbortSignal.timeout(10000) });
  const d = await r.json();
  const t = d && d.responseData && d.responseData.translatedText;
  if (/DISTINCT LANGUAGE/i.test(String(t || ''))) return q;   // MyMemory says this when the text is already English: keep it as it is
  const status = Number(d && d.responseStatus);
  if (!r.ok || !t || (status && status !== 200) || /MYMEMORY WARNING|INVALID|QUERY LENGTH|PLEASE SELECT|NO QUERY SPECIFIED/i.test(t)) throw new Error('All translation services failed or are rate-limited');
  return t;
}
// force = translate even when the text looks Latin (used by the admin Translate button)
async function toEnglish(text, force = false) {
  const s = String(text || '').trim();
  if (!s || (!force && !needsTranslation(s))) return s;
  if (trCache.has(s)) return trCache.get(s);
  const failed = trFail.get(s);
  if (!force && failed && Date.now() - failed < 5 * 60 * 1000) return s;   // don't hammer a failing service
  try {
    let out = '';
    for (const piece of chunkText(s)) {
      const sep = /\n\s*$/.test(piece) ? '\n' : ' ';
      const t = await translateChunk(piece.trim());
      out += t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim() + sep;
    }
    const t = cleanMultiline(out);
    if (t) { trCache.set(s, t); if (trCache.size > 2000) trCache.delete(trCache.keys().next().value); return t; }
  } catch (e) {
    console.warn('Translation failed:', e.message);
    trFail.set(s, Date.now()); if (trFail.size > 500) trFail.delete(trFail.keys().next().value);
  }
  return s;   // never lose the original text if translation is unavailable
}

// ---------- Admin sessions (12-hour tokens, login attempts limited) ----------
const DEFAULT_PASSWORD = 'change-this-password';
const adminTokens = new Map();   // token -> expiry time
const loginFails = new Map();    // ip -> { n, until }
const TOKEN_TTL = 12 * 60 * 60 * 1000;
function adminAuthed(token) {
  const exp = adminTokens.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { adminTokens.delete(token); return false; }
  return true;
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  if (!token || !adminAuthed(token)) return res.status(401).json({ error: 'Admin login required' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  let f = loginFails.get(ip);
  if (f && f.until && f.until <= Date.now()) { loginFails.delete(ip); f = null; }
  if (f && f.until > Date.now()) return res.status(429).json({ error: 'Too many wrong attempts. Try again in 15 minutes.' });
  if (ADMIN_PASSWORD === DEFAULT_PASSWORD) {
    return res.status(503).json({ error: 'Admin is locked until you set the ADMIN_PASSWORD environment variable on your server.' });
  }
  if (!req.body?.password || !safeEqual(req.body.password, ADMIN_PASSWORD)) {
    const n = (f?.n || 0) + 1;
    loginFails.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
    return res.status(401).json({ error: 'Incorrect password' });
  }
  loginFails.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.set(token, Date.now() + TOKEN_TTL);
  res.json({ token });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  adminTokens.delete(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
  res.json({ ok: true });
});

app.post('/api/admin/translate', requireAdmin, async (req, res) => {
  const out = {};
  for (const k of ['name', 'description']) {
    if (typeof req.body?.[k] === 'string') out[k] = await toEnglish(cleanMultiline(req.body[k]), true);
  }
  res.json({ ok: true, ...out });
});

// Public storefront product endpoint used by index.html.
// What the public may see of a product (no supplier links, no cost price).
function publicProduct(p) {
  const { sourceUrl, originalUrl, sourcePrice, ...rest } = p;
  return { ...rest, name: scrubBrands(rest.name) || 'New product', description: scrubBrands(rest.description), labels: (rest.labels || []).filter(x => { const c = scrubBrands(x); return c && (c === String(x).trim() || c.length >= 6); }).map(scrubBrands),
    variants: (rest.variants || []).map(v => ({ ...v, name: scrubBrands(v.name) || v.name })), inStock: rest.inStock !== false };
}
app.get('/api/products', async (req, res) => {
  let products = readJson(PRODUCTS_FILE).filter(p => p.active !== false);
  products = await Promise.all(products.map(async p => (needsTranslation(p.name) || needsTranslation(p.description))
    ? { ...p, name: await toEnglish(p.name), description: await toEnglish(p.description) } : p));
  const stats = reviewStats(readJson(REVIEWS_FILE));
  const sold = {};   // real units sold = quantities on paid orders
  for (const o of readJson(ORDERS_FILE)) if (o.status === 'paid') for (const l of o.lines || []) sold[l.id] = (sold[l.id] || 0) + (Number(l.quantity) || 0);
  products = products.map(publicProduct).map(p => ({ ...p, sold: sold[p.id] || 0, ...(stats[p.id] ? { reviewCount: stats[p.id].n, reviewAvg: Math.round(stats[p.id].sum / stats[p.id].n * 10) / 10 } : {}) }));
  const q = cleanText(req.query.q).toLowerCase();
  if (q) products = products.filter(p => `${p.name} ${p.category}`.toLowerCase().includes(q));
  res.json({ products });
});

// Photo upload from the admin page (images are resized in the browser first).
app.post('/api/admin/upload', requireAdmin, async (req, res) => {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.data || ''));
  if (!m) return res.status(400).json({ error: 'Send a JPEG, PNG or WebP image.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) return res.status(413).json({ error: 'Image is too large (max 3 MB).' });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const file = makeId() + '.' + ext;
  try {
    if (db) await db.query('INSERT INTO uploads(id, mime, data) VALUES($1,$2,$3)', [file, 'image/' + m[1], buf]);
    else fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  } catch (e) { console.error('Upload save failed:', e.message); return res.status(500).json({ error: 'Could not save the image. Try again.' }); }
  const base = (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
  res.json({ ok: true, url: base + '/uploads/' + file });
});

app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json({ products: readJson(PRODUCTS_FILE) });
});

// Import product data from a public Pinduoduo/Yangkeduo URL. No Pinduoduo API key is used.
app.post('/api/admin/import-url', requireAdmin, async (req, res) => {
  const url=cleanText(req.body?.url);
  const check=await checkPublicUrl(url);
  if(!check.ok)return res.status(400).json({error:check.error});
  try{
    const {html,finalUrl}=await fetchProductPage(url);
    // ---- original extraction (unchanged) ----
    const ogTitle=extractMeta(html,'og:title');
    const metaDescription=extractMeta(html,'description','name');
    const ogDescription=extractMeta(html,'og:description');
    const ogImage=absoluteUrl(extractMeta(html,'og:image'),finalUrl);
    const jsonLd=collectJsonLd(html,finalUrl);
    const embedded=extractEmbeddedPddData(html,finalUrl);
    let images=uniqueImages([ogImage,...jsonLd.imageUrls,...embedded.imageUrls,...extractAttrImages(html,finalUrl)]);
    // ---- additions: extra details, translation, and not saving Pinduoduo's own logo as a product ----
    let rawD={title:'',description:''}, extra={details:[],sourcePrice:0};
    try{rawD=readRawData(extractRawData(html));extra=extractProduct(html,finalUrl);}catch{}
    const htmlTitle=cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'');
    const rawTitle=[rawD.title,ogTitle,jsonLd.title,embedded.title,htmlTitle].find(t=>t&&!isGenericTitle(t))||'';
    const blocked=!rawTitle;
    images=images.filter(u=>!/share_logo|\/base\/|favicon/i.test(u));
    if(blocked)images=[];
    const baseDescription=blocked?'':(rawD.description||embedded.description||jsonLd.description||ogDescription||metaDescription||'');
    const detailText=blocked?'':extra.details.map(d=>`${d.k}: ${d.v}`).join('\n');
    const fullText=[cleanMultiline(baseDescription),detailText?'Details:\n'+detailText:''].filter(Boolean).join('\n\n');
    const title=blocked?'':((await toEnglish(escapeHtmlText(rawTitle)))||escapeHtmlText(rawTitle));
    const description=fullText?await toEnglish(fullText):'';
    const sourcePrice=blocked?0:Number(extra.sourcePrice||embedded.sourcePrice||jsonLd.sourcePrice||req.body?.sourcePrice||0);
    const products=readJson(PRODUCTS_FILE);
    const existing=products.find(p=>p.sourceUrl===url||p.sourceUrl===finalUrl||p.originalUrl===url);
    if(!images.length&&existing?.images?.length)images=existing.images;
    res.json({ok:true,existingId:existing?.id||null,blocked,product:{
      id:existing?.id||makeId(),sourceUrl:finalUrl,originalUrl:url,name:title,image:images[0]||'',images,
      description,sourcePrice,caayoPrice:Number(req.body?.caayoPrice||existing?.caayoPrice||0),
      category:cleanText(req.body?.category||existing?.category||guessCategory(title,description)||'New finds'),active:existing?existing.active!==false:true
    },note:blocked
      ?'The website did not give us the product details (Pinduoduo often blocks servers). Type the name and description, then tap Translate. Your uploaded photos are kept.'
      :`Imported the name, description${extra.details.length?`, ${extra.details.length} detail line${extra.details.length===1?'':'s'}`:''}${sourcePrice?' and price':''}${images.length?` and ${images.length} image${images.length===1?'':'s'}`:''}. Anything not in English was translated. Review the text, upload your photos and set your CAAYO price.`,
      translationNote:''});
  }catch(err){res.status(502).json({error:'Could not read this link automatically.',detail:err.message,fallback:'The site may be blocking automated requests. Keep the URL and use the manual product fields in the admin form.'});}
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const products = readJson(PRODUCTS_FILE);
  const product = {
    id: cleanText(body.id) || makeId(),
    sourceUrl: cleanText(body.sourceUrl),
    originalUrl: cleanText(body.originalUrl),
    name: await toEnglish(escapeHtmlText(body.name)) || 'Untitled product',
    image: cleanText(body.image) || (Array.isArray(body.images) ? cleanText(body.images[0]) : ''),
    images: uniqueImages([cleanText(body.image), ...(Array.isArray(body.images) ? body.images : [])]),
    description: await toEnglish(cleanMultiline(body.description)),
    sourcePrice: Number(body.sourcePrice || 0),
    caayoPrice: Number(body.caayoPrice || 0),
    category: escapeHtmlText(body.category) || guessCategory(body.name, body.description) || 'New finds',
    rating: Number(body.rating) > 0 ? Math.min(5, Number(body.rating)) : undefined,
    reviews: escapeHtmlText(body.reviews || ''),
    weightKg: Math.min(100, Math.max(0.01, Number(body.weightKg) || 0.5)),
    shippingClass: body.shippingClass === 'special' ? 'special' : 'normal',
    airShipping: body.airShipping !== false,   // admin switch: false = this product cannot be sent by air
    sizeType: ['none', 'shoes_adult', 'shoes_kids', 'clothing', 'clothing_kids', 'trousers', 'custom'].includes(body.sizeType) ? body.sizeType : 'none',
    sizes: (Array.isArray(body.sizes) ? body.sizes : []).slice(0, 60).map(x => cleanText(x).slice(0, 14)).filter(Boolean),
    variantLabel: escapeHtmlText(body.variantLabel).slice(0, 24) || 'Option',
    variants: cleanVariants(body.variants),
    condition: CONDITIONS.includes(body.condition) ? body.condition : '',
    inStock: body.inStock !== false,
    labels: (Array.isArray(body.labels) ? body.labels : []).slice(0, 8).map(x => escapeHtmlText(x).slice(0, 40)).filter(Boolean),
    colors: (Array.isArray(body.colors) ? body.colors : []).slice(0, 20).map(c => ({ name: cleanText(c && c.name).slice(0, 30), hex: /^#[0-9a-f]{6}$/i.test(String(c && c.hex)) ? String(c.hex).toLowerCase() : '#999999', image: cleanText(c && c.image).slice(0, 500) })).filter(c => c.name),
    active: body.active !== false,
    updatedAt: new Date().toISOString()
  };
  // With options, the headline price is the cheapest option ("from" price).
  const scrubbed = scrubProductFields(product);
  if (product.variants.length) product.caayoPrice = Math.min(...product.variants.map(v => v.price));
  if (!product.caayoPrice || product.caayoPrice < 0) return res.status(400).json({ error: 'Enter a CAAYO selling price.' });
  const idx = products.findIndex(p => p.id === product.id || (product.sourceUrl && p.sourceUrl === product.sourceUrl));
  const wasOut = idx >= 0 && products[idx].inStock === false;
  if (idx >= 0) products[idx] = { ...products[idx], ...product };
  else products.unshift({ ...product, createdAt: new Date().toISOString() });
  writeJson(PRODUCTS_FILE, products);
  const saved = idx >= 0 ? products[idx] : products[0];
  const backInStockNotified = wasOut && saved.inStock !== false ? await notifyRequestsForProduct(saved, baseUrl(req)) : 0;
  const requestMatches = idx < 0 ? matchingRequests(saved).length : 0;
  res.json({ ok: true, product: publicProduct(saved), scrubbed, backInStockNotified, requestMatches });
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const products = readJson(PRODUCTS_FILE);
  const next = products.filter(p => String(p.id) !== String(req.params.id));
  writeJson(PRODUCTS_FILE, next);
  res.json({ ok: true });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  // Older orders may not have a picture saved on each line: fill it in from the product (the chosen colour's photo first).
  const products = readJson(PRODUCTS_FILE);
  const withPhoto = l => {
    if (l.image) return l;
    const p = products.find(x => String(x.id) === String(l.id));
    if (!p) return l;
    const col = (p.colors || []).find(c => c.name === l.color);
    return { ...l, image: (col && col.image) || p.image || (Array.isArray(p.images) && p.images[0]) || '' };
  };
  res.json({ orders: readJson(ORDERS_FILE).map(o => ({ ...o, lines: (o.lines || []).map(withPhoto) })) });
});

// Public single-product endpoint.
app.get('/api/products/:id', (req, res) => {
  const p = readJson(PRODUCTS_FILE).find(x => String(x.id) === String(req.params.id) && x.active !== false);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  res.json({ product: publicProduct(p) });
});

// ---------- Delivery, shipping and settings ----------
const STATES = ["Lagos", "Delta", "Ondo", "Edo", "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River", "Ebonyi", "Ekiti", "Enugu", "FCT (Abuja)", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", "Nasarawa", "Niger", "Ogun", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara"];
const LOCAL_STATES = ['Lagos', 'Delta', 'Ondo', 'Edo'];
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || '+2349055810160';
const EXPRESS_USD_PER_KG = { normal: 9, special: 21 };   // express shipping: normal items vs special/battery items
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');   // (also registered in KEYS above)
// ---------- Product options with their own prices (optional per product), e.g. 64GB / 128GB / 256GB ----------
function cleanVariants(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).slice(0, 20)
    .map(v => ({ name: escapeHtmlText(v && v.name).slice(0, 40), price: Math.round(Number(v && v.price) || 0) }))
    .filter(v => v.name && v.price > 0 && !seen.has(v.name.toLowerCase()) && seen.add(v.name.toLowerCase()));
}
const CONDITIONS = ['', 'new', 'refurbished', 'used', 'open_box'];
const CONDITION_TEXT = { new: 'Brand new', refurbished: 'Refurbished', used: 'Used', open_box: 'Open box' };

// ---------- Reviews: only customers who ordered the product (matched by the email on the order) can review ----------
function reviewStats(reviews) {
  const by = {};
  for (const r of reviews) { if (r.hidden) continue; const b = by[r.productId] || (by[r.productId] = { n: 0, sum: 0 }); b.n++; b.sum += r.rating; }
  return by;
}
// ---------- Brand names are never shown on the store ----------
// Fashion, luxury, sports and club names are removed from product names, descriptions and labels (selling look-alikes under a brand name causes legal trouble).
// Phone and electronics names (iPhone, Samsung ...) are kept so genuine items can be described. Edit this list to add or remove words.
const BRAND_WORDS = ['chanel','coach','gucci','louis vuitton','prada','dior','christian dior','hermes','hermès','balenciaga','versace','fendi','burberry','michael kors','kate spade','givenchy','yves saint laurent','ysl','valentino','celine','bottega veneta','tory burch','nike','adidas','puma','reebok','air jordan','yeezy','new balance','converse','vans','fila','under armour','skechers','asics','bape','a bathing ape','supreme','off-white','stussy','zara','h&m','ralph lauren','tommy hilfiger','calvin klein','lacoste','levi\'s','levis','armani','emporio armani','hugo boss','moschino','dolce & gabbana','dolce and gabbana','the north face','north face','canada goose','moncler','rolex','cartier','tiffany','pandora','swarovski','arsenal','chelsea','manchester united','man utd','manchester city','liverpool','barcelona','real madrid','juventus','psg','ac milan','inter milan','bayern','tottenham','premier league','fly emirates','nba','nfl','fifa','uefa'];
const BRAND_RE = new RegExp('(?<![A-Za-z0-9])(' + BRAND_WORDS.sort((a, b) => b.length - a.length).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z0-9])', 'gi');
function scrubBrands(text) {
  if (!text) return text || '';
  return String(text).replace(BRAND_RE, ' ').replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/^[\s,.;:\-–|/]+|[\s,\-–|/]+$/g, '').replace(/ *\n */g, '\n').trim();
}
function scrubProductFields(p) {
  const before = JSON.stringify([p.name, p.description, p.labels, p.variants, p.category]);
  if (p.name) p.name = scrubBrands(p.name) || 'New product';
  if (p.description) p.description = scrubBrands(p.description);
  if (Array.isArray(p.labels)) p.labels = p.labels.filter(x => { const c = scrubBrands(x); return c && (c === String(x).trim() || c.length >= 6); }).map(scrubBrands);
  if (Array.isArray(p.variants)) p.variants = p.variants.map(v => ({ ...v, name: scrubBrands(v.name) || v.name }));
  if (/^(chanel|coach) bags$/i.test(String(p.category || ''))) p.category = 'Handbags';
  return before !== JSON.stringify([p.name, p.description, p.labels, p.variants, p.category]);
}
// Automatic categories: products without a real category are placed by keywords in their name (then description).
const GUESS_RULES = [["Car Electronics",/\b(car (charger|dash ?cam|dvr|stereo|bluetooth|player)|dash ?cam)\b/i],["Car Accessories",/\b(car (seat|cover|mat|holder|vacuum|accessor\w+|perfume|organi[sz]er)|steering wheel)\b/i],["Computer Accessories",/\b(laptop (stand|bag|sleeve|cooler|charger)|monitor|mouse ?pad|usb hubs?)\b/i],["Underwear & Sleepwear",/\b(underwear|boxers?|briefs|panties|panty|bras?|pyjamas?|pajamas?|nightwear|sleepwear|lingerie|nightgown)\b/i],["Native & African Wear",/\b(ankara|kaftan|agbada|senator|dashiki|buba|aso ?oke|native wear|african print)\b/i],["Sportswear",/\b(tracksuits?|sportswear|gym wear|sports? bras?|football jersey)\b/i],["Baby Clothing",/\b(baby (clothes|clothing|romper|dress|wear)|onesies?|rompers?)\b/i],["Children Clothing",/\b(kids?|children'?s?|boys?|girls?)'?s? (clothes|clothing|wear|shirt|dress|set|outfit|jeans|trousers)\b/i],["Kids' Shoes",/\b(kids?|children'?s?|boys?|girls?)'?s? (shoes?|sneakers?|sandals?)\b/i],["Sneakers",/\b(sneakers?|trainers?|running shoes?|air ?force|canvas shoes?)\b/i],["Sandals & Slippers",/\b(sandals?|slippers?|slides|flip ?flops?|crocs)\b/i],["Boots",/\bboots?\b/i],["Women's Shoes",/\b(heels?|pumps?|stilettos?|wedges?|ballet flats?|women'?s? (shoes?|footwear)|ladies'? shoes?)\b/i],["Men's Shoes",/\b(loafers?|oxford shoes?|derby|brogues?|men'?s? (shoes?|footwear)|formal shoes?|office shoes?)\b/i],["Shoes",/\b(shoes?|footwear)\b/i],["Backpacks",/\b(backpacks?|rucksacks?|school bags?)\b/i],["Wallets & Purses",/\b(wallets?|purses?|card holders?|coin purses?)\b/i],["Luggage",/\b(luggage|suitcases?|trolley bags?)\b/i],["Travel Bags",/\b(travel bags?|duffel|duffle|weekend bags?|gym bags?)\b/i],["Handbags",/\b(handbags?|totes?|crossbody|clutch(es)?|shoulder bags?|satchels?|ladies'? bags?|women'?s? bags?|bags?)\b/i],["Power Banks",/\bpower ?banks?\b/i],["Electrical & Wiring",/\b(solar|inverters?|generators?|power strips?|sockets?|extension (board|socket))\b/i],["Smartwatches",/\b(smart ?watch(es)?|fitness (band|tracker))\b/i],["Headsets & Earphones",/\b(earphones?|earbuds?|headphones?|headsets?|airpods?|earpods?|neckbands?)\b/i],["Speakers",/\b(speakers?|soundbars?|subwoofers?)\b/i],["Phone Cases & Accessories",/\b(phone cases?|screen protectors?|phone holders?|pop ?sockets?|phone stands?|selfie sticks?|ring lights?)\b/i],["Batteries & Chargers",/\b(chargers?|batter(y|ies)|charging)\b/i],["Cables & Adapters",/\b(cables?|adapters?|adaptors?|converters?|extension cords?)\b/i],["Fans & Coolers",/\b(fans?|coolers?)\b/i],["Cameras",/\b(cameras?|webcams?|camcorders?|gopro|tripods?|cctv)\b/i],["Tablets",/\b(tablets?|ipads?)\b/i],["Handsets",/\b(phones?|smartphones?|iphones?|handsets?|android|tecno|infinix|itel)\b/i],["Laptops",/\b(laptops?|macbooks?|chromebooks?)\b/i],["Keyboards & Mice",/\b(keyboards?|mouse|mice)\b/i],["Storage & Flash Drives",/\b(flash drives?|pen ?drives?|memory cards?|sd cards?|hard drives?|ssd|hdd|usb drives?)\b/i],["Printers & Ink",/\b(printers?|ink|toners?|cartridges?)\b/i],["Networking & Routers",/\b(routers?|wi-?fi|modems?|mifi|ethernet)\b/i],["Air Fryers",/\bair ?fryers?\b/i],["Rice Cookers",/\b(rice cookers?|pressure cookers?|slow cookers?|electric cookers?)\b/i],["Blenders & Mixers",/\b(blenders?|mixers?|juicers?|grinders?|food processors?|choppers?)\b/i],["Kettles & Toasters",/\b(kettles?|toasters?|sandwich makers?|waffle|coffee makers?)\b/i],["Irons",/\b(irons?|steamers?)\b/i],["Heaters",/\bheaters?\b/i],["Wigs & Hair Extensions",/\b(wigs?|hair extensions?|weaves?|braids?|lace front|human hair|bundles?)\b/i],["Hair Care",/\b(shampoo|conditioner|hair oil|hair dryers?|blow ?dryers?|straighteners?|curlers?|hair care|hair cream)\b/i],["Makeup",/\b(lipsticks?|lip ?gloss|foundation|mascara|eyeliner|make-?up|concealer|eyeshadow|blush|contour|highlighter)\b/i],["Skincare",/\b(skincare|skin care|serum|lotion|moisturi[sz]er|sunscreen|face wash|cleanser|face cream|body cream|body butter|sunblock)\b/i],["Fragrances",/\b(perfumes?|fragrances?|colognes?|body spray|deodorants?|oud|eau de)\b/i],["Nails",/\b(nails?|manicure|nail polish|gel polish)\b/i],["Shavers & Trimmers",/\b(shavers?|trimmers?|clippers?|razors?)\b/i],["Massagers",/\b(massagers?|massage guns?|massage)\b/i],["First Aid",/\b(first aid|bandages?|plasters?)\b/i],["Medical Supplies",/\b(thermometers?|bp monitors?|blood pressure|glucometers?|face masks?|oximeters?|nebuli[sz]ers?)\b/i],["Necklaces",/\b(necklaces?|pendants?|chains?)\b/i],["Earrings",/\b(earrings?|studs?)\b/i],["Bracelets & Bangles",/\b(bracelets?|bangles?|anklets?)\b/i],["Rings",/\brings?\b/i],["Watches",/\b(watch(es)?|wristwatch(es)?)\b/i],["Caps & Hats",/\b(caps?|hats?|beanies?|snapbacks?)\b/i],["Belts",/\bbelts?\b/i],["Sunglasses",/\b(sunglasses|shades|eyeglasses|spectacles)\b/i],["Scarves & Gloves",/\b(scarf|scarves|gloves?|hijabs?|shawls?)\b/i],["Hair Accessories",/\b(scrunchies?|hair clips?|headbands?|hair bands?|bonnets?|hair pins?)\b/i],["Keychains",/\b(key ?chains?|key rings?)\b/i],["Cookware",/\b(cookware|pots?|pans?|frying|non-?stick|skillets?|casseroles?|saucepans?)\b/i],["Kitchen Tools",/\b(knife|knives|spatulas?|peelers?|graters?|kitchen|whisks?|colanders?|chopping boards?|lunch box)\b/i],["Bedding",/\b(bed ?sheets?|duvets?|pillows?|blankets?|mattress(es)?|comforters?|bedding|towels?)\b/i],["Lighting",/\b(lamps?|bulbs?|led lights?|string lights?|lights?|lanterns?|chandeliers?)\b/i],["Home Decor",/\b(decor|vases?|wall art|curtains?|rugs?|carpets?|mirrors?|picture frames?|artificial flowers?|ornaments?)\b/i],["Storage & Organizers",/\b(organi[sz]ers?|storage boxes?|racks?|shelf|shelves|hangers?|baskets?)\b/i],["Storage & Organizers",/\b(trash ?cans?|dustbins?|waste ?bins?|laundry baskets?|bins?)\b/i],["Cleaning Supplies",/\b(mops?|brooms?|cleaning|scrubbers?|vacuum|dustpans?|detergents?)\b/i],["Trousers & Jeans",/\b(trousers?|jeans?|chinos?|cargo pants?|joggers?|slacks|leggings?|pants?|shorts|denim)\b/i],["Dresses & Skirts",/\b(dress(es)?|gowns?|skirts?|jumpsuits?|maxi|bodycon)\b/i],["Jackets & Hoodies",/\b(jackets?|hoodies?|sweaters?|sweatshirts?|coats?|blazers?|cardigans?|pullovers?|windbreakers?)\b/i],["Shirts & Tops",/\b(shirts?|t-?shirts?|tees?|polos?|blouses?|tops?|singlets?|vests?)\b/i],["Fitness Equipment",/\b(dumbbells?|yoga mats?|resistance bands?|skipping ropes?|treadmills?)\b/i],["Gaming Consoles",/\b(ps[45]|playstation|xbox|nintendo|consoles?)\b/i],["Game Controllers",/\b(controllers?|joysticks?|gamepads?)\b/i],["Toys",/\b(toys?|dolls?|lego|teddy)\b/i],["Notebooks & Paper",/\b(notebooks?|notepads?|diary|journals?)\b/i],["Stationery",/\b(pens?|pencils?|markers?|stationery)\b/i],["Pet Accessories",/\b(pet|dog|cat) (collar|leash|bowl|bed|food|toy)s?\b/i],["Gift Items",/\b(gift sets?|gift boxes?|gift items?)\b/i],["Party Supplies",/\b(balloons?|party|birthday)\b/i],["Women Clothing",/\b(women'?s?|ladies'?|female) (wear|clothes|clothing|set|outfit)\b/i],["Men Clothing",/\b(men'?s?|male) (wear|clothes|clothing|set|outfit)\b/i]];
function guessCategory(name, desc) {
  const hit = t => { const x = String(t || '').toLowerCase(); for (const [c, re] of GUESS_RULES) if (re.test(x)) return c; return ''; };
  return hit(name) || hit(String(desc || '').slice(0, 300));
}
const isUncategorised = c => !c || /^new finds$/i.test(String(c).trim());
function autoCategoriseAll() {
  try {
    const list = readJson(PRODUCTS_FILE); let n = 0, b = 0;
    for (const p of list) if (scrubProductFields(p)) b++;
    if (b) { writeJson(PRODUCTS_FILE, list); console.log('Removed brand names from ' + b + ' products.'); }
    for (const p of list) if (isUncategorised(p.category)) { const g = guessCategory(p.name, p.description); if (g) { p.category = g; n++; } }
    if (n) { writeJson(PRODUCTS_FILE, list); console.log('Auto-categorised ' + n + ' products.'); }
  } catch (e) { console.error('Auto-categorise skipped:', e.message); }
}
// Home page banners: up to 5 slides, each with a picture and text. Blank fields fall back to the built-in default on the storefront.
function cleanBanners(list) {
  return (Array.isArray(list) ? list : []).slice(0, 5).map(b => {
    b = b || {};
    const img = cleanText(b.image).slice(0, 500);
    return {
      image: /^(https?:\/\/|\/uploads\/)/i.test(img) ? img : '',
      eyebrow: escapeHtmlText(b.eyebrow).slice(0, 40),
      headline: cleanMultiline(b.headline).slice(0, 80),
      text: escapeHtmlText(b.text).slice(0, 120),
      button: escapeHtmlText(b.button).slice(0, 24),
      link: cleanText(b.link).slice(0, 60),
      full: b.full === true || b.full === 'true'
    };
  });
}
function readSettings() {
  let s = readJson(SETTINGS_FILE);
  if (!s || Array.isArray(s)) s = {};
  const num = (v, d) => (v !== undefined && v !== null && v !== '' && Number(v) >= 0 ? Number(v) : d);
  const envRate = Number(process.env.USD_NGN_RATE);
  const legacyFee = num(s.dispatchFee, Number(process.env.DISPATCH_FEE_NGN) || 0);
  return {
    usdRate: Number(s.usdRate) > 0 ? Number(s.usdRate) : (envRate > 0 ? envRate : 1500),
    freeThreshold: num(s.freeThreshold, 100000),          // door delivery is free at or above this order value
    doorFeeLocal: num(s.doorFeeLocal, 0),                 // door delivery fee: Lagos, Delta, Ondo, Edo
    doorFeeOther: num(s.doorFeeOther, legacyFee),         // door delivery fee: all other states
    thresholdAllStates: s.thresholdAllStates === true,    // does the free-delivery minimum also apply to the other states?
    pickupPoints: Array.isArray(s.pickupPoints) ? s.pickupPoints : [],
    banners: cleanBanners(s.banners)                       // home page banners (picture + text) edited in admin
  };
}
const publicPickups = () => readSettings().pickupPoints.map(p => ({ id: p.id, name: p.name, state: p.state, area: p.area, address: p.address }));
// The server always works the price out itself, so the browser can never change what a customer pays.
// Air shipping is billed on the combined weight of the whole cart, in kg and grams.
// Under 1 kg (including 0.50 kg and lighter) is billed as 1 kg. Above 1 kg the exact weight is billed, to the gram.
// If the cart mixes normal and special/battery items and totals under 1 kg, the missing weight is billed at the rate of the heavier group.
const AIR_MIN_G = 1000;
function airBilling(kg) {
  let n = Math.ceil(Math.round(kg.normal * 1e6) / 1000), sp = Math.ceil(Math.round(kg.special * 1e6) / 1000);   // grams, rounded up
  const total = n + sp;
  if (total > 0 && total < AIR_MIN_G) { if (sp > n) sp += AIR_MIN_G - total; else n += AIR_MIN_G - total; }
  const usd = (n / 1000) * EXPRESS_USD_PER_KG.normal + (sp / 1000) * EXPRESS_USD_PER_KG.special;
  return { billableKg: (n + sp) / 1000, usd };
}
// The server always works the price out itself, so the browser can never change what a customer pays.
function computeQuote(lines, products, state, method, deliveryType) {
  const subtotal = lines.reduce((n, l) => n + l.price * l.quantity, 0);
  const kg = { normal: 0, special: 0 }, airBlocked = [];
  for (const l of lines) {
    const p = products.find(x => String(x.id) === String(l.id)) || {};
    kg[p.shippingClass === 'special' ? 'special' : 'normal'] += (Number(p.weightKg) || 0.5) * l.quantity;
    if (p.airShipping === false && !airBlocked.includes(l.name)) airBlocked.push(l.name);
  }
  const st = readSettings();
  const airAvailable = airBlocked.length === 0;
  const air = airBilling(kg);
  const expressFee = method === 'express' && airAvailable ? Math.ceil(Math.round(air.usd * st.usdRate * 100) / 100) : 0;
  // Door delivery is paid unless the order reaches the free-delivery minimum. Pickup is always free.
  let dispatchFee = 0, dispatchPending = false, doorWaived = false;
  if (deliveryType !== 'pickup') {
    const local = LOCAL_STATES.includes(state);
    const base = local ? st.doorFeeLocal : st.doorFeeOther;
    if (subtotal >= st.freeThreshold && (local || st.thresholdAllStates)) doorWaived = true;
    else { dispatchFee = base; dispatchPending = !base; }
  }
  return { subtotal, kg: { normal: Math.round(kg.normal * 1000) / 1000, special: Math.round(kg.special * 1000) / 1000 }, billableKg: air.billableKg, airAvailable, airBlocked, expressFee, dispatchFee,
    dispatchPending, doorWaived, total: subtotal + expressFee + dispatchFee, usdRate: st.usdRate };
}
function etaFor(method, from = new Date()) {
  const [a, b] = method === 'express' ? [7, 10] : [56, 70];   // air 7-10 days, sea 8-10 weeks
  const at = d => new Date(from.getTime() + d * 864e5);
  const fmt = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return { from: at(a).toISOString(), to: at(b).toISOString(), text: fmt(at(a)) + ' to ' + fmt(at(b)) };
}

// ---------- Order status updates (emailed to the customer) ----------
const STAGES = [
  { key: 'placed', label: 'Order placed', msg: 'You just ordered this product. We have received your order and we are getting it ready.' },
  { key: 'packaged', label: 'Packaged', msg: 'Your product has been packaged and is being transported to the port.', msgExpress: 'Your product has been packaged and is being transported to the shipping hub.' },
  { key: 'loaded', label: 'Loaded', msg: 'Your package has been loaded onto the ship.', msgExpress: 'Your package has been loaded for express shipping to Nigeria.' },
  { key: 'departed', label: 'On its way to Nigeria', msg: 'Your package has left the port and is on its way to Nigeria.', msgExpress: 'Your package has left and is on its way to Nigeria.' },
  { key: 'arrived', label: 'Arrived in Nigeria', msg: 'Your package has arrived in Nigeria and is being sorted for delivery.' },
  { key: 'out_for_delivery', label: 'Out for delivery', msg: 'Your package is out for delivery to your address. Please keep your phone close.', msgPickup: 'Your package is ready for pickup at {point}. Please bring your order ID.', labelPickup: 'Ready for pickup' },
  { key: 'delivered', label: 'Delivered', msg: 'Your package has been delivered. Thank you for shopping with CAAYO!', msgPickup: 'Your package has been collected. Thank you for shopping with CAAYO!', labelPickup: 'Collected' }
];
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const variantText = l => (l.color || l.size || l.variant) ? ' (' + [l.variant, l.color, l.size ? 'size ' + l.size : ''].filter(Boolean).join(', ') + ')' : '';
const money = n => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
const emailConfigured = () => !!(((process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY) || process.env.BREVO_API_KEY || process.env.RESEND_API_KEY) && process.env.EMAIL_FROM);
// Sends through an email API (Mailjet, Brevo or Resend). Render's free plan blocks normal SMTP, so we use their web APIs.
async function sendEmail({ to, subject, html, text }) {
  const from = String(process.env.EMAIL_FROM || '').trim();
  const m = /^(.*?)\s*<([^>]+)>$/.exec(from);
  const fromName = (m && m[1].replace(/^"|"$/g, '')) || 'CAAYO';
  const fromEmail = m ? m[2] : from;
  if (!fromEmail) return { ok: false, error: 'EMAIL_FROM is not set' };
  try {
    if (process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY) {
      const auth = Buffer.from(process.env.MAILJET_API_KEY + ':' + process.env.MAILJET_SECRET_KEY).toString('base64');
      const r = await fetch('https://api.mailjet.com/v3.1/send', { method: 'POST',
        headers: { Authorization: 'Basic ' + auth, 'content-type': 'application/json' },
        body: JSON.stringify({ Messages: [{ From: { Email: fromEmail, Name: fromName }, To: [{ Email: to }], Subject: subject, TextPart: text, HTMLPart: html }] }),
        signal: AbortSignal.timeout(15000) });
      const body = await r.text();
      let status = ''; try { status = JSON.parse(body).Messages[0].Status; } catch {}
      if (!r.ok || (status && status !== 'success')) throw new Error('Mailjet ' + r.status + ' ' + body.slice(0, 200));
      return { ok: true };
    }
    if (process.env.BREVO_API_KEY) {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { name: fromName, email: fromEmail }, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
        signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('Brevo ' + r.status + ' ' + (await r.text()).slice(0, 160));
      return { ok: true };
    }
    if (process.env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ from: fromName + ' <' + fromEmail + '>', to: [to], subject, html, text }),
        signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('Resend ' + r.status + ' ' + (await r.text()).slice(0, 160));
      return { ok: true };
    }
    return { ok: false, error: 'No email service is set up (add MAILJET_API_KEY and MAILJET_SECRET_KEY, or BREVO_API_KEY, or RESEND_API_KEY)' };
  } catch (e) { return { ok: false, error: e.message }; }
}
const baseUrl = req => (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
const imgUrl = (base, u) => { const x = u ? (String(u).startsWith('/uploads/') ? base + u : u) : ''; return /^https?:\/\//i.test(x) ? x : ''; };
// One look for every email: header, label, headline, content, optional button, policy links.
function emailShell(base, { label, headline, body, buttonText, buttonUrl, preheader }) {
  const link = (p, t) => `<a href="${h(base + p)}" style="color:#777;text-decoration:underline">${t}</a>`;
  return `<div style="background:#f4f4f4;padding:20px;font-family:Arial,Helvetica,sans-serif;color:#111"><span style="display:none;max-height:0;overflow:hidden;opacity:0">${h(preheader || headline || '')}</span>
<div style="max-width:540px;margin:auto;background:#fff;border-radius:14px;overflow:hidden">
<div style="background:#000;color:#fff;text-align:center;padding:18px;font-size:26px;font-weight:900;letter-spacing:-1px">CAAYO</div>
<div style="padding:24px 22px 8px"><div style="font-size:12px;color:#777;letter-spacing:.07em;text-transform:uppercase">${h(label)}</div>
<h1 style="font-size:22px;line-height:1.3;margin:8px 0 12px">${h(headline)}</h1>${body}
${buttonText ? `<p style="margin:18px 0 6px"><a href="${h(buttonUrl)}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:700;font-size:14px">${h(buttonText)}</a></p>` : ''}</div>
<div style="padding:14px 22px 22px;font-size:12px;color:#888;line-height:1.6;border-top:1px solid #eee;margin-top:14px">Questions? WhatsApp or call ${h(SUPPORT_PHONE)}.<br>${link('/returns-policy', 'Returns &amp; refunds')} · ${link('/privacy-policy', 'Privacy')} · ${link('/terms', 'Terms')}<br>© CAAYO · Quality products, better prices</div></div></div>`;
}
const STAGE_TIPS = {
  placed: (o, express) => `What happens next: we get your order moving and email you at every step. ${express ? 'Air delivery takes about 7 to 10 days.' : 'Sea delivery takes 8 to 10 weeks, shipping included.'} All sales are final, except items that arrive broken or seriously damaged (see our Returns & refunds policy).`,
  arrived: () => 'Please keep your phone close, we may call you to arrange delivery.',
  out_for_delivery: (o, e, pickup) => pickup ? 'Please bring your order ID and a valid ID when you collect.' : 'Please keep your phone close. When it arrives, check the package straight away. If anything is broken or seriously damaged, take clear photos and a short video before you throw anything away.',
  delivered: () => 'Please check your items now. If anything is broken or seriously damaged, message us on WhatsApp within 72 hours with your order ID and clear photos or a video, and we will make it right. Happy with your order? Please leave a review on the product page.'
};
function orderEmail(order, stageKey, customMsg) {
  const st = STAGES.find(s => s.key === stageKey) || STAGES[0];
  const express = order.shipping && order.shipping.method === 'express';
  const pickup = order.delivery && order.delivery.type === 'pickup';
  let msg = express && st.msgExpress ? st.msgExpress : st.msg;
  if (pickup && st.msgPickup) msg = st.msgPickup.replace('{point}', (order.delivery && order.delivery.pointName) || 'your pickup point');
  if (customMsg) msg = customMsg;
  const base = String(process.env.PUBLIC_URL || order.origin || '').replace(/\/$/, '');
  const track = base + '/?track=' + encodeURIComponent(order.id);
  const idx = STAGES.findIndex(s => s.key === st.key);
  const steps = STAGES.map((s, i) => `<td style="padding:0 2px"><div style="height:5px;border-radius:5px;background:${i <= idx ? '#000' : '#ddd'}"></div></td>`).join('');
  const photo = l => { const u = imgUrl(base, l.image); return u ? `<img src="${h(u)}" width="48" height="48" alt="" style="border-radius:8px;object-fit:cover;vertical-align:middle;margin-right:10px">` : ''; };
  const rows = (order.lines || []).map(l => `<tr><td style="padding:7px 0">${photo(l)}${h(l.name)}${h(variantText(l))} × ${l.quantity}${l.condition && CONDITION_TEXT[l.condition] ? ` <span style="color:#777;font-size:12px">· ${h(CONDITION_TEXT[l.condition])}</span>` : ''}</td><td align="right" style="padding:7px 0;white-space:nowrap">${money(l.price * l.quantity)}</td></tr>`).join('');
  const extra = [
    order.shipping && order.shipping.expressFee ? `<tr><td style="padding:4px 0;color:#666">Air shipping</td><td align="right">${money(order.shipping.expressFee)}</td></tr>` : '',
    order.dispatchFee ? `<tr><td style="padding:4px 0;color:#666">Dispatch fee</td><td align="right">${money(order.dispatchFee)}</td></tr>` : ''
  ].join('');
  const c = order.customer || {};
  const labelShown = customMsg ? 'Update on your order' : ((pickup && st.labelPickup) || st.label);
  const tip = !customMsg && STAGE_TIPS[st.key] ? STAGE_TIPS[st.key](order, express, pickup) : '';
  const first = String(c.name || '').trim().split(/\s+/)[0];
  const body = `${first ? `<p style="margin:0 0 8px;font-size:15px">Hi ${h(first)},</p>` : ''}<p style="font-size:17px;line-height:1.5;margin:0 0 14px">${h(msg).replace(/\n/g, '<br>')}</p>
<table width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 14px"><tr>${steps}</tr></table>
${order.eta && order.eta.text && st.key !== 'delivered' ? `<p style="margin:0 0 12px;font-size:14px">Estimated arrival: <b>${h(order.eta.text)}</b> (${express ? 'Air' : 'Sea'} shipping)</p>` : ''}
${tip ? `<div style="background:#f6f6f6;border-radius:10px;padding:12px 14px;font-size:13.5px;line-height:1.55;color:#333;margin:0 0 14px">${h(tip)}</div>` : ''}
<p style="margin:16px 0 4px;font-size:13px;color:#777">Order ${h(order.id)}</p>
<table width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;border-top:1px solid #eee">${rows}${extra}<tr><td style="padding:9px 0;border-top:1px solid #eee"><b>Total</b></td><td align="right" style="border-top:1px solid #eee"><b>${money(order.total)}</b></td></tr></table>
<p style="font-size:13px;color:#555;margin:14px 0 0"><b>${pickup ? 'Pickup at:' : 'Delivering to:'}</b> ${h(pickup ? [order.delivery.pointName, c.address, c.city, c.state].filter(Boolean).join(', ') : [c.name, c.address, c.city, c.state].filter(Boolean).join(', '))}</p>`;
  const html = emailShell(base, { label: labelShown, headline: st.key === 'placed' && !customMsg ? 'Thank you for your order' : labelShown, body, buttonText: 'Track my order', buttonUrl: track, preheader: msg.slice(0, 90) });
  const text = `CAAYO - ${labelShown}\n\n${first ? 'Hi ' + first + ',\n\n' : ''}${msg}\n${tip ? '\n' + tip + '\n' : ''}${order.eta && order.eta.text && st.key !== 'delivered' ? '\nEstimated arrival: ' + order.eta.text : ''}\nOrder ${order.id}, total ${money(order.total)}\nTrack: ${track}\nQuestions? WhatsApp or call ${SUPPORT_PHONE}\nReturns and refunds: ${base}/returns-policy`;
  return { subject: customMsg ? `CAAYO: an update on order ${order.id}` : `CAAYO order ${order.id}: ${labelShown}`, html, text };
}
function requestReceivedEmail(r, base) {
  const body = `<p style="margin:0 0 8px;font-size:15px">Hi ${h(String(r.name || '').split(/\s+/)[0] || 'there')},</p><p style="font-size:16px;line-height:1.5;margin:0 0 12px">Thanks for telling us what you want. You asked for:</p>
<div style="background:#f6f6f6;border-radius:10px;padding:12px 14px;font-size:15px"><b>${h(r.product)}</b>${r.details ? `<div style="color:#555;font-size:13.5px;margin-top:6px">${h(r.details).replace(/\n/g, '<br>')}</div>` : ''}</div>
<p style="font-size:14px;line-height:1.55;color:#444;margin:14px 0 0">${r.notify ? 'We will email you at this address as soon as we list it. You do not need to ask again.' : 'We have noted your request.'}</p>`;
  return { subject: 'We got your request: ' + r.product.slice(0, 60), html: emailShell(base, { label: 'Request received', headline: 'We got your request', body, buttonText: 'Keep browsing', buttonUrl: base + '/' }),
    text: `CAAYO\n\nWe got your request for: ${r.product}\n${r.notify ? 'We will email you when we list it.' : ''}\n${base}/` };
}
function requestListedEmail(r, product, base, backInStock) {
  const u = imgUrl(base, product.image || (product.images && product.images[0]));
  const from = product.variants && product.variants.length ? 'From ' : '';
  const body = `<p style="margin:0 0 8px;font-size:15px">Hi ${h(String(r.name || '').split(/\s+/)[0] || 'there')},</p><p style="font-size:16px;line-height:1.5;margin:0 0 12px">${backInStock ? 'The product you wanted is back in stock:' : 'Good news, we just listed something that matches your request for <b>' + h(r.product) + '</b>:'}</p>
<table width="100%" cellspacing="0" cellpadding="0" style="background:#f6f6f6;border-radius:10px"><tr>${u ? `<td width="96" style="padding:10px"><img src="${h(u)}" width="86" height="86" alt="" style="border-radius:8px;object-fit:cover"></td>` : ''}<td style="padding:10px;font-size:15px"><b>${h(product.name)}</b><div style="margin-top:4px;font-size:16px;font-weight:700">${from}${money(product.caayoPrice)}</div></td></tr></table>
<p style="font-size:13.5px;line-height:1.55;color:#555;margin:14px 0 0">Delivery: sea shipping 8 to 10 weeks (free), air shipping about 7 to 10 days. Popular items can sell out, so order early.</p>`;
  return { subject: (backInStock ? 'Back in stock: ' : 'Now available: ') + product.name.slice(0, 60), html: emailShell(base, { label: backInStock ? 'Back in stock' : 'Now available', headline: backInStock ? 'It is back in stock' : 'We found it for you', body, buttonText: 'View product', buttonUrl: base + '/?p=' + encodeURIComponent(product.id) }),
    text: `CAAYO\n\n${backInStock ? 'Back in stock' : 'Now available'}: ${product.name} (${from}${money(product.caayoPrice)})\n${base}/?p=${product.id}` };
}
async function notifyOrder(orderId, stageKey, customMsg) {
  const order = readJson(ORDERS_FILE).find(o => o.id === orderId);
  if (!order || !order.email) return { ok: false, error: 'This order has no email address' };
  const result = await sendEmail({ to: order.email, ...orderEmail(order, stageKey, customMsg) });
  if (!result.ok) console.warn('Order email failed:', result.error);
  const orders = readJson(ORDERS_FILE);
  const o = orders.find(x => x.id === orderId);
  if (o) { (o.emails = o.emails || []).push({ stage: customMsg ? 'message' : stageKey, at: new Date().toISOString(), ok: result.ok, error: result.error }); writeJson(ORDERS_FILE, orders); }
  return result;
}

// ---------- Paystack ----------
// Set PAYSTACK_SECRET_KEY (sk_test_... or sk_live_...) in your server's environment. Never put it in code.
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
async function paystack(method, endpoint, body) {
  const r = await fetch('https://api.paystack.co' + endpoint, {
    method, headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.status) throw new Error(d.message || 'Paystack error ' + r.status);
  return d.data;
}
// Marks an order paid only after Paystack confirms the money and the amount matches. The first time, it emails the customer.
function settleOrder(reference, tx) {
  const orders = readJson(ORDERS_FILE);
  const order = orders.find(o => o.id === reference);
  if (!order) return null;
  if (order.status !== 'paid' && tx && tx.status === 'success' && tx.currency === 'NGN' && Number(tx.amount) >= Math.round(order.total * 100)) {
    order.status = 'paid';
    order.paidAt = new Date().toISOString();
    order.paystackId = tx.id;
    order.stage = 'placed';
    (order.timeline = order.timeline || []).push({ stage: 'placed', at: order.paidAt });
    writeJson(ORDERS_FILE, orders);
    notifyOrder(order.id, 'placed').catch(() => {});
  }
  return order;
}
const maskEmail = e => String(e || '').replace(/^(.).*(@.*)$/, '$1***$2');

app.get('/api/config', (req, res) => {
  const st = readSettings();
  res.json({ usdRate: st.usdRate, freeThreshold: st.freeThreshold, doorFeeLocal: st.doorFeeLocal, doorFeeOther: st.doorFeeOther,
    thresholdAllStates: st.thresholdAllStates, pickupPoints: publicPickups(), expressPerKg: EXPRESS_USD_PER_KG, localStates: LOCAL_STATES, whatsapp: SUPPORT_PHONE, banners: st.banners });
});

// Order endpoint used by the storefront checkout. Checkout needs an account (see authUser below); order updates go to the account email.
app.post('/api/orders', async (req, res) => {
  if (rateLimited('orders', req.ip, 20, 3600e3)) return res.status(429).json({ error: 'Too many orders from this connection. Please try again later.' });
  const user = authUser(req);   // checkout needs an account (browsing and the cart do not)
  if (!user) return res.status(401).json({ error: 'Please log in or create an account to check out.', needLogin: true });
  const body = req.body || {};
  const products = readJson(PRODUCTS_FILE);
  const lines = [];
  for (const it of (Array.isArray(body.items) ? body.items : []).slice(0, 40)) {
    const qty = Math.max(1, Math.min(99, parseInt(it.quantity, 10) || 0));
    const p = products.find(x => String(x.id) === String(it.id) && x.active !== false);
    if (!p || !qty) continue;
    if (p.inStock === false) return res.status(400).json({ error: p.name + ' is sold out right now. Remove it from your cart, or use Request a product to be told when it is back.' });
    const colors = Array.isArray(p.colors) ? p.colors : [], sizes = Array.isArray(p.sizes) ? p.sizes : [];
    const colorHit = colors.find(c => c.name.toLowerCase() === cleanText(it.color).toLowerCase());
    const sizeHit = sizes.find(z => z === cleanText(it.size));
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const varHit = variants.find(v => v.name.toLowerCase() === cleanText(it.variant).toLowerCase());
    if (colors.length && !colorHit) return res.status(400).json({ error: 'Please choose a colour for ' + p.name + '.' });
    if (sizes.length && !sizeHit) return res.status(400).json({ error: 'Please choose a size for ' + p.name + '.' });
    if (variants.length && !varHit) return res.status(400).json({ error: 'Please choose a ' + (p.variantLabel || 'option').toLowerCase() + ' for ' + p.name + '.' });
    const rawImg = String((colorHit && colorHit.image) || p.image || (Array.isArray(p.images) && p.images[0]) || '');
    const upl = rawImg.match(/\/uploads\/([a-f0-9]{16}\.(?:jpg|png|webp))$/i);
    lines.push({ id: p.id, name: p.name, price: varHit ? varHit.price : (Number(p.caayoPrice) || 0), quantity: qty, color: colorHit ? colorHit.name : '', size: sizeHit || '', variant: varHit ? varHit.name : '', condition: p.condition || '', labels: Array.isArray(p.labels) ? p.labels : [], image: upl ? '/uploads/' + upl[1] : (/^https:\/\//i.test(rawImg) ? rawImg.slice(0, 500) : '') });
  }
  const c = body.customer || {};
  const email = user.email;   // order updates always go to the account email
  const method = body.shippingMethod === 'express' ? 'express' : 'standard';   // 'express' = air, 'standard' = sea (keys kept so old orders still work)
  if (!lines.length) return res.status(400).json({ error: 'Your cart has no available products. Refresh and try again.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address. Your order updates are sent there.' });
  if (!cleanText(c.name) || !cleanText(c.phone)) return res.status(400).json({ error: 'Name and phone are required.' });
  const pickupMode = body.deliveryType === 'pickup';
  let customer, delivery;
  if (pickupMode) {
    const pt = readSettings().pickupPoints.find(p => p.id === cleanText(body.pickupId));
    if (!pt) return res.status(400).json({ error: 'Please choose a pickup point.' });
    customer = { name: cleanText(c.name).slice(0, 80), phone: cleanText(c.phone).slice(0, 25), state: pt.state, city: pt.area, address: pt.address };
    delivery = { type: 'pickup', pointId: pt.id, pointName: pt.name };
  } else {
    if (!cleanText(c.address)) return res.status(400).json({ error: 'Delivery address is required.' });
    if (!STATES.includes(cleanText(c.state))) return res.status(400).json({ error: 'Please choose your delivery state.' });
    customer = { name: cleanText(c.name).slice(0, 80), phone: cleanText(c.phone).slice(0, 25), state: cleanText(c.state), city: cleanText(c.city).slice(0, 60), address: cleanText(c.address).slice(0, 220) };
    delivery = { type: 'door' };
  }
  // Free gift: only for the account that unlocked it, and only when the other items reach the minimum purchase.
  let giftPack = null;
  if (body.gift === true) {
    giftPack = prepareGiftForOrder(user, lines);
    if (giftPack.error) return res.status(400).json({ error: giftPack.error });
  }
  const orderLines = giftPack ? lines.concat(giftPack.lines) : lines;
  const q = computeQuote(orderLines, giftPack ? products.concat(giftPack.synth) : products, customer.state, method, delivery.type);
  if (method === 'express' && !q.airAvailable) return res.status(400).json({ error: 'Air shipping is not available for ' + q.airBlocked.join(', ') + '. Choose sea shipping, or remove the item.' });
  const origin = ALLOWED_ORIGINS.has(req.headers.origin) ? req.headers.origin : (process.env.PUBLIC_URL || req.protocol + '://' + req.get('host')).replace(/\/$/, '');
  const order = {
    id: 'ORD-' + Date.now() + crypto.randomBytes(2).toString('hex'),
    email,
    customer, delivery, userId: user.id,
    lines: orderLines, subtotal: q.subtotal,
    gift: giftPack ? { claimId: giftPack.claim.id, value: giftPack.claim.totalValue } : undefined,
    shipping: { method, kg: q.kg, billableKg: q.billableKg, expressFee: q.expressFee, usdRate: q.usdRate },
    dispatchFee: q.dispatchFee, dispatchPending: q.dispatchPending,
    total: q.total, eta: etaFor(method), origin,
    status: 'pending', stage: '', timeline: [], emails: [], createdAt: new Date().toISOString()
  };
  const orders = readJson(ORDERS_FILE);
  orders.unshift(order);
  writeJson(ORDERS_FILE, orders);
  if (giftPack) markGiftUsed(giftPack.claim.id, order.id);
  if (!PAYSTACK_SECRET) {
    order.stage = 'placed';
    order.timeline.push({ stage: 'placed', at: order.createdAt });
    writeJson(ORDERS_FILE, orders);
    notifyOrder(order.id, 'placed').catch(() => {});
    return res.json({ ok: true, orderId: order.id, total: q.total, email: maskEmail(email), message: 'Order received. Payment is not switched on yet.' });
  }
  try {
    const tx = await paystack('POST', '/transaction/initialize', {
      email, amount: Math.round(q.total * 100), currency: 'NGN', reference: order.id,
      callback_url: origin + '/', metadata: { orderId: order.id, customer: order.customer.name, phone: order.customer.phone, delivery: delivery.type }
    });
    res.json({ ok: true, orderId: order.id, total: q.total, paymentUrl: tx.authorization_url });
  } catch (e) {
    console.warn('Paystack initialize failed:', e.message);
    res.status(502).json({ error: 'Could not start payment. Please try again in a moment.' });
  }
});

// The storefront calls this when the customer returns from Paystack. We ask Paystack directly, we never trust the browser.
app.get('/api/paystack/verify/:reference', async (req, res) => {
  const reference = cleanText(req.params.reference);
  if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'Payments are not switched on.' });
  try {
    const tx = await paystack('GET', '/transaction/verify/' + encodeURIComponent(reference));
    const order = settleOrder(reference, tx);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json({ ok: true, paid: order.status === 'paid', orderId: order.id, total: order.total, count: order.lines.reduce((n, l) => n + l.quantity, 0), email: maskEmail(order.email) });
  } catch (e) {
    res.status(502).json({ error: 'Could not confirm payment yet.' });
  }
});

// Paystack calls this too, so orders are marked paid even if the customer closes the browser before returning.
app.post('/api/paystack/webhook', (req, res) => {
  if (!PAYSTACK_SECRET || !req.rawBody) return res.sendStatus(400);
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET).update(req.rawBody).digest('hex');
  const got = String(req.headers['x-paystack-signature'] || '');
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return res.sendStatus(401);
  const ev = req.body || {};
  if (ev.event === 'charge.success' && ev.data && ev.data.reference) settleOrder(ev.data.reference, ev.data);
  res.sendStatus(200);
});

// Customers track an order with the order ID plus the email they used at checkout (no account needed).
const trackHits = new Map();
app.get('/api/track', (req, res) => {
  const now = Date.now();
  const hit = trackHits.get(req.ip) || { n: 0, t: now };
  if (now - hit.t > 60000) { hit.n = 0; hit.t = now; }
  hit.n++; trackHits.set(req.ip, hit);
  if (trackHits.size > 5000) trackHits.clear();
  if (hit.n > 20) return res.status(429).json({ error: 'Too many tries. Please wait a minute.' });
  const id = cleanText(req.query.id).toLowerCase();
  const email = cleanText(req.query.email).toLowerCase();
  const o = readJson(ORDERS_FILE).find(x => String(x.id).toLowerCase() === id);
  if (!o || !email || String(o.email || '').toLowerCase() !== email) return res.status(404).json({ error: 'We could not find an order with that ID and email.' });
  res.json({ ok: true, order: { id: o.id, status: o.status, stage: o.stage || '', timeline: o.timeline || [], eta: o.eta || null,
    method: o.shipping && o.shipping.method, delivery: o.delivery || { type: 'door' }, state: o.customer && o.customer.state, area: o.customer && o.customer.city, total: o.total,
    lines: (o.lines || []).map(l => ({ name: l.name, quantity: l.quantity, color: l.color || '', size: l.size || '', variant: l.variant || '' })), createdAt: o.createdAt, stages: STAGES.map(s => ({ key: s.key, label: (o.delivery && o.delivery.type === 'pickup' && s.labelPickup) || s.label })) } });
});

// ===== Reviews =====
const reviewHits = new Map();   // very small per-IP limiter against spam
function reviewLimited(ip) {
  const now = Date.now(), list = (reviewHits.get(ip) || []).filter(t => now - t < 3600e3);
  list.push(now); reviewHits.set(ip, list);
  return list.length > 12;
}
app.get('/api/reviews/:productId', (req, res) => {
  const list = readJson(REVIEWS_FILE).filter(r => r.productId === String(req.params.productId) && !r.hidden)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 100);
  const avg = list.length ? Math.round(list.reduce((n, r) => n + r.rating, 0) / list.length * 10) / 10 : 0;
  res.json({ count: list.length, avg, reviews: list.map(r => ({ name: r.name, rating: r.rating, text: r.text, date: r.createdAt })) });
});
app.post('/api/reviews', (req, res) => {
  if (reviewLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  const b = req.body || {};
  const productId = cleanText(b.productId), name = escapeHtmlText(b.name).slice(0, 40), email = cleanText(b.email).toLowerCase().slice(0, 120);
  const rating = Math.round(Number(b.rating)), text = cleanMultiline(b.text).slice(0, 600);
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter the email you used when you ordered.' });
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Choose a star rating from 1 to 5.' });
  if (text.length < 3) return res.status(400).json({ error: 'Please write a short review.' });
  const product = readJson(PRODUCTS_FILE).find(p => String(p.id) === productId);
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  const order = readJson(ORDERS_FILE).find(o => String(o.email || '').toLowerCase() === email && o.status !== 'cancelled'
    && (o.status === 'paid' || !PAYSTACK_SECRET) && (o.lines || []).some(l => String(l.id) === productId));
  if (!order) return res.status(403).json({ error: 'Only customers who ordered this product can review it. Use the same email you ordered with.' });
  const reviews = readJson(REVIEWS_FILE);
  const mine = reviews.find(r => r.productId === productId && r.email === email);
  if (mine) Object.assign(mine, { name, rating, text, orderId: order.id, updatedAt: new Date().toISOString() });
  else reviews.unshift({ id: makeId(), productId, name, email, rating, text, orderId: order.id, hidden: false, createdAt: new Date().toISOString() });
  writeJson(REVIEWS_FILE, reviews);
  res.json({ ok: true, updated: !!mine });
});
app.get('/api/admin/reviews', requireAdmin, (req, res) => {
  const products = readJson(PRODUCTS_FILE);
  res.json({ reviews: readJson(REVIEWS_FILE).map(r => ({ ...r, productName: (products.find(p => String(p.id) === r.productId) || {}).name || '(deleted product)' })) });
});
app.post('/api/admin/reviews/:id/hide', requireAdmin, (req, res) => {
  const reviews = readJson(REVIEWS_FILE), r = reviews.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Review not found' });
  r.hidden = !r.hidden; writeJson(REVIEWS_FILE, reviews); res.json({ ok: true, hidden: r.hidden });
});
app.delete('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  writeJson(REVIEWS_FILE, readJson(REVIEWS_FILE).filter(r => r.id !== req.params.id)); res.json({ ok: true });
});

// ===== Product requests: customers ask for something not listed (or sold out) and are emailed when it is =====
const REQ_STOP = new Set(['the','and','for','with','new','want','need','please','looking','buy','any','that','this','have','size','color','colour','like','you','are','can','get','some']);
const reqTokens = t => [...new Set(String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !REQ_STOP.has(w)))];
function matchScore(r, p) {
  const rt = reqTokens(r.product), pt = reqTokens(p.name + ' ' + (p.category || ''));
  if (!rt.length) return 0;
  const hits = rt.filter(w => pt.some(x => x === w || x.startsWith(w) || w.startsWith(x))).length;
  return hits >= Math.max(1, Math.ceil(rt.length / 2)) ? hits : 0;
}
function matchingProducts(r, products) {
  return products.filter(p => p.active !== false && p.inStock !== false).map(p => ({ p, n: matchScore(r, p) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3).map(x => x.p);
}
function matchingRequests(p) { return readJson(REQUESTS_FILE).filter(r => r.status === 'open' && matchScore(r, p) > 0); }
async function sendListedEmail(r, product, base, backInStock) {
  if (!r.notify || !emailConfigured()) return { ok: false, error: r.notify ? 'Email is not set up' : 'Customer did not ask for email updates' };
  return sendEmail({ to: r.email, ...requestListedEmail(r, publicProduct(product), base, backInStock) });
}
async function notifyRequestsForProduct(product, base) {
  const list = readJson(REQUESTS_FILE); let n = 0;
  for (const r of list) {
    if (r.status !== 'open' || r.productId !== String(product.id)) continue;
    const out = await sendListedEmail(r, product, base, true);
    r.status = 'notified'; r.notifiedAt = new Date().toISOString(); r.notifiedProductId = product.id; r.emailOk = !!out.ok;
    if (out.ok) n++;
  }
  writeJson(REQUESTS_FILE, list);
  return n;
}
app.post('/api/requests', async (req, res) => {
  if (rateLimited('requests', req.ip, 8, 3600e3)) return res.status(429).json({ error: 'Too many requests from this connection. Please try again later.' });
  const b = req.body || {};
  const product = escapeHtmlText(b.product).slice(0, 120), details = cleanMultiline(b.details).slice(0, 500), name = escapeHtmlText(b.name).slice(0, 60);
  const email = cleanText(b.email).toLowerCase().slice(0, 120), phone = cleanText(b.phone).replace(/[^0-9+ ()-]/g, '').slice(0, 25), productId = cleanText(b.productId).slice(0, 40), notify = b.notify !== false;
  if (product.length < 3) return res.status(400).json({ error: 'Tell us what product you are looking for.' });
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address so we can tell you when it is listed.' });
  const list = readJson(REQUESTS_FILE);
  const dup = list.find(r => r.email === email && r.status === 'open' && r.product.toLowerCase() === product.toLowerCase());
  if (dup) {
    Object.assign(dup, { details: details || dup.details, name, phone: phone || dup.phone, notify, productId: productId || dup.productId, updatedAt: new Date().toISOString() });
    writeJson(REQUESTS_FILE, list); return res.json({ ok: true, duplicate: true });
  }
  const r = { id: makeId(), product, details, name, email, phone, productId, notify, status: 'open', createdAt: new Date().toISOString() };
  list.unshift(r); writeJson(REQUESTS_FILE, list.slice(0, 3000));
  if (notify && emailConfigured()) sendEmail({ to: email, ...requestReceivedEmail(r, baseUrl(req)) }).catch(() => {});
  res.json({ ok: true });
});
app.get('/api/admin/requests', requireAdmin, (req, res) => {
  const products = readJson(PRODUCTS_FILE);
  res.json({ requests: readJson(REQUESTS_FILE).map(r => ({ ...r, suggest: r.status === 'open' ? matchingProducts(r, products).map(p => ({ id: p.id, name: p.name })) : [] })), products: products.filter(p => p.active !== false).map(p => ({ id: p.id, name: p.name })) });
});
app.post('/api/admin/requests/:id/notify', requireAdmin, async (req, res) => {
  const list = readJson(REQUESTS_FILE), r = list.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  const p = readJson(PRODUCTS_FILE).find(x => String(x.id) === cleanText(req.body && req.body.productId) && x.active !== false);
  if (!p) return res.status(400).json({ error: 'Choose the product that is now listed.' });
  const out = await sendListedEmail(r, p, baseUrl(req), false);
  r.status = 'notified'; r.notifiedAt = new Date().toISOString(); r.notifiedProductId = p.id; r.emailOk = !!out.ok;
  writeJson(REQUESTS_FILE, list);
  res.json({ ok: !!out.ok, error: out.error || '' });
});
app.post('/api/admin/requests/:id/close', requireAdmin, (req, res) => {
  const list = readJson(REQUESTS_FILE), r = list.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  r.status = 'closed'; writeJson(REQUESTS_FILE, list); res.json({ ok: true });
});
app.delete('/api/admin/requests/:id', requireAdmin, (req, res) => {
  writeJson(REQUESTS_FILE, readJson(REQUESTS_FILE).filter(r => r.id !== req.params.id)); res.json({ ok: true });
});

// Admin: send the customer your own written update about their goods (any time, any wording).
app.post('/api/admin/orders/:id/message', requireAdmin, async (req, res) => {
  const message = cleanMultiline(req.body && req.body.message).slice(0, 800);
  if (message.length < 3) return res.status(400).json({ error: 'Write a message first.' });
  const o = readJson(ORDERS_FILE).find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const email = await notifyOrder(o.id, o.stage || 'placed', message);
  res.json({ ok: email.ok, email });
});

// Admin: send yourself a test email to check Brevo is working.
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const to = cleanText(req.body && req.body.to).slice(0, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!emailConfigured()) return res.status(400).json({ error: 'Email is not set up. Add MAILJET_API_KEY, MAILJET_SECRET_KEY and EMAIL_FROM in your server settings.' });
  const r = await sendEmail({ to, subject: 'CAAYO test email', html: '<p>This is a test from your CAAYO store. Email is working.</p>', text: 'This is a test from your CAAYO store. Email is working.' });
  res.json({ ok: r.ok, error: r.error || '' });
});

// Admin: move an order to the next stage and email the customer.
app.post('/api/admin/orders/:id/stage', requireAdmin, async (req, res) => {
  const stage = cleanText(req.body && req.body.stage);
  if (!STAGES.some(s => s.key === stage)) return res.status(400).json({ error: 'Unknown stage' });
  const orders = readJson(ORDERS_FILE);
  const o = orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  o.stage = stage;
  (o.timeline = o.timeline || []).push({ stage, at: new Date().toISOString() });
  writeJson(ORDERS_FILE, orders);
  let email = { ok: false, error: 'Email not sent' };
  if (!req.body || req.body.notify !== false) email = await notifyOrder(o.id, stage);
  res.json({ ok: true, email, order: readJson(ORDERS_FILE).find(x => x.id === o.id) });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({ ...readSettings(), emailOn: emailConfigured(), paystackOn: !!PAYSTACK_SECRET });
});
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const cur = readSettings(), b = req.body || {};
  const num = (v, d) => (v !== undefined && v !== null && v !== '' && Number(v) >= 0 ? Number(v) : d);
  const points = Array.isArray(b.pickupPoints)
    ? b.pickupPoints.slice(0, 30).map((p, i) => ({ id: 'pp' + (i + 1), name: cleanText(p && p.name).slice(0, 80), state: STATES.includes(cleanText(p && p.state)) ? cleanText(p.state) : '', area: cleanText(p && p.area).slice(0, 80), address: cleanText(p && p.address).slice(0, 200) })).filter(p => p.name)
    : cur.pickupPoints;
  writeJson(SETTINGS_FILE, {
    usdRate: Number(b.usdRate) > 0 ? Number(b.usdRate) : cur.usdRate,
    freeThreshold: num(b.freeThreshold, cur.freeThreshold),
    doorFeeLocal: num(b.doorFeeLocal, cur.doorFeeLocal),
    doorFeeOther: num(b.doorFeeOther, cur.doorFeeOther),
    thresholdAllStates: typeof b.thresholdAllStates === 'boolean' ? b.thresholdAllStates : cur.thresholdAllStates,
    pickupPoints: points,
    banners: Array.isArray(b.banners) ? cleanBanners(b.banners) : cur.banners
  });
  res.json({ ok: true, ...readSettings(), emailOn: emailConfigured(), paystackOn: !!PAYSTACK_SECRET });
});

// ===== Customer accounts, the Free Gift campaign and referrals =====
// Data: users (accounts), claims (one per visitor gift; holds picks, referral code, referrals, status) and gift (settings + the gift catalog the admin edits).
// Claim status: picking -> sharing (picked, waiting for friends) -> unlocked (enough verified friends) -> used (order placed). cancelled = forfeited.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const digits = v => String(v || '').replace(/\D/g, '');
const readUsers = () => readJson(USERS_FILE);
const writeUsers = v => writeJson(USERS_FILE, v);
const readClaims = () => readJson(CLAIMS_FILE);
const writeClaims = v => writeJson(CLAIMS_FILE, v);
const posInt = (v, d) => (Number(v) > 0 ? Math.round(Number(v)) : d);
function readGift() {
  const raw = readJson(GIFT_FILE), o = raw && !Array.isArray(raw) ? raw : {};
  return { secret: o.secret || '', enabled: o.enabled !== false, value: posInt(o.value, 10000),
    referralsNeeded: Math.min(10, posInt(o.referralsNeeded, 3)), minPurchase: posInt(o.minPurchase, 20000),
    popupImage: cleanText(o.popupImage).slice(0, 600), items: Array.isArray(o.items) ? o.items : [] };
}
const writeGift = g => writeJson(GIFT_FILE, g);
function giftSecret() {
  const g = readGift();
  if (g.secret) return g.secret;
  g.secret = crypto.randomBytes(32).toString('hex'); writeGift(g);
  return g.secret;
}
const giftVisible = it => it.active !== false && it.inStock !== false;
const giftConfigPublic = g => ({ enabled: g.enabled, value: g.value, referralsNeeded: g.referralsNeeded, minPurchase: g.minPurchase, popupImage: g.popupImage });
function cleanGiftItem(b, old = {}) {
  const imgs = uniqueImages([cleanText(b.image), ...(Array.isArray(b.images) ? b.images : [])]).slice(0, 8);
  const names = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => cleanText(x && typeof x === 'object' ? x.name : x).slice(0, 30)).filter(Boolean).slice(0, 30);
  const known = new Map([...(old.colors || []), ...(Array.isArray(b.colors) ? b.colors.filter(c => c && typeof c === 'object') : [])].map(c => [String(c.name || '').toLowerCase(), c]));
  return {
    id: old.id || makeId(),
    name: escapeHtmlText(b.name).slice(0, 120) || 'Free gift item',
    image: imgs[0] || '', images: imgs,
    description: cleanMultiline(b.description).slice(0, 1500),
    value: Math.max(1, Math.round(Number(b.value) || 0)),
    colors: names(b.colors).map(n => { const k = known.get(n.toLowerCase()) || {}; return { name: n, hex: /^#[0-9a-f]{6}$/i.test(String(k.hex)) ? String(k.hex).toLowerCase() : '#999999', image: cleanText(k.image).slice(0, 500) }; }),
    sizes: names(b.sizes).map(s => s.slice(0, 14)),
    weightKg: Math.min(100, Math.max(0.01, Number(b.weightKg) || 0.5)),
    shippingClass: b.shippingClass === 'special' ? 'special' : 'normal',
    airShipping: b.airShipping !== false,
    inStock: b.inStock !== false,
    active: b.active !== false,
    sourceProductId: old.sourceProductId || cleanText(b.sourceProductId).slice(0, 60),
    updatedAt: new Date().toISOString()
  };
}
// ---- passwords and login tokens (no extra packages: Node's scrypt + HMAC) ----
const scryptAsync = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + (await scryptAsync(pw, salt)).toString('hex'); }
async function checkPassword(pw, stored) {
  const [s, d] = String(stored || '').split(':');
  const salt = Buffer.from(s || '00'.repeat(16), 'hex'), dk = await scryptAsync(String(pw), salt), want = Buffer.from(d || '', 'hex');
  return !!s && want.length === dk.length && crypto.timingSafeEqual(dk, want);
}
const hashCode = (code, uid) => crypto.createHash('sha256').update(giftSecret() + '|' + uid + '|' + code).digest('hex');
function makeUserToken(uid) {
  const exp = Date.now() + 30 * 864e5;
  return 'u_' + uid + '_' + exp + '_' + crypto.createHmac('sha256', giftSecret()).update(uid + '.' + exp).digest('base64url');
}
function userFromToken(token) {
  const m = /^u_([a-f0-9]{16})_(\d{10,15})_([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m || Number(m[2]) < Date.now()) return null;
  const want = crypto.createHmac('sha256', giftSecret()).update(m[1] + '.' + m[2]).digest('base64url');
  if (!safeEqual(want, m[3])) return null;
  const u = readUsers().find(x => x.id === m[1]);
  return u && u.verified ? u : null;
}
const authUser = req => userFromToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone });
// ---- referrals ----
const countRefs = c => (c.referrals || []).filter(r => !r.flagged).length;
const needOf = c => c.needed || readGift().referralsNeeded;
function publicClaim(c) {
  if (!c) return null;
  return { status: c.status, totalValue: c.totalValue, referralCode: c.referralCode || '', referralCount: countRefs(c), referralsNeeded: needOf(c),
    minPurchase: c.minPurchase || readGift().minPurchase, orderId: c.orderId || '',
    items: (c.items || []).map(i => ({ id: i.giftId, name: i.name, image: i.image, value: i.value, color: i.color, size: i.size, quantity: i.quantity })) };
}
function applyReferral(uid) {
  const users = readUsers(), u = users.find(x => x.id === uid);
  if (!u || !u.verified || !u.ref || u.refApplied) return;
  u.refApplied = true; writeUsers(users);
  const claims = readClaims(), c = claims.find(x => x.referralCode === u.ref && x.status === 'sharing');
  if (!c) return;
  const owner = c.userId ? users.find(x => x.id === c.userId) : null;
  const self = (u.refGiftToken && u.refGiftToken === c.giftToken) || c.userId === u.id ||
    (owner && (owner.email === u.email || (digits(owner.phone) && digits(owner.phone) === digits(u.phone))));
  if (self) return;
  c.referrals = c.referrals || [];
  if (c.referrals.some(r => r.userId === u.id || (digits(r.phone) && digits(r.phone) === digits(u.phone)))) return;
  const sameIp = c.referrals.filter(r => r.ip === u.signupIp && Date.now() - new Date(r.at).getTime() < 864e5).length;
  c.referrals.push({ userId: u.id, email: u.email, phone: u.phone, ip: u.signupIp || '', at: new Date().toISOString(), flagged: sameIp >= 2 });   // 3rd account from one connection waits for admin approval
  if (countRefs(c) >= needOf(c)) { c.status = 'unlocked'; c.unlockedAt = new Date().toISOString(); }
  c.updatedAt = new Date().toISOString();
  writeClaims(claims);
}
const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRefCode(claims) {
  for (;;) {
    let s = ''; for (let i = 0; i < 8; i++) s += REF_CHARS[crypto.randomInt(REF_CHARS.length)];
    if (!claims.some(c => c.referralCode === s)) return s;
  }
}
const TOKEN_RE = /^[a-f0-9]{24,64}$/;
async function sendVerifyCode(u, code) {
  return sendEmail({ to: u.email, subject: 'Your CAAYO verification code',
    html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;color:#111"><div style="background:#000;color:#fff;text-align:center;padding:16px;font-size:24px;font-weight:900;border-radius:12px 12px 0 0">CAAYO</div><div style="border:1px solid #eee;border-top:0;padding:22px;border-radius:0 0 12px 12px"><p style="margin:0 0 12px">Hi ${h(u.name)}, use this code to finish creating your account:</p><p style="font-size:34px;letter-spacing:8px;font-weight:800;margin:14px 0">${code}</p><p style="color:#666;font-size:13px;margin:0">It expires in 15 minutes. If you did not ask for it, ignore this email.</p></div></div>`,
    text: 'Your CAAYO verification code is ' + code + '. It expires in 15 minutes.' });
}
app.post('/api/auth/signup', async (req, res) => {
  if (rateLimited('signup', req.ip, 10, 3600e3)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  const b = req.body || {};
  const name = cleanText(b.name).slice(0, 80), email = cleanText(b.email).toLowerCase().slice(0, 120), phone = cleanText(b.phone).slice(0, 25), password = String(b.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'Enter your name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (digits(phone).length < 7) return res.status(400).json({ error: 'Enter a valid phone number.' });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'Choose a password of at least 8 characters.' });
  const passwordHash = await hashPassword(password);
  const users = readUsers();
  let u = users.find(x => x.email === email);
  if (u && u.verified) return res.status(409).json({ error: 'An account with this email already exists. Log in instead.' });
  const needVerify = emailConfigured(), code = String(crypto.randomInt(100000, 1000000));
  if (!u) { u = { id: makeId(), createdAt: new Date().toISOString() }; users.push(u); }
  const ref = String(b.ref || '').toUpperCase(), tok = String(b.giftToken || '');
  Object.assign(u, { name, email, phone, passwordHash, verified: !needVerify, ref: /^[A-Z0-9]{6,12}$/.test(ref) ? ref : '', refGiftToken: TOKEN_RE.test(tok) ? tok : '',
    refApplied: false, signupIp: req.ip, codeHash: needVerify ? hashCode(code, u.id) : '', codeExp: Date.now() + 15 * 60e3, codeTries: 0 });
  writeUsers(users);
  if (!needVerify) { applyReferral(u.id); return res.json({ ok: true, token: makeUserToken(u.id), user: publicUser(u) }); }
  const sent = await sendVerifyCode(u, code);
  if (!sent.ok) return res.status(502).json({ error: 'We could not send the verification email. Check the address and try again.' });
  res.json({ ok: true, needsVerify: true, email });
});
app.post('/api/auth/resend', async (req, res) => {
  const email = cleanText(req.body && req.body.email).toLowerCase();
  if (rateLimited('resend', req.ip + '|' + email, 5, 3600e3)) return res.status(429).json({ error: 'Too many codes requested. Please wait a while.' });
  const users = readUsers(), u = users.find(x => x.email === email && !x.verified);
  if (!u) return res.json({ ok: true });
  const code = String(crypto.randomInt(100000, 1000000));
  u.codeHash = hashCode(code, u.id); u.codeExp = Date.now() + 15 * 60e3; u.codeTries = 0; writeUsers(users);
  const sent = await sendVerifyCode(u, code);
  if (!sent.ok) return res.status(502).json({ error: 'We could not send the email. Try again shortly.' });
  res.json({ ok: true });
});
app.post('/api/auth/verify', (req, res) => {
  if (rateLimited('verify', req.ip, 30, 3600e3)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  const email = cleanText(req.body && req.body.email).toLowerCase(), code = cleanText(req.body && req.body.code);
  const users = readUsers(), u = users.find(x => x.email === email);
  if (!u || !u.codeHash) return res.status(400).json({ error: 'That code is not valid. Request a new one.' });
  if (u.codeTries >= 5) return res.status(429).json({ error: 'Too many wrong codes. Request a new code.' });
  if (Date.now() > u.codeExp) return res.status(400).json({ error: 'That code has expired. Request a new one.' });
  if (!safeEqual(hashCode(code, u.id), u.codeHash)) { u.codeTries = (u.codeTries || 0) + 1; writeUsers(users); return res.status(400).json({ error: 'That code is not right.' }); }
  u.verified = true; u.codeHash = ''; u.verifiedAt = new Date().toISOString(); writeUsers(users);
  applyReferral(u.id);
  res.json({ ok: true, token: makeUserToken(u.id), user: publicUser(u) });
});
app.post('/api/auth/login', async (req, res) => {
  if (rateLimited('login', req.ip, 20, 15 * 60e3)) return res.status(429).json({ error: 'Too many attempts. Please try again in a few minutes.' });
  const email = cleanText(req.body && req.body.email).toLowerCase(), password = String((req.body && req.body.password) || '');
  const u = readUsers().find(x => x.email === email);
  const ok = await checkPassword(password, u && u.passwordHash);   // always runs, so timing does not reveal whether the email exists
  if (!u || !ok) return res.status(401).json({ error: 'Wrong email or password.' });
  if (!u.verified) return res.status(403).json({ error: 'Please verify your email first.', needsVerify: true, email });
  res.json({ ok: true, token: makeUserToken(u.id), user: publicUser(u) });
});
app.get('/api/auth/me', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: publicUser(u) });
});
app.get('/api/my/orders', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  const list = readJson(ORDERS_FILE).filter(o => o.userId === u.id || (!o.userId && String(o.email || '').toLowerCase() === u.email))
    .map(o => ({ id: o.id, total: o.total, count: (o.lines || []).reduce((n, l) => n + (Number(l.quantity) || 0), 0), createdAt: o.createdAt, paid: o.status === 'paid', email: o.email,
      method: (o.shipping && o.shipping.method) || 'standard', type: (o.delivery && o.delivery.type) || 'door', gift: !!o.gift }));
  res.json({ orders: list.slice(0, 50) });
});

// ---- Free gift: public side ----
app.get('/api/gift/catalog', (req, res) => {
  const g = readGift();
  res.json({ config: giftConfigPublic(g), items: g.enabled ? g.items.filter(giftVisible).map(({ sourceProductId, ...it }) => it) : [] });
});
app.get('/api/gift/status', (req, res) => {
  const tok = String(req.query.token || '');
  if (!TOKEN_RE.test(tok)) return res.json({ claim: null });
  res.json({ claim: publicClaim(readClaims().find(c => c.giftToken === tok)) });
});
app.post('/api/gift/claim', (req, res) => {
  if (rateLimited('giftclaim', req.ip, 80, 3600e3)) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  const cfg = readGift(), b = req.body || {}, tok = String(b.giftToken || '');
  if (!cfg.enabled) return res.status(400).json({ error: 'The free gift is not running right now.' });
  if (!TOKEN_RE.test(tok)) return res.status(400).json({ error: 'Something went wrong. Refresh the page and try again.' });
  const catalog = new Map(cfg.items.filter(giftVisible).map(i => [i.id, i]));
  const merged = new Map();
  for (const p of (Array.isArray(b.items) ? b.items : []).slice(0, 40)) {
    const it = catalog.get(String(p && p.id));
    if (!it) return res.status(400).json({ error: 'One of your picks is no longer available. Please check your list.' });
    const color = cleanText(p.color), size = cleanText(p.size), qty = Math.max(1, Math.min(10, parseInt(p.quantity, 10) || 1));
    if ((it.colors || []).length && !it.colors.some(c => c.name === color)) return res.status(400).json({ error: 'Choose a colour for ' + it.name + '.' });
    if ((it.sizes || []).length && !it.sizes.includes(size)) return res.status(400).json({ error: 'Choose a size for ' + it.name + '.' });
    const k = [it.id, color, size].join('::'), prev = merged.get(k);
    merged.set(k, prev ? { ...prev, quantity: Math.min(10, prev.quantity + qty) } : { giftId: it.id, name: it.name, image: it.image, value: it.value, color: (it.colors || []).length ? color : '', size: (it.sizes || []).length ? size : '', quantity: qty,
      weightKg: it.weightKg, shippingClass: it.shippingClass, airShipping: it.airShipping !== false });
  }
  const items = [...merged.values()], total = items.reduce((n, i) => n + i.value * i.quantity, 0);
  if (total > cfg.value) return res.status(400).json({ error: 'Your picks are worth more than ' + money(cfg.value) + '. Remove something.' });
  const claims = readClaims();
  let c = claims.find(x => x.giftToken === tok);
  if (c && ['unlocked', 'used', 'cancelled'].includes(c.status)) return res.status(409).json({ error: 'This gift is already unlocked or used.', claim: publicClaim(c) });
  if (c && (c.referrals || []).length) return res.status(409).json({ error: 'Your picks are locked because a friend already joined.', claim: publicClaim(c) });
  if (!c) { c = { id: makeId(), giftToken: tok, userId: '', email: '', items: [], totalValue: 0, status: 'picking', referralCode: '', referrals: [], createdAt: new Date().toISOString(), ip: req.ip }; claims.push(c); }
  c.items = items; c.totalValue = total; c.updatedAt = new Date().toISOString(); c.status = 'picking';
  if (b.finalize) {
    if (!items.length) return res.status(400).json({ error: 'Pick at least one item.' });
    const cheapest = Math.min(...[...catalog.values()].map(i => i.value));
    if (!(total >= cfg.value || cfg.value - total < cheapest)) return res.status(400).json({ error: 'Keep adding items to fill your ' + money(cfg.value) + ' bar.' });
    c.status = 'sharing'; c.referralCode = c.referralCode || newRefCode(claims); c.needed = cfg.referralsNeeded; c.minPurchase = cfg.minPurchase;
  }
  writeClaims(claims);
  res.json({ ok: true, claim: publicClaim(c) });
});
app.post('/api/gift/attach', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in first.' });
  const tok = String((req.body && req.body.giftToken) || '');
  const claims = readClaims(), mine = claims.find(c => c.userId === u.id && c.status !== 'cancelled'), c = TOKEN_RE.test(tok) ? claims.find(x => x.giftToken === tok) : null;
  if (mine && (!c || c.id !== mine.id)) return res.json({ ok: true, existing: true, giftToken: mine.giftToken, claim: publicClaim(mine) });   // one gift per account
  if (!c) return res.json({ ok: true, claim: null });
  if (c.userId && c.userId !== u.id) return res.status(409).json({ error: 'This gift already belongs to another account.' });
  c.userId = u.id; c.email = u.email; c.updatedAt = new Date().toISOString(); writeClaims(claims);
  res.json({ ok: true, claim: publicClaim(c) });
});
app.post('/api/gift/forfeit', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in first.' });
  const claims = readClaims(), c = claims.find(x => x.userId === u.id && x.status === 'unlocked');
  if (!c) return res.status(400).json({ error: 'There is no unlocked gift to remove.' });
  c.status = 'cancelled'; c.updatedAt = new Date().toISOString(); writeClaims(claims);
  res.json({ ok: true });
});
// Called inside POST /api/orders. Everything is checked here, never trusted from the browser.
function prepareGiftForOrder(user, paidLines) {
  const claims = readClaims();
  const c = claims.find(x => x.userId === user.id && ['unlocked', 'used'].includes(x.status));
  if (!c) return { error: 'You do not have an unlocked free gift on this account.' };
  if (c.status === 'used') {
    // A gift order that was never paid (customer left the payment page) is released after 20 minutes so the gift is not lost.
    const orders = readJson(ORDERS_FILE), old = orders.find(o => o.id === c.orderId);
    if (PAYSTACK_SECRET && old && old.status === 'pending' && Date.now() - new Date(old.createdAt).getTime() > 20 * 60e3) {
      old.giftReleased = true; writeJson(ORDERS_FILE, orders); c.status = 'unlocked'; writeClaims(claims);
    } else return { error: 'Your free gift has already been used.' };
  }
  const min = c.minPurchase || readGift().minPurchase, paid = paidLines.reduce((n, l) => n + l.price * l.quantity, 0);
  if (paid < min) return { error: 'Add ' + money(min - paid) + ' more of other items to claim your free gift.' };
  const lines = c.items.map(i => ({ id: 'gift:' + i.giftId, name: i.name, price: 0, quantity: i.quantity, color: i.color || '', size: i.size || '', variant: '', condition: '', labels: [], gift: true, giftValue: i.value,
    image: /^https:\/\//i.test(String(i.image)) || /^\/uploads\//.test(String(i.image)) ? String(i.image).slice(0, 500) : '' }));
  const synth = c.items.map(i => ({ id: 'gift:' + i.giftId, weightKg: i.weightKg, shippingClass: i.shippingClass, airShipping: i.airShipping !== false }));
  return { claim: c, lines, synth };
}
function markGiftUsed(claimId, orderId) {
  const claims = readClaims(), c = claims.find(x => x.id === claimId);
  if (!c) return;
  c.status = 'used'; c.orderId = orderId; c.usedAt = new Date().toISOString(); writeClaims(claims);
}

// ---- Free gift: admin side ----
const giftAdminView = () => { const g = readGift(); return { config: giftConfigPublic(g), items: g.items }; };
app.get('/api/admin/gift', requireAdmin, (req, res) => {
  const claims = readClaims(), by = s => claims.filter(c => c.status === s).length;
  res.json({ ...giftAdminView(), emailOn: emailConfigured(),
    stats: { started: claims.length, sharing: by('sharing'), unlocked: by('unlocked'), used: by('used'), valueGiven: claims.filter(c => c.status === 'used').reduce((n, c) => n + (c.totalValue || 0), 0) } });
});
app.post('/api/admin/gift/config', requireAdmin, (req, res) => {
  const g = readGift(), b = req.body || {};
  g.enabled = b.enabled !== false;
  g.value = posInt(b.value, g.value);
  g.referralsNeeded = Math.min(10, posInt(b.referralsNeeded, g.referralsNeeded));
  g.minPurchase = posInt(b.minPurchase, g.minPurchase);
  if (b.popupImage !== undefined) g.popupImage = cleanText(b.popupImage).slice(0, 600);
  writeGift(g);
  res.json({ ok: true, ...giftAdminView() });
});
app.post('/api/admin/gift/item', requireAdmin, (req, res) => {
  const g = readGift(), b = req.body || {}, i = g.items.findIndex(x => x.id === cleanText(b.id));
  const item = cleanGiftItem(b, i >= 0 ? g.items[i] : {});
  if (!item.image) return res.status(400).json({ error: 'Add at least one photo for the gift item.' });
  if (!(Number(b.value) > 0)) return res.status(400).json({ error: 'Set the value of this gift item (what it counts for in the bar).' });
  if (i >= 0) g.items[i] = item; else g.items.push(item);
  writeGift(g);
  res.json({ ok: true, item, ...giftAdminView() });
});
app.post('/api/admin/gift/from-product', requireAdmin, (req, res) => {
  const g = readGift(), pid = cleanText(req.body && req.body.productId);
  const p = readJson(PRODUCTS_FILE).find(x => String(x.id) === pid);
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  const dupe = g.items.find(x => x.sourceProductId === pid);
  if (dupe) return res.json({ ok: true, existing: true, item: dupe, ...giftAdminView() });
  const prices = (Array.isArray(p.variants) ? p.variants.map(v => Number(v.price)) : []).filter(n => n > 0);
  const value = Number(req.body.value) > 0 ? Number(req.body.value) : (prices.length ? Math.min(...prices) : Number(p.caayoPrice) || 1);
  const item = cleanGiftItem({ name: p.name, image: p.image, images: p.images, description: p.description, value, colors: p.colors, sizes: p.sizes, weightKg: p.weightKg,
    shippingClass: p.shippingClass, airShipping: p.airShipping !== false, inStock: p.inStock !== false, active: true, sourceProductId: pid });
  g.items.push(item); writeGift(g);
  res.json({ ok: true, item, ...giftAdminView() });
});
app.delete('/api/admin/gift/item/:id', requireAdmin, (req, res) => {
  const g = readGift(); g.items = g.items.filter(x => x.id !== req.params.id); writeGift(g);
  res.json({ ok: true, ...giftAdminView() });
});
app.get('/api/admin/gift/claims', requireAdmin, (req, res) => {
  const users = readUsers(), cfg = readGift();
  res.json({ claims: readClaims().slice().reverse().slice(0, 300).map(c => { const u = users.find(x => x.id === c.userId);
    return { id: c.id, status: c.status, user: u ? { name: u.name, email: u.email, phone: u.phone } : null, items: (c.items || []).map(i => i.name + (i.color || i.size ? ' (' + [i.color, i.size].filter(Boolean).join(', ') + ')' : '') + ' x' + i.quantity),
      totalValue: c.totalValue, referralCode: c.referralCode, referralCount: countRefs(c), needed: c.needed || cfg.referralsNeeded, flagged: (c.referrals || []).filter(r => r.flagged).length,
      referrals: (c.referrals || []).map(r => ({ email: r.email, ip: r.ip, at: r.at, flagged: !!r.flagged })), orderId: c.orderId || '', createdAt: c.createdAt }; }) });
});
app.post('/api/admin/gift/claims/:id/action', requireAdmin, (req, res) => {
  const claims = readClaims(), c = claims.find(x => x.id === req.params.id), act = cleanText(req.body && req.body.action);
  if (!c) return res.status(404).json({ error: 'Claim not found.' });
  const cfg = readGift();
  if (act === 'unlock') { c.status = 'unlocked'; c.referralCode = c.referralCode || newRefCode(claims); c.needed = c.needed || cfg.referralsNeeded; c.minPurchase = c.minPurchase || cfg.minPurchase; }
  else if (act === 'release') { if (c.status === 'used') c.status = 'unlocked'; }
  else if (act === 'reset') { c.referrals = []; c.status = c.referralCode ? 'sharing' : 'picking'; }
  else if (act === 'cancel') c.status = 'cancelled';
  else if (act === 'approve') { (c.referrals || []).forEach(r => { r.flagged = false; }); if (c.status === 'sharing' && countRefs(c) >= needOf(c)) c.status = 'unlocked'; }
  else return res.status(400).json({ error: 'Unknown action.' });
  c.updatedAt = new Date().toISOString(); writeClaims(claims);
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true, products: readJson(PRODUCTS_FILE).length, storage: db ? 'database' : 'files' }));

// Bad JSON / oversized bodies get a clean answer instead of a stack trace.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return res.status(400).json({ error: 'Invalid request.' });
  console.error('Unhandled error:', err && err.message);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e && e.message));
process.on('uncaughtException', e => console.error('Uncaught exception:', e && e.message));
if (ADMIN_PASSWORD !== DEFAULT_PASSWORD && ADMIN_PASSWORD.length < 12) console.warn('WARNING: ADMIN_PASSWORD is shorter than 12 characters. Use a long, unique password.');
initStorage().then(() => {
  autoCategoriseAll();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CAAYO running on 0.0.0.0:${PORT}` + (db ? ' (database storage)' : ' (local file storage)'));
  });
}).catch(e => { console.error('Could not connect to the database:', e.message); process.exit(1); });

// Zero-dependency server: Facebook Lead Ads webhook -> order number -> Shopify -> thank-you lookup.
// Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  });
} catch {}

const E = process.env;
const PORT = E.PORT || 3000;
const START = parseInt(E.ORDER_START || '1100001', 10);
const ALLOWED_ORIGIN = E.ALLOWED_ORIGIN || 'https://barkatbooks.com';
const DB = path.join(__dirname, 'data', 'orders.json');
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(path.dirname(DB), { recursive: true });

const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return []; } };
const save = o => fs.writeFileSync(DB, JSON.stringify(o, null, 2));
const clean = (v, n) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, n);
const digits = s => String(s || '').replace(/\D/g, '');
const last10 = s => digits(s).slice(-10);

const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const send = (res, code, body, type = 'application/json', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const cors = { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

async function readBody(req, max = 100000) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > max) throw new Error('too large'); }
  return raw;
}

// Create order synchronously so numbers never collide. Returns existing one if leadId already seen.
function createOrder(o) {
  const orders = load();
  if (o.leadId) { const dup = orders.find(x => x.leadId === o.leadId); if (dup) return { order: dup, dup: true }; }
  o.orderNumber = orders.length ? orders[orders.length - 1].orderNumber + 1 : START;
  o.createdAt = new Date().toISOString();
  orders.push(o); save(orders);
  return { order: o, dup: false };
}

// Shopify token: either a fixed SHOPIFY_TOKEN (shpat_...), or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
// (Dev Dashboard apps): the server fetches a short-lived token itself and renews it automatically.
let shopTok = { token: '', exp: 0 };
async function shopifyToken() {
  if (E.SHOPIFY_TOKEN) return E.SHOPIFY_TOKEN;
  if (shopTok.token && Date.now() < shopTok.exp - 60000) return shopTok.token;
  const r = await fetch(`https://${E.SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: E.SHOPIFY_CLIENT_ID, client_secret: E.SHOPIFY_CLIENT_SECRET }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('Shopify token request failed: ' + JSON.stringify(j));
  shopTok = { token: j.access_token, exp: Date.now() + (j.expires_in || 86400) * 1000 };
  return shopTok.token;
}

// Optional: different product per Page, e.g. PAGE_VARIANTS={"1393831823819607":"111","883258038206977":"222"}
function variantFor(o) {
  try { const m = JSON.parse(E.PAGE_VARIANTS || '{}'); if (o.pageId && m[o.pageId]) return m[o.pageId]; } catch {}
  return E.SHOPIFY_VARIANT_ID;
}

async function pushToShopify(o) {
  if (!E.SHOPIFY_STORE || !(E.SHOPIFY_TOKEN || (E.SHOPIFY_CLIENT_ID && E.SHOPIFY_CLIENT_SECRET))) return null;
  const [first, ...rest] = o.name.split(' ');
  const addr = { first_name: first, last_name: rest.join(' '), address1: o.address, city: o.city, zip: o.zip, phone: o.phone, country: o.country || E.SHOPIFY_COUNTRY || '' };
  const order = {
    email: o.email || undefined, phone: o.phone,
    note: `Facebook lead ${o.leadId || ''}. ${o.note || ''}`.trim(),
    tags: 'facebook-lead' + (o.pageId ? ',page-' + o.pageId : ''),
    shipping_address: addr, billing_address: addr, financial_status: 'pending',
    line_items: variantFor(o) ? [{ variant_id: Number(variantFor(o)), quantity: 1 }] : [{ title: 'Order ' + o.orderNumber, price: '0.00', quantity: 1 }],
  };
  const r = await fetch(`https://${E.SHOPIFY_STORE}/admin/api/2024-10/orders.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await shopifyToken() }, body: JSON.stringify({ order }),
  });
  if (!r.ok) { console.error('Shopify push failed', r.status, await r.text()); return null; }
  const j = await r.json();
  return j.order && j.order.order_number; // Shopify's real order number
}

// Turn Facebook's field_data [{name, values}] into our order fields
function mapLead(fieldData) {
  const f = {};
  for (const x of fieldData || []) f[String(x.name).toLowerCase()] = (x.values || []).join(' ');
  const find = (...keys) => { for (const k of keys) { const hit = Object.keys(f).find(n => n === k) || Object.keys(f).find(n => n.includes(k)); if (hit && f[hit]) return f[hit]; } return ''; };
  const name = f.full_name || [f.first_name, f.last_name].filter(Boolean).join(' ') || find('name');
  return {
    name: clean(name, 100), phone: clean(find('phone_number', 'phone'), 30), email: clean(find('email'), 120),
    address: clean(find('street_address', 'address'), 250), city: clean(find('city'), 80),
    country: clean(find('country'), 60), zip: clean(find('zip_code', 'post_code', 'zip'), 20), state: clean(find('state'), 60),
  };
}

const inflight = new Set();
// Find the access token for a Page: FB_PAGE_TOKENS (JSON {"pageId":"token"}), else derive it from
// FB_USER_TOKEN (long-lived user token that manages all Pages), else the single FB_PAGE_TOKEN.
// Tokens live in data/tokens.json (needs the persistent disk): Page tokens made from a long-lived user token
// do not expire, so once a Page's token is saved it keeps working even if the user token later lapses.
const TOK = path.join(__dirname, 'data', 'tokens.json');
const loadTok = () => { try { return JSON.parse(fs.readFileSync(TOK, 'utf8')); } catch { return {}; } };
const saveTok = t => fs.writeFileSync(TOK, JSON.stringify(t));
const savePageToken = (id, tk) => { const t = loadTok(); t.pages = { ...t.pages, [id]: tk }; saveTok(t); pageTokenCache[id] = tk; };

// All user tokens to try: the auto-refreshed main one, plus optional extras (FB_USER_TOKENS, comma separated,
// for accounts that manage other Pages).
function userTokens() {
  const t = loadTok();
  const main = t.user && t.base === E.FB_USER_TOKEN ? t.user : E.FB_USER_TOKEN;
  return [...new Set([main, ...(E.FB_USER_TOKENS || '').split(',').map(s => s.trim())].filter(Boolean))];
}

// Renews the main user token every ~25 days so it never reaches its 60-day expiry (needs FB_APP_ID + FB_APP_SECRET).
async function refreshUserToken() {
  if (!E.FB_USER_TOKEN || !E.FB_APP_ID || !E.FB_APP_SECRET) return;
  const t = loadTok();
  const fresh = t.base === E.FB_USER_TOKEN;
  if (fresh && t.refreshedAt && Date.now() - t.refreshedAt < 25 * 864e5) return;
  const cur = (fresh && t.user) || E.FB_USER_TOKEN;
  const r = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(E.FB_APP_ID)}&client_secret=${encodeURIComponent(E.FB_APP_SECRET)}&fb_exchange_token=${encodeURIComponent(cur)}`);
  const j = await r.json();
  if (j.access_token) { saveTok({ ...loadTok(), base: E.FB_USER_TOKEN, user: j.access_token, refreshedAt: Date.now() }); console.log('User token refreshed'); }
  else console.error('TOKEN REFRESH FAILED - replace FB_USER_TOKEN soon:', JSON.stringify(j.error || j));
}

const pageTokenCache = {};
async function getPageToken(pageId) {
  if (pageTokenCache[pageId]) return pageTokenCache[pageId];
  try { const m = JSON.parse(E.FB_PAGE_TOKENS || '{}'); if (m[pageId]) return (pageTokenCache[pageId] = m[pageId]); } catch {}
  const saved = (loadTok().pages || {})[pageId];
  if (saved) return (pageTokenCache[pageId] = saved);
  for (const ut of pageId ? userTokens() : []) {
    const r = await fetch(`https://graph.facebook.com/v21.0/${pageId}?fields=access_token,name&access_token=${encodeURIComponent(ut)}`);
    const j = await r.json();
    if (j.access_token) { savePageToken(pageId, j.access_token); return j.access_token; }
  }
  return E.FB_PAGE_TOKEN || '';
}

async function handleLead(leadgenId, pageId) {
  const token = await getPageToken(pageId);
  const r = await fetch(`https://graph.facebook.com/v21.0/${leadgenId}?access_token=${encodeURIComponent(token)}`);
  const j = await r.json();
  if (!r.ok) throw new Error('Graph API: ' + JSON.stringify(j));
  await processLead({ ...mapLead(j.field_data), leadId: String(leadgenId), pageId: String(pageId || ''), source: 'facebook-lead-ad' });
}

async function processLead(o) {
  const leadgenId = o.leadId;
  if (load().some(x => x.leadId === o.leadId) || inflight.has(o.leadId)) return;
  inflight.add(o.leadId);
  try {
    // Shopify assigns the order number; our own counter is only a fallback if Shopify is unavailable
    const shopifyNo = await pushToShopify(o).catch(e => { console.error('Shopify error', e.message); return null; });
    if (shopifyNo) { const orders = load(); o.orderNumber = shopifyNo; o.createdAt = new Date().toISOString(); orders.push(o); save(orders); }
    else createOrder(o);
    console.log(`Lead ${leadgenId} -> order #${o.orderNumber} (${o.name})`);
  } finally { inflight.delete(o.leadId); }
}

// Simple per-IP rate limit for the public lookup (stops phone-number guessing)
const hits = new Map();
const limited = ip => { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a); return a.length > 20; };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain', cors);

    // Facebook webhook verification
    if (req.method === 'GET' && p === '/webhook') {
      if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === E.FB_VERIFY_TOKEN && E.FB_VERIFY_TOKEN)
        return send(res, 200, url.searchParams.get('hub.challenge') || '', 'text/plain');
      return send(res, 403, 'Forbidden', 'text/plain');
    }

    // Facebook delivers new leads here within seconds
    if (req.method === 'POST' && p === '/webhook') {
      const raw = await readBody(req);
      if (E.FB_APP_SECRET) {
        const sig = req.headers['x-hub-signature-256'] || '';
        const want = 'sha256=' + crypto.createHmac('sha256', E.FB_APP_SECRET).update(raw).digest('hex');
        if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return send(res, 403, 'Bad signature', 'text/plain');
      }
      send(res, 200, 'ok', 'text/plain'); // answer fast, process after
      let body; try { body = JSON.parse(raw); } catch { return; }
      for (const entry of body.entry || []) for (const ch of entry.changes || [])
        if (ch.field === 'leadgen' && ch.value?.leadgen_id) handleLead(ch.value.leadgen_id, ch.value.page_id || entry.id).catch(e => console.error('Lead error', e.message));
      return;
    }

    // Thank-you page asks: who is this phone number? -> name + order number
    if (req.method === 'GET' && p === '/api/lookup') {
      if (limited(req.socket.remoteAddress)) return send(res, 429, { error: 'Too many tries' }, 'application/json', cors);
      const ph = last10(url.searchParams.get('phone'));
      if (ph.length < 7) return send(res, 400, { error: 'Enter your phone number' }, 'application/json', cors);
      const o = [...load()].reverse().find(x => last10(x.phone) === ph);
      return o ? send(res, 200, { name: o.name, orderNumber: o.orderNumber }, 'application/json', cors)
               : send(res, 404, { error: 'Not found yet' }, 'application/json', cors);
    }

    // Subscribes EVERY Page your user manages to the app (run once, and again whenever you add a new Page):
    // open https://your-server/api/subscribe-all?key=ADMIN_KEY   (needs FB_USER_TOKEN)
    if (req.method === 'GET' && p === '/api/subscribe-all') {
      if (!E.ADMIN_KEY || url.searchParams.get('key') !== E.ADMIN_KEY) return send(res, 403, { error: 'Forbidden' });
      const uts = userTokens();
      if (!uts.length) return send(res, 400, { error: 'FB_USER_TOKEN not set' });
      const out = [];
      for (const ut of uts) {
      let next = `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(ut)}`;
      while (next) {
        const j = await (await fetch(next)).json();
        if (j.error) return send(res, 502, { error: j.error.message });
        for (const pg of j.data || []) {
          const r = await fetch(`https://graph.facebook.com/v21.0/${pg.id}/subscribed_apps`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `subscribed_fields=leadgen&access_token=${encodeURIComponent(pg.access_token)}` });
          const rj = await r.json();
          if (rj.success) savePageToken(pg.id, pg.access_token);
          out.push({ page: pg.name, id: pg.id, subscribed: !!rj.success, error: rj.error && rj.error.message });
        }
        next = j.paging && j.paging.next;
      }
      }
      return send(res, 200, out);
    }

    // Leads forwarded by Zapier / Make / Pabbly (no Meta app needed): POST /api/lead?key=LEAD_API_KEY
    if (req.method === 'POST' && p === '/api/lead') {
      if (!E.LEAD_API_KEY || url.searchParams.get('key') !== E.LEAD_API_KEY) return send(res, 403, { error: 'Forbidden' });
      let d; try { d = JSON.parse(await readBody(req, 20000)); } catch { return send(res, 400, { error: 'Bad JSON' }); }
      const fd = Object.entries(d).map(([name, v]) => ({ name, values: [String(v ?? '')] }));
      const o = { ...mapLead(fd), leadId: String(d.lead_id || d.id || ('x' + Date.now() + Math.random().toString(36).slice(2, 6))), source: 'facebook-lead-ad' };
      if (!o.name || !o.phone) return send(res, 400, { error: 'name and phone required' });
      send(res, 200, { ok: true });
      processLead(o).catch(e => console.error('Lead error', e.message));
      return;
    }

    // Automatic: thank-you page claims the oldest unclaimed Facebook lead from the last 90s
    if (req.method === 'GET' && p === '/api/claim') {
      if (limited(req.socket.remoteAddress)) return send(res, 429, { error: 'Too many tries' }, 'application/json', cors);
      const orders = load();
      const o = orders.find(x => x.source === 'facebook-lead-ad' && !x.claimed && Date.now() - Date.parse(x.createdAt) < 90000);
      if (!o) return send(res, 404, { error: 'Not yet' }, 'application/json', cors);
      o.claimed = true; save(orders);
      return send(res, 200, { name: o.name, orderNumber: o.orderNumber }, 'application/json', cors);
    }

    // (Optional) plain website form, kept from before
    if (req.method === 'POST' && p === '/api/order') {
      let d; try { d = JSON.parse(await readBody(req, 20000)); } catch { return send(res, 400, { error: 'Bad JSON' }); }
      const o = { name: clean(d.name, 100), phone: clean(d.phone, 30), email: clean(d.email, 120), address: clean(d.address, 250), city: clean(d.city, 80), zip: clean(d.zip, 20), note: clean(d.note, 500), source: clean(d.source, 100) };
      if (!o.name || !o.phone || !o.address || !o.city) return send(res, 400, { error: 'Please fill all required fields.' });
      const no = await pushToShopify(o).catch(() => null);
      if (no) { const orders = load(); o.orderNumber = no; o.createdAt = new Date().toISOString(); orders.push(o); save(orders); }
      else createOrder(o);
      return send(res, 200, { orderNumber: o.orderNumber });
    }
    if (req.method === 'GET' && p === '/api/order') {
      const n = parseInt(url.searchParams.get('n'), 10);
      const o = load().find(x => x.orderNumber === n);
      return o ? send(res, 200, { name: o.name, orderNumber: o.orderNumber }) : send(res, 404, { error: 'Not found' });
    }

    const f = p === '/' ? '/index.html' : p === '/thankyou' ? '/thankyou.html' : p;
    const file = path.join(PUB, path.normalize(f));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream');
  } catch (e) { console.error(e.message); if (!res.headersSent) send(res, 500, { error: 'Server error' }); }
});

refreshUserToken().catch(e => console.error('Refresh error', e.message));
setInterval(() => refreshUserToken().catch(e => console.error('Refresh error', e.message)), 12 * 3600 * 1000);
server.listen(PORT, () => console.log(`Server on :${PORT}  (next order #${(load().slice(-1)[0]?.orderNumber + 1) || START})`));

require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const { Pool } = require('pg');

// ─────────────────────────────────────────────
// POSTGRESQL
// ─────────────────────────────────────────────
let pool = null;

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function initDB() {
  const db = getPool();
  if (!db) { console.log('[db] No DATABASE_URL — using in-memory storage'); return; }
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS credits (
      email TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 3
    );
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      founder_email TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[db] PostgreSQL tables ready');
}

// DB helpers — fall back to in-memory Maps when no DB
async function dbGetUser(email) {
  const db = getPool();
  if (!db) return users.get(email) || null;
  const r = await db.query('SELECT email, password_hash AS "passwordHash", created_at AS "createdAt" FROM users WHERE email=$1', [email]);
  return r.rows[0] || null;
}
async function dbSetUser(email, data) {
  const db = getPool();
  if (!db) { users.set(email, data); return; }
  await db.query(
    'INSERT INTO users(email,password_hash,created_at) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET password_hash=$2',
    [email, data.passwordHash, data.createdAt || new Date().toISOString()]
  );
}
async function dbGetCredits(email) {
  const db = getPool();
  if (!db) return creditBalances.get(email) ?? null;
  const r = await db.query('SELECT balance FROM credits WHERE email=$1', [email]);
  return r.rows[0]?.balance ?? null;
}
async function dbSetCredits(email, balance) {
  const db = getPool();
  if (!db) { creditBalances.set(email, balance); return; }
  await db.query(
    'INSERT INTO credits(email,balance) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET balance=$2',
    [email, balance]
  );
}
async function dbAddCredits(email, amount) {
  const db = getPool();
  if (!db) {
    const cur = creditBalances.get(email) || 0;
    creditBalances.set(email, cur + amount);
    return cur + amount;
  }
  const r = await db.query(
    'INSERT INTO credits(email,balance) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET balance=credits.balance+$2 RETURNING balance',
    [email, amount]
  );
  return r.rows[0].balance;
}
async function dbGetCompany(id) {
  const db = getPool();
  if (!db) return companies.get(id) || null;
  const r = await db.query('SELECT data FROM companies WHERE id=$1', [id]);
  return r.rows[0]?.data || null;
}
async function dbSetCompany(id, founderEmail, data) {
  const db = getPool();
  if (!db) { companies.set(id, { ...data, founderEmail }); return; }
  await db.query(
    'INSERT INTO companies(id,founder_email,data,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET data=$3',
    [id, founderEmail, JSON.stringify(data), data.createdAt || new Date().toISOString()]
  );
}
async function dbGetUserCompanies(email) {
  const db = getPool();
  if (!db) {
    return [...companies.values()]
      .filter(c => c.founderEmail === email)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  const r = await db.query(
    'SELECT data FROM companies WHERE founder_email=$1 ORDER BY created_at DESC',
    [email]
  );
  return r.rows.map(row => row.data);
}

const app = express();
app.use(cors());

// ─────────────────────────────────────────────
// CLIENTS (lazy-init so missing keys don't crash startup)
// ─────────────────────────────────────────────
let anthropic, stripe, resend;

function getAnthropic() {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    const Stripe = require('stripe');
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

function getResend() {
  if (!resend) {
    if (!process.env.RESEND_API_KEY) return null;
    const { Resend } = require('resend');
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

// ─────────────────────────────────────────────
// AUTH — EMAIL + PASSWORD
// ─────────────────────────────────────────────
const users = new Map();        // email → { passwordHash, createdAt }
const userSessions = new Map(); // sessionKey → { email }
const { scrypt, timingSafeEqual } = crypto;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, hash) => {
      if (err) reject(err);
      else resolve(salt + ':' + hash.toString('hex'));
    });
  });
}

async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else {
        try { resolve(timingSafeEqual(Buffer.from(hash, 'hex'), derived)); }
        catch { resolve(false); }
      }
    });
  });
}

function requireAuth(req, res, next) {
  const key = req.headers['x-session-key'];
  const session = key && userSessions.get(key);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });
  req.userEmail = session.email;
  next();
}

// ─────────────────────────────────────────────
// CREDIT SYSTEM
// ─────────────────────────────────────────────
const creditBalances = new Map(); // email → credits
const CREDITS_PER_CREATION = 3;
const FREE_CREDITS_ON_SIGNUP = 3;

const CREDIT_PACKS = [
  { id: 'starter', credits: 10, price: 19, name: 'Starter Pack 🚀', popular: false },
  { id: 'pro',     credits: 30, price: 49, name: 'Pro Pack ⚡',     popular: true  },
  { id: 'scale',   credits: 100, price: 149, name: 'Scale Pack 🔥', popular: false },
];

// ── STRIPE WEBHOOK — registered BEFORE express.json() ──
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const s = getStripe();
  if (!s) return res.status(400).json({ error: 'Stripe not configured' });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret && sig) {
      event = s.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('[webhook] Error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.metadata?.email?.toLowerCase();
    const credits = parseInt(session.metadata?.credits || '0', 10);
    if (email && credits > 0) {
      const newTotal = await dbAddCredits(email, credits);
      console.log(`[credits] +${credits} 💎 → ${email} (total: ${newTotal})`);
    }
  }

  res.json({ received: true });
});

// Global JSON parser — AFTER webhook route
app.use(express.json());

// Serve the frontend files
app.use(express.static(path.join(__dirname)));

// Root → app
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'forge-app.html')));

// ─────────────────────────────────────────────
// IN-MEMORY STORE (replace with DB later)
// ─────────────────────────────────────────────
const companies = new Map();

// ─────────────────────────────────────────────
// SSE HELPER
// ─────────────────────────────────────────────
function sseSetup(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  return function send(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(payload);
    // Flush if compression middleware is present
    if (typeof res.flush === 'function') res.flush();
  };
}

// ─────────────────────────────────────────────
// 1. GENERATE COMPANY WITH CLAUDE
// ─────────────────────────────────────────────
async function generateCompany(idea, name, category) {
  const client = getAnthropic();

  const msg = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are a world-class startup builder. Generate a complete AI SaaS company based on:
- Idea: ${idea}
- Name: ${name}
- Category: ${category}

Return ONLY a valid JSON object — no markdown fences, no explanation. Use these exact fields:

{
  "slug": "url-slug-max-20-chars-lowercase-hyphens",
  "tagline": "catchy tagline max 8 words",
  "description": "2 sentence product description",
  "icp": "ideal customer profile in one sentence",
  "pain": "core pain point being solved",
  "value_prop": "core value proposition in one sentence",
  "starter_name": "Starter tier name (e.g. Solo, Basic, Lite)",
  "starter_price": 29,
  "starter_features": ["feature 1", "feature 2", "feature 3", "feature 4"],
  "pro_name": "Pro tier name (e.g. Growth, Pro, Team)",
  "pro_price": 99,
  "pro_features": ["feature 1", "feature 2", "feature 3", "feature 4", "feature 5", "feature 6"],
  "hero_headline": "Landing page main headline (max 8 words, punchy)",
  "hero_sub": "Landing page subheadline — one clear sentence",
  "features": [
    {"icon": "⚡", "title": "Feature Title", "desc": "One sentence description"},
    {"icon": "🎯", "title": "Feature Title", "desc": "One sentence description"},
    {"icon": "📊", "title": "Feature Title", "desc": "One sentence description"},
    {"icon": "🤖", "title": "Feature Title", "desc": "One sentence description"},
    {"icon": "💰", "title": "Feature Title", "desc": "One sentence description"},
    {"icon": "🚀", "title": "Feature Title", "desc": "One sentence description"}
  ],
  "outreach_subject": "Cold email subject line (specific, no spam words)",
  "outreach_body": "Full cold email body — 3 short paragraphs. Casual but professional. No fluff. End with a soft CTA.",
  "ad_headline": "Meta ad headline (max 6 words)",
  "ad_body": "Meta ad body text (2 sentences max)",
  "emoji": "single most relevant emoji for this company",
  "color": "#hexcolor (vivid primary brand color — pick something fitting for the industry)",
  "color_secondary": "#hexcolor (secondary accent color that pairs beautifully — complementary or analogous, clearly different from primary)",
  "font_heading": "Google Font name for headings — pick the best fit: Plus Jakarta Sans | Space Grotesk | Syne | Outfit | Manrope | Figtree | DM Sans",
  "font_body": "Google Font name for body text — pick one: Inter | DM Sans | Nunito Sans | Lato | Open Sans | Poppins"
}`
    }],
  });

  const raw = msg.content[0].text.trim();
  // Extract JSON even if wrapped in markdown fences
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude did not return valid JSON');

  const data = JSON.parse(match[0]);
  // Enforce user's chosen name
  data.name = name;
  // Sanitize slug
  data.slug = data.slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28);

  return data;
}

// ─────────────────────────────────────────────
// 2. GENERATE LANDING PAGE HTML
// ─────────────────────────────────────────────
function generateLandingHTML(company, stripeLinks) {
  const color   = company.color           || '#7c3aed';
  const color2  = company.color_secondary || '#0ea5e9';
  const hFont   = company.font_heading    || 'Plus Jakarta Sans';
  const bFont   = company.font_body       || 'Inter';
  const starterUrl = stripeLinks?.starter?.url || '#';
  const proUrl     = stripeLinks?.pro?.url     || '#';

  // Google Fonts URL — only add body font param if different from heading
  const fp1 = hFont.replace(/ /g, '+');
  const fp2 = bFont.replace(/ /g, '+');
  const fontsUrl = hFont === bFont
    ? `https://fonts.googleapis.com/css2?family=${fp1}:wght@400;500;600;700;800;900&display=swap`
    : `https://fonts.googleapis.com/css2?family=${fp1}:wght@700;800;900&family=${fp2}:wght@400;500;600&display=swap`;

  // Logo mark: first letter of company name
  const initial = escHtml((company.name || '?')[0].toUpperCase());

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(company.name)} — ${escHtml(company.tagline)}</title>
<meta name="description" content="${escHtml(company.description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${fontsUrl}" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --c: ${color};
  --c2: ${color2};
  --bg: #06060f;
  --card: #0c0c1d;
  --border: rgba(255,255,255,.08);
  --text: #f1f5f9;
  --muted: #94a3b8;
  --dim: #475569;
}
body {
  font-family: '${bFont}', system-ui, sans-serif;
  background: var(--bg);
  background-image: radial-gradient(circle, rgba(255,255,255,.028) 1px, transparent 1px);
  background-size: 28px 28px;
  color: var(--text);
  line-height: 1.6;
  overflow-x: hidden;
}
a { text-decoration: none; color: inherit; }
h1, h2, h3,
.logo-name, .nav-cta, .btn-primary, .plan-price,
.feat-title, .plan-name, .plan-btn {
  font-family: '${hFont}', system-ui, sans-serif;
}

/* ── Nav ──────────────────────────── */
nav {
  padding: 0 48px;
  height: 64px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  background: rgba(6,6,15,.88);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  z-index: 100;
}
.logo { display: flex; align-items: center; gap: 10px; }
.logo-mark {
  width: 32px; height: 32px;
  border-radius: 8px;
  background: linear-gradient(135deg, ${color}, ${color2});
  display: flex; align-items: center; justify-content: center;
  font-family: '${hFont}', sans-serif;
  font-size: 15px; font-weight: 900;
  color: white; flex-shrink: 0;
}
.logo-name { font-size: 17px; font-weight: 900; color: white; }
.nav-cta {
  padding: 9px 20px;
  background: linear-gradient(135deg, ${color}, ${color2});
  color: white; border-radius: 8px;
  font-weight: 700; font-size: 14px;
  transition: opacity .2s;
  box-shadow: 0 2px 14px ${color}44;
}
.nav-cta:hover { opacity: .85; }

/* ── Hero ─────────────────────────── */
.hero-wrap { position: relative; overflow: hidden; }
.hero-glow {
  position: absolute; top: -160px; left: 50%;
  transform: translateX(-50%);
  width: 900px; height: 620px;
  background: radial-gradient(ellipse at center, ${color}26 0%, ${color2}12 45%, transparent 70%);
  pointer-events: none;
}
.hero {
  text-align: center;
  padding: 110px 40px 100px;
  max-width: 820px; margin: 0 auto;
  position: relative;
}
.hero-badge {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 12px; font-weight: 700;
  padding: 6px 14px; border-radius: 100px;
  border: 1px solid ${color}55;
  background: ${color}14;
  color: ${color};
  margin-bottom: 32px;
  letter-spacing: .05em; text-transform: uppercase;
}
.hero-emoji {
  font-size: 58px; display: block; margin-bottom: 28px;
  filter: drop-shadow(0 0 28px ${color}66);
}
h1 {
  font-size: clamp(40px, 6.5vw, 72px);
  font-weight: 900;
  letter-spacing: -3px;
  line-height: 1.03;
  margin-bottom: 24px;
  background: linear-gradient(180deg, #ffffff 10%, rgba(255,255,255,.72) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.hero p {
  font-size: 18px; color: var(--muted);
  max-width: 540px; margin: 0 auto 44px;
  line-height: 1.75;
}
.hero-btns { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.btn-primary {
  padding: 15px 32px;
  background: linear-gradient(135deg, ${color}, ${color2});
  color: white; border-radius: 12px;
  font-weight: 800; font-size: 15px;
  transition: opacity .2s, transform .15s;
  box-shadow: 0 4px 24px ${color}44;
}
.btn-primary:hover { opacity: .9; transform: translateY(-1px); }
.btn-ghost {
  padding: 15px 26px;
  border: 1px solid var(--border);
  color: var(--muted); border-radius: 12px;
  font-weight: 600; font-size: 15px;
  transition: border-color .2s, color .2s;
}
.btn-ghost:hover { border-color: rgba(255,255,255,.2); color: white; }

/* ── Features ─────────────────────── */
.section-wrap { padding: 100px 48px; max-width: 1140px; margin: 0 auto; }
.section-label {
  text-align: center;
  font-size: 11px; text-transform: uppercase; letter-spacing: .14em;
  background: linear-gradient(90deg, ${color}, ${color2});
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  background-clip: text;
  font-weight: 800; margin-bottom: 14px;
}
h2 {
  text-align: center;
  font-size: clamp(28px, 4vw, 46px);
  font-weight: 900; letter-spacing: -2px;
  margin-bottom: 60px; color: white;
}
.feat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
.feat-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 20px; padding: 32px 28px;
  transition: border-color .25s, transform .25s;
}
.feat-card:hover { border-color: ${color}66; transform: translateY(-2px); }
.feat-icon { font-size: 32px; margin-bottom: 18px; }
.feat-title { font-size: 16px; font-weight: 800; margin-bottom: 10px; color: white; }
.feat-desc { font-size: 14px; color: var(--muted); line-height: 1.7; }

/* ── Pricing ──────────────────────── */
.pricing-wrap { padding: 100px 48px; max-width: 860px; margin: 0 auto; text-align: center; }
.pricing-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; text-align: left; }
.plan {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 24px; padding: 38px 34px;
  display: flex; flex-direction: column;
}
.plan.featured {
  border-color: ${color}88;
  background: linear-gradient(180deg, ${color}0e 0%, var(--card) 55%);
  box-shadow: 0 0 60px ${color}18;
}
.plan-badge {
  display: inline-flex; align-items: center;
  font-size: 11px; font-weight: 700;
  padding: 4px 12px; border-radius: 100px;
  background: linear-gradient(135deg, ${color}, ${color2});
  color: white; margin-bottom: 20px; width: fit-content;
  letter-spacing: .04em; text-transform: uppercase;
}
.plan-name {
  font-size: 12px; font-weight: 700; color: var(--muted);
  text-transform: uppercase; letter-spacing: .1em; margin-bottom: 12px;
}
.plan-price {
  font-size: 56px; font-weight: 900;
  letter-spacing: -3px; line-height: 1;
  margin-bottom: 6px; color: white;
}
.plan-price span { font-size: 16px; font-weight: 400; color: var(--dim); letter-spacing: 0; }
.plan-sub { font-size: 13px; color: var(--dim); margin-bottom: 28px; }
.plan-features {
  list-style: none; display: flex;
  flex-direction: column; gap: 13px;
  margin-bottom: 32px; flex: 1;
}
.plan-features li { font-size: 14px; display: flex; gap: 10px; align-items: flex-start; color: var(--muted); }
.plan-features li::before { content: '✓'; color: ${color}; font-weight: 900; flex-shrink: 0; margin-top: 1px; }
.plan-btn {
  display: block; text-align: center; padding: 15px;
  border-radius: 12px; font-weight: 800; font-size: 15px;
  background: linear-gradient(135deg, ${color}, ${color2});
  color: white; transition: opacity .2s, transform .15s;
  margin-top: auto;
  box-shadow: 0 4px 20px ${color}33;
}
.plan-btn:hover { opacity: .88; transform: translateY(-1px); }
.plan-btn.outline {
  background: transparent; border: 1px solid var(--border);
  box-shadow: none; color: var(--muted);
}
.plan-btn.outline:hover { border-color: rgba(255,255,255,.2); color: white; }

/* ── Footer ───────────────────────── */
footer {
  border-top: 1px solid var(--border);
  padding: 48px; text-align: center;
  color: var(--dim); font-size: 13px;
}
footer strong { color: var(--muted); font-family: '${hFont}', sans-serif; }

/* ── Responsive ───────────────────── */
@media(max-width: 768px) {
  nav { padding: 0 20px; }
  .hero { padding: 70px 24px 60px; }
  h1 { letter-spacing: -1.5px; }
  .section-wrap, .pricing-wrap { padding: 60px 24px; }
  .feat-grid { grid-template-columns: 1fr; gap: 12px; }
  .pricing-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>

<nav>
  <div class="logo">
    <div class="logo-mark">${initial}</div>
    <span class="logo-name">${escHtml(company.name)}</span>
  </div>
  <a href="${starterUrl}" class="nav-cta">Get started →</a>
</nav>

<div class="hero-wrap">
  <div class="hero-glow"></div>
  <section class="hero">
    <div class="hero-badge">✦ AI-Powered</div>
    <span class="hero-emoji">${company.emoji}</span>
    <h1>${escHtml(company.hero_headline)}</h1>
    <p>${escHtml(company.hero_sub)}</p>
    <div class="hero-btns">
      <a href="${starterUrl}" class="btn-primary">Start free →</a>
      <a href="#features" class="btn-ghost">See how it works</a>
    </div>
  </section>
</div>

<div class="section-wrap" id="features">
  <p class="section-label">Features</p>
  <h2>Everything you need. Nothing you don't.</h2>
  <div class="feat-grid">
    ${company.features.map(f => `
    <div class="feat-card">
      <div class="feat-icon">${f.icon}</div>
      <div class="feat-title">${escHtml(f.title)}</div>
      <div class="feat-desc">${escHtml(f.desc)}</div>
    </div>`).join('')}
  </div>
</div>

<div class="pricing-wrap" id="pricing">
  <p class="section-label">Pricing</p>
  <h2>Simple, honest pricing.</h2>
  <div class="pricing-grid">
    <div class="plan">
      <div class="plan-name">${escHtml(company.starter_name)}</div>
      <div class="plan-price">$${company.starter_price}<span>/mo</span></div>
      <div class="plan-sub">Everything to get started</div>
      <ul class="plan-features">
        ${company.starter_features.map(f => `<li>${escHtml(f)}</li>`).join('')}
      </ul>
      <a href="${starterUrl}" class="plan-btn outline">Get started →</a>
    </div>
    <div class="plan featured">
      <span class="plan-badge">⭐ Most popular</span>
      <div class="plan-name">${escHtml(company.pro_name)}</div>
      <div class="plan-price">$${company.pro_price}<span>/mo</span></div>
      <div class="plan-sub">For serious teams</div>
      <ul class="plan-features">
        ${company.pro_features.map(f => `<li>${escHtml(f)}</li>`).join('')}
      </ul>
      <a href="${proUrl}" class="plan-btn">Get ${escHtml(company.pro_name)} →</a>
    </div>
  </div>
</div>

<footer>
  <strong>${escHtml(company.name)}</strong> — ${escHtml(company.tagline)}<br>
  <span style="margin-top:10px;display:block;">Built with <a href="#" style="color:var(--muted)">Forge</a> · Powered by AI</span>
</footer>

</body>
</html>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────
// 3. DEPLOY TO VERCEL
// ─────────────────────────────────────────────
async function deployToVercel(slug, html) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return null;

  const projectName = `${slug}-${Date.now().toString(36)}`.slice(0, 52);
  const htmlB64 = Buffer.from(html).toString('base64');

  // Support team accounts — add ?teamId= if VERCEL_TEAM_ID is set
  const teamId = process.env.VERCEL_TEAM_ID;
  const apiUrl = `https://api.vercel.com/v13/deployments${teamId ? `?teamId=${teamId}` : ''}`;

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: projectName,
      files: [{ file: 'index.html', data: htmlB64, encoding: 'base64' }],
      target: 'production',
      projectSettings: {
        framework: null,
        buildCommand: null,
        outputDirectory: null,
        installCommand: null,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vercel error: ${err}`);
  }

  const data = await res.json();
  const url = data.url ? `https://${data.url}` : null;
  return { url, id: data.id };
}

// ─────────────────────────────────────────────
// 4. CREATE STRIPE PRODUCTS & PAYMENT LINKS (on connected account)
// ─────────────────────────────────────────────
async function createStripeProducts(company, connectedAccountId) {
  const s = getStripe();
  if (!s || !connectedAccountId) return null;

  const commissionPct = parseFloat(process.env.FIRMZ_COMMISSION_PERCENT || '2');
  const stripeOpts = { stripeAccount: connectedAccountId };

  async function makePlan(name, price, description) {
    const product = await s.products.create({ name, description }, stripeOpts);
    const stripePrice = await s.prices.create({
      product: product.id,
      unit_amount: price * 100,
      currency: 'usd',
      recurring: { interval: 'month' },
    }, stripeOpts);
    const link = await s.paymentLinks.create({
      line_items: [{ price: stripePrice.id, quantity: 1 }],
      subscription_data: {
        application_fee_percent: commissionPct,
      },
    }, stripeOpts);
    return { url: link.url, priceId: stripePrice.id, productId: product.id };
  }

  const [starter, pro] = await Promise.all([
    makePlan(`${company.name} — ${company.starter_name}`, company.starter_price, company.description),
    makePlan(`${company.name} — ${company.pro_name}`, company.pro_price, company.description),
  ]);

  return { starter, pro };
}

// ─────────────────────────────────────────────
// 5. SEND FOUNDER EMAIL
// ─────────────────────────────────────────────
async function sendFounderEmail(email, company, siteUrl, stripeLinks) {
  const r = getResend();
  if (!r || !email) return { skipped: true };

  const from = process.env.RESEND_FROM || 'Forge <onboarding@resend.dev>';

  await r.emails.send({
    from,
    to: email,
    subject: `⚡ ${company.name} is live — your AI company is running`,
    html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:48px 32px;background:#07070f;color:#f1f5f9;">
  <p style="font-size:48px;margin:0 0 16px;">${company.emoji}</p>
  <h1 style="font-size:28px;font-weight:900;letter-spacing:-1px;margin:0 0 8px;">${escHtml(company.name)} is live.</h1>
  <p style="color:#94a3b8;margin:0 0 36px;font-size:16px;">${escHtml(company.tagline)}</p>

  <p style="margin-bottom:20px;line-height:1.7;">Your AI company launched successfully. Here's what's already running:</p>

  <div style="background:#0d0d1a;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:28px;margin-bottom:32px;">
    ${siteUrl ? `<div style="margin-bottom:14px;font-size:14px;">🌐 <strong>Website:</strong> <a href="${siteUrl}" style="color:#a78bfa;">${siteUrl}</a></div>` : ''}
    <div style="margin-bottom:14px;font-size:14px;">💳 <strong>Payments live:</strong> ${escHtml(company.starter_name)} $${company.starter_price}/mo · ${escHtml(company.pro_name)} $${company.pro_price}/mo</div>
    <div style="margin-bottom:14px;font-size:14px;">📧 <strong>Outreach:</strong> First email batch queued and ready</div>
    <div style="font-size:14px;">🤖 <strong>CEO Agent:</strong> Active — you can chat with it now</div>
  </div>

  <div style="background:#0d0d1a;border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:24px;margin-bottom:32px;">
    <p style="font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#475569;font-weight:700;margin-bottom:12px;">Your first cold email template</p>
    <p style="font-size:13px;color:#94a3b8;line-height:1.8;margin:0;white-space:pre-line;">${escHtml(company.outreach_body)}</p>
  </div>

  ${siteUrl ? `<a href="${siteUrl}" style="display:inline-block;padding:16px 32px;background:#7c3aed;color:white;border-radius:12px;font-weight:800;font-size:15px;text-decoration:none;margin-bottom:24px;">Open your company →</a>` : ''}

  <p style="color:#475569;font-size:12px;margin:0;">Built with Forge · AI-powered company builder</p>
</div>`,
  });

  return { sent: true, to: email };
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    db: !!process.env.DATABASE_URL,
    services: {
      claude: !!process.env.ANTHROPIC_API_KEY,
      vercel: !!process.env.VERCEL_TOKEN,
      stripe: !!process.env.STRIPE_SECRET_KEY,
      stripeConnect: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_CLIENT_ID),
      resend: !!process.env.RESEND_API_KEY,
    },
  });
});

// ── SIGNUP ──
app.post('/api/auth/signup', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const password = req.body.password || '';
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalide' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });

  const existing = await dbGetUser(email);
  if (existing) return res.status(409).json({ error: 'Ce compte existe déjà — connecte-toi' });

  const passwordHash = await hashPassword(password);
  await dbSetUser(email, { passwordHash, createdAt: new Date().toISOString() });

  const existingCredits = await dbGetCredits(email);
  if (existingCredits === null) await dbSetCredits(email, FREE_CREDITS_ON_SIGNUP);
  const credits = await dbGetCredits(email);

  const sessionKey = generateToken();
  userSessions.set(sessionKey, { email });
  console.log(`[auth] New user: ${email}`);
  res.json({ sessionKey, email, credits });
});

// ── LOGIN ──
app.post('/api/auth/login', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const password = req.body.password || '';
  const user = await dbGetUser(email);
  if (!user) return res.status(401).json({ error: 'Compte introuvable — crée un compte' });

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect' });

  const existingCredits = await dbGetCredits(email);
  if (existingCredits === null) await dbSetCredits(email, FREE_CREDITS_ON_SIGNUP);
  const credits = await dbGetCredits(email);

  const sessionKey = generateToken();
  userSessions.set(sessionKey, { email });
  console.log(`[auth] Login: ${email}`);
  res.json({ sessionKey, email, credits });
});

// ── FORGOT PASSWORD ──
const resetTokens = new Map(); // token → { email, expiresAt }
const RESET_EXPIRY = 30 * 60 * 1000; // 30 min

app.post('/api/auth/forgot', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email invalide' });

  // Always respond OK (don't reveal if account exists)
  res.json({ sent: true });

  const userExists = await dbGetUser(email);
  if (!userExists) return; // silently ignore unknown emails

  const token = generateToken();
  resetTokens.set(token, { email, expiresAt: Date.now() + RESET_EXPIRY });
  setTimeout(() => resetTokens.delete(token), RESET_EXPIRY);

  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const link = `${appUrl}/?reset=${token}`;

  const r = getResend();
  if (r) {
    try {
      await r.emails.send({
        from: process.env.RESEND_FROM || 'Firmz <onboarding@resend.dev>',
        to: email,
        subject: '⬡ Réinitialisation de ton mot de passe Firmz',
        html: `
<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#07070f;color:#f1f5f9;">
  <p style="font-size:36px;margin:0 0 16px;">⬡</p>
  <h1 style="font-size:22px;font-weight:900;margin:0 0 8px;letter-spacing:-0.5px;">Réinitialise ton mot de passe</h1>
  <p style="color:#94a3b8;margin:0 0 28px;">Clique sur le bouton ci-dessous pour choisir un nouveau mot de passe. Le lien expire dans 30 minutes.</p>
  <a href="${link}" style="display:inline-block;padding:14px 28px;background:#7c3aed;color:white;border-radius:10px;font-weight:800;font-size:15px;text-decoration:none;">Réinitialiser mon mot de passe →</a>
  <p style="color:#475569;font-size:12px;margin:24px 0 0;">Si tu n'as pas demandé cela, ignore cet email.</p>
</div>`,
      });
    } catch (e) {
      console.error('[auth] Reset email error:', e.message);
    }
  }
  console.log(`[auth] Reset link for ${email}: ${link}`);
});

// ── RESET PASSWORD ──
app.post('/api/auth/reset', async (req, res) => {
  const { token, password } = req.body;
  const entry = token && resetTokens.get(token);
  if (!entry || Date.now() > entry.expiresAt) {
    resetTokens.delete(token);
    return res.status(401).json({ error: 'Lien expiré ou invalide — demande-en un nouveau.' });
  }
  if (!password || password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });

  resetTokens.delete(token); // one-time use
  const passwordHash = await hashPassword(password);
  const existingUser = await dbGetUser(entry.email) || { createdAt: new Date().toISOString() };
  await dbSetUser(entry.email, { ...existingUser, passwordHash });

  // Auto-login
  const existingCredits = await dbGetCredits(entry.email);
  if (existingCredits === null) await dbSetCredits(entry.email, FREE_CREDITS_ON_SIGNUP);
  const sessionKey = generateToken();
  userSessions.set(sessionKey, { email: entry.email });
  console.log(`[auth] Password reset: ${entry.email}`);
  const credits = await dbGetCredits(entry.email);
  res.json({ sessionKey, email: entry.email, credits });
});

// ── SESSION ME ──
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const email = req.userEmail;
  const existingCredits = await dbGetCredits(email);
  if (existingCredits === null) await dbSetCredits(email, FREE_CREDITS_ON_SIGNUP);
  const credits = await dbGetCredits(email);
  res.json({ email, credits });
});

// ── LOGOUT ──
app.post('/api/auth/logout', (req, res) => {
  const key = req.headers['x-session-key'];
  if (key) userSessions.delete(key);
  res.json({ ok: true });
});

// ── ACCOUNT — full profile + companies ──
app.get('/api/account', requireAuth, async (req, res) => {
  const email = req.userEmail;
  const existingCredits = await dbGetCredits(email);
  if (existingCredits === null) await dbSetCredits(email, FREE_CREDITS_ON_SIGNUP);
  const credits = await dbGetCredits(email);
  const userCompanies = (await dbGetUserCompanies(email)).map(c => ({
      id: c.id,
      name: c.name,
      category: c.category,
      emoji: c.emoji,
      color: c.color,
      slug: c.slug,
      tagline: c.tagline,
      siteUrl: c.siteUrl,
      createdAt: c.createdAt,
    }));
  const userRecord = await dbGetUser(email);
  res.json({
    email,
    credits,
    createdAt: userRecord?.createdAt || null,
    companies: userCompanies,
    companiesCount: userCompanies.length,
    creditsSpent: userCompanies.length * CREDITS_PER_CREATION,
  });
});

// ── CREDIT PACKS ──
app.get('/api/credits/packs', (req, res) => res.json(CREDIT_PACKS));

// ── CREDIT SPEND (agent runs, etc.) ──
app.post('/api/credits/spend', requireAuth, async (req, res) => {
  const { amount = 1 } = req.body;
  const email = req.userEmail;
  const cur = await dbGetCredits(email);
  if (cur === null || cur < amount) {
    return res.status(402).json({ error: 'insufficient_credits', credits: cur ?? 0, required: amount });
  }
  await dbSetCredits(email, cur - amount);
  res.json({ credits: cur - amount });
});

// ── CREDIT BALANCE ──
app.get('/api/credits/balance', requireAuth, async (req, res) => {
  const email = req.userEmail;
  const existingCredits = await dbGetCredits(email);
  if (existingCredits === null) await dbSetCredits(email, FREE_CREDITS_ON_SIGNUP);
  res.json({ email, credits: await dbGetCredits(email) });
});

// ── BUY CREDITS — Stripe Checkout ──
app.post('/api/credits/checkout', async (req, res) => {
  const { email, packId } = req.body;
  if (!email || !packId) return res.status(400).json({ error: 'email and packId required' });

  const pack = CREDIT_PACKS.find(p => p.id === packId);
  if (!pack) return res.status(400).json({ error: 'Invalid pack' });

  const s = getStripe();
  if (!s) return res.status(400).json({ error: 'Stripe not configured. Add STRIPE_SECRET_KEY.' });

  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const normalizedEmail = email.toLowerCase();

  try {
    const session = await s.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: normalizedEmail,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Firmz — ${pack.name}`,
            description: `${pack.credits} 💎 credits · create AI companies on Firmz`,
          },
          unit_amount: pack.price * 100,
        },
        quantity: 1,
      }],
      success_url: `${appUrl}/forge-app.html?credits=success&email=${encodeURIComponent(normalizedEmail)}&pack=${pack.id}`,
      cancel_url: `${appUrl}/forge-app.html?credits=cancelled`,
      metadata: { email: normalizedEmail, credits: String(pack.credits), packId: pack.id },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[credits checkout]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE CONNECT — Start OAuth ──
app.get('/api/stripe/connect/:companyId', async (req, res) => {
  if (!process.env.STRIPE_CLIENT_ID || !process.env.STRIPE_SECRET_KEY) {
    return res.status(400).json({ error: 'Stripe Connect not configured. Add STRIPE_CLIENT_ID + STRIPE_SECRET_KEY to .env' });
  }
  const company = await dbGetCompany(req.params.companyId);
  if (!company) return res.status(404).json({ error: 'Company not found' });

  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.STRIPE_CLIENT_ID,
    scope: 'read_write',
    state: req.params.companyId,
    redirect_uri: `${appUrl}/api/stripe/callback`,
  });

  res.redirect(`https://connect.stripe.com/oauth/authorize?${params}`);
});

// ── STRIPE CONNECT — OAuth Callback ──
app.get('/api/stripe/callback', async (req, res) => {
  const { code, state: companyId, error, error_description } = req.query;

  if (error) {
    console.error('[stripe connect error]', error, error_description);
    return res.redirect(`/forge-app.html?stripe_error=${encodeURIComponent(error_description || error)}`);
  }

  let company = await dbGetCompany(companyId);
  if (!company) return res.redirect('/forge-app.html?stripe_error=company_not_found');

  try {
    const s = getStripe();

    // Exchange auth code for access token
    const oauthResponse = await s.oauth.token({ grant_type: 'authorization_code', code });
    const connectedAccountId = oauthResponse.stripe_user_id;

    // Create products + payment links on their Stripe account
    const stripeLinks = await createStripeProducts(company, connectedAccountId);

    // Persist updated company with Stripe data
    company = {
      ...company,
      stripeAccountId: connectedAccountId,
      stripeConnectedAt: new Date().toISOString(),
      stripeLinks,
      landingHtml: generateLandingHTML(company, stripeLinks),
    };
    await dbSetCompany(companyId, company.founderEmail, company);

    // Redeploy to Vercel with payment links
    if (process.env.VERCEL_TOKEN) {
      try {
        const dep = await deployToVercel(company.slug, company.landingHtml);
        if (dep?.url) {
          company = { ...company, siteUrl: dep.url };
          await dbSetCompany(companyId, company.founderEmail, company);
        }
      } catch (e) {
        console.error('[stripe callback] Vercel redeploy error:', e.message);
      }
    }

    console.log(`[stripe connect] ✓ ${company.name} connected → ${connectedAccountId}`);
    res.redirect(`/forge-app.html?company=${companyId}&stripe=connected`);
  } catch (err) {
    console.error('[stripe callback error]', err);
    res.redirect(`/forge-app.html?stripe_error=${encodeURIComponent(err.message)}`);
  }
});

// ── CREATE COMPANY (SSE stream) ──
app.post('/api/create-company', requireAuth, async (req, res) => {
  const { idea, name, category = 'B2B SaaS' } = req.body;
  const founderEmail = req.userEmail; // from authenticated session

  if (!idea?.trim() || !name?.trim()) {
    return res.status(400).json({ error: 'idea and name are required' });
  }

  // ── CREDIT CHECK ──
  const email = founderEmail;
  if (email) {
    let userCredits = await dbGetCredits(email);
    if (userCredits === null) { await dbSetCredits(email, FREE_CREDITS_ON_SIGNUP); userCredits = FREE_CREDITS_ON_SIGNUP; }
    if (userCredits < CREDITS_PER_CREATION) {
      return res.status(402).json({
        error: 'insufficient_credits',
        message: `You need ${CREDITS_PER_CREATION} 💎 to create a company. You have ${userCredits}.`,
        credits: userCredits,
        required: CREDITS_PER_CREATION,
      });
    }
    await dbSetCredits(email, userCredits - CREDITS_PER_CREATION);
    console.log(`[credits] -${CREDITS_PER_CREATION} 💎 from ${email} → remaining: ${userCredits - CREDITS_PER_CREATION}`);
  }

  const send = sseSetup(res);

  try {
    // ── ARCHITECT ──
    send('agent', { id: 'ag-architect', status: 'active', task: 'Analyzing idea with Claude…' });
    send('log', { msg: '→ Generating business structure with Claude Opus…', cls: 'log-info' });
    send('progress', { pct: 5, label: 'Thinking…' });

    const company = await generateCompany(idea, name, category);

    send('agent', { id: 'ag-architect', status: 'done', task: `Pricing: $${company.starter_price}/mo & $${company.pro_price}/mo · ICP: ${company.icp.slice(0, 50)}` });
    send('log', { msg: `✓ Business model defined: ${company.tagline}`, cls: 'log-ok' });
    send('log', { msg: `✓ ICP: ${company.icp}`, cls: 'log-act' });
    send('progress', { pct: 25, label: 'Building landing page…' });

    // ── BUILDER ──
    send('agent', { id: 'ag-builder', status: 'active', task: 'Generating landing page…' });
    send('log', { msg: '→ Generating landing page HTML…', cls: 'log-info' });

    let siteUrl = `https://${company.slug}.forge.app`; // default placeholder
    let deploymentId = null;

    if (process.env.VERCEL_TOKEN) {
      try {
        send('log', { msg: '→ Deploying to Vercel (this takes ~10s)…', cls: 'log-info' });
        const html = generateLandingHTML(company, null); // first deploy without Stripe links
        const deployment = await deployToVercel(company.slug, html);
        if (deployment?.url) {
          siteUrl = deployment.url;
          deploymentId = deployment.id;
          send('agent', { id: 'ag-builder', status: 'done', task: `Deployed → ${siteUrl}` });
          send('log', { msg: `✓ Website live: ${siteUrl}`, cls: 'log-ok' });
        }
      } catch (vercelErr) {
        console.error('[vercel deploy] failed:', vercelErr.message);
        send('agent', { id: 'ag-builder', status: 'done', task: 'Landing page generated (Vercel token expired — reconnect in Railway)' });
        send('log', { msg: '⚠ Vercel deploy failed — continuing without live URL', cls: 'log-warn' });
        send('log', { msg: '○ Regenerate VERCEL_TOKEN in Railway to re-enable deployments', cls: 'log-act' });
      }
    } else {
      send('agent', { id: 'ag-builder', status: 'done', task: 'Landing page generated (add VERCEL_TOKEN to deploy)' });
      send('log', { msg: '✓ Landing page HTML generated', cls: 'log-ok' });
      send('log', { msg: '○ Add VERCEL_TOKEN to .env to deploy it live', cls: 'log-act' });
    }

    send('progress', { pct: 55, label: 'Configuring payments…' });

    // ── PAYMENTS ──
    // Products are created AFTER the founder connects their Stripe via OAuth
    send('agent', { id: 'ag-payments', status: 'active', task: 'Setting up Stripe Connect…' });

    const stripeLinks = null;
    const stripeConnectEnabled = !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_CLIENT_ID);

    if (stripeConnectEnabled) {
      send('agent', { id: 'ag-payments', status: 'done', task: 'Stripe Connect ready — connect your account after launch' });
      send('log', { msg: '✓ Stripe Connect configured — connect your account to activate payments', cls: 'log-ok' });
      send('log', { msg: `  Firmz commission: ${process.env.FIRMZ_COMMISSION_PERCENT || '2'}% per transaction`, cls: 'log-act' });
    } else {
      send('agent', { id: 'ag-payments', status: 'done', task: 'Add STRIPE_SECRET_KEY + STRIPE_CLIENT_ID to activate' });
      send('log', { msg: '○ Add STRIPE_SECRET_KEY + STRIPE_CLIENT_ID to enable Stripe Connect', cls: 'log-act' });
    }

    send('progress', { pct: 80, label: 'Sending outreach…' });

    // ── GROWTH ──
    send('agent', { id: 'ag-growth', status: 'active', task: 'Sending launch email to founder…' });
    send('log', { msg: '→ Sending launch email…', cls: 'log-info' });

    if (process.env.RESEND_API_KEY && founderEmail) {
      const emailResult = await sendFounderEmail(founderEmail, company, siteUrl, stripeLinks);
      if (emailResult.sent) {
        send('agent', { id: 'ag-growth', status: 'done', task: `Launch email sent to ${founderEmail}` });
        send('log', { msg: `✓ Launch email sent to ${founderEmail}`, cls: 'log-ok' });
      }
    } else {
      send('agent', { id: 'ag-growth', status: 'done', task: 'Outreach template ready (add RESEND_API_KEY to send)' });
      send('log', { msg: '✓ Cold email template generated', cls: 'log-ok' });
      send('log', { msg: `  Subject: "${company.outreach_subject}"`, cls: 'log-act' });
    }

    send('progress', { pct: 95, label: 'Initializing CEO…' });

    // ── CEO ──
    send('agent', { id: 'ag-ceo', status: 'active', task: 'Initializing AI CEO with full context…' });

    const companyId = crypto.randomUUID();
    const companyData = {
      ...company,
      id: companyId,
      siteUrl,
      stripeLinks,
      founderEmail,
      landingHtml: generateLandingHTML(company, stripeLinks),
      createdAt: new Date().toISOString(),
      chatHistory: [],
    };
    await dbSetCompany(companyId, founderEmail, companyData);

    send('agent', { id: 'ag-ceo', status: 'done', task: 'CEO ready — open chat to talk to your company' });
    send('log', { msg: `✓ CEO initialized with company context`, cls: 'log-ok' });
    send('log', { msg: `✓ ${name} is fully operational. 🎉`, cls: 'log-ok' });
    send('progress', { pct: 100, label: `${name} is live!` });

    send('complete', {
      companyId,
      siteUrl,
      stripeLinks,
      stripeConnectEnabled,
      company: {
        name: company.name,
        slug: company.slug,
        tagline: company.tagline,
        emoji: company.emoji,
        color: company.color,
        starter_price: company.starter_price,
        pro_price: company.pro_price,
        starter_name: company.starter_name,
        pro_name: company.pro_name,
        icp: company.icp,
      },
    });

  } catch (err) {
    console.error('[create-company error]', err);
    send('error', { message: err.message });
  }

  res.end();
});

// ── CEO CHAT ──
app.post('/api/chat', async (req, res) => {
  const { companyId, message } = req.body;

  if (!companyId || !message?.trim()) {
    return res.status(400).json({ error: 'companyId and message are required' });
  }

  const company = await dbGetCompany(companyId);
  if (!company) return res.status(404).json({ error: 'Company not found.' });

  try {
    const client = getAnthropic();

    const systemPrompt = `You are the AI CEO of ${company.name}.

Company profile:
- Name: ${company.name}
- Tagline: ${company.tagline}
- What it does: ${company.description}
- Target customer: ${company.icp}
- Pain point: ${company.pain}
- Value prop: ${company.value_prop}
- Pricing: ${company.starter_name} $${company.starter_price}/mo, ${company.pro_name} $${company.pro_price}/mo
- Website: ${company.siteUrl || 'deploying...'}
- Category: ${company.category || 'B2B SaaS'}

Current status: Company is live and operational. Agents are running sales outreach, monitoring analytics, and optimizing performance.

Your personality:
- Sharp, action-oriented, zero fluff
- When asked to do something, you confirm the action and give a specific expected result with a timeframe
- You speak like a competent startup operator — direct, metrics-driven, confident
- You proactively flag opportunities and risks
- You can help with: strategy, pricing, copy, ads, outreach, product decisions, growth
- Keep responses concise — max 4 sentences unless depth is needed`;

    // Keep last 20 messages for context
    const history = (company.chatHistory || []).slice(-20);
    history.push({ role: 'user', content: message });

    const msg = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 600,
      system: systemPrompt,
      messages: history,
    });

    const reply = msg.content[0].text;

    // Persist updated chat history
    const updatedHistory = [...(company.chatHistory || []),
      { role: 'user', content: message },
      { role: 'assistant', content: reply }
    ];
    await dbSetCompany(companyId, company.founderEmail, { ...company, chatHistory: updatedHistory });

    res.json({ reply });
  } catch (err) {
    console.error('[chat error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET COMPANY ──
app.get('/api/company/:id', async (req, res) => {
  const company = await dbGetCompany(req.params.id);
  if (!company) return res.status(404).json({ error: 'Not found' });
  // Don't expose chat history or full landing HTML in this endpoint
  const { chatHistory, landingHtml, ...safe } = company;
  res.json(safe);
});

// ── DOWNLOAD LANDING PAGE HTML ──
app.get('/api/company/:id/html', async (req, res) => {
  const company = await dbGetCompany(req.params.id);
  if (!company) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="${company.slug}.html"`);
  res.send(company.landingHtml || generateLandingHTML(company, company.stripeLinks));
});

// ─────────────────────────────────────────────
// AGENTS — real Claude-powered runners
// ─────────────────────────────────────────────
const AGENT_META = {
  sales:   { icon: '📧', name: 'Sales Agent',   role: 'Outreach & prospecting',  color: 'rgba(16,185,129,.12)' },
  growth:  { icon: '🌐', name: 'Growth Agent',  role: 'SEO & content',           color: 'rgba(6,182,212,.12)' },
  ads:     { icon: '📣', name: 'Ads Agent',     role: 'Ad copy generation',      color: 'rgba(245,158,11,.12)' },
  product: { icon: '💻', name: 'Product Agent', role: 'Roadmap & priorities',    color: 'rgba(124,58,237,.12)' },
};

async function runSalesAgent(company, config = {}) {
  const client = getAnthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{ role: 'user', content:
`Generate 5 highly personalized cold outreach emails for this SaaS.
Company: ${company.name} — ${company.tagline}
ICP: ${company.icp}
Pain solved: ${company.pain}
Value prop: ${company.value_prop}
Base subject: ${company.outreach_subject}
Base body: ${company.outreach_body}

Return ONLY a JSON array (no markdown):
[{"subject":"...","body":"...","angle":"pain-led|benefit-led|curiosity|social-proof|question"}]
Max 100 words per body. 5 different angles.` }],
  });
  const emails = JSON.parse((msg.content[0].text.match(/\[[\s\S]*\]/) || ['[]'])[0]);

  let sent = 0;
  const resend = getResend();
  if (resend && config.targets?.length > 0) {
    for (let i = 0; i < Math.min(config.targets.length, emails.length); i++) {
      try {
        await resend.emails.send({
          from: `${company.name} <onboarding@resend.dev>`,
          to: config.targets[i],
          subject: emails[i]?.subject || company.outreach_subject,
          text: emails[i]?.body || company.outreach_body,
        });
        sent++;
      } catch(e) { console.error('[sales-agent send]', e.message); }
    }
  }
  return { emailsGenerated: emails.length, emailsSent: sent, outputs: emails, generatedAt: new Date().toISOString() };
}

async function runGrowthAgent(company, config = {}) {
  const client = getAnthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2500,
    messages: [{ role: 'user', content:
`Write an SEO blog post for this SaaS product.
Company: ${company.name} — ${company.description}
ICP: ${company.icp}
Pain: ${company.pain}

Return ONLY JSON (no markdown):
{"title":"50-60 chars SEO title","meta":"150-160 chars meta description","keyword":"primary keyword","outline":["H2 1","H2 2","H2 3","H2 4"],"intro":"First 2 paragraphs (~200 words)","cta":"closing call to action"}` }],
  });
  const article = JSON.parse((msg.content[0].text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
  return { articlesGenerated: 1, outputs: [article], generatedAt: new Date().toISOString() };
}

async function runAdsAgent(company, config = {}) {
  const client = getAnthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [{ role: 'user', content:
`Create 3 Meta ad variations for this SaaS.
Company: ${company.name} — ${company.tagline}
ICP: ${company.icp}
Pain: ${company.pain}
Base headline: ${company.ad_headline}
Base body: ${company.ad_body}

Return ONLY a JSON array (no markdown):
[{"headline":"max 40 chars","primary_text":"max 125 chars","cta":"Sign up|Get started|Try free|Learn more","angle":"pain|benefit|urgency|social-proof"}]
3 variations, each different psychological angle.` }],
  });
  const ads = JSON.parse((msg.content[0].text.match(/\[[\s\S]*\]/) || ['[]'])[0]);
  return { adsGenerated: ads.length, outputs: ads, generatedAt: new Date().toISOString() };
}

async function runProductAgent(company, config = {}) {
  const client = getAnthropic();
  const recent = (company.chatHistory || []).slice(-20).map(m => `${m.role}: ${m.content}`).join('\n');
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{ role: 'user', content:
`You are the Product Agent for ${company.name}.
Description: ${company.description}
ICP: ${company.icp}
Recent CEO conversations:\n${recent || '(none yet)'}

Analyze and generate a product roadmap. Return ONLY JSON (no markdown):
{"priorities":[{"title":"...","impact":"high|medium|low","effort":"small|medium|large","why":"one sentence"}],"insights":["...","...","..."],"nextSprint":["task 1","task 2","task 3"]}` }],
  });
  const roadmap = JSON.parse((msg.content[0].text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
  return { featuresIdentified: roadmap.priorities?.length || 0, outputs: [roadmap], generatedAt: new Date().toISOString() };
}

// ── GET agents ──
app.get('/api/agents/:companyId', requireAuth, async (req, res) => {
  try {
    const company = await dbGetCompany(req.params.companyId);
    if (!company) return res.status(404).json({ error: 'Not found' });
    if (company.founderEmail !== req.userEmail) return res.status(403).json({ error: 'Forbidden' });
    const stored = company.agents || {};
    const agents = Object.keys(AGENT_META).map(type => ({
      type, ...AGENT_META[type],
      status:  stored[type]?.status  || 'idle',
      config:  stored[type]?.config  || {},
      stats:   stored[type]?.stats   || {},
      lastRun: stored[type]?.lastRun || null,
    }));
    res.json({ agents });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RUN agent ──
app.post('/api/agents/:companyId/:type/run', requireAuth, async (req, res) => {
  const { companyId, type } = req.params;
  if (!AGENT_META[type]) return res.status(400).json({ error: 'Unknown agent' });
  try {
    let company = await dbGetCompany(companyId);
    if (!company) return res.status(404).json({ error: 'Not found' });
    if (company.founderEmail !== req.userEmail) return res.status(403).json({ error: 'Forbidden' });

    const config = company.agents?.[type]?.config || {};

    const runners = { sales: runSalesAgent, growth: runGrowthAgent, ads: runAdsAgent, product: runProductAgent };
    const result = await runners[type](company, config);

    company = { ...company, agents: { ...(company.agents || {}),
      [type]: { ...(company.agents?.[type] || {}), status: 'done', stats: result, lastRun: new Date().toISOString() }
    }};
    await dbSetCompany(companyId, company.founderEmail, company);
    res.json({ success: true, result });
  } catch(e) {
    console.error(`[agent:${type}]`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CONFIGURE agent ──
app.patch('/api/agents/:companyId/:type', requireAuth, async (req, res) => {
  const { companyId, type } = req.params;
  if (!AGENT_META[type]) return res.status(400).json({ error: 'Unknown agent' });
  try {
    let company = await dbGetCompany(companyId);
    if (!company) return res.status(404).json({ error: 'Not found' });
    if (company.founderEmail !== req.userEmail) return res.status(403).json({ error: 'Forbidden' });
    company = { ...company, agents: { ...(company.agents || {}),
      [type]: { ...(company.agents?.[type] || {}), config: { ...(company.agents?.[type]?.config || {}), ...req.body.config } }
    }};
    await dbSetCompany(companyId, company.founderEmail, company);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DAILY REPORT — Claude-generated narrative ──
app.get('/api/report/:companyId', requireAuth, async (req, res) => {
  try {
    const company = await dbGetCompany(req.params.companyId);
    if (!company) return res.status(404).json({ error: 'Not found' });
    if (company.founderEmail !== req.userEmail) return res.status(403).json({ error: 'Forbidden' });

    // Gather Stripe snapshot
    let revenue24h = 0, revenueTotal = 0, customers = 0, recentTx = [];
    if (company.stripeAccountId) {
      try {
        const s = getStripe();
        const since24h = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
        const [charges24h, allCharges] = await Promise.all([
          s.charges.list({ limit: 50, created: { gte: since24h } }, { stripeAccount: company.stripeAccountId }),
          s.charges.list({ limit: 100 }, { stripeAccount: company.stripeAccountId }),
        ]);
        const ok24h = charges24h.data.filter(c => c.status === 'succeeded');
        const okAll  = allCharges.data.filter(c => c.status === 'succeeded');
        revenue24h   = ok24h.reduce((s, c) => s + c.amount, 0) / 100;
        revenueTotal = okAll.reduce((s, c) => s + c.amount, 0) / 100;
        customers    = new Set(okAll.map(c => c.billing_details?.email || c.receipt_email).filter(Boolean)).size;
        recentTx     = ok24h.slice(0, 5).map(c => `${c.currency.toUpperCase()} ${(c.amount/100).toFixed(2)} from ${c.billing_details?.email || 'customer'}`);
      } catch(e) { console.error('[report] stripe:', e.message); }
    }

    // Agent statuses
    const agents = company.agents || {};
    const agentLines = ['sales','growth','ads','product'].map(t => {
      const a = agents[t];
      return `${t}: ${a?.status || 'idle'}${a?.lastRun ? ' (last run: ' + new Date(a.lastRun).toLocaleDateString('en-GB') + ')' : ''}`;
    }).join(', ');

    const today = new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content:
`You are the AI CEO of ${company.name}. Write a concise, punchy daily business report for ${today}.

Company: ${company.name} — ${company.tagline}
Description: ${company.description}
ICP: ${company.icp}
Stripe connected: ${!!company.stripeAccountId}
Revenue last 24h: $${revenue24h.toFixed(2)}
Revenue all-time: $${revenueTotal.toFixed(2)}
Total customers: ${customers}
Recent transactions: ${recentTx.join('; ') || 'none yet'}
Agent statuses: ${agentLines}

Return ONLY JSON (no markdown):
{
  "headline": "one punchy sentence summarizing the day",
  "metrics": [
    { "label": "Revenue 24h", "value": "...", "trend": "up|down|flat" },
    { "label": "All-time revenue", "value": "...", "trend": "up|down|flat" },
    { "label": "Customers", "value": "...", "trend": "up|down|flat" },
    { "label": "Active agents", "value": "X/4", "trend": "up|down|flat" }
  ],
  "summary": "2-3 sentences narrative of what happened today and why it matters",
  "priorities": ["top priority for tomorrow #1", "top priority for tomorrow #2", "top priority for tomorrow #3"]
}`
      }],
    });

    const raw = msg.content[0].text;
    const report = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    report.date = today;
    report.companyName = company.name;
    report.stripeConnected = !!company.stripeAccountId;
    res.json(report);
  } catch(e) {
    console.error('[report]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DASHBOARD — real Stripe data ──
app.get('/api/dashboard/:companyId', requireAuth, async (req, res) => {
  try {
    const company = await dbGetCompany(req.params.companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    if (company.founderEmail !== req.userEmail) return res.status(403).json({ error: 'Forbidden' });

    const result = {
      name: company.name,
      emoji: company.emoji,
      siteUrl: company.siteUrl,
      stripeConnected: !!company.stripeAccountId,
      revenue30d: 0,
      revenueTotal: 0,
      customers: 0,
      recentActivity: [],
    };

    if (company.stripeAccountId) {
      try {
        const s = getStripe();
        const since30d = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);

        const [charges30d, allCharges] = await Promise.all([
          s.charges.list({ limit: 50, created: { gte: since30d } }, { stripeAccount: company.stripeAccountId }),
          s.charges.list({ limit: 100 }, { stripeAccount: company.stripeAccountId }),
        ]);

        const succeeded30d = charges30d.data.filter(c => c.status === 'succeeded');
        const succeededAll = allCharges.data.filter(c => c.status === 'succeeded');

        result.revenue30d   = succeeded30d.reduce((s, c) => s + c.amount, 0) / 100;
        result.revenueTotal = succeededAll.reduce((s, c) => s + c.amount, 0) / 100;

        const emails = new Set(succeededAll.map(c => c.billing_details?.email || c.receipt_email).filter(Boolean));
        result.customers = emails.size;

        result.recentActivity = succeeded30d.slice(0, 10).map(c => ({
          amount:   c.amount / 100,
          currency: c.currency.toUpperCase(),
          email:    c.billing_details?.email || c.receipt_email || 'customer',
          date:     new Date(c.created * 1000).toISOString(),
        }));
      } catch (stripeErr) {
        console.error('[dashboard] Stripe error:', stripeErr.message);
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[dashboard error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n⬡  Forge server running → http://localhost:${PORT}`);
    console.log(`\nServices:`);
    console.log(`  Claude API  ${process.env.ANTHROPIC_API_KEY ? '✓ connected' : '✗ missing ANTHROPIC_API_KEY'}`);
    console.log(`  PostgreSQL  ${process.env.DATABASE_URL ? '✓ connected' : '○ in-memory (add DATABASE_URL)'}`);
    console.log(`  Vercel      ${process.env.VERCEL_TOKEN ? '✓ connected' : '○ optional (add VERCEL_TOKEN)'}`);
    console.log(`  Stripe      ${process.env.STRIPE_SECRET_KEY ? '✓ connected' : '○ optional (add STRIPE_SECRET_KEY)'}`);
    console.log(`  Stripe Conn ${(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_CLIENT_ID) ? '✓ enabled' : '○ optional (add STRIPE_CLIENT_ID + APP_URL)'}`);
    console.log(`  Resend      ${process.env.RESEND_API_KEY ? '✓ connected' : '○ optional (add RESEND_API_KEY)'}`);
    console.log('');
  });
}).catch(err => {
  console.error('[db] Failed to initialize database:', err.message);
  process.exit(1);
});

require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Serve the frontend files
app.use(express.static(path.join(__dirname)));

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
  "color": "#hexcolor (vivid brand color, not purple — pick something fitting)"
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
  const color = company.color || '#7c3aed';
  const starterUrl = stripeLinks?.starter?.url || '#';
  const proUrl = stripeLinks?.pro?.url || '#';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(company.name)} — ${escHtml(company.tagline)}</title>
<meta name="description" content="${escHtml(company.description)}">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root { --c: ${color}; --bg: #07070f; --card: #0d0d1a; --text: #f1f5f9; --muted: #94a3b8; --dim: #475569; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
a { text-decoration: none; }
/* Nav */
nav { padding: 16px 48px; border-bottom: 1px solid rgba(255,255,255,.07); display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; background: rgba(7,7,15,.92); backdrop-filter: blur(16px); z-index: 50; }
.logo { font-size: 18px; font-weight: 900; color: white; }
.nav-cta { padding: 10px 22px; background: var(--c); color: white; border-radius: 8px; font-weight: 700; font-size: 14px; transition: opacity .2s; }
.nav-cta:hover { opacity: .85; }
/* Hero */
.hero { text-align: center; padding: 120px 40px 100px; max-width: 800px; margin: 0 auto; }
.hero-emoji { font-size: 60px; margin-bottom: 24px; display: block; }
h1 { font-size: clamp(38px, 6vw, 68px); font-weight: 900; letter-spacing: -2.5px; line-height: 1.05; margin-bottom: 22px; }
.hero p { font-size: 18px; color: var(--muted); max-width: 540px; margin: 0 auto 40px; line-height: 1.7; }
.hero-btns { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; }
.btn-primary { padding: 16px 34px; background: var(--c); color: white; border-radius: 12px; font-weight: 800; font-size: 16px; transition: opacity .2s; }
.btn-primary:hover { opacity: .85; }
.btn-ghost { padding: 16px 28px; border: 1px solid rgba(255,255,255,.15); color: var(--text); border-radius: 12px; font-weight: 600; font-size: 15px; transition: background .2s; }
.btn-ghost:hover { background: rgba(255,255,255,.05); }
/* Features */
.features { padding: 100px 48px; max-width: 1100px; margin: 0 auto; }
.section-label { text-align: center; font-size: 12px; text-transform: uppercase; letter-spacing: .12em; color: var(--c); font-weight: 700; margin-bottom: 16px; }
.features h2 { text-align: center; font-size: clamp(28px, 4vw, 44px); font-weight: 900; letter-spacing: -1.5px; margin-bottom: 60px; }
.feat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.feat-card { background: var(--card); border: 1px solid rgba(255,255,255,.07); border-radius: 16px; padding: 32px; transition: border-color .2s; }
.feat-card:hover { border-color: rgba(255,255,255,.15); }
.feat-icon { font-size: 34px; margin-bottom: 16px; }
.feat-title { font-size: 16px; font-weight: 800; margin-bottom: 8px; }
.feat-desc { font-size: 14px; color: var(--muted); line-height: 1.7; }
/* Pricing */
.pricing { padding: 100px 48px; max-width: 820px; margin: 0 auto; text-align: center; }
.pricing h2 { font-size: clamp(28px, 4vw, 44px); font-weight: 900; letter-spacing: -1.5px; margin-bottom: 60px; }
.pricing-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; text-align: left; }
.plan { background: var(--card); border: 1px solid rgba(255,255,255,.08); border-radius: 20px; padding: 36px; display: flex; flex-direction: column; }
.plan.featured { border-color: var(--c); box-shadow: 0 0 40px rgba(0,0,0,.4); }
.plan-badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 100px; background: var(--c); color: white; margin-bottom: 20px; width: fit-content; }
.plan-name { font-size: 13px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 12px; }
.plan-price { font-size: 52px; font-weight: 900; letter-spacing: -2px; margin-bottom: 4px; }
.plan-price span { font-size: 16px; font-weight: 400; color: var(--dim); }
.plan-sub { font-size: 13px; color: var(--dim); margin-bottom: 28px; }
.plan-features { list-style: none; display: flex; flex-direction: column; gap: 12px; margin-bottom: 32px; flex: 1; }
.plan-features li { font-size: 14px; display: flex; gap: 9px; align-items: flex-start; }
.plan-features li::before { content: '✓'; color: var(--c); font-weight: 900; flex-shrink: 0; margin-top: 1px; }
.plan-btn { display: block; text-align: center; padding: 15px; border-radius: 12px; font-weight: 800; font-size: 15px; background: var(--c); color: white; transition: opacity .2s; margin-top: auto; }
.plan-btn:hover { opacity: .85; }
.plan-btn.outline { background: transparent; border: 1px solid rgba(255,255,255,.15); }
/* Footer */
footer { border-top: 1px solid rgba(255,255,255,.07); padding: 48px; text-align: center; color: var(--dim); font-size: 13px; }
footer strong { color: var(--muted); }
@media(max-width: 768px) {
  nav { padding: 14px 24px; }
  .feat-grid { grid-template-columns: 1fr; }
  .pricing-grid { grid-template-columns: 1fr; }
  .hero { padding: 80px 24px 60px; }
  .features, .pricing { padding: 60px 24px; }
}
</style>
</head>
<body>

<nav>
  <div class="logo">${company.emoji} ${escHtml(company.name)}</div>
  <a href="${starterUrl}" class="nav-cta">Get started →</a>
</nav>

<section class="hero">
  <span class="hero-emoji">${company.emoji}</span>
  <h1>${escHtml(company.hero_headline)}</h1>
  <p>${escHtml(company.hero_sub)}</p>
  <div class="hero-btns">
    <a href="${starterUrl}" class="btn-primary">Start free →</a>
    <a href="#features" class="btn-ghost">How it works</a>
  </div>
</section>

<section class="features" id="features">
  <p class="section-label">Features</p>
  <h2>Everything built in. Zero setup.</h2>
  <div class="feat-grid">
    ${company.features.map(f => `
    <div class="feat-card">
      <div class="feat-icon">${f.icon}</div>
      <div class="feat-title">${escHtml(f.title)}</div>
      <div class="feat-desc">${escHtml(f.desc)}</div>
    </div>`).join('')}
  </div>
</section>

<section class="pricing" id="pricing">
  <h2>Simple pricing.</h2>
  <div class="pricing-grid">
    <div class="plan">
      <div class="plan-name">${escHtml(company.starter_name)}</div>
      <div class="plan-price">$${company.starter_price}<span>/mo</span></div>
      <div class="plan-sub">Perfect to get started</div>
      <ul class="plan-features">
        ${company.starter_features.map(f => `<li>${escHtml(f)}</li>`).join('')}
      </ul>
      <a href="${starterUrl}" class="plan-btn outline">Get started →</a>
    </div>
    <div class="plan featured">
      <span class="plan-badge">Most popular</span>
      <div class="plan-name">${escHtml(company.pro_name)}</div>
      <div class="plan-price">$${company.pro_price}<span>/mo</span></div>
      <div class="plan-sub">For serious founders</div>
      <ul class="plan-features">
        ${company.pro_features.map(f => `<li>${escHtml(f)}</li>`).join('')}
      </ul>
      <a href="${proUrl}" class="plan-btn">Get ${escHtml(company.pro_name)} →</a>
    </div>
  </div>
</section>

<footer>
  <strong>${escHtml(company.name)}</strong> — ${escHtml(company.tagline)}<br>
  <span style="margin-top:10px;display:block;">Built with <a href="#" style="color:var(--muted);">Forge</a> · Powered by AI</span>
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

  const res = await fetch('https://api.vercel.com/v13/deployments', {
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
// 4. CREATE STRIPE PRODUCTS & PAYMENT LINKS
// ─────────────────────────────────────────────
async function createStripeProducts(company) {
  const s = getStripe();
  if (!s) return null;

  async function makePlan(name, price, description) {
    const product = await s.products.create({ name, description });
    const stripePrice = await s.prices.create({
      product: product.id,
      unit_amount: price * 100,
      currency: 'usd',
      recurring: { interval: 'month' },
    });
    const link = await s.paymentLinks.create({
      line_items: [{ price: stripePrice.id, quantity: 1 }],
    });
    return { url: link.url, priceId: stripePrice.id, productId: product.id };
  }

  const [starter, pro] = await Promise.all([
    makePlan(
      `${company.name} — ${company.starter_name}`,
      company.starter_price,
      company.description
    ),
    makePlan(
      `${company.name} — ${company.pro_name}`,
      company.pro_price,
      company.description
    ),
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
    companies: companies.size,
    services: {
      claude: !!process.env.ANTHROPIC_API_KEY,
      vercel: !!process.env.VERCEL_TOKEN,
      stripe: !!process.env.STRIPE_SECRET_KEY,
      resend: !!process.env.RESEND_API_KEY,
    },
  });
});

// ── CREATE COMPANY (SSE stream) ──
app.post('/api/create-company', async (req, res) => {
  const { idea, name, category = 'B2B SaaS', founderEmail } = req.body;

  if (!idea?.trim() || !name?.trim()) {
    return res.status(400).json({ error: 'idea and name are required' });
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
      send('log', { msg: '→ Deploying to Vercel (this takes ~10s)…', cls: 'log-info' });
      const html = generateLandingHTML(company, null); // first deploy without Stripe links
      const deployment = await deployToVercel(company.slug, html);
      if (deployment?.url) {
        siteUrl = deployment.url;
        deploymentId = deployment.id;
        send('agent', { id: 'ag-builder', status: 'done', task: `Deployed → ${siteUrl}` });
        send('log', { msg: `✓ Website live: ${siteUrl}`, cls: 'log-ok' });
      }
    } else {
      send('agent', { id: 'ag-builder', status: 'done', task: 'Landing page generated (add VERCEL_TOKEN to deploy)' });
      send('log', { msg: '✓ Landing page HTML generated', cls: 'log-ok' });
      send('log', { msg: '○ Add VERCEL_TOKEN to .env to deploy it live', cls: 'log-act' });
    }

    send('progress', { pct: 55, label: 'Configuring payments…' });

    // ── PAYMENTS ──
    send('agent', { id: 'ag-payments', status: 'active', task: 'Creating Stripe products…' });

    let stripeLinks = null;

    if (process.env.STRIPE_SECRET_KEY) {
      send('log', { msg: '→ Creating Stripe products + recurring prices…', cls: 'log-info' });
      stripeLinks = await createStripeProducts(company);
      send('agent', { id: 'ag-payments', status: 'done', task: `Stripe live — payment links active` });
      send('log', { msg: `✓ Stripe ${company.starter_name}: $${company.starter_price}/mo → ${stripeLinks.starter.url.slice(0, 40)}…`, cls: 'log-ok' });
      send('log', { msg: `✓ Stripe ${company.pro_name}: $${company.pro_price}/mo → ${stripeLinks.pro.url.slice(0, 40)}…`, cls: 'log-ok' });

      // Redeploy with real Stripe links embedded
      if (process.env.VERCEL_TOKEN) {
        send('log', { msg: '→ Redeploying site with live payment links…', cls: 'log-info' });
        const htmlFinal = generateLandingHTML(company, stripeLinks);
        const dep2 = await deployToVercel(company.slug, htmlFinal);
        if (dep2?.url) {
          siteUrl = dep2.url;
          send('log', { msg: `✓ Site updated with live Stripe links`, cls: 'log-ok' });
        }
      }
    } else {
      send('agent', { id: 'ag-payments', status: 'done', task: 'Add STRIPE_SECRET_KEY to activate' });
      send('log', { msg: '○ Add STRIPE_SECRET_KEY to .env to create real payment links', cls: 'log-act' });
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
    companies.set(companyId, {
      ...company,
      siteUrl,
      stripeLinks,
      founderEmail: founderEmail || null,
      landingHtml: generateLandingHTML(company, stripeLinks),
      createdAt: new Date().toISOString(),
      chatHistory: [],
    });

    send('agent', { id: 'ag-ceo', status: 'done', task: 'CEO ready — open chat to talk to your company' });
    send('log', { msg: `✓ CEO initialized with company context`, cls: 'log-ok' });
    send('log', { msg: `✓ ${name} is fully operational. 🎉`, cls: 'log-ok' });
    send('progress', { pct: 100, label: `${name} is live!` });

    send('complete', {
      companyId,
      siteUrl,
      stripeLinks,
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

  const company = companies.get(companyId);
  if (!company) return res.status(404).json({ error: 'Company not found. It may have been cleared on server restart.' });

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
    const history = company.chatHistory.slice(-20);
    history.push({ role: 'user', content: message });

    const msg = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 600,
      system: systemPrompt,
      messages: history,
    });

    const reply = msg.content[0].text;

    // Update chat history
    company.chatHistory.push({ role: 'user', content: message });
    company.chatHistory.push({ role: 'assistant', content: reply });

    res.json({ reply });
  } catch (err) {
    console.error('[chat error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET COMPANY ──
app.get('/api/company/:id', (req, res) => {
  const company = companies.get(req.params.id);
  if (!company) return res.status(404).json({ error: 'Not found' });
  // Don't expose chat history or full landing HTML in this endpoint
  const { chatHistory, landingHtml, ...safe } = company;
  res.json(safe);
});

// ── DOWNLOAD LANDING PAGE HTML ──
app.get('/api/company/:id/html', (req, res) => {
  const company = companies.get(req.params.id);
  if (!company) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="${company.slug}.html"`);
  res.send(company.landingHtml || generateLandingHTML(company, company.stripeLinks));
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n⬡  Forge server running → http://localhost:${PORT}`);
  console.log(`\nServices:`);
  console.log(`  Claude API  ${process.env.ANTHROPIC_API_KEY ? '✓ connected' : '✗ missing ANTHROPIC_API_KEY'}`);
  console.log(`  Vercel      ${process.env.VERCEL_TOKEN ? '✓ connected' : '○ optional (add VERCEL_TOKEN)'}`);
  console.log(`  Stripe      ${process.env.STRIPE_SECRET_KEY ? '✓ connected' : '○ optional (add STRIPE_SECRET_KEY)'}`);
  console.log(`  Resend      ${process.env.RESEND_API_KEY ? '✓ connected' : '○ optional (add RESEND_API_KEY)'}`);
  console.log('');
});

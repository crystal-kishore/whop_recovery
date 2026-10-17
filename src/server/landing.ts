import type { Request, Response } from "express";

/**
 * Public marketing landing page for "Whop Payment Recovery", served at
 * GET / (root). Completely separate from the internal /dashboard route and
 * the OAuth flow — this is a static, unauthenticated page with a single CTA
 * that kicks off /auth/whop. Plain HTML + CSS, no client-side JS/frameworks,
 * so it's fast and has nothing to build.
 */
function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Whop Payment Recovery — Recover failed payments via Discord DM</title>
<meta name="description" content="Whop Payment Recovery automatically catches failed subscription payments and recovers them via Discord DM. No fees unless we recover your money." />
<style>
  :root {
    --bg: #0b0c10;
    --bg-alt: #111319;
    --card: #15171f;
    --border: #22242e;
    --text: #e9e9ef;
    --text-dim: #a2a5b3;
    --accent: #7c5cff;
    --accent-2: #5865f2;
    --accent-gradient: linear-gradient(135deg, #7c5cff 0%, #5865f2 100%);
    --success: #3ddc97;
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
    scroll-behavior: smooth;
  }

  a { color: inherit; text-decoration: none; }

  .wrap {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 24px;
  }

  /* ---------- Nav ---------- */
  nav.topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 24px;
    max-width: 1080px;
    margin: 0 auto;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 700;
    font-size: 16px;
    letter-spacing: -0.01em;
  }
  .brand .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent-gradient);
    box-shadow: 0 0 12px rgba(124, 92, 255, 0.7);
  }
  .nav-cta {
    padding: 9px 18px;
    border-radius: 8px;
    border: 1px solid var(--border);
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .nav-cta:hover {
    border-color: var(--accent);
    background: rgba(124, 92, 255, 0.08);
  }

  /* ---------- Hero ---------- */
  header.hero {
    text-align: center;
    padding: 76px 24px 64px;
    background:
      radial-gradient(600px 300px at 50% -10%, rgba(124, 92, 255, 0.25), transparent 70%),
      var(--bg);
  }
  .eyebrow {
    display: inline-block;
    font-size: 13px;
    font-weight: 600;
    color: var(--accent);
    background: rgba(124, 92, 255, 0.12);
    border: 1px solid rgba(124, 92, 255, 0.35);
    padding: 6px 14px;
    border-radius: 999px;
    margin-bottom: 24px;
  }
  h1.headline {
    font-size: clamp(32px, 5vw, 56px);
    line-height: 1.08;
    letter-spacing: -0.02em;
    margin: 0 0 20px;
    font-weight: 800;
    max-width: 820px;
    margin-left: auto;
    margin-right: auto;
  }
  h1.headline .accent-text {
    background: var(--accent-gradient);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  p.subheadline {
    font-size: clamp(16px, 2vw, 19px);
    color: var(--text-dim);
    max-width: 620px;
    margin: 0 auto 36px;
    line-height: 1.6;
  }
  .cta-primary {
    display: inline-block;
    padding: 16px 34px;
    border-radius: 10px;
    background: var(--accent-gradient);
    color: #fff;
    font-weight: 700;
    font-size: 16px;
    box-shadow: 0 8px 24px rgba(124, 92, 255, 0.35);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .cta-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 28px rgba(124, 92, 255, 0.45);
  }
  .trust-line {
    margin-top: 16px;
    font-size: 14px;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .trust-line .check {
    color: var(--success);
    font-weight: 700;
  }
  .pricing-heading {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 700;
    color: var(--success);
    background: rgba(34, 197, 94, 0.12);
    border: 1px solid rgba(34, 197, 94, 0.35);
    padding: 10px 20px;
    border-radius: 999px;
    margin: 0 0 24px;
  }

  /* ---------- Sections ---------- */
  section {
    padding: 72px 24px;
    border-top: 1px solid var(--border);
  }
  section.alt { background: var(--bg-alt); }

  .section-heading {
    text-align: center;
    margin-bottom: 48px;
  }
  .section-heading h2 {
    font-size: clamp(24px, 3.4vw, 34px);
    letter-spacing: -0.01em;
    margin: 0 0 12px;
    font-weight: 800;
  }
  .section-heading p {
    color: var(--text-dim);
    font-size: 16px;
    max-width: 560px;
    margin: 0 auto;
    line-height: 1.6;
  }

  /* ---------- How it works ---------- */
  .steps {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 20px;
    max-width: 1080px;
    margin: 0 auto;
  }
  .step-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 26px 20px;
  }
  .step-number {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--accent-gradient);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 15px;
    color: #fff;
    margin-bottom: 16px;
  }
  .step-card h3 {
    font-size: 16px;
    margin: 0 0 8px;
    font-weight: 700;
  }
  .step-card p {
    font-size: 14px;
    color: var(--text-dim);
    line-height: 1.55;
    margin: 0;
  }

  /* ---------- Features ---------- */
  .features-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
    max-width: 1080px;
    margin: 0 auto;
  }
  .feature-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 24px;
  }
  .feature-icon {
    font-size: 22px;
    margin-bottom: 14px;
  }
  .feature-card h3 {
    font-size: 15.5px;
    margin: 0 0 8px;
    font-weight: 700;
  }
  .feature-card p {
    font-size: 14px;
    color: var(--text-dim);
    line-height: 1.55;
    margin: 0;
  }

  /* ---------- Why Discord ---------- */
  .why-discord {
    max-width: 760px;
    margin: 0 auto;
    text-align: center;
  }
  .why-discord .badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: rgba(88, 101, 242, 0.14);
    border: 1px solid rgba(88, 101, 242, 0.4);
    color: #a9b3ff;
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 20px;
  }
  .why-discord p {
    font-size: 17px;
    line-height: 1.7;
    color: var(--text-dim);
  }
  .why-discord strong { color: var(--text); }

  /* ---------- Pricing ---------- */
  .pricing-card {
    max-width: 480px;
    margin: 0 auto;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 44px 36px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .pricing-card::before {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(400px 200px at 50% 0%, rgba(124, 92, 255, 0.18), transparent 70%);
    pointer-events: none;
  }
  .pricing-rate {
    font-size: 56px;
    font-weight: 800;
    letter-spacing: -0.02em;
    background: var(--accent-gradient);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    margin-bottom: 4px;
  }
  .pricing-card .pricing-label {
    font-size: 15px;
    color: var(--text-dim);
    margin-bottom: 24px;
  }
  .pricing-list {
    list-style: none;
    padding: 0;
    margin: 0 0 32px;
    text-align: left;
    display: inline-block;
  }
  .pricing-list li {
    font-size: 14.5px;
    color: var(--text-dim);
    margin-bottom: 10px;
    padding-left: 24px;
    position: relative;
  }
  .pricing-list li::before {
    content: "✓";
    position: absolute;
    left: 0;
    color: var(--success);
    font-weight: 700;
  }

  /* ---------- Final CTA ---------- */
  section.final-cta {
    text-align: center;
    padding: 88px 24px;
    background:
      radial-gradient(600px 260px at 50% 100%, rgba(124, 92, 255, 0.2), transparent 70%),
      var(--bg);
  }
  section.final-cta h2 {
    font-size: clamp(24px, 3.6vw, 36px);
    font-weight: 800;
    margin: 0 0 14px;
  }
  section.final-cta p {
    color: var(--text-dim);
    margin: 0 0 32px;
    font-size: 16px;
  }

  /* ---------- Footer ---------- */
  footer {
    border-top: 1px solid var(--border);
    padding: 32px 24px;
    text-align: center;
    color: var(--text-dim);
    font-size: 13.5px;
  }
  footer a { color: var(--text-dim); border-bottom: 1px dotted var(--border); }
  footer a:hover { color: var(--text); }

  @media (max-width: 860px) {
    .steps { grid-template-columns: repeat(2, 1fr); }
    .features-grid { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 560px) {
    .steps { grid-template-columns: 1fr; }
    .features-grid { grid-template-columns: 1fr; }
    nav.topbar { padding: 16px; }
  }
</style>
</head>
<body>

<nav class="topbar">
  <div class="brand"><span class="dot"></span>Whop Payment Recovery</div>
  <a class="nav-cta" href="/auth/whop">Connect Whop</a>
</nav>

<header class="hero">
  <div class="wrap">
    <span class="eyebrow">For Whop creators</span>
    <h1 class="headline">Stop Losing Revenue to <span class="accent-text">Failed Payments</span></h1>
    <p class="subheadline">
      Whop Payment Recovery automatically catches failed subscription payments and recovers
      them via Discord DM — where your members actually are.
    </p>
    <p class="pricing-heading">% We only take a small commission when we recover real money for you — no recovery, no charge.</p>
    <a class="cta-primary" href="/auth/whop">Connect Whop</a>
    <div class="trust-line"><span class="check">✓</span> No fees unless we recover your money</div>
  </div>
</header>

<section id="how-it-works">
  <div class="wrap">
    <div class="section-heading">
      <h2>How it works</h2>
      <p>Set up once, then let it run in the background — no manual chasing.</p>
    </div>
    <div class="steps">
      <div class="step-card">
        <div class="step-number">1</div>
        <h3>Connect your Whop account</h3>
        <p>One-click OAuth — we securely link to your Whop account to watch for failed payments.</p>
      </div>
      <div class="step-card">
        <div class="step-number">2</div>
        <h3>Add our Discord bot</h3>
        <p>Invite the bot to your server so it can DM customers who link their Discord to Whop.</p>
      </div>
      <div class="step-card">
        <div class="step-number">3</div>
        <h3>We catch failures instantly</h3>
        <p>The moment a payment fails, we detect it via real-time webhook and DM the customer a fix-it link.</p>
      </div>
      <div class="step-card">
        <div class="step-number">4</div>
        <h3>You get paid</h3>
        <p>We only take 15% of what we actually recover for you. Nothing recovered, nothing charged.</p>
      </div>
    </div>
  </div>
</section>

<section class="alt" id="features">
  <div class="wrap">
    <div class="section-heading">
      <h2>Built to actually get payments fixed</h2>
      <p>Not another notification that gets ignored — a recovery system built around where your members already are.</p>
    </div>
    <div class="features-grid">
      <div class="feature-card">
        <div class="feature-icon">💬</div>
        <h3>Discord-native recovery</h3>
        <p>Messages arrive where your community already lives, not buried in an email inbox.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">⚡</div>
        <h3>Instant detection</h3>
        <p>Failed payments are caught the moment they happen via real-time webhooks — no polling delays.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🔁</div>
        <h3>Smart follow-ups</h3>
        <p>Automatic reminders at 24h and 72h if the first message doesn't convert.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🛡️</div>
        <h3>Zero-risk pricing</h3>
        <p>No monthly fee. We only earn when you recover revenue — 15% of what's recovered, period.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🔗</div>
        <h3>Real payment links</h3>
        <p>Customers get a direct, working link to fix their payment — not a generic "your payment failed" notice.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">📊</div>
        <h3>Simple dashboard</h3>
        <p>See exactly what's been caught and recovered, in real time, from one clean dashboard.</p>
      </div>
    </div>
  </div>
</section>

<section id="why-discord">
  <div class="wrap why-discord">
    <span class="badge">Why Discord?</span>
    <p>
      Most failed-payment emails go straight to spam or get ignored entirely. But a Discord DM
      gets seen — <strong>that's where the community engagement is already happening</strong>.
      Your members check Discord daily; recovering revenue there means higher response rates
      and faster fixes, without adding another email your customers tune out.
    </p>
  </div>
</section>

<section class="alt" id="pricing">
  <div class="wrap">
    <div class="section-heading">
      <h2>Pricing</h2>
      <p>One plan. No surprises.</p>
    </div>
    <div class="pricing-card">
      <div class="pricing-rate">15%</div>
      <div class="pricing-label">of recovered revenue. That's it.</div>
      <ul class="pricing-list">
        <li>No subscription fee</li>
        <li>No setup fee</li>
        <li>No cost if we don't recover anything</li>
        <li>Billed automatically only against what we recover</li>
      </ul>
    </div>
  </div>
</section>

<section class="final-cta">
  <div class="wrap">
    <h2>Ready to stop losing revenue?</h2>
    <p>Connect your Whop account in under a minute — recovery starts working immediately.</p>
    <a class="cta-primary" href="/auth/whop">Connect Whop</a>
  </div>
</section>

<footer>
  &copy; ${new Date().getFullYear()} Whop Payment Recovery. Questions? <a href="mailto:support@whop-recovery.example.com">Contact support</a>.
</footer>

</body>
</html>`;
}

/** GET / — public marketing landing page. Unauthenticated, no side effects. */
export function landingHandler(_req: Request, res: Response): void {
  res.status(200).set("Content-Type", "text/html; charset=utf-8").send(renderLandingPage());
}

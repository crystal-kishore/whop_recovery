import type { Request, Response } from "express";
import {
  getBillingLogForCreator,
  getCreatorAccountBySessionToken,
  getDashboardStats,
  getTotalBilledForCreator,
  type BillingLogRecord,
  type CreatorAccountRecord,
  type DashboardStats,
  type FailedPaymentRecord,
} from "../db/schema";

/** Escapes a string for safe interpolation into HTML text content or attributes. */
function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function renderStatusBadge(status: string): string {
  const cls = status === "recovered" ? "badge badge-recovered" : "badge badge-pending";
  return `<span class="${cls}">${escapeHtml(status)}</span>`;
}

function renderChannelBadge(channel: string | null): string {
  if (!channel) return `<span class="muted">&mdash;</span>`;
  const cls = channel === "discord" ? "badge badge-discord" : channel === "whatsapp" ? "badge badge-whatsapp" : "badge badge-email";
  return `<span class="${cls}">${escapeHtml(channel)}</span>`;
}

function renderRow(payment: FailedPaymentRecord): string {
  return `
    <tr>
      <td>${escapeHtml(payment.customer_name || "\u2014")}</td>
      <td>${escapeHtml(formatCurrency(payment.amount_due, payment.currency))}</td>
      <td>${renderStatusBadge(payment.status)}</td>
      <td>${renderChannelBadge(payment.last_channel)}</td>
      <td>${escapeHtml(payment.created_at)}</td>
      <td>${escapeHtml(payment.last_reminder_at || "\u2014")}</td>
    </tr>`;
}

function renderBillingStatusBadge(status: string): string {
  const cls = status === "succeeded" ? "badge badge-recovered" : "badge badge-pending";
  return `<span class="${cls}">${escapeHtml(status)}</span>`;
}

function renderBillingRow(entry: BillingLogRecord): string {
  return `
    <tr>
      <td>${escapeHtml(formatCurrency(entry.amount_charged, entry.currency))}</td>
      <td>${renderBillingStatusBadge(entry.status)}</td>
      <td>${escapeHtml(entry.error_message || "\u2014")}</td>
      <td>${escapeHtml(entry.created_at)}</td>
    </tr>`;
}

const PAGE_STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    margin: 0;
    background: #f5f6f8;
    color: #1a1a1a;
  }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: #666; margin: 0 0 24px; font-size: 14px; }
  .connect-banner {
    background: #fff; border: 1px solid #e0e0e0; border-radius: 8px;
    padding: 24px; text-align: center; margin-bottom: 24px;
  }
  .connect-banner p { color: #555; margin-bottom: 16px; }
  .btn {
    display: inline-block; background: #111; color: #fff; text-decoration: none;
    padding: 10px 20px; border-radius: 6px; font-weight: 600; font-size: 14px;
  }
  .btn:hover { background: #333; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card {
    background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px;
  }
  .card .label { font-size: 12px; text-transform: uppercase; color: #888; letter-spacing: 0.04em; margin-bottom: 6px; }
  .card .value { font-size: 24px; font-weight: 700; }
  .connection-status { font-size: 14px; margin-bottom: 24px; color: #333; }
  .connection-status .dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: #22c55e; margin-right: 6px;
  }
  .onboarding-step {
    background: #fff; border: 1px solid #e0e0e0; border-radius: 8px;
    padding: 16px 20px; margin-bottom: 24px; display: flex; align-items: center;
    justify-content: space-between; gap: 16px; flex-wrap: wrap;
  }
  .onboarding-step p { margin: 0; color: #555; font-size: 14px; }
  .onboarding-step .confirmed { color: #166534; font-weight: 600; font-size: 14px; }
  .btn-discord { background: #5865f2; }
  .btn-discord:hover { background: #4752c4; }
  .btn-dodo { background: #7c3aed; }
  .btn-dodo:hover { background: #6d28d9; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #eee; }
  th { background: #fafafa; color: #666; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.03em; }
  tr:last-child td { border-bottom: none; }
  .muted { color: #aaa; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge-recovered { background: #dcfce7; color: #166534; }
  .badge-pending { background: #fef3c7; color: #92400e; }
  .badge-whatsapp { background: #dcfce7; color: #166534; }
  .badge-email { background: #dbeafe; color: #1e40af; }
  .badge-discord { background: #e0e7ff; color: #4338ca; }
  .empty-state { text-align: center; padding: 32px; color: #888; background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; }
`;

function renderPage(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>whop-recovery dashboard</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="container">
    <h1>Recovery Dashboard</h1>
    <p class="subtitle">Failed payment tracking and recovery messaging status.</p>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

function renderNotConnected(): string {
  return renderPage(`
    <div class="connect-banner">
      <p>You haven't connected a Whop account yet.</p>
      <a class="btn" href="/auth/whop">Connect Whop</a>
    </div>
  `);
}

function renderConnected(
  creatorAccount: CreatorAccountRecord,
  stats: DashboardStats,
  billingLog: BillingLogRecord[],
  totalBilled: number
): string {
  const identity = creatorAccount.name || creatorAccount.email || creatorAccount.whop_account_id;

  const discordStep = creatorAccount.discord_guild_id
    ? `
      <div class="onboarding-step">
        <p><span class="confirmed">&#10003; Discord bot connected</span> &mdash; recovery DMs can be sent to customers in your server.</p>
      </div>`
    : `
      <div class="onboarding-step">
        <p>Add our Discord bot to your server so customers who link Discord to Whop can receive recovery DMs.</p>
        <a class="btn btn-discord" href="/auth/discord">Add our Discord bot to your server</a>
      </div>`;

  const billingStep = creatorAccount.dodo_subscription_id
    ? `
      <div class="onboarding-step">
        <p><span class="confirmed">&#10003; Payment method connected</span> &mdash; we'll bill your ${Math.round(creatorAccount.billing_rate * 100)}% commission on recovered revenue weekly.</p>
      </div>`
    : `
      <div class="onboarding-step">
        <p><strong>Required:</strong> connect a payment method so we can bill our ${Math.round(creatorAccount.billing_rate * 100)}% commission on revenue we recover for you (only charged when we actually recover a payment). Recovery messages won't be sent until this is connected.</p>
        <a class="btn btn-dodo" href="/billing/dodo/connect">Connect payment method</a>
      </div>`;

  const rowsHtml = stats.recentPayments.length
    ? stats.recentPayments.map(renderRow).join("")
    : "";

  const tableSection = stats.recentPayments.length
    ? `
      <table>
        <thead>
          <tr>
            <th>Customer</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Channel</th>
            <th>Created</th>
            <th>Last reminder</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>`
    : `<div class="empty-state">No failed payments recorded yet.</div>`;

  const billingRowsHtml = billingLog.length ? billingLog.map(renderBillingRow).join("") : "";

  const billingTableSection = billingLog.length
    ? `
      <table>
        <thead>
          <tr>
            <th>Amount charged</th>
            <th>Status</th>
            <th>Error</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>${billingRowsHtml}</tbody>
      </table>`
    : `<div class="empty-state">No commission charges yet.</div>`;

  return renderPage(`
    <div class="connection-status"><span class="dot"></span>Connected as ${escapeHtml(identity)}</div>
    ${discordStep}
    ${billingStep}
    <div class="cards">
      <div class="card">
        <div class="label">Failed payments caught</div>
        <div class="value">${stats.totalFailed}</div>
      </div>
      <div class="card">
        <div class="label">Total recovered</div>
        <div class="value">${stats.totalRecovered}</div>
      </div>
      <div class="card">
        <div class="label">Amount recovered</div>
        <!-- Simplification: sums across all currencies and formats as USD.
             Fine for now since the tool is single-currency in practice. -->
        <div class="value">${escapeHtml(formatCurrency(stats.totalAmountRecovered, "usd"))}</div>
      </div>
    </div>
    <h2 style="font-size:16px;margin:0 0 12px;">Recent failed payments</h2>
    ${tableSection}
    <h2 style="font-size:16px;margin:24px 0 12px;">Commission billing</h2>
    <div class="cards">
      <div class="card">
        <div class="label">Commission rate</div>
        <div class="value">${Math.round(creatorAccount.billing_rate * 100)}%</div>
      </div>
      <div class="card">
        <div class="label">Total billed</div>
        <div class="value">${escapeHtml(formatCurrency(totalBilled, "usd"))}</div>
      </div>
    </div>
    ${billingTableSection}
  `);
}

/** GET /dashboard — read-only creator dashboard, gated by the session cookie set after OAuth. */
export function dashboardHandler(req: Request, res: Response): void {
  const sessionToken = req.cookies?.session_token as string | undefined;
  const creatorAccount = sessionToken ? getCreatorAccountBySessionToken(sessionToken) : null;

  if (!creatorAccount) {
    res.status(200).send(renderNotConnected());
    return;
  }

  try {
    const stats = getDashboardStats(creatorAccount.id);
    const billingLog = getBillingLogForCreator(creatorAccount.id);
    const totalBilled = getTotalBilledForCreator(creatorAccount.id);
    res.status(200).send(renderConnected(creatorAccount, stats, billingLog, totalBilled));
  } catch (err) {
    console.error("[dashboard] Failed to load dashboard stats:", (err as Error).message);
    res.status(500).send("Failed to load dashboard.");
  }
}

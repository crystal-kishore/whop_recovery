import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";
import { getCreatorAccountByCompanyId, getFailedPaymentByWhopId, initSchema } from "../src/db/schema";

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.TEST_SERVER_URL || `http://localhost:${PORT}`;
const SECRET = process.env.WHOP_WEBHOOK_SECRET;
const WHOP_API_BASE = "https://api.whop.com/api/v1";

/**
 * Looks up the real buyer's display name via Whop's Users API using the
 * server-to-server `WHOP_API_KEY`, so the simulated payload reflects the
 * actual account instead of a hardcoded placeholder. Falls back to `null`
 * (never throws) if the id is a placeholder or the lookup fails.
 */
async function fetchRealUserName(userId: string): Promise<string | null> {
  const apiKey = process.env.WHOP_API_KEY;
  if (!apiKey || userId === "user_test") return null;
  try {
    const response = await fetch(`${WHOP_API_BASE}/users/${userId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { username?: string | null; name?: string | null };
    return body.name ?? body.username ?? null;
  } catch {
    return null;
  }
}


/**
 * Simulates a Whop `payment.failed` webhook: signs a sample payload the same
 * way the real server verifies it, POSTs it to the running server, then
 * queries the database directly to confirm the record was stored.
 *
 * Usage: start the server (npm run dev), then in another terminal run
 * `npm run test:webhook [membershipId] [companyId] [userId]`.
 *
 * The payload shape below matches a real payment.failed delivery captured
 * from Whop's servers (data.user/company/customer_phone/failure_message/
 * total), not a guessed schema.
 */
async function main(): Promise<void> {
  if (!SECRET) {
    console.error(
      "WHOP_WEBHOOK_SECRET is not set. Copy .env.example to .env and set a secret before running this script."
    );
    process.exit(1);
  }

  // Make sure the tables exist even if this script is run standalone.
  initSchema();

  const paymentId = `test_payment_${Date.now()}`;
  const webhookId = `msg_${randomUUID()}`;

  // Pass a real `mem_...` id (from your connected Whop account) as the first
  // CLI arg or TEST_MEMBERSHIP_ID env var to exercise the real membership
  // lookup end-to-end; otherwise a placeholder id is sent, which the server
  // will fail to fetch (logged, then falls back to a null recoveryLink).
  const membershipId = process.argv[2] || process.env.TEST_MEMBERSHIP_ID || "mem_placeholder";

  // The company id must match a real `creator_accounts.whop_company_id` row
  // (captured via the OAuth connect flow's Accounts API lookup) so the
  // server can resolve a real access token to call the Memberships/Users
  // APIs with. Pass it as the second CLI arg or TEST_COMPANY_ID env var.
  const companyId = process.argv[3] || process.env.TEST_COMPANY_ID || "acct_test_creator";

  // Pass the real Whop `user_...` id of the test buyer (a different Whop
  // account than the creator's) as the third CLI arg or TEST_USER_ID env
  // var, so the server's real Discord-id lookup (GET /users/{id}) resolves
  // that buyer's actual linked Discord account instead of failing on the
  // "user_test" placeholder.
  const userId = process.argv[4] || process.env.TEST_USER_ID || "user_test";

  // The email address the recovery message goes to when the email fallback
  // channel is exercised (i.e. no Discord id resolves, e.g. with the
  // "user_test" placeholder). Pass it as the 5th CLI arg or TEST_USER_EMAIL
  // env var; defaults to a fake placeholder that won't actually deliver.
  const customerEmail = process.argv[5] || process.env.TEST_USER_EMAIL || "jane.doe@example.com";

  // Resolve real display data instead of hardcoded placeholders: the buyer's
  // name comes from Whop's Users API, and the company title comes from the
  // creator_account row captured during OAuth connect (same source the real
  // webhook handler prefers over the payload's own `company.title`).
  const realUserName = await fetchRealUserName(userId);
  const creatorAccount = getCreatorAccountByCompanyId(companyId);
  const companyTitle = creatorAccount?.whop_company_name || "Test Company";

  const payload = {
    id: webhookId,
    api_version: "v1",
    api_version_date: null,
    timestamp: new Date().toISOString(),
    type: "payment.failed",
    data: {
      id: paymentId,
      total: 49.99,
      subtotal: 49.99,
      currency: "usd",
      failure_message: "Your card was declined.",
      company: { id: companyId, route: companyId, title: companyTitle },
      customer_phone: "+919025751099",
      user: { id: userId, name: realUserName ?? "Jane Doe", email: customerEmail },
      // The server derives the real recoveryLink by calling Whop's
      // Memberships API (GET /memberships/{id}) with the creator's stored
      // access token and reading `manage_url` off the response — it no
      // longer trusts a `recovery_url` field on the payload.
      membership: { id: membershipId },
    },
  };

  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");

  // Sign the payload the same way the real server verifies it: HMAC-SHA256
  // over `${webhook-id}.${webhook-timestamp}.${rawBody}` using the `ws_...`
  // secret as-is as the HMAC key, base64-encoded, per Whop's documented
  // "Verify without an SDK" scheme (see https://docs.whop.com/webhooks).
  const timestampSeconds = Math.floor(Date.now() / 1000);
  const signedContent = `${webhookId}.${timestampSeconds}.${rawBody.toString("utf8")}`;
  const signature = createHmac("sha256", SECRET).update(signedContent, "utf8").digest("base64");

  console.log(`Sending simulated payment.failed webhook to ${BASE_URL}/webhooks/whop ...`);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/webhooks/whop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": String(timestampSeconds),
        "webhook-signature": `v1,${signature}`,
      },
      body: rawBody,
    });
  } catch (err) {
    console.error(`Failed to reach server at ${BASE_URL}. Is it running? (npm run dev)`);
    console.error((err as Error).message);
    process.exit(1);
  }

  const responseBody = await response.json().catch(() => null);
  console.log(`Webhook response: ${response.status}`, responseBody);

  if (!response.ok) {
    console.error("FAILED: webhook was rejected by the server.");
    process.exit(1);
  }

  const stored = getFailedPaymentByWhopId(paymentId);
  if (!stored) {
    console.error("FAILED: no matching failed_payments row was found in the database.");
    process.exit(1);
  }

  console.log("SUCCESS: failed payment record stored correctly:");
  console.log(stored);
}

main();


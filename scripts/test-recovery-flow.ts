import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";
import { getFailedPaymentByWhopId, initSchema, insertFailedPayment } from "../src/db/schema";

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.TEST_SERVER_URL || `http://localhost:${PORT}`;
const SECRET = process.env.WHOP_WEBHOOK_SECRET;

/**
 * End-to-end test of the failed -> succeeded -> recovered flow:
 *
 * 1. Inserts a fake failed_payments row directly into SQLite with a known
 *    email/phone.
 * 2. Builds a real-shaped `payment.succeeded` payload referencing the same
 *    email/phone, signs it the same way the server verifies it (see
 *    src/webhooks/whopWebhook.ts — Whop's `ws_...` secret + manual
 *    HMAC-SHA256, NOT the `standardwebhooks`/svix library, which expects an
 *    incompatible `whsec_` base64 secret format and would produce a
 *    signature the server rejects), and POSTs it to the running server.
 * 3. Re-queries the failed_payments row and reports whether its status
 *    flipped to "recovered" and recovered_at was set.
 *
 * Usage: start the server (npm run dev), then in another terminal run
 * `npm run test:recovery-flow`.
 */
async function main(): Promise<void> {
  if (!SECRET) {
    console.error(
      "WHOP_WEBHOOK_SECRET is not set. Copy .env.example to .env and set a secret before running this script."
    );
    process.exit(1);
  }

  initSchema();

  const customerEmail = "recovery-flow-test@example.com";
  const customerPhone = "+15555550123";
  const whopPaymentId = `test_recovery_flow_${Date.now()}`;

  const failedPayment = insertFailedPayment({
    whopPaymentId,
    creatorAccountId: null,
    customerName: "Recovery Flow Test",
    customerEmail,
    customerPhone,
    amountDue: 29.99,
    currency: "usd",
    failureReason: "card_declined",
    recoveryLink: null,
    rawEvent: JSON.stringify({ type: "payment.failed", data: { id: whopPaymentId } }),
  });

  console.log("Inserted fake failed_payments row:");
  console.log(failedPayment);

  if (failedPayment.status !== "pending") {
    console.error(`FAILED: expected initial status "pending", got "${failedPayment.status}".`);
    process.exit(1);
  }

  const webhookId = `msg_${randomUUID()}`;
  const timestampSeconds = Math.floor(Date.now() / 1000);

  const succeededPayload = {
    id: webhookId,
    api_version: "v1",
    api_version_date: null,
    timestamp: new Date().toISOString(),
    type: "payment.succeeded",
    data: {
      id: `pay_${randomUUID()}`,
      company: { id: "acct_test_creator", route: "acct_test_creator", title: "Test Company" },
      customer_phone: customerPhone,
      user: { id: "user_test", name: "Recovery Flow Test", email: customerEmail },
    },
  };

  const rawBody = Buffer.from(JSON.stringify(succeededPayload), "utf8");

  // Same manual HMAC scheme the server verifies against (see
  // src/webhooks/whopWebhook.ts): HMAC-SHA256 over
  // `${webhook-id}.${webhook-timestamp}.${rawBody}` using the `ws_...`
  // secret string as-is as the key, base64-encoded.
  const signedContent = `${webhookId}.${timestampSeconds}.${rawBody.toString("utf8")}`;
  const signature = createHmac("sha256", SECRET).update(signedContent, "utf8").digest("base64");

  console.log(`\nSending simulated payment.succeeded webhook to ${BASE_URL}/webhooks/whop ...`);

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
    console.error("FAILED: payment.succeeded webhook was rejected by the server.");
    process.exit(1);
  }

  const updated = getFailedPaymentByWhopId(whopPaymentId);
  if (!updated) {
    console.error("FAILED: could not re-fetch the failed_payments row after the webhook.");
    process.exit(1);
  }

  console.log("\nfailed_payments row after payment.succeeded webhook:");
  console.log(updated);

  if (updated.status === "recovered" && updated.recovered_at) {
    console.log(
      `\nSUCCESS: status changed to "recovered" and recovered_at was set (${updated.recovered_at}).`
    );
  } else {
    console.error(
      `\nFAILED: expected status "recovered" with recovered_at set, got status="${updated.status}", recovered_at=${updated.recovered_at}.`
    );
    process.exit(1);
  }
}

main();

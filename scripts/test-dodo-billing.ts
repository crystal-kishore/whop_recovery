import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  getCreatorAccountByWhopId,
  initSchema,
  insertFailedPayment,
  recoverFailedPaymentsForCustomer,
  upsertCreatorAccount,
  type CreatorAccountRecord,
} from "../src/db/schema";
import { createPaymentMethodSetupSession } from "../src/billing/paymentMethodSetup";
import { billCreator } from "../src/billing/billingScheduler";

/**
 * Real end-to-end Dodo Payments commission-billing test, in two modes since
 * the "save a card" step needs a real browser + Dodo test card and can't be
 * fully API-automated:
 *
 *   setup  — creates a test creator_account + Dodo customer, starts a
 *            mandate-only checkout session, and prints the checkout URL to
 *            open in a browser.
 *   charge — inserts a fake recovered failed_payment for that same test
 *            creator and runs one real billing pass against their saved
 *            payment method, printing the resulting billing_log outcome.
 *
 * Setup before running:
 *   1. Create a Dodo Payments account (test mode) at
 *      https://app.dodopayments.com, then set DODO_PAYMENTS_API_KEY,
 *      DODO_PAYMENTS_WEBHOOK_KEY, and DODO_BILLING_PRODUCT_ID (any product,
 *      even a $0 placeholder — see .env.example) in .env.
 *   2. Set DODO_BILLING_RETURN_URL to your running dev server's public URL
 *      + /billing/dodo/return (e.g. your ngrok tunnel), and make sure the
 *      dev server (`npm run dev`) is running so that route can store the
 *      subscription id once you complete checkout.
 *
 * Usage:
 *   npx tsx scripts/test-dodo-billing.ts setup
 *   (open the printed checkout_url, pay with a Dodo test card, confirm
 *    "?billing=connected" in the dashboard redirect)
 *   npx tsx scripts/test-dodo-billing.ts charge
 */
const TEST_WHOP_ACCOUNT_ID = "test_dodo_billing_creator";
const TEST_CUSTOMER_EMAIL = "dodo-billing-test-customer@example.com";

function getOrCreateTestCreator(): CreatorAccountRecord {
  const existing = getCreatorAccountByWhopId(TEST_WHOP_ACCOUNT_ID);
  if (existing) return existing;

  return upsertCreatorAccount({
    whopAccountId: TEST_WHOP_ACCOUNT_ID,
    accessToken: "test_access_token",
    refreshToken: null,
    tokenType: null,
    expiresAt: null,
    name: "Dodo Billing Test Creator",
  });
}

async function runSetup(): Promise<void> {
  if (!process.env.DODO_PAYMENTS_API_KEY) {
    console.error("DODO_PAYMENTS_API_KEY is not set. Add it to .env before running this test.");
    process.exit(1);
  }
  if (!process.env.DODO_BILLING_PRODUCT_ID || !process.env.DODO_BILLING_RETURN_URL) {
    console.error(
      "DODO_BILLING_PRODUCT_ID and DODO_BILLING_RETURN_URL must be set in .env before running this test."
    );
    process.exit(1);
  }

  const creator = getOrCreateTestCreator();
  console.log(`Using test creator_account id=${creator.id} (whop_account_id=${TEST_WHOP_ACCOUNT_ID})`);

  const checkoutUrl = await createPaymentMethodSetupSession(creator);

  console.log("\nOpen this URL in a browser and pay with a Dodo test card to authorize the mandate:");
  console.log(checkoutUrl);
  console.log(
    `\nAfter completing checkout, Dodo will redirect to ${process.env.DODO_BILLING_RETURN_URL}` +
      "?subscription_id=...&status=...&email=..., which (with the dev server running) stores the" +
      " subscription id on this creator account. Then run:\n  npx tsx scripts/test-dodo-billing.ts charge"
  );
}

async function runCharge(): Promise<void> {
  const creator = getCreatorAccountByWhopId(TEST_WHOP_ACCOUNT_ID);
  if (!creator) {
    console.error('No test creator account found. Run "npx tsx scripts/test-dodo-billing.ts setup" first.');
    process.exit(1);
  }
  if (!creator.dodo_subscription_id) {
    console.error(
      "Test creator has no dodo_subscription_id yet -- complete the checkout flow from setup mode first."
    );
    process.exit(1);
  }

  const whopPaymentId = `test_dodo_billing_payment_${randomUUID()}`;
  const inserted = insertFailedPayment({
    whopPaymentId,
    creatorAccountId: creator.id,
    customerName: "Dodo Billing Test Customer",
    customerEmail: TEST_CUSTOMER_EMAIL,
    customerPhone: null,
    amountDue: 49.99,
    currency: "usd",
    failureReason: "card_declined",
    recoveryLink: "https://whop.com/recover/test-dodo-billing-e2e",
    rawEvent: JSON.stringify({ type: "payment.failed", test: true }),
  });
  console.log(`Inserted fake failed_payment id=${inserted.id} (amount_due=${inserted.amount_due})`);

  const recovered = recoverFailedPaymentsForCustomer({
    creatorAccountId: creator.id,
    customerEmail: TEST_CUSTOMER_EMAIL,
    customerPhone: null,
  });
  if (recovered.length === 0) {
    console.error("FAIL: expected the fake failed_payment to be marked recovered.");
    process.exit(1);
  }
  console.log(`Marked ${recovered.length} payment(s) recovered. Running billing cycle for this creator...`);

  await billCreator(creator);

  const expectedCommission = inserted.amount_due * creator.billing_rate;
  console.log(
    `PASS: billing cycle ran. Expected commission ~${expectedCommission.toFixed(2)} ${inserted.currency}` +
      ` (${Math.round(creator.billing_rate * 100)}% of ${inserted.amount_due}). Check the dashboard's` +
      " commission billing section, or the billing_log table, to confirm the charge succeeded."
  );
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "setup" && mode !== "charge") {
    console.error("Usage: npx tsx scripts/test-dodo-billing.ts <setup|charge>");
    process.exit(1);
  }

  initSchema();

  if (mode === "setup") {
    await runSetup();
  } else {
    await runCharge();
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

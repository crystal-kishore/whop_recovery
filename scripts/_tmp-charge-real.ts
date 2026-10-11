import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  getCreatorAccountByWhopId,
  initSchema,
  insertFailedPayment,
  recoverFailedPaymentsForCustomer,
} from "../src/db/schema";
import { billCreator } from "../src/billing/billingScheduler";

const REAL_WHOP_ACCOUNT_ID = "user_RhOJaVSmDQtor";
const TEST_CUSTOMER_EMAIL = "dodo-billing-real-test-customer@example.com";

async function main(): Promise<void> {
  initSchema();

  const creator = getCreatorAccountByWhopId(REAL_WHOP_ACCOUNT_ID);
  if (!creator) {
    console.error("Creator account not found.");
    process.exit(1);
  }
  if (!creator.dodo_subscription_id) {
    console.error("Creator has no dodo_subscription_id yet.");
    process.exit(1);
  }
  console.log(`Using creator id=${creator.id}, dodo_subscription_id=${creator.dodo_subscription_id}`);

  const whopPaymentId = `real_dodo_billing_payment_${randomUUID()}`;
  const inserted = insertFailedPayment({
    whopPaymentId,
    creatorAccountId: creator.id,
    customerName: "Dodo Billing Real Test Customer",
    customerEmail: TEST_CUSTOMER_EMAIL,
    customerPhone: null,
    amountDue: 49.99,
    currency: "usd",
    failureReason: "card_declined",
    recoveryLink: "https://whop.com/recover/real-dodo-billing-e2e",
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
  console.log(`Marked ${recovered.length} payment(s) recovered. Running billing cycle...`);

  await billCreator(creator);

  const expectedCommission = inserted.amount_due * creator.billing_rate;
  console.log(
    `PASS: billing cycle ran. Expected commission ~${expectedCommission.toFixed(2)} ${inserted.currency}` +
      ` (${Math.round(creator.billing_rate * 100)}% of ${inserted.amount_due}). Check billing_log for the outcome.`
  );
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

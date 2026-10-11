import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  createSession,
  initSchema,
  insertFailedPayment,
  upsertCreatorAccount,
  incrementReminderSent,
  recoverFailedPaymentsForCustomer,
} from "../src/db/schema";

async function main(): Promise<void> {
  initSchema();

  const whopAccountId = `acct_dashboard_test_${randomUUID()}`;
  const creatorAccount = upsertCreatorAccount({
    whopAccountId,
    accessToken: "fake_access_token",
    refreshToken: null,
    tokenType: "bearer",
    expiresAt: null,
    email: "creator@example.com",
    name: "Test Creator",
  });

  console.log(`Created creator_account id=${creatorAccount.id}`);

  // A pending failed payment reminded once via WhatsApp.
  const p1 = insertFailedPayment({
    whopPaymentId: `test_dashboard_${randomUUID()}`,
    creatorAccountId: creatorAccount.id,
    customerName: "Alex WhatsApp",
    customerEmail: "alex@example.com",
    customerPhone: "+15551110000",
    amountDue: 39.99,
    currency: "usd",
    failureReason: "card_declined",
    recoveryLink: null,
    rawEvent: JSON.stringify({ test: true }),
  });
  incrementReminderSent(p1.id, "whatsapp");

  // A pending failed payment reminded once via email.
  const p2 = insertFailedPayment({
    whopPaymentId: `test_dashboard_${randomUUID()}`,
    creatorAccountId: creatorAccount.id,
    customerName: "Jamie Email",
    customerEmail: "jamie@example.com",
    customerPhone: null,
    amountDue: 15,
    currency: "usd",
    failureReason: "card_declined",
    recoveryLink: null,
    rawEvent: JSON.stringify({ test: true }),
  });
  incrementReminderSent(p2.id, "email");

  // A recovered payment (to show up in the "total recovered" numbers).
  const p3 = insertFailedPayment({
    whopPaymentId: `test_dashboard_${randomUUID()}`,
    creatorAccountId: creatorAccount.id,
    customerName: "Sam Recovered",
    customerEmail: "sam@example.com",
    customerPhone: "+15552220000",
    amountDue: 99.5,
    currency: "usd",
    failureReason: "card_declined",
    recoveryLink: null,
    rawEvent: JSON.stringify({ test: true }),
  });
  recoverFailedPaymentsForCustomer({
    creatorAccountId: creatorAccount.id,
    customerEmail: p3.customer_email,
    customerPhone: p3.customer_phone,
  });

  const sessionToken = createSession(creatorAccount.id);
  console.log(`Session token: ${sessionToken}`);
  console.log(`\nRun this to view the connected dashboard:`);
  console.log(
    `Invoke-WebRequest -Uri http://localhost:3000/dashboard -Headers @{ Cookie = "session_token=${sessionToken}" } -UseBasicParsing | Select-Object -ExpandProperty Content`
  );
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getFailedPaymentById, initSchema, insertFailedPayment } from "../src/db/schema";
import { sendRecoveryMessage } from "../src/messaging/sendRecovery";
import type { EmailProvider, SendMessageResult } from "../src/messaging/types";

/**
 * Stand-in messaging provider for tests: records what would have been sent
 * instead of calling a real email API.
 */
class MockEmailProvider implements EmailProvider {
  public sentMessages: { to: string; subject: string; body: string }[] = [];

  async sendEmail(toEmail: string, subject: string, body: string): Promise<SendMessageResult> {
    this.sentMessages.push({ to: toEmail, subject, body });
    return { success: true, providerMessageId: `mock_${randomUUID()}` };
  }
}

async function main(): Promise<void> {
  initSchema();

  const whopPaymentId = `test_payment_${randomUUID()}`;
  const stored = insertFailedPayment({
    whopPaymentId,
    creatorAccountId: null,
    customerName: "Jamie Test",
    customerEmail: "jamie@example.com",
    customerPhone: null,
    amountDue: 29.99,
    currency: "usd",
    failureReason: "card_declined",
    recoveryLink: "https://whop.com/recover/test123",
    rawEvent: JSON.stringify({ type: "payment.failed", test: true }),
  });

  console.log(`Inserted fake failed_payment id=${stored.id} (whop_payment_id=${whopPaymentId})`);

  const mockProvider = new MockEmailProvider();
  const result = await sendRecoveryMessage(stored, { emailProvider: mockProvider });

  if (!result.success) {
    console.error("❌ sendRecoveryMessage reported failure:", result.error);
    process.exit(1);
  }

  if (mockProvider.sentMessages.length !== 1) {
    console.error(`❌ Expected exactly 1 mock message send, got ${mockProvider.sentMessages.length}`);
    process.exit(1);
  }

  const updated = getFailedPaymentById(stored.id);
  if (!updated || updated.reminder_count !== 1) {
    console.error("❌ Expected reminder_count to be 1 after sending, got:", updated?.reminder_count);
    process.exit(1);
  }

  console.log("✅ Mock email message triggered successfully:");
  console.log(`   To:      ${mockProvider.sentMessages[0].to}`);
  console.log(`   Subject: ${mockProvider.sentMessages[0].subject}`);
  console.log(`   Body:    ${mockProvider.sentMessages[0].body}`);
  console.log(`✅ reminder_count correctly incremented to ${updated.reminder_count}`);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

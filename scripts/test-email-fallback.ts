import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getFailedPaymentById, initSchema, insertFailedPayment } from "../src/db/schema";
import { sendRecoveryMessage } from "../src/messaging/sendRecovery";
import type { DiscordProvider, EmailProvider, SendMessageResult } from "../src/messaging/types";

/** Stand-in email provider: records sends instead of calling Resend. */
class MockEmailProvider implements EmailProvider {
  public sent: { to: string; subject: string; body: string }[] = [];

  async sendEmail(toEmail: string, subject: string, body: string): Promise<SendMessageResult> {
    this.sent.push({ to: toEmail, subject, body });
    return { success: true, providerMessageId: `mock_email_${randomUUID()}` };
  }
}
/** Stand-in Discord provider: records sends instead of calling the Discord API. */
class MockDiscordProvider implements DiscordProvider {
  public sent: { to: string; body: string }[] = [];

  async sendDiscordMessage(discordUserId: string, body: string): Promise<SendMessageResult> {
    this.sent.push({ to: discordUserId, body });
    return { success: true, providerMessageId: `mock_discord_${randomUUID()}` };
  }
}
async function main(): Promise<void> {
  initSchema();

  let failures = 0;

  // Case 0: customer has a discord_id (and also an email on file) -> should
  // route to Discord, since it's the primary channel.
  {
    const discordProvider = new MockDiscordProvider();
    const emailProvider = new MockEmailProvider();
    const stored = insertFailedPayment({
      whopPaymentId: `test_channel_discord_${randomUUID()}`,
      creatorAccountId: null,
      customerName: "Has Discord",
      customerEmail: "has-discord@example.com",
      customerPhone: null,
      discordId: "123456789012345678",
      amountDue: 15,
      currency: "usd",
      failureReason: "card_declined",
      recoveryLink: "https://whop.com/recover/test-discord",
      rawEvent: JSON.stringify({ type: "payment.failed", test: true }),
    });

    const result = await sendRecoveryMessage(stored, { discordProvider, emailProvider });
    const updated = getFailedPaymentById(stored.id);

    const ok =
      result.success &&
      result.channel === "discord" &&
      discordProvider.sent.length === 1 &&
      discordProvider.sent[0]?.to === "123456789012345678" &&
      emailProvider.sent.length === 0 &&
      updated?.reminder_count === 1;

    console.log(`[${ok ? "PASS" : "FAIL"}] Case 0: discord_id present -> routes to Discord (over email)`);
    if (!ok) {
      failures++;
      console.log("       detail:", {
        success: result.success,
        channel: result.channel,
        discordSends: discordProvider.sent.length,
        emailSends: emailProvider.sent.length,
        reminderCount: updated?.reminder_count,
      });
    }
  }

  // Case 1: customer has no discord_id but has an email -> should route to email.
  {
    const emailProvider = new MockEmailProvider();
    const stored = insertFailedPayment({
      whopPaymentId: `test_channel_email_${randomUUID()}`,
      creatorAccountId: null,
      customerName: "No Discord",
      customerEmail: "no-discord@example.com",
      customerPhone: null,
      amountDue: 24.5,
      currency: "usd",
      failureReason: "card_declined",
      recoveryLink: "https://whop.com/recover/test-email",
      rawEvent: JSON.stringify({ type: "payment.failed", test: true }),
    });

    const result = await sendRecoveryMessage(stored, { emailProvider });
    const updated = getFailedPaymentById(stored.id);

    const ok =
      result.success &&
      result.channel === "email" &&
      emailProvider.sent.length === 1 &&
      emailProvider.sent[0]?.to === "no-discord@example.com" &&
      updated?.reminder_count === 1;

    console.log(`[${ok ? "PASS" : "FAIL"}] Case 1: no discord_id, customer_email present -> routes to email`);
    if (!ok) {
      failures++;
      console.log("       detail:", {
        success: result.success,
        channel: result.channel,
        emailSends: emailProvider.sent.length,
        emailTo: emailProvider.sent[0]?.to,
        reminderCount: updated?.reminder_count,
      });
    }
  }

  // Case 2: customer has neither discord_id nor email -> should skip entirely, no send.
  {
    const emailProvider = new MockEmailProvider();
    const stored = insertFailedPayment({
      whopPaymentId: `test_channel_none_${randomUUID()}`,
      creatorAccountId: null,
      customerName: "No Contact Info",
      customerEmail: null,
      customerPhone: null,
      amountDue: 10,
      currency: "usd",
      failureReason: "card_declined",
      recoveryLink: null,
      rawEvent: JSON.stringify({ type: "payment.failed", test: true }),
    });

    const result = await sendRecoveryMessage(stored, { emailProvider });
    const updated = getFailedPaymentById(stored.id);

    const ok = !result.success && emailProvider.sent.length === 0 && updated?.reminder_count === 0;

    console.log(`[${ok ? "PASS" : "FAIL"}] Case 2: no discord_id and no email -> no send`);
    if (!ok) {
      failures++;
      console.log("       detail:", {
        success: result.success,
        emailSends: emailProvider.sent.length,
        reminderCount: updated?.reminder_count,
      });
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} case(s) failed.`);
    process.exit(1);
  }

  console.log("\nAll email fallback routing cases passed.");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

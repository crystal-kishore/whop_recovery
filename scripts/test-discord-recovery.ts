import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getFailedPaymentById, initSchema, insertFailedPayment } from "../src/db/schema";
import { sendRecoveryMessage } from "../src/messaging/sendRecovery";

/**
 * Real end-to-end Discord recovery test: simulates a failed_payments record
 * with a real discord_id and confirms sendRecoveryMessage() delivers an
 * actual DM via the configured Discord bot (DISCORD_BOT_TOKEN).
 *
 * Unlike test-email-fallback.ts (mocked providers, safe to run anytime),
 * this script hits the real Discord API -- deliberately, since Discord (and
 * email) sends don't consume the limited Twilio WhatsApp test quota.
 *
 * Setup before running:
 *   1. Create a Discord application + bot at
 *      https://discord.com/developers/applications, copy its token into
 *      DISCORD_BOT_TOKEN in .env.
 *   2. Invite the bot to a test server using the OAuth2 URL Generator in
 *      the Discord Developer Portal: scopes "bot", permission
 *      "Send Messages" (View Channels helps too). Bots can only DM users
 *      they share a server with.
 *   3. Get your own Discord user id (already linked to your Whop account):
 *      enable Developer Mode in Discord (User Settings > Advanced), then
 *      right-click your name > "Copy User ID".
 *
 * Usage:
 *   npx tsx scripts/test-discord-recovery.ts <discordUserId>
 *   (or set TEST_DISCORD_USER_ID in the environment)
 */
async function main(): Promise<void> {
  const discordUserId = process.argv[2] || process.env.TEST_DISCORD_USER_ID;

  if (!discordUserId) {
    console.error(
      "Usage: npx tsx scripts/test-discord-recovery.ts <discordUserId>\n" +
        "(or set TEST_DISCORD_USER_ID in the environment)"
    );
    process.exit(1);
  }

  if (!process.env.DISCORD_BOT_TOKEN) {
    console.error("DISCORD_BOT_TOKEN is not set. Add it to .env before running this test.");
    process.exit(1);
  }

  initSchema();

  const whopPaymentId = `test_discord_payment_${randomUUID()}`;
  const stored = insertFailedPayment({
    whopPaymentId,
    creatorAccountId: null,
    customerName: "Discord Test User",
    customerEmail: null,
    customerPhone: null,
    discordId: discordUserId,
    amountDue: 29.99,
    currency: "usd",
    failureReason: "card_declined",
    recoveryLink: "https://whop.com/recover/test-discord-e2e",
    rawEvent: JSON.stringify({ type: "payment.failed", test: true }),
  });

  console.log(`Inserted fake failed_payment id=${stored.id} (discord_id=${discordUserId})`);

  const result = await sendRecoveryMessage(stored);

  if (!result.success) {
    console.error("FAIL: sendRecoveryMessage did not succeed:", result.error);
    process.exit(1);
  }

  if (result.channel !== "discord") {
    console.error(`FAIL: expected channel "discord", got "${result.channel}".`);
    process.exit(1);
  }

  const updated = getFailedPaymentById(stored.id);
  console.log("PASS: Discord DM sent.", {
    providerMessageId: result.providerMessageId,
    reminderCount: updated?.reminder_count,
    lastChannel: updated?.last_channel,
  });
  console.log("Check the recipient's Discord DMs to confirm the message content (amount + manage_url).");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

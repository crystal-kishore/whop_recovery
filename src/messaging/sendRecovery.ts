import { incrementReminderSent, type FailedPaymentRecord } from "../db/schema";
import { composeRecoveryEmailSubject, composeRecoveryMessage } from "./composeMessage";
import { getDiscordProvider, getEmailProvider } from "./provider";
import type { DiscordProvider, EmailProvider, SendMessageResult } from "./types";

export interface SendRecoveryMessageOptions {
  /** Injectable for tests; defaults to the configured production Discord provider. */
  discordProvider?: DiscordProvider;
  /** Injectable for tests; defaults to the configured production email provider. */
  emailProvider?: EmailProvider;
  companyName?: string;
}

/**
 * Sends (or re-sends) a recovery message for a failed payment and records
 * the send by incrementing the record's reminder_count. Caps out at 3 total
 * messages per failed payment (the initial notification plus two
 * follow-ups).
 *
 * Channel selection (priority order): Discord DM is used whenever the
 * customer has a linked Discord id on file — the primary channel, since
 * Whop requires customers in paid Discord communities to link their
 * Discord account, making this far more reliably available than a phone
 * number for that audience. Email (via Resend) is the fallback when no
 * Discord id is available. WhatsApp/Twilio is intentionally not used as a
 * channel (product decision). Both channels share the same
 * reminder_count/last_reminder_at tracking and 24h/72h scheduling — there's
 * no separate cap or schedule per channel.
 */
export async function sendRecoveryMessage(
  payment: FailedPaymentRecord,
  options: SendRecoveryMessageOptions = {}
): Promise<SendMessageResult> {
  const channel: "discord" | "email" | null = payment.discord_id
    ? "discord"
    : payment.customer_email
      ? "email"
      : null;

  if (!channel) {
    console.warn(
      `[sendRecovery] Failed payment ${payment.id} has no discord_id or customer_email; skipping.`
    );
    return { success: false, error: "No Discord id or email on file." };
  }

  if (payment.reminder_count >= 3) {
    console.warn(
      `[sendRecovery] Failed payment ${payment.id} already received 3 reminders; skipping.`
    );
    return { success: false, error: "Maximum reminder count reached." };
  }

  const reminderNumber = (payment.reminder_count + 1) as 1 | 2 | 3;
  const body = composeRecoveryMessage(payment, reminderNumber, options.companyName);

  let result: SendMessageResult;
  if (channel === "discord") {
    const provider = options.discordProvider ?? getDiscordProvider();
    result = await provider.sendDiscordMessage(payment.discord_id as string, body);
  } else {
    const emailProvider = options.emailProvider ?? getEmailProvider();
    const subject = composeRecoveryEmailSubject(payment, reminderNumber, options.companyName);
    result = await emailProvider.sendEmail(payment.customer_email as string, subject, body);
  }
  result.channel = channel;

  const destination = channel === "discord" ? payment.discord_id : payment.customer_email;
  if (result.success) {
    console.log(
      `[sendRecovery] Sent reminder #${reminderNumber} for payment ${payment.id} via ${channel} (${destination}).`
    );
    incrementReminderSent(payment.id, channel);
  } else {
    console.error(
      `[sendRecovery] Failed to send ${channel} message for payment ${payment.id} (${destination}):`,
      result.error
    );
  }

  return result;
}



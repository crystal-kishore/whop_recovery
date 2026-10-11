export interface SendMessageResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
  /** Which channel actually handled the send; set by sendRecoveryMessage. */
  channel?: "discord" | "whatsapp" | "email";
}

/**
 * Abstraction over the transactional email provider used as a fallback
 * channel for customers with no phone number on file. Same pattern as
 * `MessagingProvider` so the underlying provider (Resend, SendGrid, etc.)
 * can be swapped without touching the recovery-messaging logic.
 */
export interface EmailProvider {
  sendEmail(toEmail: string, subject: string, body: string): Promise<SendMessageResult>;
}

/**
 * Abstraction over the Discord messaging provider — the primary recovery
 * channel, since Whop requires customers in paid Discord communities to
 * link their Discord account, making a Discord id far more reliably
 * available than a phone number. Same pattern as `MessagingProvider` /
 * `EmailProvider` so the underlying implementation (discord.js bot today)
 * can be swapped without touching the recovery-messaging logic.
 */
export interface DiscordProvider {
  sendDiscordMessage(discordUserId: string, body: string): Promise<SendMessageResult>;
}

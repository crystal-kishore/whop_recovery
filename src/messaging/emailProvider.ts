import { Resend } from "resend";
import type { EmailProvider, SendMessageResult } from "./types";

/**
 * Sends recovery emails via Resend (https://resend.com). Chosen over
 * SendGrid for its simpler free-tier setup — no sender domain verification
 * is required to get started, since Resend provides a shared
 * "onboarding@resend.dev" sender for testing/low-volume use out of the box.
 *
 * Requires RESEND_API_KEY to be set. RESEND_FROM_EMAIL is optional and
 * defaults to the shared test sender.
 */
export class ResendEmailProvider implements EmailProvider {
  private readonly client: Resend;
  private readonly fromAddress: string;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;

    if (!apiKey) {
      throw new Error("Resend email is not configured. Set RESEND_API_KEY.");
    }

    this.client = new Resend(apiKey);
    this.fromAddress = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
  }

  async sendEmail(toEmail: string, subject: string, body: string): Promise<SendMessageResult> {
    try {
      const { data, error } = await this.client.emails.send({
        from: this.fromAddress,
        to: toEmail,
        subject,
        text: body,
      });

      if (error) {
        return { success: false, error: error.message ?? String(error) };
      }

      return { success: true, providerMessageId: data?.id };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}

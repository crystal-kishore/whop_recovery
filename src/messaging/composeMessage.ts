import type { FailedPaymentRecord } from "../db/schema";

const DEFAULT_COMPANY_NAME = "the team";

function formatAmount(amountDue: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amountDue);
  } catch {
    return `${amountDue.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/**
 * Builds the casual-tone WhatsApp message body for a recovery reminder.
 * Tone gets slightly more direct with each successive reminder.
 */
export function composeRecoveryMessage(
  payment: FailedPaymentRecord,
  reminderNumber: 1 | 2 | 3,
  companyName?: string,
  productName?: string
): string {
  const name = payment.customer_name?.trim() || "there";
  const company =
    companyName?.trim() || payment.company_name?.trim() || process.env.DEFAULT_COMPANY_NAME || DEFAULT_COMPANY_NAME;
  const product = productName?.trim() || payment.product_name?.trim() || null;
  // e.g. " for your GitHub Coding Community membership" -- omitted entirely
  // when the product title couldn't be resolved, so the sentence still reads
  // naturally without a placeholder.
  const productPhrase = product ? ` for your ${product} membership` : "";
  const amount = formatAmount(payment.amount_due, payment.currency);
  const linkLine = payment.recovery_link
    ? `\n\nYou can update your payment here: ${payment.recovery_link}`
    : "";

  if (reminderNumber === 1) {
    return (
      `Hey ${name}! 👋 This is ${company} — we tried to charge your card for ${amount}${productPhrase} but it ` +
      `didn't go through. No worries, it happens! Just wanted to give you a heads up.${linkLine}`
    );
  }

  if (reminderNumber === 2) {
    return (
      `Hey ${name}, quick reminder from ${company} 🙂 Your payment of ${amount}${productPhrase} is still ` +
      `pending — mind updating it when you get a chance so you don't lose access?${linkLine}`
    );
  }

  return (
    `Hi ${name}, this is our last reminder from ${company} about your ${amount} payment${productPhrase}. ` +
    `We'd hate for you to lose access — update it whenever you're ready.${linkLine}`
  );
}

/**
 * Builds the subject line for a recovery email. Kept separate from the
 * (channel-agnostic) message body so the same casual-tone body text can be
 * reused for both WhatsApp and email sends.
 */
export function composeRecoveryEmailSubject(
  payment: FailedPaymentRecord,
  reminderNumber: 1 | 2 | 3,
  companyName?: string,
  productName?: string
): string {
  const company =
    companyName?.trim() || payment.company_name?.trim() || process.env.DEFAULT_COMPANY_NAME || DEFAULT_COMPANY_NAME;
  const product = productName?.trim() || payment.product_name?.trim() || null;
  const productSuffix = product ? ` for ${product}` : "";
  const amount = formatAmount(payment.amount_due, payment.currency);

  if (reminderNumber === 1) {
    return `${company}: your ${amount} payment${productSuffix} didn't go through`;
  }

  if (reminderNumber === 2) {
    return `Reminder: your ${amount} payment to ${company}${productSuffix} is still pending`;
  }

  return `Last reminder: your ${amount} payment to ${company}${productSuffix} is still pending`;
}

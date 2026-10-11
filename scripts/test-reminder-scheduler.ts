import "dotenv/config";
import { randomUUID } from "node:crypto";
import { db, initSchema, insertFailedPayment, type FailedPaymentRecord } from "../src/db/schema";
import { checkAndSendDueReminders } from "../src/scheduler/reminderScheduler";
import type { EmailProvider, SendMessageResult } from "../src/messaging/types";

/**
 * Stand-in messaging provider for tests: records what would have been sent
 * instead of calling a real email API.
 */
class MockEmailProvider implements EmailProvider {
  public sentTo: string[] = [];

  async sendEmail(toEmail: string, _subject: string, _body: string): Promise<SendMessageResult> {
    this.sentTo.push(toEmail);
    return { success: true, providerMessageId: `mock_${randomUUID()}` };
  }
}

/**
 * Inserts a fake failed_payment row, then backdates `created_at` (which is
 * what `getFailedPaymentsDueForReminder` actually keys its 24h/72h due
 * check on) and `last_reminder_at` to `hoursAgo` in the past, and sets
 * `reminder_count` directly. `insertFailedPayment` doesn't expose these as
 * parameters (they're meant to be set by real send/webhook events), so this
 * uses the raw `db` handle to simulate "time has passed" for testing.
 */
function insertBackdatedFailedPayment(
  customerEmail: string,
  hoursAgo: number,
  reminderCount: number
): FailedPaymentRecord {
  const whopPaymentId = `test_reminder_${randomUUID()}`;

  const stored = insertFailedPayment({
    whopPaymentId,
    creatorAccountId: null,
    customerName: "Reminder Scheduler Test",
    customerEmail,
    customerPhone: null,
    amountDue: 19.99,
    currency: "usd",
    failureReason: "card_declined",
    recoveryLink: null,
    rawEvent: JSON.stringify({ type: "payment.failed", test: true }),
  });

  db.prepare(
    `UPDATE failed_payments
     SET created_at = datetime('now', ?),
         last_reminder_at = datetime('now', ?),
         reminder_count = ?
     WHERE id = ?`
  ).run(`-${hoursAgo} hours`, `-${hoursAgo} hours`, reminderCount, stored.id);

  const updated = db.prepare("SELECT * FROM failed_payments WHERE id = ?").get(stored.id) as FailedPaymentRecord;
  return updated;
}

interface CaseResult {
  label: string;
  pass: boolean;
  detail: string;
}

async function runCase(
  label: string,
  hoursAgo: number,
  reminderCount: number,
  expectSend: boolean
): Promise<CaseResult> {
  const email = `reminder-scheduler-test-${randomUUID()}@example.com`;
  const before = insertBackdatedFailedPayment(email, hoursAgo, reminderCount);
  const provider = new MockEmailProvider();

  const due = await checkAndSendDueReminders({ emailProvider: provider });

  const wasPickedUp = due.some((p) => p.id === before.id);
  const wasSentTo = provider.sentTo.includes(email);
  const after = db.prepare("SELECT * FROM failed_payments WHERE id = ?").get(before.id) as FailedPaymentRecord;

  if (expectSend) {
    const pass = wasPickedUp && wasSentTo && after.reminder_count === reminderCount + 1;
    return {
      label,
      pass,
      detail: pass
        ? `picked up as due, mock send fired, reminder_count ${reminderCount} -> ${after.reminder_count}`
        : `expected due+sent+increment, got pickedUp=${wasPickedUp} sent=${wasSentTo} reminder_count=${after.reminder_count}`,
    };
  }

  const pass = !wasPickedUp && !wasSentTo && after.reminder_count === reminderCount;
  return {
    label,
    pass,
    detail: pass
      ? `correctly NOT picked up (reminder cap respected), reminder_count stayed ${after.reminder_count}`
      : `expected no pickup/send, got pickedUp=${wasPickedUp} sent=${wasSentTo} reminder_count=${after.reminder_count}`,
  };
}

/**
 * Exercises `checkAndSendDueReminders` (the same function
 * `startReminderScheduler`'s cron job calls) directly against three
 * backdated failed_payments rows, using a mock email provider so no real
 * Resend call is made.
 *
 * Usage: `npm run test:reminder-scheduler` (server does not need to be
 * running; this calls the scheduler logic in-process against the same
 * SQLite database).
 */
async function main(): Promise<void> {
  initSchema();

  const results: CaseResult[] = [];

  results.push(
    await runCase("Case 1: 25h old, reminder_count=1 -> expect 2nd reminder fires", 25, 1, true)
  );
  results.push(
    await runCase("Case 2: 73h old, reminder_count=2 -> expect 3rd (final) reminder fires", 73, 2, true)
  );
  results.push(
    await runCase("Case 3: 73h old, reminder_count=3 -> expect NO further reminder (cap respected)", 73, 3, false)
  );

  console.log("\n=== Reminder scheduler test results ===");
  let allPassed = true;
  for (const result of results) {
    const status = result.pass ? "PASS" : "FAIL";
    console.log(`[${status}] ${result.label}\n       ${result.detail}`);
    if (!result.pass) allPassed = false;
  }

  if (!allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

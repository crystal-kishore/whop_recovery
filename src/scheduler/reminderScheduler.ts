import cron, { type ScheduledTask } from "node-cron";
import { getFailedPaymentsDueForReminder, type FailedPaymentRecord } from "../db/schema";
import { sendRecoveryMessage, type SendRecoveryMessageOptions } from "../messaging/sendRecovery";

// How often to check for due follow-up reminders. Runs every 15 minutes by
// default, which is frequent enough to hit the 24h/72h follow-up windows
// promptly without hammering the database.
const CHECK_SCHEDULE = process.env.REMINDER_CHECK_CRON || "*/15 * * * *";

let task: ScheduledTask | null = null;

/**
 * Queries for failed payments due their next 24h/72h follow-up reminder and
 * sends one for each. Extracted out of the cron callback so both the live
 * scheduler and test scripts can invoke the exact same due-check-and-send
 * logic directly (e.g. to test reminder timing/cap behavior without
 * waiting for node-cron to fire). Returns the records that were found due
 * (regardless of whether each individual send succeeded).
 */
export async function checkAndSendDueReminders(
  options: SendRecoveryMessageOptions = {}
): Promise<FailedPaymentRecord[]> {
  const due = getFailedPaymentsDueForReminder();

  for (const payment of due) {
    try {
      await sendRecoveryMessage(payment, options);
    } catch (err) {
      console.error(
        `[reminderScheduler] Failed to send reminder for payment ${payment.id}:`,
        (err as Error).message
      );
    }
  }

  return due;
}

/**
 * Starts the periodic job that sends 24h and 72h follow-up recovery
 * messages for failed payments that are still pending. Because eligibility
 * is re-queried from the database on every run (rather than relying on
 * per-record in-memory timers), marking a payment "recovered" automatically
 * cancels any pending reminders for it — there's nothing further to
 * schedule or clean up.
 */
export function startReminderScheduler(): void {
  if (task) return;

  task = cron.schedule(CHECK_SCHEDULE, async () => {
    try {
      await checkAndSendDueReminders();
    } catch (err) {
      console.error("[reminderScheduler] Failed to query due reminders:", (err as Error).message);
    }
  });

  console.log(`[reminderScheduler] Started (schedule: "${CHECK_SCHEDULE}")`);
}


/** Stops the scheduler. Mainly useful for tests/scripts that don't need it running. */
export function stopReminderScheduler(): void {
  task?.stop();
  task = null;
}

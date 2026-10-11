import cron, { type ScheduledTask } from "node-cron";
import {
  getCreatorAccountsWithDodoSubscription,
  getUnbilledRecoveredPayments,
  insertBillingLog,
  markFailedPaymentsBilled,
  type CreatorAccountRecord,
} from "../db/schema";
import { getDodoClient } from "./dodoClient";
import { APIError } from "dodopayments";

// How often to run the commission-billing job. Defaults to weekly, every
// Sunday at midnight -- frequent enough that creators see recognizable,
// dated charges without nickel-and-diming them per-recovery.
const CHECK_SCHEDULE = process.env.BILLING_CHECK_CRON || "0 0 * * 0";

// Dodo doesn't retry a failed on-demand charge for us (unlike its own
// subscription renewals), so we own the retry policy: a handful of
// exponential-backoff attempts, skipping decline codes that mean retrying
// is pointless (the card/account itself was rejected, not a transient
// processor error).
const MAX_CHARGE_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2000;
const HARD_DECLINE_CODES = new Set([
  "DO_NOT_HONOR",
  "STOLEN_CARD",
  "LOST_CARD",
  "PICKUP_CARD",
  "FRAUDULENT",
  "AUTHENTICATION_FAILURE",
]);

let task: ScheduledTask | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHardDecline(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  const code = (err.error as { code?: string } | undefined)?.code;
  return typeof code === "string" && HARD_DECLINE_CODES.has(code);
}

/**
 * Charges a creator's on-demand subscription for a commission amount, with
 * a small exponential-backoff retry policy for transient failures. Skips
 * retrying immediately on a recognized hard-decline code (see
 * HARD_DECLINE_CODES) since another attempt won't succeed. Returns the
 * resulting `payment_id`; throws the last error if every attempt failed.
 */
async function chargeWithRetry(
  subscriptionId: string,
  amountInSmallestUnit: number,
  description: string
): Promise<string> {
  const client = getDodoClient();
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_CHARGE_ATTEMPTS; attempt++) {
    try {
      const response = await client.subscriptions.charge(subscriptionId, {
        product_price: amountInSmallestUnit,
        product_description: description,
      });
      return response.payment_id;
    } catch (err) {
      lastError = err;
      if (isHardDecline(err) || attempt === MAX_CHARGE_ATTEMPTS) {
        throw err;
      }
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}

/**
 * Bills a single creator's commission on the revenue their recovered
 * payments represent: sums the unbilled `failed_payments` rows still
 * awaiting commission, charges `billing_rate` (default 15%) of that total
 * against their saved Dodo payment method, and records the outcome either
 * way in `billing_log`. Recovered payments are only marked `billed` once
 * the charge actually succeeds, so a failed attempt leaves them eligible
 * for the next cycle instead of silently writing off the commission.
 */
export async function billCreator(creator: CreatorAccountRecord): Promise<void> {
  if (!creator.dodo_subscription_id) return;

  const unbilled = getUnbilledRecoveredPayments(creator.id);
  if (unbilled.length === 0) return;

  const currency = unbilled[0].currency || "usd";
  const totalRecovered = unbilled.reduce((sum, payment) => sum + payment.amount_due, 0);
  const commission = totalRecovered * creator.billing_rate;
  // Amounts in failed_payments are stored as decimal currency units (e.g.
  // dollars); Dodo's charge API expects the smallest unit (e.g. cents).
  const amountInSmallestUnit = Math.round(commission * 100);

  if (amountInSmallestUnit <= 0) {
    // Nothing meaningful to bill (e.g. billing_rate is 0) -- mark these
    // billed anyway so they aren't re-summed into every future cycle.
    markFailedPaymentsBilled(unbilled.map((payment) => payment.id));
    return;
  }

  const paymentIds = unbilled.map((payment) => payment.id);

  try {
    const dodoTransactionId = await chargeWithRetry(
      creator.dodo_subscription_id,
      amountInSmallestUnit,
      `Recovery commission (${unbilled.length} recovered payment${unbilled.length === 1 ? "" : "s"})`
    );

    insertBillingLog({
      creatorAccountId: creator.id,
      amountCharged: commission,
      currency,
      recoveredPaymentIds: paymentIds,
      status: "succeeded",
      dodoTransactionId,
    });
    markFailedPaymentsBilled(paymentIds);
  } catch (err) {
    console.error(`[billingScheduler] Failed to charge creator ${creator.id}:`, (err as Error).message);
    insertBillingLog({
      creatorAccountId: creator.id,
      amountCharged: commission,
      currency,
      recoveredPaymentIds: paymentIds,
      status: "failed",
      errorMessage: (err as Error).message,
    });
  }
}

/**
 * Runs one full commission-billing pass across every creator with a
 * connected Dodo payment method. Extracted out of the cron callback so
 * both the live scheduler and test scripts can invoke the exact same
 * bill-everyone logic directly.
 */
export async function runBillingCycle(): Promise<void> {
  const creators = getCreatorAccountsWithDodoSubscription();
  for (const creator of creators) {
    try {
      await billCreator(creator);
    } catch (err) {
      console.error(`[billingScheduler] Unexpected error billing creator ${creator.id}:`, (err as Error).message);
    }
  }
}

/** Starts the periodic job that bills creators commission on recovered revenue. Weekly by default. */
export function startBillingScheduler(): void {
  if (task) return;

  task = cron.schedule(CHECK_SCHEDULE, async () => {
    try {
      await runBillingCycle();
    } catch (err) {
      console.error("[billingScheduler] Failed to run billing cycle:", (err as Error).message);
    }
  });

  console.log(`[billingScheduler] Started (schedule: "${CHECK_SCHEDULE}")`);
}

/** Stops the scheduler. Mainly useful for tests/scripts that don't need it running. */
export function stopBillingScheduler(): void {
  task?.stop();
  task = null;
}

import DodoPayments from "dodopayments";

const DODO_PAYMENTS_API_KEY = process.env.DODO_PAYMENTS_API_KEY;
const DODO_PAYMENTS_ENVIRONMENT = (process.env.DODO_PAYMENTS_ENVIRONMENT || "test_mode") as
  | "test_mode"
  | "live_mode";

export class DodoNotConfiguredError extends Error {}

let cachedClient: DodoPayments | undefined;

/**
 * Returns the configured Dodo Payments API client (a singleton), used for
 * the *separate* commission-billing relationship we have with creators (not
 * to be confused with Whop, which is where their own customers pay). Throws
 * `DodoNotConfiguredError` if DODO_PAYMENTS_API_KEY hasn't been set yet, so
 * callers can surface a clear "billing isn't set up" error instead of the
 * SDK's own less-obvious failure.
 */
export function getDodoClient(): DodoPayments {
  if (!DODO_PAYMENTS_API_KEY) {
    throw new DodoNotConfiguredError(
      "DODO_PAYMENTS_API_KEY is not configured. Commission billing is disabled until it's set."
    );
  }

  if (!cachedClient) {
    cachedClient = new DodoPayments({
      bearerToken: DODO_PAYMENTS_API_KEY,
      environment: DODO_PAYMENTS_ENVIRONMENT,
      webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY ?? null,
    });
  }

  return cachedClient;
}

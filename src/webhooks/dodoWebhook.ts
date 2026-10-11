import type { Request, Response } from "express";
import { getCreatorAccountByDodoCustomerId, setDodoSubscriptionForCreator } from "../db/schema";
import { getDodoClient, DodoNotConfiguredError } from "../billing/dodoClient";

/**
 * POST /webhooks/dodo — verifies and processes Dodo Payments webhook
 * events for the commission-billing relationship. Unlike Whop's webhook
 * (which needed a manual HMAC implementation because its `ws_...` secret
 * isn't Standard-Webhooks-library-compatible), Dodo's secret is a
 * `whsec_...` base64 string the SDK's own `client.webhooks.unwrap()` helper
 * verifies directly, so no custom signature code is needed here.
 *
 * `subscription.active` is the authoritative confirmation that a creator's
 * mandate-only checkout succeeded and their card is now on file -- this is
 * a fallback/source of truth in case the `/billing/dodo/return` redirect
 * handler was missed (e.g. the browser tab was closed early). Other billing
 * events (`subscription.failed`, `subscription.on_hold`,
 * `subscription.cancelled`, `payment.succeeded`, `payment.failed` for the
 * commission charges themselves) are acknowledged but not yet acted on
 * beyond logging, since src/billing/billingScheduler.ts already records the
 * outcome of every charge it makes synchronously.
 */
export async function handleDodoWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = req.rawBody;
  if (!rawBody) {
    console.error("[dodoWebhook] Raw request body was not captured; check body parser setup.");
    res.status(500).json({ error: "Raw request body was not captured." });
    return;
  }

  let event: { type: string; data?: Record<string, unknown> };
  try {
    const client = getDodoClient();
    const unwrapped = client.webhooks.unwrap(rawBody.toString("utf8"), {
      headers: req.headers as Record<string, string>,
    });
    event = unwrapped as unknown as { type: string; data?: Record<string, unknown> };
  } catch (err) {
    if (err instanceof DodoNotConfiguredError) {
      console.error("[dodoWebhook] Dodo billing is not configured:", err.message);
      res.status(500).json({ error: "Billing is not configured." });
      return;
    }
    console.error("[dodoWebhook] Webhook verification failed:", (err as Error).message);
    res.status(401).json({ error: "Invalid webhook signature." });
    return;
  }

  try {
    switch (event.type) {
      case "subscription.active": {
        const data = event.data as
          | { subscription_id?: string; customer?: { customer_id?: string } }
          | undefined;
        const subscriptionId = data?.subscription_id;
        const dodoCustomerId = data?.customer?.customer_id;

        if (subscriptionId && dodoCustomerId) {
          const creatorAccount = getCreatorAccountByDodoCustomerId(dodoCustomerId);
          if (creatorAccount) {
            setDodoSubscriptionForCreator(creatorAccount.id, subscriptionId);
          } else {
            console.error(
              `[dodoWebhook] subscription.active for unknown Dodo customer ${dodoCustomerId}.`
            );
          }
        }
        break;
      }
      default:
        // Acknowledged but not acted on -- see docstring above.
        break;
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[dodoWebhook] Failed to process ${event.type} event:`, (err as Error).message);
    res.status(500).json({ error: "Failed to process webhook event." });
  }
}

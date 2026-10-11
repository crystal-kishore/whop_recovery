import type { Request, Response } from "express";
import {
  getCreatorAccountBySessionToken,
  setDodoCustomerForCreator,
  setDodoSubscriptionForCreator,
  type CreatorAccountRecord,
} from "../db/schema";
import { getDodoClient } from "./dodoClient";

const DODO_BILLING_PRODUCT_ID = process.env.DODO_BILLING_PRODUCT_ID;
const DODO_BILLING_RETURN_URL = process.env.DODO_BILLING_RETURN_URL;

export class BillingSetupError extends Error {}

function assertBillingConfigured(): void {
  if (!DODO_BILLING_PRODUCT_ID || !DODO_BILLING_RETURN_URL) {
    throw new BillingSetupError(
      "Commission billing is not configured. Set DODO_BILLING_PRODUCT_ID and DODO_BILLING_RETURN_URL."
    );
  }
}

/**
 * Returns the Dodo customer id representing this creator in our commission
 * billing relationship, creating one via the Dodo API on first use. Unlike
 * the on-demand subscription (created per "connect payment method"
 * attempt), a creator only ever needs one Dodo customer id, so this is
 * cached on the creator_accounts row.
 */
export async function ensureDodoCustomerForCreator(
  creatorAccount: CreatorAccountRecord
): Promise<string> {
  if (creatorAccount.dodo_customer_id) {
    return creatorAccount.dodo_customer_id;
  }

  const client = getDodoClient();
  // creator_accounts has no verified contact email on file (Whop's OAuth
  // scope we use doesn't expose one) -- Dodo requires an email to create a
  // customer, so we synthesize a stable, non-deliverable placeholder from
  // the Whop account id. It's only ever used as a Dodo-side identifier;
  // real payment failure/receipt emails always go to Dodo's own dashboard,
  // not this address.
  const email = `${creatorAccount.whop_account_id}@creators.whop-recovery.invalid`;

  const customer = await client.customers.create({
    email,
    name: creatorAccount.whop_company_name || creatorAccount.whop_account_id,
  });

  setDodoCustomerForCreator(creatorAccount.id, customer.customer_id);
  return customer.customer_id;
}

/**
 * Creates a Dodo "mandate only" checkout session -- Dodo's on-demand
 * subscription mechanism for saving a card without charging it -- and
 * returns the hosted checkout URL to redirect the creator to. Requires
 * DODO_BILLING_PRODUCT_ID (a placeholder product used only to authorize the
 * checkout flow; see .env.example) since Dodo checkout sessions always
 * require at least one product in the cart, even mandate-only ones.
 */
export async function createPaymentMethodSetupSession(
  creatorAccount: CreatorAccountRecord
): Promise<string> {
  assertBillingConfigured();
  const client = getDodoClient();
  const dodoCustomerId = await ensureDodoCustomerForCreator(creatorAccount);

  const session = await client.checkoutSessions.create({
    product_cart: [{ product_id: DODO_BILLING_PRODUCT_ID as string, quantity: 1 }],
    customer: { customer_id: dodoCustomerId },
    return_url: DODO_BILLING_RETURN_URL,
    // Restrict to card payment methods. Local/regional rails like UPI
    // require a real customer approval step and can leave test-mode
    // payments stuck in "processing" indefinitely, which then blocks all
    // future on-demand charges against the subscription with a 409.
    allowed_payment_method_types: ["credit", "debit"],
    // Force a US billing address (and prevent the customer from changing
    // it) so the checkout doesn't auto-detect the creator's actual
    // location and route the card through country-specific compliance
    // rules (e.g. India's RBI e-mandate requirements), which this Dodo
    // merchant isn't enabled for and causes card charges to fail outright.
    // This is just an internal authorization for our own commission
    // billing, not a purchase by the creator, so the billing country here
    // is unrelated to where the creator actually lives.
    billing_address: { country: "US" },
    feature_flags: {
      allow_customer_editing_country: false,
    },
    subscription_data: {
      on_demand: {
        mandate_only: true,
      },
    },
  });

  if (!session.checkout_url) {
    throw new BillingSetupError("Dodo did not return a checkout URL for the mandate session.");
  }

  return session.checkout_url;
}

/**
 * GET /billing/dodo/connect — starts the "connect payment method" flow for
 * the logged-in creator. Unlike the Discord bot-invite flow, Dodo's
 * checkout `return_url` redirect lands back in the same browser tab where
 * the dashboard session cookie is already set, so no CSRF state map is
 * needed here -- both this handler and the return handler simply gate on
 * `session_token`.
 */
export async function dodoConnectHandler(req: Request, res: Response): Promise<void> {
  const sessionToken = req.cookies?.session_token as string | undefined;
  const creatorAccount = sessionToken ? getCreatorAccountBySessionToken(sessionToken) : null;

  if (!creatorAccount) {
    res.status(401).json({ error: "Connect your Whop account first." });
    return;
  }

  try {
    const checkoutUrl = await createPaymentMethodSetupSession(creatorAccount);
    res.redirect(checkoutUrl);
  } catch (err) {
    console.error("[paymentMethodSetup] Failed to start Dodo checkout session:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
}

/**
 * GET /billing/dodo/return — Dodo redirects here after the creator
 * approves (or cancels) the mandate on the hosted checkout page, with
 * `subscription_id` and `status` query params appended (no `customer_id`,
 * which is why we create/track the Dodo customer proactively above). Stores
 * the subscription id immediately as a best-effort; the `subscription.active`
 * webhook handler is the authoritative source in case this redirect is
 * missed (e.g. the tab was closed before it completed).
 */
export function dodoReturnHandler(req: Request, res: Response): void {
  const sessionToken = req.cookies?.session_token as string | undefined;
  const creatorAccount = sessionToken ? getCreatorAccountBySessionToken(sessionToken) : null;

  if (!creatorAccount) {
    res.status(401).json({ error: "Connect your Whop account first." });
    return;
  }

  const { subscription_id: subscriptionId, status } = req.query;

  if (typeof subscriptionId !== "string" || !subscriptionId) {
    console.error("[paymentMethodSetup] Dodo return is missing subscription_id; mandate likely cancelled.");
    res.redirect("/dashboard?billing=cancelled");
    return;
  }

  try {
    setDodoSubscriptionForCreator(creatorAccount.id, subscriptionId);
    console.log(`[paymentMethodSetup] Creator ${creatorAccount.id} mandate return status: ${status}`);
    res.redirect("/dashboard?billing=connected");
  } catch (err) {
    console.error("[paymentMethodSetup] Failed to store Dodo subscription id:", (err as Error).message);
    res.status(500).json({ error: "Failed to record payment method connection." });
  }
}

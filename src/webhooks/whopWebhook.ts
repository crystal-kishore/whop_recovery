import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import {
  getCreatorAccountByCompanyId,
  insertFailedPayment,
  recoverFailedPaymentsForCustomer,
} from "../db/schema";
import { sendRecoveryMessage } from "../messaging/sendRecovery";

const WEBHOOK_SIGNING_SECRET = process.env.WHOP_WEBHOOK_SECRET;

// Reject requests whose webhook-timestamp is further than this from now, to
// prevent replay attacks (matches Whop's documented 5 minute tolerance).
const MAX_TIMESTAMP_DRIFT_SECONDS = 5 * 60;

export class WhopWebhookError extends Error {}
export class WebhookVerificationError extends Error {}

/**
 * Verifies and parses an incoming Whop webhook request.
 *
 * Whop webhooks follow the Standard Webhooks header format (`webhook-id`,
 * `webhook-timestamp`, `webhook-signature: v1,<base64>`), but the signing
 * secret Whop issues (a `ws_<hex>` string, from the dashboard or
 * `POST /api/v1/webhooks`) is NOT the base64 `whsec_` format the generic
 * `standardwebhooks`/svix libraries expect — passing it to those libraries
 * fails verification. Whop's own SDK helper (`@whop/sdk/helpers`,
 * `unwrapWebhook`) isn't available in the currently installed SDK version,
 * so this implements Whop's documented "Verify without an SDK" scheme
 * directly: HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${rawBody}`
 * using the `ws_...` secret string as-is as the HMAC key, base64-encoded,
 * compared against the `webhook-signature` header in constant time.
 * (See https://docs.whop.com/webhooks)
 *
 * Throws `WebhookVerificationError` if the signature or timestamp is
 * invalid, or `WhopWebhookError` if the secret isn't configured.
 */
export function verifyAndParseWhopWebhook(rawBody: Buffer, headers: Record<string, string>): unknown {
  if (!WEBHOOK_SIGNING_SECRET) {
    throw new WhopWebhookError("WHOP_WEBHOOK_SECRET is not configured.");
  }

  const webhookId = headers["webhook-id"];
  const webhookTimestamp = headers["webhook-timestamp"];
  const webhookSignatureHeader = headers["webhook-signature"];

  if (!webhookId || !webhookTimestamp || !webhookSignatureHeader) {
    throw new WebhookVerificationError("Missing required webhook signature headers.");
  }

  const timestampSeconds = Number(webhookTimestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > MAX_TIMESTAMP_DRIFT_SECONDS) {
    throw new WebhookVerificationError("Webhook timestamp is too old or too far in the future.");
  }

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody.toString("utf8")}`;
  const expectedSignature = createHmac("sha256", WEBHOOK_SIGNING_SECRET).update(signedContent, "utf8").digest();

  // The header may contain multiple space-separated "v1,<base64>" values;
  // accept if any of them match.
  const providedSignatures = webhookSignatureHeader
    .split(" ")
    .map((entry) => entry.split(",")[1])
    .filter((sig): sig is string => Boolean(sig));

  const isValid = providedSignatures.some((sig) => {
    let sigBuffer: Buffer;
    try {
      sigBuffer = Buffer.from(sig, "base64");
    } catch {
      return false;
    }
    return sigBuffer.length === expectedSignature.length && timingSafeEqual(sigBuffer, expectedSignature);
  });

  if (!isValid) {
    throw new WebhookVerificationError("Invalid webhook signature.");
  }

  return JSON.parse(rawBody.toString("utf8"));
}


/**
 * Shape of Whop's real `payment.failed` event `data` (the full Payment
 * resource), confirmed against a live webhook delivery. This differs
 * substantially from the Standard Webhooks "guessed" shape originally coded
 * against: there's no flat `amount_due`/`customer`/`recovery_link`/
 * `whop_account_id` — instead amounts are on `total`/`subtotal`, the
 * customer is `user` (name/email) plus a separate `customer_phone` (or
 * `member.phone`/`membership.phone_number`), the failure text is
 * `failure_message`, and the account is `company.id`.
 *
 * `membership.id`: used to look up the real recovery link. Whop's Legacy
 * Membership resource (`GET /api/v1/memberships/{id}`, still fully
 * supported alongside the newer versioned API — see
 * docs.whop.com/api-reference/memberships/membership) carries a
 * `manage_url` field: "The URL where the customer can view and manage this
 * membership, including cancellation and plan changes." That's the real,
 * customer-specific billing portal link we want, fetched fresh per webhook
 * rather than constructed by hand from product/plan/membership ids (Whop
 * documents no such construction scheme).
 */
interface WhopPaymentFailedEvent {
  type: "payment.failed";
  data: {
    id: string;
    total?: number;
    subtotal?: number;
    recovery_url?: string | null;
    currency?: string;
    failure_message?: string;
    company?: { id?: string; title?: string };
    customer_phone?: string | null;
    member?: { phone?: string | null };
    membership?: { id?: string; phone_number?: string | null };
    user?: { id?: string; name?: string; email?: string };
  };
}

function isPaymentFailedEvent(payload: unknown): payload is WhopPaymentFailedEvent {
  if (typeof payload !== "object" || payload === null) return false;
  const candidate = payload as Record<string, unknown>;
  return (
    candidate.type === "payment.failed" &&
    typeof candidate.data === "object" &&
    candidate.data !== null &&
    typeof (candidate.data as Record<string, unknown>).id === "string"
  );
}

interface WhopPaymentSucceededEvent {
  type: "payment.succeeded";
  data: {
    id: string;
    company?: { id?: string; title?: string };
    customer_phone?: string | null;
    member?: { phone?: string | null };
    membership?: { phone_number?: string | null };
    user?: { id?: string; name?: string; email?: string };
  };
}

/**
 * Matches a payment.succeeded event's shape. Note: Whop's success event
 * isn't guaranteed to reference the id of a prior failed charge, so
 * `recoverFailedPaymentsForCustomer` correlates by customer email/phone
 * within the same creator account instead of by payment id.
 */
function isPaymentSucceededEvent(payload: unknown): payload is WhopPaymentSucceededEvent {
  if (typeof payload !== "object" || payload === null) return false;
  const candidate = payload as Record<string, unknown>;
  return (
    candidate.type === "payment.succeeded" &&
    typeof candidate.data === "object" &&
    candidate.data !== null &&
    typeof (candidate.data as Record<string, unknown>).id === "string"
  );
}

/** Picks the first available customer phone from the several places Whop may put it. */
function extractCustomerPhone(data: {
  customer_phone?: string | null;
  member?: { phone?: string | null };
  membership?: { phone_number?: string | null };
}): string | null {
  return data.customer_phone ?? data.member?.phone ?? data.membership?.phone_number ?? null;
}

const WHOP_API_BASE = "https://api.whop.com/api/v1";

/**
 * Fetches the real, customer-specific billing portal link (`manage_url`)
 * and the product/plan title (e.g. "GitHub Coding Community") for a
 * membership from Whop's Membership resource -- the product title lets
 * recovery messages tell the customer exactly which product/community the
 * payment is for, not just which creator. Never throws — logs the reason
 * and returns nulls if the membership id is missing, no creator access
 * token is available, or the request fails, so a lookup problem can never
 * crash webhook processing.
 */
async function fetchMembershipManageUrl(
  membershipId: string | null | undefined,
  accessToken: string | null | undefined
): Promise<{ manageUrl: string | null; productName: string | null }> {
  if (!membershipId) {
    console.error("[whopWebhook] Cannot fetch manage_url: payment event had no membership id.");
    return { manageUrl: null, productName: null };
  }
  if (!accessToken) {
    console.error(
      `[whopWebhook] Cannot fetch manage_url for membership ${membershipId}: no creator access token available.`
    );
    return { manageUrl: null, productName: null };
  }

  try {
    const response = await fetch(`${WHOP_API_BASE}/memberships/${membershipId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `[whopWebhook] Failed to fetch membership ${membershipId}: ${response.status} ${body}`
      );
      return { manageUrl: null, productName: null };
    }

    const membership = (await response.json()) as {
      manage_url?: string | null;
      product?: { title?: string | null } | null;
    };
    return {
      manageUrl: membership.manage_url ?? null,
      productName: membership.product?.title ?? null,
    };
  } catch (err) {
    console.error(`[whopWebhook] Error fetching membership ${membershipId}:`, (err as Error).message);
    return { manageUrl: null, productName: null };
  }
}

/**
 * Resolves a customer's linked Discord account id via Whop's Users API
 * (`GET /api/v1/users/{id}`, see docs.whop.com/api-reference/beta/users/user).
 * The response's `social_accounts` array lists every social account linked
 * to that user; Discord/X entries are included even when looking up
 * someone else's profile (Whop treats them as public), unlike email which
 * is self-view only. Each entry's `external_id` is the platform-specific
 * id -- for a `platform: "discord"` entry, that's the real Discord user
 * snowflake needed to open a DM, as opposed to `id`, which is a Whop-
 * internal social-account id (e.g. "discord_123...").
 *
 * Never throws -- logs the reason and returns `null` if the user id is
 * missing, no creator access token is available, the customer has no
 * linked Discord account, or the request fails, so a lookup problem can
 * never crash webhook processing (the customer just falls back to
 * WhatsApp/email).
 */
async function fetchDiscordId(
  userId: string | null | undefined,
  accessToken: string | null | undefined
): Promise<string | null> {
  if (!userId) {
    console.error("[whopWebhook] Cannot fetch discord_id: payment event had no user id.");
    return null;
  }
  if (!accessToken) {
    console.error(
      `[whopWebhook] Cannot fetch discord_id for user ${userId}: no creator access token available.`
    );
    return null;
  }

  try {
    const response = await fetch(`${WHOP_API_BASE}/users/${userId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[whopWebhook] Failed to fetch user ${userId}: ${response.status} ${body}`);
      return null;
    }

    const user = (await response.json()) as {
      social_accounts?: { platform?: string; external_id?: string | null }[];
    };
    const discordAccount = user.social_accounts?.find((account) => account.platform === "discord");
    return discordAccount?.external_id ?? null;
  } catch (err) {
    console.error(`[whopWebhook] Error fetching user ${userId}:`, (err as Error).message);
    return null;
  }
}

/** POST /webhooks/whop — verifies and processes Whop payment.failed events. */
export async function handleWhopWebhook(req: Request, res: Response): Promise<void> {
  // TEMP DEBUG: log the raw incoming request before signature verification
  // so real Whop-sent payloads can be compared against the local simulator.
  // Remove once real-webhook debugging is done.
  console.log("[whopWebhook][DEBUG] Incoming request headers:", JSON.stringify(req.headers, null, 2));
  console.log(
    "[whopWebhook][DEBUG] Incoming raw body:",
    req.rawBody ? req.rawBody.toString("utf8") : "<no rawBody captured>"
  );

  const rawBody = req.rawBody;
  if (!rawBody) {
    console.error("[whopWebhook] Raw request body was not captured; check body parser setup.");
    res.status(500).json({ error: "Raw request body was not captured." });
    return;
  }

  let payload: unknown;
  try {
    payload = verifyAndParseWhopWebhook(rawBody, req.headers as Record<string, string>);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      res.status(401).json({ error: "Invalid webhook signature." });
      return;
    }
    console.error("[whopWebhook] Signature verification error:", (err as Error).message);
    res.status(500).json({ error: "Webhook signature verification is not configured correctly." });
    return;
  }

  if (!isPaymentFailedEvent(payload)) {
    if (isPaymentSucceededEvent(payload)) {
      const { data } = payload;
      try {
        const creatorAccount = data.company?.id ? getCreatorAccountByCompanyId(data.company.id) : null;

        const recovered = recoverFailedPaymentsForCustomer({
          creatorAccountId: creatorAccount?.id ?? null,
          customerEmail: data.user?.email ?? null,
          customerPhone: extractCustomerPhone(data),
        });

        res.status(200).json({ received: true, recoveredCount: recovered.length });
      } catch (err) {
        console.error("[whopWebhook] Failed to process payment.succeeded event:", (err as Error).message);
        res.status(500).json({ error: "Failed to process payment.succeeded event." });
      }
      return;
    }

    // Not an event this endpoint handles — acknowledge so Whop doesn't keep
    // retrying, but don't process it further.
    res.status(200).json({ received: true, ignored: true });
    return;
  }

  const { data } = payload;

  try {
    const creatorAccount = data.company?.id ? getCreatorAccountByCompanyId(data.company.id) : null;

    const { manageUrl: recoveryLink, productName } = await fetchMembershipManageUrl(
      data.membership?.id,
      creatorAccount?.access_token
    );
    const discordId = await fetchDiscordId(data.user?.id, creatorAccount?.access_token);
    // Prefer the name captured from Whop's Accounts API at OAuth time (the
    // creator's actual business/community display name); fall back to
    // whatever the webhook payload itself provides, so recovery messages
    // still identify the community even for creators who connected before
    // this lookup existed or whose lookup failed.
    const companyName = creatorAccount?.whop_company_name ?? data.company?.title ?? null;

    const stored = insertFailedPayment({
      whopPaymentId: data.id,
      creatorAccountId: creatorAccount?.id ?? null,
      customerName: data.user?.name ?? null,
      customerEmail: data.user?.email ?? null,
      customerPhone: extractCustomerPhone(data),
      discordId,
      companyName,
      productName,
      amountDue: data.total ?? data.subtotal ?? 0,
      currency: data.currency ?? "usd",
      failureReason: data.failure_message ?? null,
      recoveryLink,
      rawEvent: rawBody.toString("utf8"),
    });

    res.status(200).json({ received: true, id: stored.id });

    // Fire the initial WhatsApp recovery message without blocking the
    // webhook acknowledgment. Errors are logged, not surfaced to Whop.
    void sendRecoveryMessage(stored).catch((err) => {
      console.error(
        `[whopWebhook] Failed to send recovery message for payment ${stored.id}:`,
        (err as Error).message
      );
    });
  } catch (err) {
    console.error("[whopWebhook] Failed to store failed payment:", (err as Error).message);
    res.status(500).json({ error: "Failed to store failed payment record." });
  }
}


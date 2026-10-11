import { createHash, randomBytes } from "node:crypto";
import type { Request, Response as ExpressResponse } from "express";
import { createSession, upsertCreatorAccount } from "../db/schema";

// Whop's real OAuth 2.1 + PKCE endpoints. These are fixed per Whop's API,
// unlike the app-specific client id/redirect URI below, so they aren't
// sourced from env vars. See https://docs.whop.com/developer/guides/oauth
const WHOP_AUTHORIZE_URL = "https://api.whop.com/oauth/authorize";
const WHOP_TOKEN_URL = "https://api.whop.com/oauth/token";
const WHOP_USERINFO_URL = "https://api.whop.com/oauth/userinfo";
const WHOP_API_BASE = "https://api.whop.com/api/v1";
// In addition to the OIDC claims (openid/profile/email), we must explicitly
// request the app-level permissions configured in the Whop Developer
// Dashboard (Permissions tab) -- that dashboard only declares which scopes
// the app is *allowed* to request; the OAuth `scope` param here is what
// actually grants them on the resulting access token.
const WHOP_OAUTH_SCOPE = "openid profile email member:basic:read company:balance:read";

const CLIENT_ID = process.env.WHOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOP_CLIENT_SECRET;
const REDIRECT_URI = process.env.WHOP_REDIRECT_URI;

// Whop's OAuth flow uses PKCE rather than a client secret. We generate a
// code_verifier per authorization attempt and stash it here (keyed by the
// CSRF `state` value) until the callback arrives to exchange the code.
// Entries expire after 10 minutes to avoid unbounded growth if a flow is
// abandoned.
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;
const pendingAuthorizations = new Map<string, { codeVerifier: string; createdAt: number }>();

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

function generateCodeChallenge(codeVerifier: string): string {
  return base64url(createHash("sha256").update(codeVerifier).digest());
}

function generateNonce(): string {
  return base64url(randomBytes(16));
}

function storePendingAuthorization(state: string, codeVerifier: string): void {
  const now = Date.now();
  for (const [key, value] of pendingAuthorizations) {
    if (now - value.createdAt > PENDING_AUTH_TTL_MS) {
      pendingAuthorizations.delete(key);
    }
  }
  pendingAuthorizations.set(state, { codeVerifier, createdAt: now });
}

function consumePendingAuthorization(state: string): string | undefined {
  const entry = pendingAuthorizations.get(state);
  pendingAuthorizations.delete(state);
  if (!entry || Date.now() - entry.createdAt > PENDING_AUTH_TTL_MS) {
    return undefined;
  }
  return entry.codeVerifier;
}

export class WhopOAuthError extends Error {}

function assertOAuthConfigured(): void {
  if (!CLIENT_ID || !REDIRECT_URI) {
    throw new WhopOAuthError("Whop OAuth is not configured. Set WHOP_CLIENT_ID and WHOP_REDIRECT_URI.");
  }
}

/**
 * Builds the URL a creator is redirected to in order to authorize the app.
 * When `companyId` (a `biz_...` id) is provided, the resulting token is
 * account-scoped to that specific Whop business rather than a general user
 * token -- per Whop's OAuth docs, this is required to access resources
 * (like memberships) that belong to that account, even for its own owner.
 */
export function buildAuthorizationUrl(
  state: string,
  codeChallenge: string,
  nonce: string,
  companyId?: string
): string {
  assertOAuthConfigured();
  const url = new URL(WHOP_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID as string);
  url.searchParams.set("redirect_uri", REDIRECT_URI as string);
  url.searchParams.set("scope", WHOP_OAUTH_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", nonce);
  if (companyId) {
    url.searchParams.set("company_id", companyId);
  }
  return url.toString();
}

interface WhopTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface WhopAccountInfo {
  id: string;
  email: string | null;
  name: string | null;
}

async function exchangeCodeForToken(code: string, codeVerifier: string): Promise<WhopTokenResponse> {
  assertOAuthConfigured();

  const body = JSON.stringify({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI as string,
    client_id: CLIENT_ID as string,
    code_verifier: codeVerifier,
  });

  let response: Response;
  try {
    response = await fetch(WHOP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (err) {
    throw new WhopOAuthError(`Failed to reach Whop token endpoint: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new WhopOAuthError(`Whop token exchange failed (${response.status}): ${body}`);
  }

  try {
    return (await response.json()) as WhopTokenResponse;
  } catch {
    throw new WhopOAuthError("Whop token response was not valid JSON.");
  }
}

async function fetchWhopAccount(accessToken: string): Promise<WhopAccountInfo> {
  let response: Response;
  try {
    response = await fetch(WHOP_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    throw new WhopOAuthError(`Failed to reach Whop userinfo endpoint: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new WhopOAuthError(`Failed to fetch Whop account info (${response.status}): ${body}`);
  }

  let user: { sub?: string; email?: string; name?: string };
  try {
    user = (await response.json()) as { sub?: string; email?: string; name?: string };
  } catch {
    throw new WhopOAuthError("Whop userinfo response was not valid JSON.");
  }

  if (!user.sub) {
    throw new WhopOAuthError("Whop userinfo response did not include a sub (user id).");
  }

  return { id: user.sub, email: user.email ?? null, name: user.name ?? null };
}

/**
 * Resolves the `biz_...` company id (and display name) of the account this
 * creator manages, by asking the Whop API which accounts are visible to
 * their token (`GET /accounts`). Real webhooks key off this company id
 * (`data.company.id`), which is distinct from the user's own `user_...` id
 * from `/oauth/userinfo` \u2014 so it has to be looked up separately to route
 * webhooks to the right creator. The name is captured too so recovery
 * messages can say "This is Acme Inc" instead of a generic "the team",
 * letting customers tell which community a payment reminder is about.
 * Never throws: returns null (logging why) if the request fails or the
 * user has no accounts, so login can't be broken by this lookup.
 */
async function fetchWhopCompanyInfo(
  accessToken: string
): Promise<{ id: string; name: string | null } | null> {
  try {
    // Requires the versioned `Api-Version-Date` header to route to the
    // Current API's "List Accounts" behavior (user tokens -> the user's
    // business accounts, per docs.whop.com/api-reference/beta/accounts/
    // list-accounts). Without this header the unversioned/Legacy endpoint
    // is hit instead, which is an unrelated financial-accounts resource
    // gated behind a `company:balance:read` scope our OAuth token doesn't
    // have -- that mismatch silently looked like "no accounts found".
    const response = await fetch(`${WHOP_API_BASE}/accounts`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Api-Version-Date": "2026-06-09",
      },
    });

    if (!response.ok) {
      console.error(`[whopOAuth] Failed to list accounts (${response.status}): ${await response.text()}`);
      return null;
    }

    // Whop's Accounts API calls the business's display name `title`, not
    // `name` -- using the wrong key here silently produced `null` on every
    // successful lookup, masking a working call as "no company found".
    const body = (await response.json()) as { data?: { id?: string; title?: string | null }[] };
    const account = body.data?.[0];
    if (!account?.id) {
      console.error("[whopOAuth] No Whop company/account found for this user.");
      return null;
    }
    return { id: account.id, name: account.title ?? null };
  } catch (err) {
    console.error("[whopOAuth] Error resolving Whop company id:", (err as Error).message);
    return null;
  }
}

/**
 * Completes the OAuth2 flow: exchanges the authorization code for an access
 * token, fetches the creator's Whop account info, persists it, and starts a
 * dashboard session tied to that creator_account row.
 */
export async function handleOAuthCallback(
  code: string,
  codeVerifier: string
): Promise<{ whopAccountId: string; sessionToken: string }> {
  const token = await exchangeCodeForToken(code, codeVerifier);
  const account = await fetchWhopAccount(token.access_token);
  const companyInfo = await fetchWhopCompanyInfo(token.access_token);

  const expiresAt = token.expires_in
    ? new Date(Date.now() + token.expires_in * 1000).toISOString()
    : null;

  const creatorAccount = upsertCreatorAccount({
    whopAccountId: account.id,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    tokenType: token.token_type ?? null,
    expiresAt,
    email: account.email,
    name: account.name,
    whopCompanyId: companyInfo?.id ?? null,
    whopCompanyName: companyInfo?.name ?? null,
  });

  const sessionToken = createSession(creatorAccount.id);

  return { whopAccountId: account.id, sessionToken };
}

// --- Express route handlers -------------------------------------------------

/**
 * GET /auth/whop — redirects the creator to Whop to authorize the app.
 * Accepts an optional `?company_id=biz_...` query param to request an
 * account-scoped token for that specific business (see buildAuthorizationUrl).
 */
export function loginHandler(req: Request, res: ExpressResponse): void {
  try {
    const state = randomBytes(16).toString("hex");
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const nonce = generateNonce();
    storePendingAuthorization(state, codeVerifier);
    const companyId = typeof req.query.company_id === "string" ? req.query.company_id : undefined;
    const url = buildAuthorizationUrl(state, codeChallenge, nonce, companyId);
    res.redirect(url);
  } catch (err) {
    console.error("[whopOAuth] Failed to build authorization URL:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
}

/** GET /auth/whop/callback — exchanges the returned code for a token. */
export function callbackHandler(req: Request, res: ExpressResponse): void {
  const { code, state } = req.query;

  if (typeof code !== "string" || !code) {
    console.error("[whopOAuth] Callback missing code. Full query:", req.query);
    res.status(400).json({ error: "Missing authorization code.", query: req.query });
    return;
  }

  if (typeof state !== "string" || !state) {
    res.status(400).json({ error: "Missing state parameter." });
    return;
  }

  const codeVerifier = consumePendingAuthorization(state);
  if (!codeVerifier) {
    res.status(400).json({ error: "Unknown or expired state parameter." });
    return;
  }

  handleOAuthCallback(code, codeVerifier)
    .then(({ sessionToken }) => {
      res.cookie("session_token", sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      });
      res.redirect("/dashboard");
    })
    .catch((err: Error) => {
      console.error("[whopOAuth] OAuth callback failed:", err.message);
      res.status(502).json({ error: "Failed to complete Whop OAuth flow." });
    });
}

import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { getCreatorAccountBySessionToken, setDiscordGuildForCreator } from "../db/schema";

// Discord's OAuth2 authorize endpoint, used here purely for the "bot
// invite" flow: with `scope=bot` and a `permissions` bitfield, Discord lets
// the user pick a server to add the bot to directly from the consent
// screen (no token exchange needed for the bot to join). See
// https://discord.com/developers/docs/topics/oauth2#bot-authorization-flow
const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_BOT_INVITE_REDIRECT_URI = process.env.DISCORD_BOT_INVITE_REDIRECT_URI;

// View Channels (1024) + Send Messages (2048) = 3072. Send Messages is what
// the recovery bot actually needs (DMs don't require guild permissions at
// all, but requesting these keeps the consent screen meaningful and covers
// future in-server use).
const DISCORD_BOT_PERMISSIONS = "3072";

// Short-lived state -> creatorAccountId map, mirroring the PKCE
// `pendingAuthorizations` pattern in whopOAuth.ts: protects the callback
// against CSRF and lets us identify which creator was mid-flow, without
// needing the session cookie to survive the round trip through Discord.
const PENDING_INVITE_TTL_MS = 10 * 60 * 1000;
const pendingInvites = new Map<string, { creatorAccountId: number; createdAt: number }>();

function storePendingInvite(state: string, creatorAccountId: number): void {
  const now = Date.now();
  for (const [key, value] of pendingInvites) {
    if (now - value.createdAt > PENDING_INVITE_TTL_MS) {
      pendingInvites.delete(key);
    }
  }
  pendingInvites.set(state, { creatorAccountId, createdAt: now });
}

function consumePendingInvite(state: string): number | undefined {
  const entry = pendingInvites.get(state);
  pendingInvites.delete(state);
  if (!entry || Date.now() - entry.createdAt > PENDING_INVITE_TTL_MS) {
    return undefined;
  }
  return entry.creatorAccountId;
}

export class DiscordBotInviteError extends Error {}

function assertDiscordInviteConfigured(): void {
  if (!DISCORD_CLIENT_ID || !DISCORD_BOT_INVITE_REDIRECT_URI) {
    throw new DiscordBotInviteError(
      "Discord bot invite is not configured. Set DISCORD_CLIENT_ID and DISCORD_BOT_INVITE_REDIRECT_URI."
    );
  }
}

/** Builds the URL a creator is redirected to in order to add the bot to a server. */
export function buildDiscordBotInviteUrl(state: string): string {
  assertDiscordInviteConfigured();
  const url = new URL(DISCORD_AUTHORIZE_URL);
  url.searchParams.set("client_id", DISCORD_CLIENT_ID as string);
  url.searchParams.set("scope", "bot");
  url.searchParams.set("permissions", DISCORD_BOT_PERMISSIONS);
  url.searchParams.set("redirect_uri", DISCORD_BOT_INVITE_REDIRECT_URI as string);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * GET /auth/discord — redirects the logged-in creator to Discord's
 * bot-invite consent screen. Requires a valid dashboard session (i.e. the
 * creator must have already connected Whop), since we need to know which
 * creator_account row to attach the resulting guild id to.
 */
export function discordInviteLoginHandler(req: Request, res: Response): void {
  const sessionToken = req.cookies?.session_token as string | undefined;
  const creatorAccount = sessionToken ? getCreatorAccountBySessionToken(sessionToken) : null;

  if (!creatorAccount) {
    res.status(401).json({ error: "Connect your Whop account first." });
    return;
  }

  try {
    const state = randomBytes(16).toString("hex");
    storePendingInvite(state, creatorAccount.id);
    res.redirect(buildDiscordBotInviteUrl(state));
  } catch (err) {
    console.error("[discordBotInvite] Failed to build invite URL:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
}

/**
 * GET /auth/discord/callback — Discord redirects here after the creator
 * picks a server and authorizes the bot, with the joined server's id as
 * `guild_id`. Stores that confirmation on the creator's account so the
 * dashboard can show the Discord step as complete.
 */
export function discordInviteCallbackHandler(req: Request, res: Response): void {
  const { guild_id: guildId, state } = req.query;

  if (typeof state !== "string" || !state) {
    res.status(400).json({ error: "Missing state parameter." });
    return;
  }

  const creatorAccountId = consumePendingInvite(state);
  if (!creatorAccountId) {
    res.status(400).json({ error: "Unknown or expired state parameter." });
    return;
  }

  if (typeof guildId !== "string" || !guildId) {
    // The user closed the consent screen without picking a server, or
    // Discord otherwise didn't add the bot to a guild.
    console.error("[discordBotInvite] Callback missing guild_id; invite was likely cancelled.");
    res.redirect("/dashboard?discord=cancelled");
    return;
  }

  try {
    setDiscordGuildForCreator(creatorAccountId, guildId);
    res.redirect("/dashboard?discord=connected");
  } catch (err) {
    console.error("[discordBotInvite] Failed to store Discord guild id:", (err as Error).message);
    res.status(500).json({ error: "Failed to record Discord bot connection." });
  }
}

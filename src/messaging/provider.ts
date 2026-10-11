import type { DiscordProvider, EmailProvider } from "./types";
import { ResendEmailProvider } from "./emailProvider";
import { DiscordBotProvider } from "./discordProvider";

let cachedEmailProvider: EmailProvider | undefined;
let cachedDiscordProvider: DiscordProvider | undefined;

/**
 * Returns the configured email fallback provider (a singleton). Currently
 * always Resend; swap the implementation returned here to change providers
 * without touching any of the recovery-messaging call sites.
 */
export function getEmailProvider(): EmailProvider {
  if (!cachedEmailProvider) {
    cachedEmailProvider = new ResendEmailProvider();
  }
  return cachedEmailProvider;
}

/**
 * Returns the configured Discord messaging provider (a singleton) — the
 * primary recovery channel. Currently always a discord.js bot; swap the
 * implementation returned here to change providers without touching any of
 * the recovery-messaging call sites.
 */
export function getDiscordProvider(): DiscordProvider {
  if (!cachedDiscordProvider) {
    cachedDiscordProvider = new DiscordBotProvider();
  }
  return cachedDiscordProvider;
}

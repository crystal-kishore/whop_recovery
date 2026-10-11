import { Client, GatewayIntentBits, Partials } from "discord.js";
import type { DiscordProvider, SendMessageResult } from "./types";

/**
 * Sends recovery messages via Discord DM, using a bot account. This is the
 * primary recovery channel: Whop requires customers in paid Discord
 * communities to link their Discord account to claim server access, so a
 * Discord id is reliably available for this audience — unlike phone
 * numbers, which are often missing.
 *
 * Requires DISCORD_BOT_TOKEN to be set (from the Discord Developer Portal,
 * https://discord.com/developers/applications — create an application, add
 * a Bot, copy its token, and invite it to a server with the
 * `bot` + `Send Messages` scopes so it shares at least one server with the
 * customers it needs to DM; Discord does not allow bots to DM users they
 * share no server with).
 *
 * The gateway connection is opened lazily on the first send and reused for
 * the life of the process — `client.users.fetch` + `.send()` both require
 * an active session, not just the bot token.
 */
export class DiscordBotProvider implements DiscordProvider {
  private readonly token: string;
  private client: Client | undefined;
  private readyPromise: Promise<Client> | undefined;

  constructor() {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      throw new Error("Discord is not configured. Set DISCORD_BOT_TOKEN.");
    }
    this.token = token;
  }

  private async getReadyClient(): Promise<Client> {
    if (this.client?.isReady()) {
      return this.client;
    }

    if (!this.readyPromise) {
      const client = new Client({
        // No message-content/guild intents needed — this bot only opens DM
        // channels and sends to them, it never reads server messages.
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
        partials: [Partials.Channel],
      });
      this.client = client;
      this.readyPromise = new Promise((resolve, reject) => {
        client.once("ready", () => resolve(client));
        client.once("error", reject);
        client.login(this.token).catch(reject);
      });
    }

    return this.readyPromise;
  }

  async sendDiscordMessage(discordUserId: string, body: string): Promise<SendMessageResult> {
    try {
      const client = await this.getReadyClient();
      const user = await client.users.fetch(discordUserId);
      const message = await user.send(body);
      return { success: true, providerMessageId: message.id };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}

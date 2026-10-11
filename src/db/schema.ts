import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DB_PATH =
  process.env.DATABASE_PATH || path.join(process.cwd(), "data", "whop-recovery.sqlite");

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export class DatabaseError extends Error {}

/**
 * Creates the tables the app needs if they don't already exist. Safe to call
 * on every server start.
 */
export function initSchema(): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS creator_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        whop_account_id TEXT NOT NULL UNIQUE,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        token_type TEXT,
        expires_at TEXT,
        email TEXT,
        name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_token TEXT PRIMARY KEY,
        creator_account_id INTEGER NOT NULL REFERENCES creator_accounts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS failed_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        whop_payment_id TEXT UNIQUE,
        creator_account_id INTEGER REFERENCES creator_accounts(id),
        customer_name TEXT,
        customer_email TEXT,
        customer_phone TEXT,
        amount_due REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'usd',
        failure_reason TEXT,
        recovery_link TEXT,
        raw_event TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        reminder_count INTEGER NOT NULL DEFAULT 0,
        last_reminder_at TEXT,
        recovered_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Commission billing: one row per attempted charge against a
      -- creator's saved Dodo payment method (weekly billing job). Kept
      -- separate from failed_payments so a billing attempt covering many
      -- recovered payments doesn't need one row per payment, and so
      -- failed/succeeded attempts are both preserved for an audit trail.
      CREATE TABLE IF NOT EXISTS billing_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        creator_account_id INTEGER NOT NULL REFERENCES creator_accounts(id),
        amount_charged REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'usd',
        recovered_payment_ids TEXT NOT NULL,
        status TEXT NOT NULL,
        dodo_transaction_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    ensureFailedPaymentColumns();
    ensureCreatorAccountColumns();
    ensureBillingLogColumns();
  } catch (err) {
    throw new DatabaseError(`Failed to initialize database schema: ${(err as Error).message}`);
  }
}

/**
 * Adds recovery-messaging columns to `failed_payments` if the table was
 * created before they existed. `CREATE TABLE IF NOT EXISTS` above doesn't
 * retroactively add columns to a pre-existing table, so this migrates older
 * local databases in place. Safe to run on every startup.
 */
function ensureFailedPaymentColumns(): void {
  const columns = db.prepare("PRAGMA table_info(failed_payments)").all() as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("status")) {
    db.exec("ALTER TABLE failed_payments ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!columnNames.has("reminder_count")) {
    db.exec("ALTER TABLE failed_payments ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnNames.has("last_reminder_at")) {
    db.exec("ALTER TABLE failed_payments ADD COLUMN last_reminder_at TEXT");
  }
  if (!columnNames.has("recovered_at")) {
    db.exec("ALTER TABLE failed_payments ADD COLUMN recovered_at TEXT");
  }
  if (!columnNames.has("last_channel")) {
    db.exec("ALTER TABLE failed_payments ADD COLUMN last_channel TEXT");
  }
  if (!columnNames.has("discord_id")) {
    // The customer's linked Discord user id (snowflake), resolved from
    // Whop's Users API (`social_accounts` with platform "discord") when the
    // webhook fires. Nullable: not every customer links Discord, and the
    // lookup can fail (missing creator access token, API error, etc).
    db.exec("ALTER TABLE failed_payments ADD COLUMN discord_id TEXT");
  }
  if (!columnNames.has("company_name")) {
    // The creator/community display name shown in recovery messages (e.g.
    // "This is Acme Inc"), resolved at webhook time from the creator's
    // stored `whop_company_name` (falling back to the webhook payload's
    // `company.title`) and denormalized onto the payment row so every
    // reminder \u2014 including later scheduled 24h/72h follow-ups \u2014 uses the
    // same, correct name without a join. Nullable: falls back to a generic
    // "the team" at compose time when unresolved.
    db.exec("ALTER TABLE failed_payments ADD COLUMN company_name TEXT");
  }
  if (!columnNames.has("product_name")) {
    // The specific product/plan the customer is paying for (e.g. "GitHub
    // Coding Community"), resolved from the membership's `product.title` at
    // webhook time and denormalized onto the payment row for the same
    // reason as `company_name` -- so reminders can tell the customer exactly
    // which product/community the payment is for, not just which creator.
    // Nullable: falls back to omitting the product mention at compose time.
    db.exec("ALTER TABLE failed_payments ADD COLUMN product_name TEXT");
  }
  if (!columnNames.has("billed")) {
    // Whether this recovered payment's commission has already been billed
    // to the creator via the weekly Dodo billing job (0/1). Only rows with
    // status = 'recovered' AND billed = 0 are candidates for the next
    // billing cycle; set to 1 only after a charge actually succeeds, so a
    // failed charge attempt leaves the row eligible for the next cycle.
    db.exec("ALTER TABLE failed_payments ADD COLUMN billed INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * Adds dashboard-display columns to `creator_accounts` if the table was
 * created before they existed. Safe to run on every startup.
 */
function ensureCreatorAccountColumns(): void {
  const columns = db.prepare("PRAGMA table_info(creator_accounts)").all() as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("email")) {
    db.exec("ALTER TABLE creator_accounts ADD COLUMN email TEXT");
  }
  if (!columnNames.has("name")) {
    db.exec("ALTER TABLE creator_accounts ADD COLUMN name TEXT");
  }
  if (!columnNames.has("whop_company_id")) {
    // The `biz_...` company/account id the OAuth'd user manages, distinct
    // from `whop_account_id` (their own `user_...` id). Real webhooks key
    // off `data.company.id`, which is this `biz_...` id, so it's stored
    // separately to look creator accounts up for incoming webhooks. Nullable
    // because it's fetched best-effort after login and may be unavailable.
    db.exec("ALTER TABLE creator_accounts ADD COLUMN whop_company_id TEXT");
  }
  if (!columnNames.has("whop_company_name")) {
    // The business/community display name (e.g. "Acme Inc"), fetched
    // alongside whop_company_id from `GET /api/v1/accounts` at login time.
    // Used to personalize recovery messages so customers can tell which
    // community a payment reminder is about, instead of a generic "the
    // team". Nullable: best-effort, may be unavailable.
    db.exec("ALTER TABLE creator_accounts ADD COLUMN whop_company_name TEXT");
  }
  if (!columnNames.has("discord_guild_id")) {
    // The Discord server (guild) id the creator added our bot to, captured
    // from the `guild_id` query param Discord includes on the bot-invite
    // OAuth redirect (see src/auth/discordBotInvite.ts). Nullable until the
    // "Add our Discord bot to your server" onboarding step is completed.
    db.exec("ALTER TABLE creator_accounts ADD COLUMN discord_guild_id TEXT");
  }
  if (!columnNames.has("discord_bot_connected_at")) {
    db.exec("ALTER TABLE creator_accounts ADD COLUMN discord_bot_connected_at TEXT");
  }
  if (!columnNames.has("dodo_customer_id")) {
    // The Dodo Payments customer id (`cus_...`) representing this creator
    // in our *separate* commission-billing relationship with them (not to
    // be confused with the Whop customers whose failed payments we
    // recover). Created via the Dodo API the first time a creator starts
    // the "Connect payment method" flow. Nullable until then.
    db.exec("ALTER TABLE creator_accounts ADD COLUMN dodo_customer_id TEXT");
  }
  if (!columnNames.has("dodo_subscription_id")) {
    // The Dodo on-demand subscription id (`sub_...`) that authorizes us to
    // charge this creator's saved card on demand (see
    // src/billing/paymentMethodSetup.ts). Set once the creator completes
    // the mandate-only checkout; the weekly billing job charges against
    // this subscription rather than its own fixed price. Nullable until a
    // payment method is connected.
    db.exec("ALTER TABLE creator_accounts ADD COLUMN dodo_subscription_id TEXT");
  }
  if (!columnNames.has("dodo_payment_method_connected_at")) {
    db.exec("ALTER TABLE creator_accounts ADD COLUMN dodo_payment_method_connected_at TEXT");
  }
  if (!columnNames.has("billing_rate")) {
    // The fraction of recovered revenue we bill this creator (e.g. 0.15 =
    // 15%). Defaults to 15% for every creator but can be adjusted
    // per-creator later (e.g. negotiated enterprise rates).
    db.exec("ALTER TABLE creator_accounts ADD COLUMN billing_rate REAL NOT NULL DEFAULT 0.15");
  }
}

/**
 * Adds columns to `billing_log` if the table was created before they
 * existed (e.g. local databases created before `currency` was added to the
 * CREATE TABLE statement). Safe to run on every startup.
 */
function ensureBillingLogColumns(): void {
  const columns = db.prepare("PRAGMA table_info(billing_log)").all() as { name: string }[];
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("currency")) {
    db.exec("ALTER TABLE billing_log ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd'");
  }
  if (!columnNames.has("dodo_transaction_id")) {
    // Older local databases predate the Dodo billing integration and were
    // created with a `stripe_charge_id` column from an earlier prototype
    // instead. That column is left in place (unused) rather than dropped,
    // since SQLite's ALTER TABLE DROP COLUMN support is version-dependent.
    db.exec("ALTER TABLE billing_log ADD COLUMN dodo_transaction_id TEXT");
  }
}

export interface CreatorAccountRecord {
  id: number;
  whop_account_id: string;
  access_token: string;
  refresh_token: string | null;
  token_type: string | null;
  expires_at: string | null;
  email: string | null;
  name: string | null;
  whop_company_id: string | null;
  whop_company_name: string | null;
  discord_guild_id: string | null;
  discord_bot_connected_at: string | null;
  dodo_customer_id: string | null;
  dodo_subscription_id: string | null;
  dodo_payment_method_connected_at: string | null;
  billing_rate: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertCreatorAccountInput {
  whopAccountId: string;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string | null;
  expiresAt: string | null;
  email?: string | null;
  name?: string | null;
  whopCompanyId?: string | null;
  whopCompanyName?: string | null;
}

/** Inserts a creator's Whop account + token, or updates it if it already exists. */
export function upsertCreatorAccount(input: UpsertCreatorAccountInput): CreatorAccountRecord {
  try {
    const stmt = db.prepare(`
      INSERT INTO creator_accounts (whop_account_id, access_token, refresh_token, token_type, expires_at, email, name, whop_company_id, whop_company_name, updated_at)
      VALUES (@whopAccountId, @accessToken, @refreshToken, @tokenType, @expiresAt, @email, @name, @whopCompanyId, @whopCompanyName, datetime('now'))
      ON CONFLICT(whop_account_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        token_type = excluded.token_type,
        expires_at = excluded.expires_at,
        email = excluded.email,
        name = excluded.name,
        whop_company_id = excluded.whop_company_id,
        whop_company_name = excluded.whop_company_name,
        updated_at = datetime('now')
    `);
    stmt.run({ email: null, name: null, whopCompanyId: null, whopCompanyName: null, ...input });
    const record = getCreatorAccountByWhopId(input.whopAccountId);
    if (!record) {
      throw new DatabaseError("Creator account upsert did not return a row.");
    }
    return record;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`Failed to upsert creator account: ${(err as Error).message}`);
  }
}

export function getCreatorAccountByWhopId(whopAccountId: string): CreatorAccountRecord | null {
  try {
    const row = db
      .prepare("SELECT * FROM creator_accounts WHERE whop_account_id = ?")
      .get(whopAccountId) as CreatorAccountRecord | undefined;
    return row ?? null;
  } catch (err) {
    throw new DatabaseError(`Failed to fetch creator account: ${(err as Error).message}`);
  }
}

/**
 * Looks a creator account up by their Whop *company* id (`biz_...`), which
 * is what real `payment.failed`/`payment.succeeded` webhooks key off
 * (`data.company.id`) — distinct from `whop_account_id`, the OAuth'd user's
 * own `user_...` id. Returns null if no creator has connected that company
 * yet, or the company id couldn't be resolved at login time.
 */
export function getCreatorAccountByCompanyId(whopCompanyId: string): CreatorAccountRecord | null {
  try {
    const row = db
      .prepare("SELECT * FROM creator_accounts WHERE whop_company_id = ?")
      .get(whopCompanyId) as CreatorAccountRecord | undefined;
    return row ?? null;
  } catch (err) {
    throw new DatabaseError(`Failed to fetch creator account by company id: ${(err as Error).message}`);
  }
}

/**
 * Records that the Discord bot was successfully added to a creator's
 * server, storing the guild id Discord returned on the bot-invite OAuth
 * redirect. Called from the /auth/discord/callback handler once Discord
 * confirms the bot joined a guild.
 */
export function setDiscordGuildForCreator(
  creatorAccountId: number,
  guildId: string
): CreatorAccountRecord | null {
  try {
    db.prepare(
      `UPDATE creator_accounts
       SET discord_guild_id = ?, discord_bot_connected_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(guildId, creatorAccountId);
    return db
      .prepare("SELECT * FROM creator_accounts WHERE id = ?")
      .get(creatorAccountId) as CreatorAccountRecord | null;
  } catch (err) {
    throw new DatabaseError(`Failed to store Discord guild id: ${(err as Error).message}`);
  }
}

/** Looks a creator account up by its internal id. */
export function getCreatorAccountById(id: number): CreatorAccountRecord | null {
  try {
    const row = db
      .prepare("SELECT * FROM creator_accounts WHERE id = ?")
      .get(id) as CreatorAccountRecord | undefined;
    return row ?? null;
  } catch (err) {
    throw new DatabaseError(`Failed to fetch creator account by id: ${(err as Error).message}`);
  }
}

/**
 * Records the Dodo Payments customer id created for a creator the first
 * time they start the "Connect payment method" flow (see
 * src/billing/paymentMethodSetup.ts). Idempotent: safe to call again with
 * the same id on retries.
 */
export function setDodoCustomerForCreator(
  creatorAccountId: number,
  dodoCustomerId: string
): CreatorAccountRecord | null {
  try {
    db.prepare(
      `UPDATE creator_accounts SET dodo_customer_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(dodoCustomerId, creatorAccountId);
    return getCreatorAccountById(creatorAccountId);
  } catch (err) {
    throw new DatabaseError(`Failed to store Dodo customer id: ${(err as Error).message}`);
  }
}

/**
 * Records that a creator approved the on-demand billing mandate, storing
 * the Dodo subscription id the weekly billing job charges against. Called
 * both from the checkout return-URL handler (best-effort, immediate) and
 * the `subscription.active` webhook handler (authoritative), so either one
 * arriving first is sufficient.
 */
export function setDodoSubscriptionForCreator(
  creatorAccountId: number,
  dodoSubscriptionId: string
): CreatorAccountRecord | null {
  try {
    db.prepare(
      `UPDATE creator_accounts
       SET dodo_subscription_id = ?, dodo_payment_method_connected_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(dodoSubscriptionId, creatorAccountId);
    return getCreatorAccountById(creatorAccountId);
  } catch (err) {
    throw new DatabaseError(`Failed to store Dodo subscription id: ${(err as Error).message}`);
  }
}

/** Looks a creator account up by its Dodo customer id, e.g. from a webhook payload. */
export function getCreatorAccountByDodoCustomerId(dodoCustomerId: string): CreatorAccountRecord | null {
  try {
    const row = db
      .prepare("SELECT * FROM creator_accounts WHERE dodo_customer_id = ?")
      .get(dodoCustomerId) as CreatorAccountRecord | undefined;
    return row ?? null;
  } catch (err) {
    throw new DatabaseError(`Failed to fetch creator account by Dodo customer id: ${(err as Error).message}`);
  }
}

/** Adjusts the commission rate billed to a specific creator (defaults to 0.15 for everyone). */
export function updateCreatorBillingRate(
  creatorAccountId: number,
  billingRate: number
): CreatorAccountRecord | null {
  try {
    db.prepare(
      `UPDATE creator_accounts SET billing_rate = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(billingRate, creatorAccountId);
    return getCreatorAccountById(creatorAccountId);
  } catch (err) {
    throw new DatabaseError(`Failed to update billing rate: ${(err as Error).message}`);
  }
}

/** Every creator account with a saved Dodo payment method (i.e. eligible for the billing job). */
export function getCreatorAccountsWithDodoSubscription(): CreatorAccountRecord[] {
  try {
    return db
      .prepare("SELECT * FROM creator_accounts WHERE dodo_subscription_id IS NOT NULL")
      .all() as CreatorAccountRecord[];
  } catch (err) {
    throw new DatabaseError(`Failed to fetch creator accounts with a Dodo subscription: ${(err as Error).message}`);
  }
}

export interface FailedPaymentRecord {
  id: number;
  whop_payment_id: string | null;
  creator_account_id: number | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  discord_id: string | null;
  company_name: string | null;
  product_name: string | null;
  amount_due: number;
  currency: string;
  failure_reason: string | null;
  recovery_link: string | null;
  raw_event: string | null;
  status: string;
  reminder_count: number;
  last_reminder_at: string | null;
  last_channel: string | null;
  recovered_at: string | null;
  billed: number;
  created_at: string;
}

export interface InsertFailedPaymentInput {
  whopPaymentId: string;
  creatorAccountId: number | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  discordId?: string | null;
  companyName?: string | null;
  productName?: string | null;
  amountDue: number;
  currency: string;
  failureReason: string | null;
  recoveryLink: string | null;
  rawEvent: string;
}

/**
 * Stores a failed payment record. Uses an upsert on whop_payment_id so
 * webhook retries (which Whop, like most providers, may send) don't create
 * duplicate rows.
 */
export function insertFailedPayment(input: InsertFailedPaymentInput): FailedPaymentRecord {
  try {
    const stmt = db.prepare(`
      INSERT INTO failed_payments (
        whop_payment_id, creator_account_id, customer_name, customer_email,
        customer_phone, discord_id, company_name, product_name, amount_due, currency, failure_reason, recovery_link, raw_event
      ) VALUES (
        @whopPaymentId, @creatorAccountId, @customerName, @customerEmail,
        @customerPhone, @discordId, @companyName, @productName, @amountDue, @currency, @failureReason, @recoveryLink, @rawEvent
      )
      ON CONFLICT(whop_payment_id) DO UPDATE SET
        customer_name = excluded.customer_name,
        customer_email = excluded.customer_email,
        customer_phone = excluded.customer_phone,
        discord_id = excluded.discord_id,
        company_name = excluded.company_name,
        product_name = excluded.product_name,
        amount_due = excluded.amount_due,
        currency = excluded.currency,
        failure_reason = excluded.failure_reason,
        recovery_link = excluded.recovery_link,
        raw_event = excluded.raw_event
    `);
    stmt.run({ discordId: null, companyName: null, productName: null, ...input });
    const record = getFailedPaymentByWhopId(input.whopPaymentId);
    if (!record) {
      throw new DatabaseError("Failed payment insert did not return a row.");
    }
    return record;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`Failed to insert failed payment record: ${(err as Error).message}`);
  }
}

export function getFailedPaymentByWhopId(whopPaymentId: string): FailedPaymentRecord | null {
  try {
    const row = db
      .prepare("SELECT * FROM failed_payments WHERE whop_payment_id = ?")
      .get(whopPaymentId) as FailedPaymentRecord | undefined;
    return row ?? null;
  } catch (err) {
    throw new DatabaseError(`Failed to fetch failed payment: ${(err as Error).message}`);
  }
}

export function getFailedPaymentById(id: number): FailedPaymentRecord | null {
  try {
    const row = db
      .prepare("SELECT * FROM failed_payments WHERE id = ?")
      .get(id) as FailedPaymentRecord | undefined;
    return row ?? null;
  } catch (err) {
    throw new DatabaseError(`Failed to fetch failed payment by id: ${(err as Error).message}`);
  }
}

/**
 * Records that a reminder message was just sent for a failed payment by
 * bumping its reminder_count and last_reminder_at, and (optionally) noting
 * which channel (discord/whatsapp/email) handled the send for dashboard
 * visibility.
 */
export function incrementReminderSent(
  id: number,
  channel?: "discord" | "whatsapp" | "email"
): FailedPaymentRecord | null {
  try {
    db.prepare(
      `UPDATE failed_payments
       SET reminder_count = reminder_count + 1,
           last_reminder_at = datetime('now'),
           last_channel = COALESCE(?, last_channel)
       WHERE id = ?`
    ).run(channel ?? null, id);
    return getFailedPaymentById(id);
  } catch (err) {
    throw new DatabaseError(`Failed to update reminder count: ${(err as Error).message}`);
  }
}

/**
 * Finds still-pending failed payments due for their next scheduled
 * follow-up: a 2nd reminder 24 hours after the original failure, and a 3rd
 * (final) reminder 72 hours after the original failure. The initial
 * reminder (reminder_count 0 -> 1) is sent immediately when the webhook
 * arrives, not by this scheduled check.
 */
export function getFailedPaymentsDueForReminder(referenceTime: Date = new Date()): FailedPaymentRecord[] {
  try {
    const nowIso = referenceTime.toISOString();
    return db
      .prepare(
        `SELECT * FROM failed_payments
         WHERE status = 'pending'
           AND (
             (reminder_count = 1 AND datetime(created_at, '+24 hours') <= datetime(?))
             OR (reminder_count = 2 AND datetime(created_at, '+72 hours') <= datetime(?))
           )`
      )
      .all(nowIso, nowIso) as FailedPaymentRecord[];
  } catch (err) {
    throw new DatabaseError(`Failed to fetch due reminders: ${(err as Error).message}`);
  }
}

export interface RecoverFailedPaymentsInput {
  creatorAccountId: number | null;
  customerEmail: string | null;
  customerPhone: string | null;
}

/**
 * Marks any still-pending failed payments for a given customer as
 * "recovered" (e.g. in response to a payment.succeeded webhook). Matches by
 * customer email or phone within the same creator account, since Whop's
 * success event isn't guaranteed to reference the original failed charge's
 * id. Recovered records are automatically skipped by
 * `getFailedPaymentsDueForReminder`, which effectively cancels any pending
 * follow-up reminders for them.
 */
export function recoverFailedPaymentsForCustomer(
  input: RecoverFailedPaymentsInput
): FailedPaymentRecord[] {
  if (!input.customerEmail && !input.customerPhone) {
    return [];
  }

  try {
    const matches = db
      .prepare(
        `SELECT * FROM failed_payments
         WHERE status = 'pending'
           AND creator_account_id IS ?
           AND (
             (customer_email IS NOT NULL AND customer_email = ?)
             OR (customer_phone IS NOT NULL AND customer_phone = ?)
           )`
      )
      .all(input.creatorAccountId, input.customerEmail, input.customerPhone) as FailedPaymentRecord[];

    if (matches.length === 0) {
      return [];
    }

    const markRecovered = db.prepare(
      `UPDATE failed_payments SET status = 'recovered', recovered_at = datetime('now') WHERE id = ?`
    );
    for (const match of matches) {
      markRecovered.run(match.id);
    }

    return matches.map((match) => ({ ...match, status: "recovered" }));
  } catch (err) {
    throw new DatabaseError(`Failed to mark failed payments recovered: ${(err as Error).message}`);
  }
}

/**
 * Recovered payments for a creator that haven't been billed yet -- the
 * candidate set for the next commission-billing cycle (see
 * src/billing/billingScheduler.ts). Excludes anything already billed so a
 * partially-failed cycle can safely re-run without double-charging.
 */
export function getUnbilledRecoveredPayments(creatorAccountId: number): FailedPaymentRecord[] {
  try {
    return db
      .prepare(
        `SELECT * FROM failed_payments
         WHERE creator_account_id = ? AND status = 'recovered' AND billed = 0`
      )
      .all(creatorAccountId) as FailedPaymentRecord[];
  } catch (err) {
    throw new DatabaseError(`Failed to fetch unbilled recovered payments: ${(err as Error).message}`);
  }
}

/** Flags a batch of recovered payments as billed once a commission charge for them has succeeded. */
export function markFailedPaymentsBilled(ids: number[]): void {
  if (ids.length === 0) {
    return;
  }
  try {
    const markBilled = db.prepare(`UPDATE failed_payments SET billed = 1 WHERE id = ?`);
    const runAll = db.transaction((paymentIds: number[]) => {
      for (const id of paymentIds) {
        markBilled.run(id);
      }
    });
    runAll(ids);
  } catch (err) {
    throw new DatabaseError(`Failed to mark failed payments billed: ${(err as Error).message}`);
  }
}

/**
 * Creates a new dashboard login session for a creator and returns the
 * opaque session token to set as an httpOnly cookie. Minimal by design: no
 * expiry/rotation yet, just enough to gate the read-only dashboard behind
 * "you completed the OAuth flow for this creator account".
 */
export function createSession(creatorAccountId: number): string {
  try {
    const sessionToken = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (session_token, creator_account_id) VALUES (?, ?)").run(
      sessionToken,
      creatorAccountId
    );
    return sessionToken;
  } catch (err) {
    throw new DatabaseError(`Failed to create session: ${(err as Error).message}`);
  }
}

/** Looks up the creator account tied to a dashboard session cookie, if valid. */
export function getCreatorAccountBySessionToken(sessionToken: string): CreatorAccountRecord | null {
  try {
    const row = db
      .prepare(
        `SELECT creator_accounts.* FROM sessions
         JOIN creator_accounts ON creator_accounts.id = sessions.creator_account_id
         WHERE sessions.session_token = ?`
      )
      .get(sessionToken) as CreatorAccountRecord | undefined;
    return row ?? null;
  } catch (err) {
    throw new DatabaseError(`Failed to look up session: ${(err as Error).message}`);
  }
}

export interface DashboardStats {
  totalFailed: number;
  totalRecovered: number;
  totalAmountRecovered: number;
  recentPayments: FailedPaymentRecord[];
}

/**
 * Aggregates the numbers shown on the creator dashboard, scoped to a single
 * creator account: total failed payments caught, total recovered, total
 * amount recovered, and the 20 most recent failed_payments records.
 */
export function getDashboardStats(creatorAccountId: number): DashboardStats {
  try {
    const totals = db
      .prepare(
        `SELECT
           COUNT(*) AS totalFailed,
           COALESCE(SUM(CASE WHEN status = 'recovered' THEN 1 ELSE 0 END), 0) AS totalRecovered,
           COALESCE(SUM(CASE WHEN status = 'recovered' THEN amount_due ELSE 0 END), 0) AS totalAmountRecovered
         FROM failed_payments
         WHERE creator_account_id = ?`
      )
      .get(creatorAccountId) as {
      totalFailed: number;
      totalRecovered: number;
      totalAmountRecovered: number;
    };

    const recentPayments = db
      .prepare(
        `SELECT * FROM failed_payments
         WHERE creator_account_id = ?
         ORDER BY created_at DESC
         LIMIT 20`
      )
      .all(creatorAccountId) as FailedPaymentRecord[];

    return { ...totals, recentPayments };
  } catch (err) {
    throw new DatabaseError(`Failed to load dashboard stats: ${(err as Error).message}`);
  }
}

export interface BillingLogRecord {
  id: number;
  creator_account_id: number;
  amount_charged: number;
  currency: string;
  recovered_payment_ids: string;
  status: string;
  dodo_transaction_id: string | null;
  error_message: string | null;
  created_at: string;
}

export interface InsertBillingLogInput {
  creatorAccountId: number;
  amountCharged: number;
  currency?: string;
  recoveredPaymentIds: number[];
  status: "succeeded" | "failed";
  dodoTransactionId?: string | null;
  errorMessage?: string | null;
}

/**
 * Records the outcome (success or failure) of a single commission-billing
 * charge attempt against a creator's saved Dodo payment method, for both
 * the dashboard's billing history table and general auditability. Stores
 * the recovered `failed_payments` ids the charge covered as a JSON array
 * since a single charge can bundle a week's worth of recoveries together.
 */
export function insertBillingLog(input: InsertBillingLogInput): BillingLogRecord {
  try {
    const result = db
      .prepare(
        `INSERT INTO billing_log
           (creator_account_id, amount_charged, currency, recovered_payment_ids, status, dodo_transaction_id, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.creatorAccountId,
        input.amountCharged,
        input.currency ?? "usd",
        JSON.stringify(input.recoveredPaymentIds),
        input.status,
        input.dodoTransactionId ?? null,
        input.errorMessage ?? null
      );

    const row = db
      .prepare("SELECT * FROM billing_log WHERE id = ?")
      .get(result.lastInsertRowid) as BillingLogRecord;
    return row;
  } catch (err) {
    throw new DatabaseError(`Failed to insert billing log entry: ${(err as Error).message}`);
  }
}

/** The most recent commission-billing attempts for a creator, newest first, for the dashboard. */
export function getBillingLogForCreator(creatorAccountId: number, limit = 20): BillingLogRecord[] {
  try {
    return db
      .prepare(
        `SELECT * FROM billing_log WHERE creator_account_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(creatorAccountId, limit) as BillingLogRecord[];
  } catch (err) {
    throw new DatabaseError(`Failed to load billing log: ${(err as Error).message}`);
  }
}

/** Total commission successfully billed to a creator across all time, for the dashboard summary. */
export function getTotalBilledForCreator(creatorAccountId: number): number {
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount_charged), 0) AS total FROM billing_log
         WHERE creator_account_id = ? AND status = 'succeeded'`
      )
      .get(creatorAccountId) as { total: number };
    return row.total;
  } catch (err) {
    throw new DatabaseError(`Failed to compute total billed: ${(err as Error).message}`);
  }
}

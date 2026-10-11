import "dotenv/config";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { callbackHandler, loginHandler } from "../auth/whopOAuth";
import { discordInviteCallbackHandler, discordInviteLoginHandler } from "../auth/discordBotInvite";
import { dodoConnectHandler, dodoReturnHandler } from "../billing/paymentMethodSetup";
import { startBillingScheduler } from "../billing/billingScheduler";
import { initSchema } from "../db/schema";
import { startReminderScheduler } from "../scheduler/reminderScheduler";
import { dashboardHandler } from "./dashboard";
import { landingHandler } from "./landing";
import { handleWhopWebhook } from "../webhooks/whopWebhook";
import { handleDodoWebhook } from "../webhooks/dodoWebhook";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Capture the raw request body so webhook signatures can be verified against
// the exact bytes Whop sent, while still getting parsed JSON on req.body.
app.use(
  express.json({
    verify: (req: Request, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  })
);
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Public marketing landing page (unauthenticated). Kept separate from the
// internal /dashboard route and the OAuth flow below, which remain
// untouched.
app.get("/", landingHandler);

app.get("/auth/whop", loginHandler);
app.get("/auth/whop/callback", callbackHandler);
app.get("/auth/discord", discordInviteLoginHandler);
app.get("/auth/discord/callback", discordInviteCallbackHandler);
app.get("/billing/dodo/connect", dodoConnectHandler);
app.get("/billing/dodo/return", dodoReturnHandler);
app.get("/dashboard", dashboardHandler);

app.post("/webhooks/whop", handleWhopWebhook);
app.post("/webhooks/dodo", handleDodoWebhook);

// Centralized error handler (e.g. malformed JSON bodies from express.json()).
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[server] Unhandled error:", err.message);
  res.status(400).json({ error: "Invalid request." });
});

function start(): void {
  try {
    initSchema();
  } catch (err) {
    console.error("[server] Failed to initialize database schema:", (err as Error).message);
    process.exit(1);
  }

  startReminderScheduler();
  startBillingScheduler();

  app.listen(PORT, () => {
    console.log(`whop-recovery server listening on port ${PORT}`);
    console.log(`[server] GET  /                 ready (landing page)`);
    console.log(`[server] GET  /health           ready`);
    console.log(`[server] GET  /dashboard         ready`);
    console.log(`[server] POST /webhooks/whop     ready (webhook route registered)`);
    console.log(`[server] POST /webhooks/dodo     ready (webhook route registered)`);
  });
}

start();

import "dotenv/config";
import { db } from "../src/db/schema";

const accounts = db
  .prepare("SELECT id, whop_account_id, email, name, created_at FROM creator_accounts ORDER BY created_at DESC LIMIT 5")
  .all();
console.log("Recent creator_accounts:", accounts);

const sessions = db
  .prepare("SELECT session_token, creator_account_id, created_at FROM sessions ORDER BY created_at DESC LIMIT 5")
  .all();
console.log("Recent sessions:", sessions);

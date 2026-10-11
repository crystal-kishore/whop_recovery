import "dotenv/config";
import { db } from "../src/db/schema";

const rows = db
  .prepare(
    "SELECT id, whop_payment_id, raw_event FROM failed_payments WHERE raw_event LIKE '%api_version%' ORDER BY id DESC"
  )
  .all() as { id: number; whop_payment_id: string; raw_event: string }[];

for (const row of rows) {
  console.log(`\n==== id ${row.id} (${row.whop_payment_id}) ====`);
  try {
    const parsed = JSON.parse(row.raw_event);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log(row.raw_event);
  }
}

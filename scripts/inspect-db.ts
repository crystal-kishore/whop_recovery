import "dotenv/config";
import { db } from "../src/db/schema";

const rows = db.prepare("SELECT * FROM failed_payments ORDER BY id").all() as Record<
  string,
  unknown
>[];

console.log(`Total rows: ${rows.length}`);

for (const row of rows) {
  console.log(`\n---- id ${row.id} ----`);
  for (const [key, value] of Object.entries(row)) {
    const display = value === null ? "NULL" : value === "" ? "(empty string)" : value;
    console.log(`  ${key}: ${display}`);
  }
}

const phoneStats = {
  total: rows.length,
  withPhone: rows.filter((r) => r.customer_phone !== null && r.customer_phone !== "").length,
  nullOrEmptyPhone: rows.filter((r) => r.customer_phone === null || r.customer_phone === "")
    .length,
};

console.log("\n---- customer_phone summary ----");
console.log(phoneStats);

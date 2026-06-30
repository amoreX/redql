// Throwaway connection test. Run: npx tsx src/db/check.ts  — delete after.
import { db } from "./index.js";
import { users } from "./schema.js";

const [inserted] = await db
  .insert(users)
  .values({ email: `test_${Date.now()}@example.com`, passHash: "x" })
  .returning();
console.log("inserted:", inserted);

const all = await db.select().from(users);
console.log("rows in users:", all.length);
process.exit(0);

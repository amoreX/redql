import "dotenv/config";
import { drizzle } from "drizzle-orm/neon-http";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL missing in .env");
}

// drizzle v1: pass the connection string directly. (schema only needed for the
// relational db.query.* API — we use db.select()/insert(), so skip it.)
export const db = drizzle(process.env.DATABASE_URL);

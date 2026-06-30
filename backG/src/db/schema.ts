import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// User — furnace-app addition (furnace has no users). Mirrors ARCHITECTURE.md §4.1,
// plus passHash for email+password auth. githubId added later at the OAuth phase.
export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  passHash: text("pass_hash").notNull(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

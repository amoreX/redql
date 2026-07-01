import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

// User — furnace-app addition (furnace has no users). Mirrors ARCHITECTURE.md §4.1,
// plus passHash for email+password auth. githubId added later at the OAuth phase.
export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  passHash: text("pass_hash").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  cwd: text("cwd").notNull(),
  activeLeafId: text("active_leaf_id"),
  parentSessionId: text("parent_session_id"),
  forkedFromEntryId: text("forked_from_entry_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  archivedAt: timestamp("archived_at"),
});

export const entries = pgTable("entries", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  // Soft tree link (entry → entry before it). Root = null. Enforced in code, not DB.
  parentEntryId: text("parent_entry_id"),
  // message | tool_call | tool_result | compaction | branch_summary | model_change | custom
  type: text("type").notNull(),
  role: text("role"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  data: jsonb("data").notNull(), // jsonb to match varying type of content
});

// Types derived straight from the schema (no hand-writing).
// $inferSelect = row you READ back. $inferInsert = shape you pass to INSERT.
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Entry = typeof entries.$inferSelect;
export type NewEntry = typeof entries.$inferInsert;

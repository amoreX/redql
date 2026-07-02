// userId inferred from jwtToken
import { eq, and, desc, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  sessions,
  entries,
  type Session,
  type Entry,
  type NewEntry,
} from "../db/schema.js";
import { pubsub, tokensTopic } from "../lib/pubsub.js";
import { chatStream, generateTitle, DEFAULT_MODEL } from "./llm.services.js";
import { buildMessages } from "../lib/buildMessages.js";

export const createSession = async (
  userId: string,
  cwd: string,
  title: string = "New chat", // default VALUE (=), not a union (|)
): Promise<Session> => {
  const [session] = await db
    .insert(sessions)
    .values({ userId, cwd, title })
    .returning();
  return session; // whole row: id, title, cwd, activeLeafId, createdAt...
};

export const listSessions = async (userId: string): Promise<Session[]> => {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.archivedAt)))
    .orderBy(desc(sessions.updatedAt));
  return rows;
};

export const getSession = async (sessionId: string): Promise<Session> => {
  const row = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row[0];
};

export const appendEntry = async (entry: NewEntry): Promise<Entry> => {
  return await db.transaction(async (tx) => {
    //fetches session from sessionId for parent connection
    const [session] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, entry.sessionId));
    if (!session) throw new Error("Session not found");

    // inserts actual entry
    const [newEntry] = await tx
      .insert(entries)
      .values({ ...entry, parentEntryId: session.activeLeafId })
      .returning();

    // updates tip of sesssion
    await tx
      .update(sessions)
      .set({ activeLeafId: newEntry.id, updatedAt: new Date() })
      .where(eq(sessions.id, entry.sessionId));

    return newEntry;
  });
};

export const getActivePath = async (sessionId: string): Promise<Entry[]> => {
  // 1. find the tip
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (!session) throw new Error("Session not found");
  if (!session.activeLeafId) return []; // empty chat, no entries yet

  // 2. load ALL entries for this session in ONE query
  const rows = await db
    .select()
    .from(entries)
    .where(eq(entries.sessionId, sessionId));

  // 3. index by id → entry for O(1) hops
  const byId = new Map(rows.map((e) => [e.id, e]));

  // 4. walk tip → root via parentEntryId
  const path: Entry[] = [];
  let cursor: string | null = session.activeLeafId;
  while (cursor) {
    const entry = byId.get(cursor);
    if (!entry) break; // dangling link — stop, don't loop forever
    path.push(entry);
    cursor = entry.parentEntryId;
  }

  // 5. collected leaf → root; flip to root → leaf (the order the model reads)
  return path.reverse();
};

export const appendMessage = (
  sessionId: string,
  role: "user" | "assistant",
  content: string,
): Promise<Entry> =>
  appendEntry({ sessionId, type: "message", role, data: { content } });

export const appendToolCall = (
  sessionId: string,
  data: { name: string; arguments: string; toolCallId: string },
): Promise<Entry> =>
  appendEntry({ sessionId, type: "tool_call", role: "assistant", data });

export const appendToolResult = (
  sessionId: string,
  data: { name: string; content: string; toolCallId: string },
): Promise<Entry> =>
  appendEntry({ sessionId, type: "tool_result", role: "tool", data });

// The real streaming turn. SPLIT from the echo: user append (txn) → LLM stream
// (OUTSIDE any txn) → assistant append (txn). Tokens are published to the
// session's pubsub topic as they arrive; the tokenStream subscription relays them.
// Returns the USER entry immediately (fire-and-stream); the assistant arrives
// over the subscription and is persisted when the stream completes.
export const runStreamingTurn = async (
  sessionId: string,
  userId: string,
  content: string,
  model: string = DEFAULT_MODEL,
): Promise<Entry> => {
  // ownership + existence (one read)
  const session = await getSession(sessionId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  if (session.userId !== userId) throw new Error("SESSION_FORBIDDEN");

  // txn1: persist the user message (moves the tip)
  const userEntry = await appendMessage(sessionId, "user", content);

  // first message → generate a real title (async, don't block the stream)
  if (session.title === "New chat") {
    void generateTitle(content)
      .then((title) =>
        db.update(sessions).set({ title }).where(eq(sessions.id, sessionId)),
      )
      .catch(() => {});
  }

  // build model input from the full path (system + convo, ends with the user msg)
  const path = await getActivePath(sessionId);
  const messages = buildMessages(path);

  // fire-and-stream: NOT awaited. publish deltas as they arrive, persist the
  // assistant entry when done, then publish the final done event.
  void (async () => {
    let full = "";
    try {
      for await (const delta of chatStream(messages, model)) {
        full += delta;
        pubsub.publish(tokensTopic(sessionId), {
          tokenStream: { sessionId, delta, done: false, entryId: null },
        });
      }
      // txn2: persist the complete assistant reply (+ which model produced it)
      const asst = await appendEntry({
        sessionId,
        type: "message",
        role: "assistant",
        data: { content: full, model },
      });
      pubsub.publish(tokensTopic(sessionId), {
        tokenStream: { sessionId, delta: "", done: true, entryId: asst.id },
      });
    } catch (err) {
      pubsub.publish(tokensTopic(sessionId), {
        tokenStream: {
          sessionId,
          delta: `\n[error: ${(err as Error).message}]`,
          done: true,
          entryId: null,
        },
      });
    }
  })();

  return userEntry;
};

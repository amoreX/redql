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
import { pubsub, tokensTopic, toolTopic } from "../lib/pubsub.js";
import { streamAgent, generateTitle, DEFAULT_MODEL } from "./llm.services.js";
import { buildMessages } from "../lib/buildMessages.js";
import { TOOL_DEFS } from "../lib/tools.js";
import { waitForToolResult, resolveToolResult } from "../lib/toolWaiters.js";

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

// The agent turn: append the user msg, then LOOP — stream the model (with tools),
// and whenever it emits tool calls, dispatch each to the DEVICE, PARK the loop
// until the device submits the result, append it, and loop again. Ends when the
// model replies with plain text (no tool calls). All LLM/tool work runs OUTSIDE
// any transaction; only the individual appendEntry writes are transactional.
// Returns the USER entry immediately (fire-and-stream).
export const runAgentTurn = async (
  sessionId: string,
  userId: string,
  content: string,
  model: string = DEFAULT_MODEL,
): Promise<Entry> => {
  const session = await getSession(sessionId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  if (session.userId !== userId) throw new Error("SESSION_FORBIDDEN");

  // persist the user message (moves the tip)
  const userEntry = await appendMessage(sessionId, "user", content);

  // first message → title (async, non-blocking)
  if (session.title === "New chat") {
    void generateTitle(content)
      .then((title) =>
        db.update(sessions).set({ title }).where(eq(sessions.id, sessionId)),
      )
      .catch(() => {});
  }

  const publishToken = (delta: string, done: boolean, entryId: string | null) =>
    pubsub.publish(tokensTopic(sessionId), {
      tokenStream: { sessionId, delta, done, entryId },
    });

  // fire-and-stream: run the loop async, return the user entry now.
  void (async () => {
    try {
      const MAX_STEPS = 20; // safety cap against runaway tool loops
      for (let step = 0; step < MAX_STEPS; step++) {
        const path = await getActivePath(sessionId);
        const messages = buildMessages(path);

        let text = "";
        let toolCalls: {
          toolCallId: string;
          name: string;
          arguments: string;
        }[] = [];

        for await (const ev of streamAgent(messages, model, TOOL_DEFS)) {
          if (ev.type === "text") {
            text += ev.delta;
            publishToken(ev.delta, false, null); // live tokens to the client
          } else if (ev.type === "tool_calls") {
            toolCalls = ev.calls;
          }
        }

        if (toolCalls.length > 0) {
          for (const tc of toolCalls) {
            // persist tool_call → dispatch to device → PARK until result comes back
            await appendToolCall(sessionId, {
              name: tc.name,
              arguments: tc.arguments,
              toolCallId: tc.toolCallId,
            });
            publishToken(`\n[tool: ${tc.name}]\n`, false, null);
            pubsub.publish(toolTopic(sessionId), {
              toolDispatch: {
                sessionId,
                toolCallId: tc.toolCallId,
                name: tc.name,
                arguments: tc.arguments,
              },
            });
            const result = await waitForToolResult(tc.toolCallId); // blocks
            await appendToolResult(sessionId, {
              name: tc.name,
              content: result,
              toolCallId: tc.toolCallId,
            });
          }
          continue; // loop again — the model now sees the tool results
        }

        // no tool calls → final assistant message, end the turn
        const asst = await appendEntry({
          sessionId,
          type: "message",
          role: "assistant",
          data: { content: text, model },
        });
        publishToken("", true, asst.id);
        return;
      }
      publishToken("\n[stopped: too many tool steps]", true, null);
    } catch (err) {
      publishToken(`\n[error: ${(err as Error).message}]`, true, null);
    }
  })();

  return userEntry;
};

// Device calls this (via the submitToolResult mutation) to hand back a tool's
// output. Wakes the parked loop. Returns false if nothing was waiting on that id.
export const submitToolResult = (
  toolCallId: string,
  content: string,
): boolean => resolveToolResult(toolCallId, content);

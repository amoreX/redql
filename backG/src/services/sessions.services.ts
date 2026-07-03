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
import {
  buildMessages,
  toolCallMessage,
  toolResultMessage,
} from "../lib/buildMessages.js";
import { TOOL_DEFS } from "../lib/tools.js";
import { parkToolResult, resolveToolResult } from "../lib/toolWaiters.js";

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

// undefined when no session has that id — callers guard on it (requireOwnedSession,
// runAgentTurn) and turn it into a 404 / SESSION_NOT_FOUND.
export const getSession = async (
  sessionId: string,
): Promise<Session | undefined> => {
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

// Tool calls on the active path with no matching tool_result yet — i.e. dispatched
// but unanswered. Used to REPLAY in-flight dispatches to a device that (re)subscribes
// AFTER the dispatch was published: plain pub/sub drops messages to absent
// subscribers, so without this a reconnecting device would never see the pending
// tool and the turn would hang until the 120s timeout.
export const getPendingToolCalls = async (
  sessionId: string,
): Promise<{ toolCallId: string; name: string; arguments: string }[]> => {
  const path = await getActivePath(sessionId);
  const answered = new Set<string>();
  for (const e of path) {
    if (e.type === "tool_result") {
      const d = e.data as { toolCallId?: string };
      if (d.toolCallId) answered.add(d.toolCallId);
    }
  }
  const pending: { toolCallId: string; name: string; arguments: string }[] = [];
  for (const e of path) {
    if (e.type === "tool_call") {
      const d = e.data as { toolCallId: string; name: string; arguments: string };
      if (!answered.has(d.toolCallId)) {
        pending.push({
          toolCallId: d.toolCallId,
          name: d.name,
          arguments: d.arguments,
        });
      }
    }
  }
  return pending;
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
      // Build the OpenAI transcript ONCE from the DB, then extend it in memory as
      // the loop appends tool calls/results below. (Previously this re-read every
      // entry in the session from Postgres on each step — up to MAX_STEPS times
      // per turn — even though we already know exactly what we just appended.)
      const messages = buildMessages(await getActivePath(sessionId));

      const MAX_STEPS = 20; // safety cap against runaway tool loops
      for (let step = 0; step < MAX_STEPS; step++) {
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
          // NOTE: tool calls within one turn run SERIALLY here — dispatch one,
          // wait for its result, then the next. Simple and safe, and fine for
          // normal use. To let the device run independent calls concurrently,
          // parallelize this loop (park + dispatch all, then await them together);
          // left as a deliberate, configurable choice because it trades this
          // simplicity for throughput and requires the device runner to handle
          // concurrent tool execution.
          for (const tc of toolCalls) {
            // persist tool_call → PARK for the result (subscribe FIRST) → THEN
            // dispatch to device. Parking before dispatch closes the race where a
            // result could arrive before we're listening.
            await appendToolCall(sessionId, {
              name: tc.name,
              arguments: tc.arguments,
              toolCallId: tc.toolCallId,
            });
            // mirror the persisted tool_call into the in-memory transcript (same
            // shape buildMessages would rebuild from the DB row).
            messages.push(toolCallMessage(tc));
            const { result: resultP } = await parkToolResult(tc.toolCallId);
            publishToken(`\n[tool: ${tc.name}]\n`, false, null);
            pubsub.publish(toolTopic(sessionId), {
              toolDispatch: {
                sessionId,
                toolCallId: tc.toolCallId,
                name: tc.name,
                arguments: tc.arguments,
              },
            });
            const result = await resultP; // blocks until the device submits
            await appendToolResult(sessionId, {
              name: tc.name,
              content: result,
              toolCallId: tc.toolCallId,
            });
            messages.push(toolResultMessage({ toolCallId: tc.toolCallId, content: result }));
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
): Promise<boolean> => resolveToolResult(toolCallId, content);

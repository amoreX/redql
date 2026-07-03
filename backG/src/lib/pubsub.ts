import { RedisPubSub } from "graphql-redis-subscriptions";
import { createRedis } from "./redis.js";
// Redis pub/sub for streaming tokens + tool dispatch. One topic per session.
// Redis (not in-memory) so fan-out works across multiple server processes; the
// resolver API (asyncIterableIterator) is identical either way.

export const pubsub = new RedisPubSub({
  publisher: createRedis(),
  subscriber: createRedis(),
});

// Topic name for a session's token stream.
export const tokensTopic = (sessionId: string) => `TOKENS.${sessionId}`;

// Topic name for a session's tool dispatch (server → device).
export const toolTopic = (sessionId: string) => `TOOLS.${sessionId}`;

// The payload shape published on each token + on completion.
export type TokenChunk = {
  sessionId: string;
  delta: string; // the new text piece ("" on the final done event)
  done: boolean; // true on the last event of a turn
  entryId: string | null; // the saved assistant entry id (only on done)
};

// A tool call the DEVICE must run, pushed over toolDispatch.
export type ToolDispatch = {
  sessionId: string;
  toolCallId: string;
  name: string;
  arguments: string; // JSON string of the tool args
};

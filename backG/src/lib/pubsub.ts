import { PubSub } from "graphql-subscriptions";

// In-memory pub/sub for streaming tokens. One topic per session. This is the
// piece Redis replaces later (cross-process fan-out); the resolver API is the same.
export const pubsub = new PubSub();

// Topic name for a session's token stream.
export const tokensTopic = (sessionId: string) => `TOKENS.${sessionId}`;

// The payload shape published on each token + on completion.
export type TokenChunk = {
  sessionId: string;
  delta: string; // the new text piece ("" on the final done event)
  done: boolean; // true on the last event of a turn
  entryId: string | null; // the saved assistant entry id (only on done)
};

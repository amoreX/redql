import { GraphQLError } from "graphql";
import { JSONResolver, DateTimeResolver } from "graphql-scalars";
import {
  createSession,
  listSessions,
  getSession,
  getActivePath,
  runAgentTurn,
  submitToolResult,
} from "../services/sessions.services.js";
import { pubsub, tokensTopic, toolTopic } from "./pubsub.js";

// Curated model list for the client's picker (MVP). Don't let a client pick an
// arbitrary/expensive model. (later: proxy OpenRouter /models.)
const MODELS = [
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
];

// The per-request context, produced by the context fn in index.ts (from the JWT).
// userId is null when the request has no valid Bearer token.
export type GqlContext = { userId: string | null };

// Guard: every resolver that needs a logged-in user calls this. Throws if the
// token was missing/invalid (ctx.userId is null), else hands back the id.
function requireUser(ctx: GqlContext): string {
  if (!ctx.userId) {
    throw new GraphQLError("Not authenticated", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return ctx.userId;
}

// Guard: the session must exist AND belong to this user. Stops user A from
// reading user B's chat by guessing an id.
async function requireOwnedSession(sessionId: string, userId: string) {
  const session = await getSession(sessionId);
  if (!session) {
    throw new GraphQLError("Session not found", {
      extensions: { code: "NOT_FOUND" },
    });
  }
  if (session.userId !== userId) {
    throw new GraphQLError("Forbidden", { extensions: { code: "FORBIDDEN" } });
  }
  return session;
}

export const typeDefs = `#graphql
  scalar JSON
  scalar DateTime

  type Session {
    id: ID!
    title: String!
    cwd: String!
    activeLeafId: ID
    parentSessionId: ID
    forkedFromEntryId: ID
    createdAt: DateTime!
    updatedAt: DateTime!
    archivedAt: DateTime
  }

  type Entry {
    id: ID!
    sessionId: ID!
    parentEntryId: ID
    type: String!
    role: String
    createdAt: DateTime!
    data: JSON!
  }

  type Model {
    id: ID!
    name: String!
  }

  type TokenChunk {
    sessionId: ID!
    delta: String!
    done: Boolean!
    entryId: ID
  }

  type ToolCall {
    sessionId: ID!
    toolCallId: ID!
    name: String!
    arguments: String!
  }

  type Query {
    sessions: [Session!]!
    session(id: ID!): Session
    activePath(sessionId: ID!): [Entry!]!
    models: [Model!]!
  }

  type Mutation {
    createSession(cwd: String!, title: String): Session!
    sendMessage(sessionId: ID!, content: String!, model: String): Entry!
    submitToolResult(sessionId: ID!, toolCallId: ID!, content: String!): Boolean!
  }

  type Subscription {
    tokenStream(sessionId: ID!): TokenChunk!
    toolDispatch(sessionId: ID!): ToolCall!
  }
`;

export const resolvers = {
  // Custom scalars: teach GraphQL how to (de)serialize JSON + DateTime.
  JSON: JSONResolver,
  DateTime: DateTimeResolver,

  Query: {
    // (parent, args, context) — userId comes from ctx (the JWT), never the client.
    sessions: (_parent: unknown, _args: unknown, ctx: GqlContext) =>
      listSessions(requireUser(ctx)),

    session: async (_parent: unknown, { id }: { id: string }, ctx: GqlContext) => {
      const userId = requireUser(ctx);
      return requireOwnedSession(id, userId); // 404/403 if not yours
    },

    activePath: async (
      _parent: unknown,
      { sessionId }: { sessionId: string },
      ctx: GqlContext,
    ) => {
      const userId = requireUser(ctx);
      await requireOwnedSession(sessionId, userId);
      return getActivePath(sessionId);
    },

    // Curated model list for the client's model picker.
    models: () => MODELS,
  },

  Mutation: {
    createSession: (
      _parent: unknown,
      { cwd, title }: { cwd: string; title?: string },
      ctx: GqlContext,
    ) => createSession(requireUser(ctx), cwd, title),

    // Fire-and-stream: persist the user msg, kick off the streaming turn, return
    // the USER entry immediately. The assistant streams over `tokenStream`.
    sendMessage: async (
      _parent: unknown,
      {
        sessionId,
        content,
        model,
      }: { sessionId: string; content: string; model?: string },
      ctx: GqlContext,
    ) => {
      const userId = requireUser(ctx);
      try {
        return await runAgentTurn(sessionId, userId, content, model);
      } catch (err) {
        const code = err instanceof Error ? err.message : "";
        if (code === "SESSION_NOT_FOUND")
          throw new GraphQLError("Session not found", {
            extensions: { code: "NOT_FOUND" },
          });
        if (code === "SESSION_FORBIDDEN")
          throw new GraphQLError("Forbidden", {
            extensions: { code: "FORBIDDEN" },
          });
        throw err;
      }
    },

    // Device hands back a tool's output → wakes the parked agent loop.
    submitToolResult: async (
      _parent: unknown,
      {
        sessionId,
        toolCallId,
        content,
      }: { sessionId: string; toolCallId: string; content: string },
      ctx: GqlContext,
    ) => {
      const userId = requireUser(ctx);
      await requireOwnedSession(sessionId, userId);
      return submitToolResult(toolCallId, content);
    },
  },

  Subscription: {
    // Relay tokens for a session's turn. Auth via ctx (WS connectionParams → userId).
    tokenStream: {
      subscribe: async (
        _parent: unknown,
        { sessionId }: { sessionId: string },
        ctx: GqlContext,
      ) => {
        const userId = requireUser(ctx);
        await requireOwnedSession(sessionId, userId);
        return pubsub.asyncIterableIterator(tokensTopic(sessionId));
      },
    },

    // The device subscribes to receive tool calls it must run locally.
    toolDispatch: {
      subscribe: async (
        _parent: unknown,
        { sessionId }: { sessionId: string },
        ctx: GqlContext,
      ) => {
        const userId = requireUser(ctx);
        await requireOwnedSession(sessionId, userId);
        return pubsub.asyncIterableIterator(toolTopic(sessionId));
      },
    },
  },
};

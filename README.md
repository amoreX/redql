# redql

**A scaffold for a durable, streaming backend for AI agents — built on GraphQL + Redis.**

`redql` (Redis × GraphQL) is a backend that runs an **agent loop server-side** and
**streams** the model's output token-by-token to clients over GraphQL subscriptions,
while the agent's **tools execute on the user's own device** (a "split runtime").
It's the cloud brain for a local coding agent — modeled 1:1 on the
[furnace](https://github.com/) terminal agent's entry-tree session format.

> **Status: scaffold / not actively maintained.** Built as a learning project. The
> core streaming + agent-loop + tool-dispatch pipeline works end-to-end against real
> Neon + Redis + OpenRouter. It's a solid, honest foundation to fork for a
> durable streaming agent backend — not a finished product. See
> [What's built vs. TODO](#whats-built-vs-todo) for the exact line.

---

## The idea

Three pieces make it interesting:

1. **Split runtime — "brain in the cloud, hands on the device."**
   The agent loop (model calls, conversation state, streaming) runs on the server.
   When the model wants a tool (`read`, `write`, `bash`, …), the server **dispatches
   it to the user's device**, which runs it locally against the real filesystem and
   sends the result back. The server never touches the user's files — no sandbox,
   no repo cloning.

2. **Entry-tree sessions (1:1 with furnace).**
   A conversation isn't a flat list — it's a **tree** of entries (`Session ──< Entry`)
   with an `activeLeafId` pointer (the "Pi rule": each new entry chains onto the
   current leaf, then the leaf moves forward). This makes branching/forking a first-
   class future feature. Every event — message, tool call, tool result — is an entry.

3. **Fire-and-stream over GraphQL.**
   Sending a message is a **mutation** (returns immediately). The assistant's reply
   **streams back over a subscription** (WebSocket). Tool calls flow to the device
   over a second subscription. Redis pub/sub is the fan-out bus so it works across
   multiple server processes.

---

## Architecture

```
   Client (app role)                    redql server                         Device (tool role)
 ┌───────────────────┐          ┌──────────────────────────┐             ┌────────────────────┐
 │  sendMessage ─────────POST──►│  agent loop (runAgentTurn)│             │                    │
 │                   │          │   ├─ OpenRouter (stream)  │             │                    │
 │  tokenStream ◄────────WS─────│   ├─ publish tokens ──────┼──Redis────► tokenStream (app)    │
 │                   │          │   └─ publish tool calls ──┼──Redis────► toolDispatch ────────┤
 │                   │          │        park + await ◄─────┼──────┐      │  run read/bash/…   │
 └───────────────────┘          │                          │      │      │  locally           │
                                │  submitToolResult ◄───────┼POST──┴──────┤  submitToolResult  │
                                └───────────┬──────────────┘             └────────────────────┘
                                            │
                             Neon Postgres (Drizzle)   ← source of truth: users, sessions, entries
                             Redis (ioredis)           ← pub/sub fan-out (+ cache, planned)
                             OpenRouter                 ← the model (default: claude-sonnet-4.5)
```

The **app** and the **device** are two roles; on one machine they're the same client
(subscribes to `tokenStream` + `toolDispatch`, fires `sendMessage` + `submitToolResult`).
`device-runner.mjs` is a stand-in for that device until a real client (e.g. a desktop app) exists.

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime / HTTP | Node.js (ESM), **Express 5** |
| GraphQL (HTTP) | **Apollo Server 5** via `@as-integrations/express5` |
| GraphQL (WS) | **graphql-ws** + `graphql-subscriptions` (in-memory) / **`graphql-redis-subscriptions`** (Redis) |
| DB / ORM | **Neon** (serverless Postgres) + **Drizzle ORM** (`neon-serverless` driver — WS, for transactions) |
| Cache / realtime bus | **Redis** via **ioredis** |
| LLM | **OpenRouter** via the `openai` SDK (default `anthropic/claude-sonnet-4.5`) |
| Auth | email + password → **JWT** (`bcryptjs`, `jsonwebtoken`) |
| Scalars | `graphql-scalars` (`JSON`, `DateTime`) |

---

## Data model (Drizzle → Postgres)

```
users     id, email, passHash, name, createdAt
sessions  id, userId→users, title, cwd, activeLeafId, parentSessionId,
          forkedFromEntryId, createdAt, updatedAt, archivedAt
entries   id, sessionId→sessions, parentEntryId (soft tree link),
          type, role, createdAt, data (jsonb)
```

- `entries.type` = `message | tool_call | tool_result | compaction | branch_summary | model_change | custom`
- `entries.data` (jsonb) shape varies by type (message → `{content}`, tool_call → `{name, arguments, toolCallId}`, …).
- **The Pi rule** (`appendEntry`): new entry's `parentEntryId = session.activeLeafId`,
  insert, then move `activeLeafId` to the new entry — all in one transaction.
- **`getActivePath`**: walk `parentEntryId` from the leaf to the root, reverse → the
  exact conversation the model sees.

---

## API surface

**REST** (`/api/auth`) — auth only:
- `POST /api/auth/signup` · `POST /api/auth/login` → `{ result, message, token }`

**GraphQL** (`/graphql`) — everything else. Auth via `Authorization: Bearer <jwt>`
(HTTP) or `connectionParams` / `?token=` (WS).

```graphql
type Query {
  sessions: [Session!]!                    # my chats (sidebar)
  session(id: ID!): Session                # one chat (ownership-checked)
  activePath(sessionId: ID!): [Entry!]!    # the conversation
  models: [Model!]!                        # curated model picker list
}

type Mutation {
  createSession(cwd: String!, title: String): Session!
  sendMessage(sessionId: ID!, content: String!, model: String): Entry!   # fire-and-stream: returns the USER entry
  submitToolResult(sessionId: ID!, toolCallId: ID!, content: String!): Boolean!   # device → server
}

type Subscription {
  tokenStream(sessionId: ID!): TokenChunk!   # assistant reply, streamed (server → app)
  toolDispatch(sessionId: ID!): ToolCall!    # tool calls to run (server → device)
}
```

Every session-scoped resolver enforces `requireUser` (valid JWT) + `requireOwnedSession`
(the session belongs to you) → `401 UNAUTHENTICATED` / `403 FORBIDDEN` / `404 NOT_FOUND`.

---

## Turn lifecycle (fire-and-stream + agent loop)

```
sendMessage(sessionId, content, model)
  ├─ append USER entry (txn) → return it immediately
  ├─ (async) generate a session title on the first message
  └─ (async) LOOP:
       stream the model (with tool defs)
        ├─ text delta?  → publish to tokenStream (client renders live)
        └─ tool call?   → append tool_call → publish to toolDispatch (device)
                        → PARK (await the result) → append tool_result → loop again
       no tool call → append final assistant entry → publish done
```

Transactions are **split** deliberately: user append, then the multi-second model
call *outside* any transaction, then the assistant append — you never hold a DB
transaction open across an LLM call.

---

## Project structure

```
backG/                         # the server
├── src/
│   ├── index.ts               # Express + Apollo (HTTP) + graphql-ws (WS) on /graphql
│   ├── db/
│   │   ├── schema.ts          # Drizzle tables + inferred types
│   │   └── index.ts           # neon-serverless drizzle client (WS pool)
│   ├── routes/ controller/ services/   # REST auth (route → controller → service)
│   ├── middleware/requireAuth.ts        # JWT guard for REST
│   ├── utils/jwt.ts           # sign / verify
│   ├── lib/
│   │   ├── types.ts           # GraphQL SDL + resolvers + auth guards
│   │   ├── pubsub.ts          # RedisPubSub + topic helpers
│   │   ├── redis.ts           # ioredis connection factory
│   │   ├── tools.ts           # tool definitions (read/write/ls/grep/bash)
│   │   ├── toolWaiters.ts     # parked-promise registry (in-memory — see TODO)
│   │   ├── buildMessages.ts   # activePath → OpenAI message array
│   │   └── systemPrompt.ts    # loads src/prompts/*.md
│   ├── prompts/               # furnace's real base-system + title prompts (verbatim)
│   └── services/
│       ├── sessions.services.ts   # store logic + runAgentTurn + submitToolResult
│       └── llm.services.ts        # OpenRouter chat/stream + title gen
├── device-runner.mjs          # dev "device": runs tools locally, submits results
└── drizzle.config.ts
docs/ARCHITECTURE.md           # deeper design notes (some predates this build — see below)
app/                           # early React scaffold — UNUSED / superseded
```

---

## Getting started

### Prerequisites
- Node.js 20+
- A **Neon** Postgres database (or any Postgres; Drizzle uses the `neon-serverless` driver)
- **Redis** (local: `brew install redis && redis-server`, or `docker run -p 6379:6379 redis`)
- An **OpenRouter** API key

### 1. Env — `backG/.env`
```env
PORT=4000
DATABASE_URL=postgres://...            # Neon pooled connection string
JWT_SECRET=<any long random string>
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
OPENROUTER_TITLE_MODEL=openai/gpt-4o-mini   # optional
REDIS_URL=redis://localhost:6379
```

### 2. Install + push schema + run
```bash
cd backG
npm install
npx drizzle-kit push          # create users/sessions/entries in Postgres
redis-server --daemonize yes  # if not already running
npm run dev                   # → http://localhost:4000  (HTTP + WS on /graphql)
```

### 3. Try it
```bash
# get a token
curl -X POST localhost:4000/api/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"me@test.com","password":"pass123"}'

# run the device (so tool calls can execute locally), for a session id you create:
DEVICE_TOKEN=<jwt> node device-runner.mjs <sessionId>
```
Then from Postman/Apollo Sandbox: subscribe to `tokenStream(sessionId)` (auth via
`?token=<jwt>` on the WS URL), create a session, `sendMessage`, and watch the reply
stream in — including tool calls the device runs. Watch Redis with `redis-cli monitor`.

---

## What's built vs. TODO

**Built + tested end-to-end (real Neon + Redis + OpenRouter):**
- ✅ Email/password auth → JWT (REST), JWT→GraphQL context bridge, ownership guards
- ✅ Entry-tree store: `createSession`, `listSessions`, `getSession`, `appendEntry` (Pi rule + txn), `getActivePath`
- ✅ GraphQL API (queries/mutations/subscriptions) with `JSON`/`DateTime` scalars
- ✅ Real LLM replies via OpenRouter + LLM-generated session titles (furnace's prompts)
- ✅ **Token streaming** over `graphql-ws` — **Redis pub/sub** fan-out (multi-process ready)
- ✅ **Agent loop + tool dispatch**: `read`/`write`/`ls`/`grep`/`bash`, `toolDispatch` → device → `submitToolResult` → loop, with `device-runner.mjs`

**Scaffold TODO (known, intentional):**
- ⬜ **`toolWaiters` is still in-memory** — the parked-promise registry works on a
  single process, but a multi-process deploy needs it moved onto a Redis
  `result:<toolCallId>` channel (pub/sub was migrated; this wasn't).
- ⬜ **Caching** — `cache.ts` (cache-aside on hot reads + invalidation) is designed but not implemented.
- ⬜ **Redis Streams** — plain pub/sub is fire-and-forget, so a client must subscribe
  *before* a turn starts or it misses tokens. Streams would buffer/replay.
- ⬜ A real **client** (the `app/` React scaffold is abandoned; intended target was a native desktop client playing both app + device roles)
- ⬜ Branching/forking, compaction, projects/devices scoping, OAuth, per-tool permission prompts

> `docs/ARCHITECTURE.md` contains earlier design exploration. Some of it (Prisma,
> a server-side execution sandbox) was **superseded** by the decisions this README
> describes (Drizzle, split-runtime tools-on-device). Trust this README for the
> current state.

---

## License / provenance

Personal learning scaffold, formerly `furnace-app`. Use it as a starting point for a
streaming, tool-dispatching agent backend on GraphQL + Redis. No warranty.

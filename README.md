# redql

**A scaffold for a durable, streaming backend for AI agents — GraphQL + Redis.**

`redql` (Redis × GraphQL) runs an **agent loop server-side** and **streams** the
model's output to clients over GraphQL subscriptions, while the agent's **tools run
on the user's own device** (a "split runtime"). It's the cloud brain for a local
coding agent, modeled on the [furnace](https://github.com/) terminal agent's
entry-tree session format.

> **Status: scaffold / not actively maintained.** A learning project. The core
> pipeline (auth → sessions → streaming → LLM → on-device tool dispatch → Redis
> fan-out) works end-to-end against real Neon + Redis + OpenRouter. Fork it as a
> foundation, not a finished product. Full design: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## The idea

- **Split runtime — brain in the cloud, hands on the device.** The agent loop runs
  on the server; when the model wants a tool (`read`/`write`/`bash`/…), the server
  **dispatches it to the user's device**, which runs it locally and sends the result
  back. No sandbox, no repo cloning.
- **Entry-tree sessions (1:1 furnace).** A conversation is a **tree** of entries with
  an `activeLeafId` (the "Pi rule": chain onto the leaf, then move it). Branching-ready.
- **Fire-and-stream.** `sendMessage` is a mutation that returns instantly; the reply
  **streams over a subscription**; tool calls flow to the device over a second one.
  Redis pub/sub is the fan-out bus (works across processes).

## Stack

Node/Express 5 · Apollo Server 5 (HTTP) + **graphql-ws** (WS) · **Drizzle** + **Neon**
Postgres · **Redis** (ioredis + `graphql-redis-subscriptions`) · **OpenRouter** (default
`anthropic/claude-sonnet-4.5`) · JWT auth.

## API (`/graphql`)

```graphql
Query:        sessions · session(id) · activePath(sessionId) · models
Mutation:     createSession · sendMessage(…, model) · submitToolResult   # device → server
Subscription: tokenStream(sessionId)   # reply, server → app
              toolDispatch(sessionId)  # tool calls, server → device
```
Auth: `Authorization: Bearer <jwt>` (HTTP) or `?token=<jwt>` / `connectionParams` (WS).
REST: `POST /api/auth/signup` · `POST /api/auth/login`. Every session resolver checks
`requireUser` + ownership (401/403/404). Data model, full SDL, and turn lifecycle:
see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quickstart

```bash
cd backG && npm install
# .env: PORT, DATABASE_URL (Neon), JWT_SECRET, OPENROUTER_API_KEY,
#       OPENROUTER_MODEL, REDIS_URL
npx drizzle-kit push            # create users/sessions/entries
redis-server --daemonize yes    # local Redis
npm run dev                     # http://localhost:4000  (HTTP + WS on /graphql)
```
Then get a token (`/api/auth/signup`), run the device so tools can execute locally
(`DEVICE_TOKEN=<jwt> node device-runner.mjs <sessionId>`), subscribe to
`tokenStream(sessionId)`, `sendMessage`, and watch the reply stream in. `redis-cli monitor`
to watch the bus.

## What's built vs. TODO

**Built + tested (real Neon + Redis + OpenRouter):** JWT auth · entry-tree store
(Pi rule + txn, `getActivePath`) · GraphQL API + `JSON`/`DateTime` scalars · LLM
replies + LLM titles (OpenRouter) · **token streaming over Redis pub/sub** · **agent
loop + tool dispatch** (`read`/`write`/`ls`/`grep`/`bash`, `toolDispatch` → device →
`submitToolResult` → loop) + `device-runner.mjs`.

**TODO (scaffold):** `toolWaiters` still in-memory (move to a Redis `result:*` channel
for multi-process) · caching (cache-aside, designed not built) · Redis Streams
(buffered streaming — plain pub/sub misses tokens if you subscribe late) · real client
(the `app/` React scaffold is abandoned) · branching/forking, compaction,
projects/devices, OAuth, per-tool permission prompts.

## Layout

```
backG/src/{index.ts, db/, routes+controller+services (REST auth), lib/, prompts/}
backG/device-runner.mjs   # dev "device": runs tools locally
docs/ARCHITECTURE.md      # full design (some parts aspirational — see its banner)
app/                      # early React scaffold — UNUSED
```

Personal learning scaffold, formerly `furnace-app`. No warranty.

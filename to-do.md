# furnace-app — TO-DO

> Working checklist. Later topics are just titles — we elaborate them when we get there.
> Auth ✅, Sessions/Chats ✅, LLM + Streaming ✅ done — see `claude_session.md`.

---

## 🟢 NOW: Redis PubSub

Swap the in-memory `PubSub` (`src/lib/pubsub.ts`) → Redis pub/sub so streaming +
tool dispatch work across **multiple server processes** (horizontal scaling), not
just one. Same resolver API (`asyncIterableIterator`), different transport.
Note: the parked-promise registry (`toolWaiters.ts`) is also in-process — with
multiple servers, the turn loop and the `submitToolResult` may land on different
boxes, so that needs a cross-process story too (Redis, or sticky routing).

---

## ✅ DONE

### Auth (email + password, REST + JWT)
Signup/login → JWT → `requireAuth`. See `claude_session.md`.

### Sessions / Chats (data layer + GraphQL, tested vs Neon)
- [x] Tables `sessions` + `entries` (1:1 furnace, `data` = jsonb), live in Neon.
- [x] Store logic: `createSession`, `listSessions`, `getSession`, `appendEntry`
      (Pi-rule + txn), `getActivePath`, thin helpers.
- [x] GraphQL: `Session`/`Entry`, `JSON`+`DateTime` scalars, Query/Mutation.
- [x] JWT → context (`requireUser` + `requireOwnedSession`, 401/403/404).
- [x] Echo turn proved the tree end-to-end; batched into 1 txn (~13 → ~7 round-trips).
- [x] `neon-http` → `neon-serverless` (transactions need a WS connection).

### LLM integration + Streaming (OpenRouter, real replies over WS)
- [x] **1. OpenRouter setup** — `OPENROUTER_API_KEY` + `OPENROUTER_MODEL`
      (`anthropic/claude-sonnet-4.5`) in `.env`; `npm i openai`.
- [x] **2. System prompt** — furnace's real `base-system.md` + `title-system.md`
      copied into `src/prompts/`, loaded by `src/lib/systemPrompt.ts`.
- [x] **3. Provider service** — `src/services/llm.services.ts`: `chat()` (non-stream),
      `chatStream()` (async generator), `generateTitle()` (furnace title logic).
- [x] **4. Models query** — `Query { models }` returns a curated list (client picker).
- [x] **5. activePath → messages** — `src/lib/buildMessages.ts` prepends SYSTEM_PROMPT.
- [x] **6. Real turn (SPLIT txns)** — `runStreamingTurn`: user append (txn) → LLM
      stream (outside txn) → assistant append (txn) + `data.model`; async LLM title-gen.
- [x] **7. Streaming delivery** — `graphql-ws` WS server on `/graphql` + in-memory
      `PubSub`; `Subscription { tokenStream(sessionId) }`; `sendMessage` is fire-and-stream.
- [x] Tested end-to-end: tokens streamed live, assistant persisted, LLM title generated.

### Tool dispatch to device (split-runtime agent loop)
- [x] Basic tools (`read`/`write`/`ls`/`grep`/`bash`) as OpenAI tool defs (`src/lib/tools.ts`).
- [x] Agent LOOP (`runAgentTurn`): stream → tool_calls → dispatch → park → result → loop.
- [x] `streamAgent` assembles streamed tool-call deltas; `buildMessages` rebuilds
      tool_call/tool_result into OpenAI message format.
- [x] `toolDispatch` subscription (server→device) + `submitToolResult` mutation (device→server).
- [x] Parked-promise registry (`src/lib/toolWaiters.ts`) keyed by toolCallId (+ timeout).
- [x] `device-runner.mjs` — dev stand-in for the Swift app's bundled runner.
- [x] Tested: model read package.json via the device, looped, answered;
      tree = user → tool_call → tool_result → assistant.

---

## ⚪ LATER (titles only — flesh out when we reach them)

- [ ] Projects / Devices scoping
- [ ] Branching & forking (`switchBranch`, `forkSession`)
- [ ] Compaction (context window management)
- [ ] Swift desktop app (SwiftUI client + Apollo iOS + bundled tool runner)
- [ ] OAuth (GitHub login via `ASWebAuthenticationSession`)
- [ ] Skills / Tasks (subagents)
- [ ] Convert `docs/ARCHITECTURE.md` schema from Prisma syntax → Drizzle
- [ ] Prod: copy `src/prompts/*.md` → `dist/` in the build step (tsc doesn't copy .md)

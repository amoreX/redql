# furnace-app — TO-DO

> Working checklist. Later topics are just titles — we elaborate them when we get there.
> Auth ✅, Sessions/Chats ✅, LLM + Streaming ✅ done — see `claude_session.md`.

---

## 🟢 NOW: (next topic — pick one to elaborate)

Likely next: **Tool dispatch to device** (`toolDispatch` / `submitToolResult`) —
the split-runtime piece where the model's tool calls run on the user's Mac.

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

---

## ⚪ LATER (titles only — flesh out when we reach them)

- [ ] Tool dispatch to device (`toolDispatch` / `submitToolResult`)  ← likely next
- [ ] Redis PubSub (swap in-memory PubSub → Redis for multi-process streaming)
- [ ] Projects / Devices scoping
- [ ] Branching & forking (`switchBranch`, `forkSession`)
- [ ] Compaction (context window management)
- [ ] Swift desktop app (SwiftUI client + Apollo iOS + bundled tool runner)
- [ ] OAuth (GitHub login via `ASWebAuthenticationSession`)
- [ ] Skills / Tasks (subagents)
- [ ] Convert `docs/ARCHITECTURE.md` schema from Prisma syntax → Drizzle
- [ ] Prod: copy `src/prompts/*.md` → `dist/` in the build step (tsc doesn't copy .md)

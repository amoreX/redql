# redql — Architecture & Design Notes

The **full-vision** design for a ChatGPT-style desktop client + cloud brain for the
[furnace](../../furnace) terminal agent. This doc is **aspirational** — "how the whole
thing *could* be built." The actual scaffold (`redql`) implements the **core backend
pipeline** and deliberately diverges from this doc in several specifics.

> ### ⚠️ Status: vision doc vs. what shipped
> **Source of truth for what actually exists = [README.md](../README.md) + the code.**
> Read *this* doc for the north-star design and the parts **not yet built** (branching,
> projects/devices, compaction, the native client).
>
> **Where `redql` diverged from this doc:**
>
> | This doc says | What `redql` actually built |
> |---|---|
> | **Prisma** ORM | **Drizzle** ORM (Neon `neon-serverless` driver) |
> | User/Device/Project/Session/Entry/ToolGrant/Task/Skill | **users / sessions / entries only** (rest = TODO) |
> | GitHub **OAuth** (`ASWebAuthenticationSession`) | **email + password → JWT** |
> | Native **SwiftUI** app + bundled TS tool runner | **`device-runner.mjs`** (node) as the device stand-in |
> | `Timestamp` / `BigInt` epoch-ms columns | **`timestamp` (DateTime)** columns |
> | furnace's ~15 tools | **5 basic**: `read` / `write` / `ls` / `grep` / `bash` |
> | typed `EntryData` union | **`data: JSON`** scalar (union = TODO) |
> | tool-result wait keyed in Redis | **in-memory** parked promise (streaming pub/sub *is* on Redis; this isn't yet) |
>
> **What held up exactly as designed:** the **split-runtime execution model (§2 —
> brain in cloud, tools on device)** and the **entry-tree session model (§1)**. Both
> were built as described. There is **no server-side sandbox** — in the design *or*
> the build; tools run on the device.

> **Original framing (still the intended end state):** client is a native macOS app
> (Swift / SwiftUI), not a web app. Because the client already runs on the user's
> machine, tools execute **on the device** — the agent's *brain* runs in the backend,
> its *hands* on the Mac.

---

## 1. What furnace is (and why this matters for the design)

furnace is a from-scratch agentic coding harness that runs in the terminal. Key
facts that shape furnace-app:

- **Session model is an entry-tree.** A `session` has many `entries`; each entry
  points at its `parent_entry_id`, forming a Pi-style tree. The session's
  `active_leaf_id` is the tip of the current branch. The model/UI only ever sees
  the **root → active-leaf path**. Branching = move the leaf; forking = new
  session with `parent_session_id` + `forked_from_entry_id`.
- **Entries are polymorphic.** `type ∈ {message, tool_call, tool_result,
  compaction, branch_summary, model_change, custom}`, with a JSON `data` blob
  whose shape depends on `type`.
- **Storage is local SQLite** (`.furnace/furnace.sqlite`, `better-sqlite3`).
- **Provider is OpenRouter** (`OPENROUTER_API_KEY`, default model
  `anthropic/claude-sonnet-4.6`). The agent loop is non-streaming for tool turns
  but a streaming completion API exists.
- **~15 tools**: `read, ls, find, glob, grep, write, edit, bash, ask_question,
  skill, skill_manage, task, task_status, websearch, webfetch`.
- **Permissions** are `allow / ask / deny`, session-scoped. Write/edit/bash/
  skill_manage default to **ask**.
- **No web/server/multi-user code exists.** furnace-app is a new layer; the good
  news is the entry-tree maps almost 1:1 onto Postgres.

**What changes for furnace-app, and what doesn't:**

| Concern | furnace (terminal) | furnace-app | 
|---|---|---|
| Store | local SQLite | **Postgres/Drizzle** (backend) |
| Agent loop / provider / compaction | local process | **backend** (unchanged logic) |
| Filesystem + bash tools | local process | **the user's Mac, via the app** |
| `process.cwd()` | terminal cwd | a **local folder the user picks** |
| Skills (`~/.furnace`, `~/.cursor`, `~/.claude`) | disk roots | DB-backed, or device-reported |
| UI | TTY | **SwiftUI** |

The important realization: the file/bash tools are **still meant to run locally** —
furnace-app keeps that, it just **relocates** them from the agent's own process to
the connected desktop client and round-trips the call. The agent loop, compaction,
permission *evaluation*, title generation, context building, and the OpenRouter
provider are **pure-ish** and run server-side untouched.

---

## 2. The execution model: brain in the cloud, hands on the device

furnace edits files and runs `bash`. The original open question was *"where does
that run?"* — and for a web app the answer was painful (you can't run arbitrary
user `bash` on a shared server, so you'd need a per-session sandbox). **A native
macOS client removes the problem entirely:** the client is already on the user's
machine, so tools execute there.

### The shape

```
The agent LOOP runs in the backend.            The agent's TOOLS run on the Mac.
─────────────────────────────────────          ─────────────────────────────────
sendMessage → reconstruct path → call           read / ls / find / glob / grep
OpenRouter → stream tokens → on a tool           write / edit / bash / ask_question
call, DISPATCH it to the device and BLOCK        … execute against the user's local
awaiting the result → append result →            repo, then submitToolResult back
continue the loop.                               to the backend, unblocking the loop.
```

The backend's tool executor is a **remote executor**: instead of running a tool, it
serializes the tool call, publishes it to the connected client, and awaits the
result — *exactly* the pattern furnace already uses today when it blocks awaiting a
permission decision. The result comes back via a mutation; the loop resumes.

### Why this is the right model for a desktop app

- ✅ **No sandbox infrastructure.** No Fly Machines / Firecracker / Docker, no repo
  cloning, no cold-starts, no per-session container cost.
- ✅ **Operates on the user's real local repos**, in place — the actual product
  ("furnace, with a GUI and a cloud brain").
- ✅ **Native permission prompts.** Write/edit/bash gates are macOS dialogs,
  evaluated and enforced **on-device** before anything runs.
- ✅ **Minimal change to furnace's tool layer.** The tools already run locally; we
  reuse them rather than reimplement read/edit/bash semantics.
- ✅ **Simple trust model.** The user is running an agent on their *own* machine
  against their *own* files — identical to furnace / Claude Code today. (Revisit
  only if you ever execute tools for *someone else's* session.)
- ⚠️ **Online-only turns.** The loop is server-side, so a turn only progresses
  while the app is connected. A dropped connection mid-tool-call stalls the pending
  call → need a timeout + resume-on-reconnect.
- ⚠️ **Per-tool network round-trip** (device ↔ server). Fine for normal use; a
  bash-heavy loop feels the RTT. (Mitigate later with a persistent WS and batching.)

### How tools physically run on the device

Recommended: **bundle furnace's existing TypeScript tool executors** inside the
macOS app as a local helper process (the furnace CLI in an "executor" mode, or a
small embedded Node runner). SwiftUI owns the UI + permission prompts and drives
this local runner; **it does not reimplement** `read`/`edit`/`bash`/`grep` in
Swift. The backend dispatches an abstract tool call → the app routes it to the
bundled runner → returns the structured result. This keeps tool behavior byte-for-
byte identical to furnace and avoids a second implementation drifting out of sync.

> This is the one call worth confirming before heavy implementation — say the word
> if you'd rather reimplement tools natively in Swift instead of bundling the TS
> runner. Everything else below assumes the bundled-runner approach.

---

## 3. High-level architecture

```
┌──────────────────────┐   GraphQL (HTTP + WS)    ┌────────────────────────────┐
│  macOS app (SwiftUI)  │ ────────────────────────▶│  GraphQL API server         │
│  - chat UI / branches │   queries / mutations    │  Express 5 + Apollo (backG/) │
│  - LOCAL TOOL EXECUTOR│◀──────────────────────── │  - auth, sessions, entries   │
│    (bundled TS runner)│   subscriptions (WS):    │  - drives agent turns (BRAIN)│
│  - native perm prompts│   tokens · entries ·     │  - furnace runtime           │
│  - Keychain auth      │   TOOL-CALL DISPATCH     │  - Drizzle                   │
└──────────┬────────────┘                          └───┬──────────┬───────────────┘
           │ executes tools on                         │          │
           │ the user's Mac (FS + bash),     publishes │  reads / │
           │ returns results via mutation    (Pub/Sub) │  writes  │
           ▼                                       ┌────▼────┐ ┌───▼─────┐
   user's local repo (the chosen cwd)             │  Redis  │ │Postgres │
                                                   │ pub/sub │ │ (Neon)  │
                                                   │ + cache │ │ users/  │
                                                   │ + sess  │ │ sessions│
                                                   └─────────┘ │ /entries│
                                                               └─────────┘
```

- **macOS app** (`app/` → SwiftUI): chat UI, session/branch sidebar, live token
  streaming, tool-activity + native permission prompts, **and the on-device tool
  executor**. Talks to the backend with **Apollo iOS** (queries/mutations over
  HTTP, subscriptions + tool dispatch over WebSocket). No browser ⇒ **no CORS**.
- **API server** (`backG/`, Express 5 + Apollo, **long-lived**): GraphQL over HTTP
  + WebSocket. Owns auth, the DB via Drizzle, and **runs the furnace agent loop**.
- **furnace runtime (backend)**: the refactored furnace agent loop, run server-side
  per session, with its store pointed at **Postgres** and its tool executor pointed
  at the **connected device** (the remote executor) instead of local `fs`.
- **Postgres (Neon)**: durable source of truth.
- **Redis**: Pub/Sub for streaming + tool dispatch, cache, sessions, rate limiting,
  ephemeral file-read receipts.

---

## 4. Data model (Postgres / Drizzle) — suggested

Mirror furnace's entry-tree and add multi-user scoping. Suggested entities:
`User`, `Project` (a workspace = a **local folder on the user's Mac**), `Session`,
`Entry` (the tree node), `ToolGrant` (permissions), `Task` (subagents), `Skill`.
Mapping:

| furnace (SQLite)            | furnace-app (Postgres)        | Notes |
|-----------------------------|-------------------------------|-------|
| `sessions`                  | `Session` (+ `userId`,`projectId`) | same tree fields: `activeLeafId`, `parentSessionId`, `forkedFromEntryId` |
| `entries`                   | `Entry`                       | `data` → `Json`/JSONB, polymorphic by `type` |
| `cwd` string               | `Project` (`localPath`, `deviceId`) | a **local folder on the user's machine** — *not* cloned anywhere |
| permission grants (memory) | `ToolGrant`                   | session-scoped allow/deny; mirrored to the device for native prompts |
| `TaskRecord`                | `Task`                        | subagent delegation; child = a `Session` |
| `~/.furnace/skills/*`       | `Skill`                       | per-user, DB-backed (or device-reported) |
| `file_read_files/_ranges`   | **Redis** (ephemeral, TTL)    | dedupe state the *server* tracks across dispatched reads; not durable |
| —                           | `User`                        | new: accounts/auth |
| —                           | `Device`                      | new: a registered Mac (for routing tool dispatch + `localPath` scoping) |

Design choices:
- **`Project` is a local path, not a repo to clone.** Because tools run on the
  device, a project is just a label + the folder the user selected on a given
  `Device`. Optionally store `repoUrl` for display only.
- **`Entry.data` stays JSON** (matches furnace and keeps the tree schema simple).
  A typed GraphQL union can be layered on later if the UI wants it.
- **IDs**: Prisma `cuid()` by default. If you ever want to sync a local furnace
  SQLite session up to the cloud, switch to furnace's `ses_`/`ent_` UUID scheme so
  ids are portable.
- **Indexes** mirror furnace's hot paths: `(sessionId, createdAt, id)` and
  `(sessionId, parentEntryId)` for fast path reconstruction.

### 4.1 Prisma schema — 1:1 with furnace (`src/session/store.ts` + `types.ts`)

The `Session` / `Entry` models below are the **furnace `sessions` / `entries`
tables, column-for-column**, with multi-user scoping added. Source of truth:
furnace's `store.ts` migration (table DDL) and `types.ts` (the `data` shapes).

> **What actually shipped:** the block below is **Prisma syntax** and the *full* vision
> (User/Device/Project/ToolGrant + `BigInt` epoch-ms + typed union). `redql` built a
> **Drizzle** subset — `users` / `sessions` / `entries` with `timestamp` columns and a
> `jsonb` `data` blob. The **entry columns + Pi-rule tree are identical**; the extras
> (Device/Project/ToolGrant/Task/Skill) are not built yet. Real schema: `backG/src/db/schema.ts`.

```prisma
// ─── Identity & scoping — NEW in furnace-app (furnace has none of this) ───

model User {
  id        String      @id @default(cuid())
  email     String      @unique
  name      String?
  avatarUrl String?
  githubId  String?     @unique          // GitHub OAuth subject
  createdAt DateTime    @default(now())
  devices   Device[]
  projects  Project[]
  sessions  Session[]
  grants    ToolGrant[]
}

model Device {
  id         String    @id @default(cuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  name       String                       // "Nihal's MacBook Pro" — routes tool dispatch
  platform   String    @default("macos")
  lastSeenAt DateTime?
  createdAt  DateTime  @default(now())
  projects   Project[]
  sessions   Session[]
  @@index([userId])
}

model Project {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  deviceId  String                         // which Mac this folder lives on
  device    Device    @relation(fields: [deviceId], references: [id], onDelete: Cascade)
  localPath String                         // == furnace's `cwd`; a folder on the device
  repoUrl   String?                        // display only — nothing is cloned
  createdAt DateTime  @default(now())
  sessions  Session[]
  @@unique([deviceId, localPath])
  @@index([userId])
}

// ─── Conversations — 1:1 with furnace `sessions` (+ scoping) ───

model Session {
  // ── furnace columns, verbatim ─────────────────────────────────────────
  id                String      @id @default(cuid())  // furnace: text PK `ses_<uuid>`
  title             String
  cwd               String                            // furnace working dir (== Project.localPath)
  activeLeafId      String?                           // tip of active branch (Entry id; soft ptr, no FK — as in furnace)
  parentSessionId   String?                           // set ONLY when this session is a fork
  forkedFromEntryId String?                           // entry in parent where the fork begins
  createdAt         BigInt                            // epoch ms (furnace uses Date.now())
  updatedAt         BigInt                            // epoch ms
  archivedAt        BigInt?                           // epoch ms; null = active
  // ── furnace-app scoping, NEW ──────────────────────────────────────────
  userId            String
  user              User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  projectId         String
  project           Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  // ── relations ─────────────────────────────────────────────────────────
  entries           Entry[]
  grants            ToolGrant[]
  parent            Session?    @relation("Fork", fields: [parentSessionId], references: [id])
  forks             Session[]   @relation("Fork")

  @@index([cwd, updatedAt])                // furnace: sessions_cwd_updated_idx
  @@index([parentSessionId])               // furnace: sessions_parent_idx
  @@index([userId, projectId, updatedAt])  // NEW: list a user's conversations
}

// ─── Entries — 1:1 with furnace `entries` (the polymorphic tree node) ───

model Entry {
  // ── furnace columns, verbatim ─────────────────────────────────────────
  id            String     @id @default(cuid())  // furnace: text PK `ent_<uuid>`
  sessionId     String
  session       Session    @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  parentEntryId String?                          // tree edge; null at root
  type          EntryType                        // furnace stores as free text
  role          EntryRole?                       // nullable (e.g. custom/todo_state entries)
  createdAt     BigInt                           // epoch ms
  data          Json                             // JSONB; shape depends on `type` (see §5.2)

  @@index([sessionId, createdAt, id])  // furnace: entries_session_created_idx
  @@index([sessionId, parentEntryId])  // furnace: entries_parent_idx
}

enum EntryType { message tool_call tool_result compaction branch_summary model_change custom }
enum EntryRole { user assistant system tool }

// ─── Permissions — furnace's in-memory allow/ask/deny, persisted ───

model ToolGrant {
  id        String        @id @default(cuid())
  sessionId String
  session   Session       @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  userId    String
  user      User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  toolName  String                              // "bash", "write", "edit", …
  decision  GrantDecision                       // allow | ask | deny (session-scoped)
  createdAt DateTime      @default(now())
  @@unique([sessionId, toolName])
}

enum GrantDecision { allow ask deny }
```

Notes:
- **`createdAt`/`updatedAt`/`archivedAt` are `BigInt` epoch-ms** to stay byte-identical
  to furnace (so a local `.furnace/furnace.sqlite` session could later sync to the
  cloud). Swap to `DateTime` if you don't care about that.
- **IDs**: shown as `cuid()`. For sync-portability switch to furnace's `ses_`/`ent_`
  UUID scheme (see §4 bullet).
- **`activeLeafId` is a plain nullable string, not a Prisma relation** — furnace keeps
  it as a soft pointer with no FK (avoids the circular Session↔Entry FK); mirror that.
- **`file_read_files` / `file_read_ranges` are NOT ported to Postgres** — they're
  sandbox/device-bound dedupe state, kept in **Redis** with a TTL (see §6).
- `Skill` and `Task` follow the §4 mapping table; omitted here to keep the focus on
  conversations.

---

## 5. GraphQL API — suggested shape

- **Queries**: `me`, `devices`, `projects`, `sessions(projectId)`, `session(id)`,
  `activePath(sessionId)` (the root→leaf path the model sees).
- **Mutations**:
  - `createProject(deviceId, localPath)`, `createSession`, `cancelTurn`.
  - `sendMessage` — appends the user entry and kicks off the turn; assistant output
    streams back.
  - **`submitToolResult(callId, result)`** — the device returns a finished tool
    call's output (or a denial); the blocked agent loop resumes. **This is the
    desktop-specific core of the API.**
  - `forkSession` / `switchBranch` (the tree ops).
- **Subscriptions** (the realtime core, all fed by **Redis Pub/Sub**):
  - `tokenStream` — assistant tokens, rendered live.
  - `entryAdded` — new messages / tool-calls / results.
  - **`toolDispatch(deviceId)`** — server→device requests to **execute a tool
    call** locally (the inverse direction of a normal subscription: the server is
    asking the client to *do* something). The app runs it and replies with
    `submitToolResult`.
  - `toolActivity` — progress display for the UI.

`sendMessage` is request/response for the user's turn but **fire-and-stream** for
the assistant: the mutation returns fast, the agent runs async server-side, and
everything it produces is published to Redis → delivered over the subscriptions.
Tool calls flow out over `toolDispatch` and back in over `submitToolResult`.

> **Permissions fold into this round-trip.** `ask_question` and permission gates
> (write/edit/bash) are handled **on the device**: when a tool needs approval the
> app shows a native prompt *before* executing, then returns the result — or a
> "denied" result if the user declines. Session-scoped "always allow" decisions are
> persisted to `ToolGrant`. So there's no separate `approveTool` mutation — the
> permission decision is part of fulfilling the dispatched tool call.

### 5.1 What's GraphQL — and what deliberately isn't

**GraphQL** (one `/graphql` endpoint; HTTP `POST` for queries/mutations, WebSocket
for subscriptions) owns **all domain data + realtime**:

- *Fetch conversations*: `me`, `devices`, `projects`, `sessions(projectId)`,
  `session(id)`, `activePath(sessionId)`.
- *Run turns / tree ops*: `sendMessage`, `cancelTurn`, `forkSession`,
  `switchBranch`, `updateSessionTitle`, `archiveSession`.
- *Realtime*: `tokenStream`, `entryAdded`, `toolActivity` (server→client push) plus
  the tool round-trip `toolDispatch` (server→device) / `submitToolResult` (device→server).

**Plain HTTP — NOT GraphQL.** These are things GraphQL is the wrong tool for —
browser redirects, token bootstrapping, binary bytes, and infra probes:

| Endpoint | Method | Why it can't / shouldn't be GraphQL |
|---|---|---|
| `/auth/github` | `GET` → 302 | OAuth **start**: a redirect to GitHub. GraphQL can't issue redirects. |
| `/auth/github/callback` | `GET` → 302 | OAuth **callback**: GitHub redirects here with `?code=`. Backend exchanges the code (it holds the GitHub **client secret**, which must never live on the device), mints a session token, then deep-links back to the app via `furnaceapp://auth?token=…`. |
| `/auth/token` | `POST` | Exchange OAuth code → session token. **Bootstrapping**: you need a token *before* any GraphQL request can be authenticated. |
| `/auth/refresh` | `POST` | Rotate an expired token — must work when the GraphQL auth context is already expired. |
| `/auth/logout` | `POST` | Revoke the session token server-side. |
| `/uploads` | `POST` (multipart) | Image attachments / blobs. furnace `MessageData.images` allows base64, but shipping big base64 through GraphQL is wasteful — upload here, get a URL, reference it in `sendMessage`. |
| `/files/:id` | `GET` | Download an uploaded blob. |
| `/healthz`, `/` | `GET` | Liveness probes for Railway / the load balancer. |
| `/graphql` (ws://) | WS upgrade | The subscription **transport** (`graphql-ws`) — same path, different protocol, not a "query". |

**Rule of thumb:** anything that *redirects a browser, mints/refreshes/revokes a
session token, moves binary bytes, or is an infra probe* is plain HTTP. Everything
that *reads or mutates conversation/agent data* is GraphQL.

**Auth model for the native app:** GitHub OAuth via `ASWebAuthenticationSession` →
backend-mediated code exchange (secret stays server-side) → token deep-linked back →
stored in the **Keychain** → sent as `Authorization: Bearer <token>` on every
GraphQL **HTTP** request *and* in the WS `connectionParams` for subscriptions. No
cookies, **no CORS** (native client, no browser origin).

### 5.2 Conversation schema (GraphQL SDL) — 1:1 with furnace

The types mirror furnace's records exactly; the `data` union has **one variant per
furnace `*EntryData` type** (`types.ts`). A resolver picks the variant from
`entry.type` (`__resolveType`).

```graphql
scalar JSON
scalar Timestamp                       # epoch milliseconds (furnace uses Date.now())

enum EntryType { message tool_call tool_result compaction branch_summary model_change custom }
enum EntryRole { user assistant system tool }   # nullable on Entry

# ── Session: furnace `sessions`, 1:1 ──────────────────────────────
type Session {
  id: ID!
  title: String!
  cwd: String!
  activeLeafId: ID
  parentSessionId: ID
  forkedFromEntryId: ID
  createdAt: Timestamp!
  updatedAt: Timestamp!
  archivedAt: Timestamp
  entries: [Entry!]!                   # full tree (server-resolved)
  activePath: [Entry!]!                # root → activeLeaf path — what the model sees
}

# ── Entry: furnace `entries`, 1:1 ─────────────────────────────────
type Entry {
  id: ID!
  sessionId: ID!
  parentEntryId: ID
  type: EntryType!
  role: EntryRole
  createdAt: Timestamp!
  data: EntryData!                     # typed below (or use `raw: JSON!` for the shortcut)
}

# ── Polymorphic `data` — one variant per furnace *EntryData ───────
union EntryData =
    MessageData
  | ToolCallData
  | ToolResultData
  | CompactionData
  | TodoStateData
  | RawData                            # branch_summary / model_change / unshaped custom → JSON passthrough

type MessageImage { type: String!  mediaType: String  data: String  url: String }
type MessageData {                     # furnace MessageEntryData
  content: String!
  images: [MessageImage!]
  hidden: Boolean
  model: String
  source: String
}
type ToolCallData {                    # furnace ToolCallEntryData
  name: String!
  toolCallId: String!
  arguments: String!                   # JSON-encoded args, exactly as furnace stores it
  content: String
}
type ToolResultData {                  # furnace ToolResultEntryData
  name: String!
  toolCallId: String!
  content: String!
}
enum CompactionReason { manual threshold overflow }
type CompactionDetails {
  fallback: Boolean
  modifiedFiles: [String!]
  readFiles: [String!]
  summarizedEntryCount: Int
}
type CompactionData {                  # furnace CompactionEntryData
  kind: String!                        # always "context_compaction"
  summary: String!
  reason: CompactionReason!
  model: String!
  firstKeptEntryId: ID!
  focus: String
  tokensBefore: Int!
  tokensAfter: Int
  details: CompactionDetails
}
enum TodoStatus { pending in_progress completed cancelled }
enum TodoPriority { high medium low }
type TodoItem { id: ID!  content: String!  status: TodoStatus!  priority: TodoPriority }
type TodoStateData {                   # furnace TodoStateEntryData (stored as type=custom)
  kind: String!                        # always "todo_state"
  todos: [TodoItem!]!
  updatedAt: Timestamp
}
type RawData { json: JSON! }

# ── Operations ────────────────────────────────────────────────────
type Query {
  me: User!
  devices: [Device!]!
  projects(deviceId: ID): [Project!]!
  sessions(projectId: ID!): [Session!]!        # list a project's conversations
  session(id: ID!): Session                     # one conversation
  activePath(sessionId: ID!): [Entry!]!         # root→leaf path
}

type Mutation {
  createProject(deviceId: ID!, localPath: String!): Project!
  createSession(projectId: ID!, title: String): Session!
  sendMessage(sessionId: ID!, content: String!): Entry!        # append user entry + start the turn
  submitToolResult(callId: ID!, result: JSON!): Boolean!       # device returns tool output / denial
  forkSession(sessionId: ID!, fromEntryId: ID!): Session!      # new session w/ parent + forkedFrom
  switchBranch(sessionId: ID!, leafEntryId: ID!): Session!     # move activeLeafId (same-session branch)
  cancelTurn(sessionId: ID!): Boolean!
  updateSessionTitle(sessionId: ID!, title: String!): Session!
  archiveSession(sessionId: ID!): Session!                     # set archivedAt
}

type Subscription {
  tokenStream(sessionId: ID!): TokenChunk!     # assistant tokens, live
  entryAdded(sessionId: ID!): Entry!
  toolActivity(sessionId: ID!): ToolActivity!
  toolDispatch(deviceId: ID!): ToolDispatch!   # server → device: "run this tool locally"
}
```

> **Shortcut:** if the typed union is more than the UI needs early on, replace
> `data: EntryData!` with `data: JSON!` and keep the rest — the Prisma column is
> JSONB either way, so you can layer the union in later without a migration.

---

## 6. Redis usage

| Purpose | Keys / channels | Notes |
|---|---|---|
| **Token streaming** | `pub session:{id}:tokens` | agent publishes deltas; `tokenStream` relays |
| **Entry events** | `pub session:{id}:entries` | new entries → `entryAdded` |
| **Tool dispatch** | `pub device:{id}:dispatch` | server→device tool-call requests → `toolDispatch` |
| **Tool result round-trip** | `key tool:{sessionId}:{callId}` | agent loop blocks on it; `submitToolResult` resolves it (incl. permission denials) |
| **Tool activity** | `pub session:{id}:tools` | progress for the UI |
| **activePath cache** | `session:{id}:path` | invalidated on append; cheap reconstruction |
| **Web auth sessions** | `sess:{token}` | TTL'd |
| **Rate limiting** | `rl:{userId}` | per-user/IP |
| **File-read receipts** | `fr:{sessionId}:{file}` | mirrors furnace dedupe across dispatched reads; TTL'd; cleared on compaction |

Library: `graphql-redis-subscriptions` (ioredis) — needs **classic TCP Pub/Sub**
(not Upstash's REST/SSE path). Co-locate Redis with the server: it's on the hot
path of every streamed token **and every tool dispatch**.

---

## 7. Turn lifecycle (sequence)

1. App → `sendMessage(sessionId, content)`.
2. Backend: `Entry{type:message, role:user}` appended (Prisma); `activeLeafId`
   advances; `entryAdded` published. Mutation returns the user entry.
3. Backend reconstructs the root→leaf path → OpenRouter messages, starts the
   **furnace agent loop** (async, server-side).
4. Assistant tokens stream → published to `session:{id}:tokens` → `tokenStream` →
   the app renders them live.
5. Model emits a tool call → backend appends `Entry{type:tool_call}`, publishes it
   to `device:{id}:dispatch` (→ `toolDispatch`) **and blocks** the loop awaiting
   `tool:{sessionId}:{callId}`.
6. The **app** receives the dispatch:
   - If the tool defaults to **ask** (write/edit/bash/skill_manage) and no
     session grant covers it → show a **native permission prompt**. Decline →
     return a "denied" result and skip execution.
   - Otherwise / on approval → run the tool via the **bundled local runner**
     against the user's repo (`cwd`), on the user's Mac.
7. App → `submitToolResult(callId, result)`. Backend appends
   `Entry{type:tool_result}`, resolves the Redis key, **unblocks the loop**, and
   publishes `entryAdded` + `toolActivity(completed)`.
8. Loop repeats (4–7) until the model returns no tool calls → final assistant
   `Entry{type:message}` + `tokenStream(done:true)`.
9. Context near the window limit → compaction entry written (furnace logic reused,
   server-side).

> **Disconnect handling:** if the device drops between steps 5 and 7, the
> `tool:{…}:{callId}` wait should **time out** (and/or the turn pauses) so the loop
> doesn't hang forever; on reconnect, re-dispatch any in-flight tool call.

---

## 8. Hosting (researched, mid-2026)

**Locked-in recommendation — ~$5–10/mo at solo stage:**

| Layer | Choice | Why |
|---|---|---|
| **Postgres** | **Neon** (free → Launch) | Best free tier (never expires), built-in PgBouncer pooler, **pgvector** built in, copy-on-write **branching** (great for per-PR DBs), best Prisma docs. Pooled URL + `directUrl` for migrations. |
| **Server** | **Railway** (Hobby ~$5/mo) | Always-on (no sleep), native **WebSocket/SSE** for subscriptions, easiest git-push DX, 1-click **co-located Redis on a private network**. |
| **Redis** | **Railway Redis** (same project) | Co-located = minimal token-streaming + tool-dispatch latency, flat cost, full TCP Pub/Sub. |

**Why not serverless (Vercel/Lambda) for the server:** the WebSocket is now
*doubly* load-bearing — it carries streamed tokens **and** tool dispatch/results
for the life of each turn. One process must hold that socket open. Serverless has
execution-time caps, statelessness (a socket in one invocation isn't owned by the
next), and forced multi-instance fan-out — awkward and more complex, not less. A
long-lived container is the right tool. (Vercel got WS in public beta 2026-06-22
but it still inherits function duration limits.)

**A native client is simpler here than a browser:** no CORS, no cookie/SameSite
dance — the app holds a token in the **Keychain** and sends it as a header. Use
GitHub OAuth via `ASWebAuthenticationSession` for sign-in.

**Scaling path (no rewrite):**
- Postgres: Neon free → Neon Launch (usage-based, no tier cliff); turn off
  scale-to-zero to kill cold starts; enable pgvector for semantic search.
- Redis: if co-located outgrows Hobby, move to **Aiven for Valkey** (1 GB free,
  flat pricing) or **Upstash Fixed $10/mo** (avoid Upstash PAYG — it bills per
  PUBLISH, brutal for token streaming + per-tool dispatch).
- Server: scale Railway vertically, then horizontal replicas (Redis Pub/Sub fan-
  out becomes mandatory once there are multiple replicas — already in the design;
  note tool dispatch must route to the replica holding *that device's* socket, so
  publish on a per-device channel as in §6).

**Alternative (one bill, simplest):** everything on Railway (incl. its Postgres).
You give up Neon's free-forever tier + branching and pay metered for the DB.

---

## 9. Reusing the furnace runtime

Refactor furnace so the web server can drive it:

1. **Store interface** — extract a `SessionStore` interface; add a Prisma-backed
   implementation alongside the SQLite one. Methods map directly (`appendMessage`,
   `appendToolCall`, `appendToolResult`, `getActivePath`, `createSession`, …).
2. **Tool executor interface** — the file/bash tools take an "environment"
   (filesystem + shell) instead of assuming local `fs`/`process.cwd()`. Two impls:
   the **local impl** (used by the furnace CLI *and* by the bundled runner inside
   the macOS app), and a **remote executor** on the backend that publishes the
   tool call to `device:{id}:dispatch` and awaits `submitToolResult`. The backend
   never touches a filesystem; the device does.
3. **Permissions** — evaluation moves to the **device** (native prompts), with
   session-scoped grants persisted to `ToolGrant` and mirrored to the app so it
   only prompts when needed. The server treats a denied tool the same as any other
   tool result.
4. **Events** — the loop already exposes `onToolStart`/`onToolResult` hooks and a
   streaming completion; wire those to Redis publishes (tokens, entries, activity).
5. **Skills** — load from the `Skill` table (per user), or have the device report
   skills discovered on disk; either way the *prompt is assembled server-side*.
6. **Keep pure**: agent loop, compaction, title generation, context building,
   OpenRouter provider — all server-side, unchanged.

Secrets the **server** needs (from furnace `.env.example`): `OPENROUTER_API_KEY`
(required), `OPENROUTER_MODEL`, optional `EXA_API_KEY` / `PARALLEL_API_KEY` for
websearch — plus `DATABASE_URL`, `DIRECT_URL`, `REDIS_URL`, and auth secrets. The
**device** needs no provider keys (the brain lives in the cloud); it only needs the
bundled tool runner and a signed-in session token.

---

## 10. Build phases

- [ ] **P0 — Plumbing**: Prisma + Neon, `prisma migrate`, wire Apollo to the SDL,
      health checks. Replace the Todo demo schema.
- [ ] **P1 — Persistence**: implement Session/Entry resolvers over Prisma; port
      `getActivePath`/append logic; `createSession` / `sendMessage` (echo only).
- [ ] **P2 — Runtime**: extract furnace `SessionStore` + tool-executor interfaces;
      Prisma store impl; run the agent loop server-side. As a stand-in, run tools
      with the **local impl on the server** against a dev workspace dir (proves the
      loop before the device round-trip exists).
- [ ] **P3 — Streaming**: Redis Pub/Sub + GraphQL subscriptions; `tokenStream` /
      `entryAdded` / `toolActivity` end-to-end.
- [ ] **P4 — On-device execution**: the **remote executor** — dispatch tool calls
      over `toolDispatch` to a connected client and await `submitToolResult`;
      timeout + resume-on-reconnect. (Test the round-trip with a CLI/headless
      client before the SwiftUI app exists.)
- [ ] **P5 — Permissions & questions**: native permission prompts + `ask_question`
      handled in-app; session-scoped `ToolGrant` persistence + mirroring.
- [ ] **P6 — App + auth**: the **SwiftUI macOS app** (Apollo iOS, chat UI,
      branch/fork view, **bundled local tool runner**); GitHub OAuth via
      `ASWebAuthenticationSession`; token in Keychain.
- [ ] **P7 — Extras**: skills table, subagents/tasks, compaction, pgvector search.

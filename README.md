# furnace-app — A GraphQL + Postgres + Redis ChatGPT Clone

furnace-app is a work-in-progress **ChatGPT-style chat application** built to learn
and apply a modern API stack. The goal is a real-time conversational app where:

- the **client** is a React single-page app,
- the **API** is exposed over **GraphQL** (Apollo Server on Express),
- **PostgreSQL** (via Prisma) is the **primary database** — users, conversations, messages,
- **Redis** handles caching, sessions, and **Pub/Sub** for streaming assistant replies.

> **Status: early scaffold.** The frontend and the GraphQL backend are wired up
> and running, but the backend currently serves a small **Todo demo API**
> (proxying [JSONPlaceholder](https://jsonplaceholder.typicode.com)) that exists
> only to prove the GraphQL plumbing works. Chat features, the LLM integration,
> and Redis are **planned** — see the [Roadmap](#roadmap). This README documents
> both what exists today and where the project is headed, and is explicit about
> which is which.

---

## Tech stack

### Frontend — `app/`
| Concern | Choice |
|---|---|
| Framework | **React 19** (SPA) |
| Build tool | **Vite 8** |
| Language | TypeScript 6 |
| Styling | Tailwind CSS 3 (PostCSS + Autoprefixer) |

> Note: this is **React + Vite**, *not* Next.js. There is no SSR — it's a
> client-rendered single-page app served by Vite in dev.

### Backend — `backG/`
| Concern | Choice |
|---|---|
| Runtime | Node.js (ESM) |
| HTTP server | **Express 5** |
| GraphQL server | **Apollo Server 5** via `@as-integrations/express5` |
| Schema language | GraphQL SDL (`graphql` 16) |
| Outbound HTTP | axios (used by the demo resolvers) |
| Config | dotenv |
| Dev runner | `nodemon` + `tsx` |

### Data & realtime layer (decided — not yet wired up)
- **PostgreSQL** — primary, durable store for `User` / `Conversation` / `Message`.
- **Prisma** — TypeScript ORM + migrations on top of Postgres.
- **Redis** — caching hot data, session/auth storage, and **rate limiting**.
- **Redis Pub/Sub** — fan-out for **streaming** assistant responses token-by-token.
- **DataLoader** — batch + cache DB lookups to avoid GraphQL N+1 query storms.

### Planned
- An **LLM provider** (e.g. the Anthropic Claude API) to generate chat responses.

---

## Architecture decisions (locked in — read this so we don't forget)

These are the deliberate choices for this project. Written down on purpose:

1. **Postgres is the source of truth.** Chat data is relational
   (`User ──< Conversation ──< Message`), so it lives in PostgreSQL, accessed
   through **Prisma**. GraphQL is *database-agnostic* — we do **not** use a graph
   database; the "graph" in GraphQL refers to the schema's relationships, not storage.
2. **Redis is the speed + realtime layer, not the primary store.** It handles
   caching, sessions/auth, and rate limiting — Postgres stays the durable truth.
3. **Streaming uses Redis Pub/Sub.** Assistant replies are streamed to clients
   token-by-token (ChatGPT style) via Redis Pub/Sub behind GraphQL subscriptions/SSE.
4. **DataLoader is mandatory** for any nested resolver (e.g. messages within a list
   of conversations) to prevent N+1 queries against Postgres.

---

## Repository layout

```
Gapp/
├── app/                  # React + Vite frontend (SPA)
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx      # React entry point (mounts <App/>)
│   │   ├── App.tsx       # Root component (currently a placeholder)
│   │   └── style.css     # Tailwind directives
│   ├── tailwind.config.js
│   ├── vite.config.ts
│   └── package.json
│
├── backG/                # Express + Apollo GraphQL backend
│   ├── src/
│   │   ├── index.ts      # Server bootstrap: Express + Apollo @ /graphql
│   │   └── lib/
│   │       └── types.ts  # GraphQL schema (typeDefs) + resolvers
│   ├── .env              # PORT (and future secrets)
│   └── package.json
│
└── README.md
```

---

## Getting started

### Prerequisites
- Node.js 20+ (ESM and modern tooling)
- npm
- *(planned)* a running Redis instance

### 1. Backend (`backG`)

```bash
cd backG
npm install
npm run dev          # starts the GraphQL server on PORT (default 4000)
```

`backG/.env`:
```env
PORT=4000
```

Verify it's up:
- Health check: open <http://localhost:4000/> → `Server alive twin`
- GraphQL endpoint: <http://localhost:4000/graphql> (opens the Apollo Sandbox in a browser)

### 2. Frontend (`app`)

```bash
cd app
npm install
npm run dev          # starts Vite dev server (default http://localhost:5173)
```

> **Heads up — CORS.** Once the frontend starts calling the backend, the browser
> will block cross-origin requests (Vite on `:5173` → API on `:4000`). The `cors`
> package is a backend dependency but is **not yet wired up** in
> `backG/src/index.ts`. Add `app.use(cors())` before the routes when you connect
> the two.

---

## Scripts

### `backG`
| Script | Action |
|---|---|
| `npm run dev` | Run in watch mode (`nodemon` + `tsx`) |
| `npm run build` | Type-check & compile TypeScript → `dist/` |
| `npm start` | Run the compiled server (`node dist/index.js`) |

### `app`
| Script | Action |
|---|---|
| `npm run dev` | Start Vite dev server |
| `npm run build` | Type-check (`tsc --noEmit`) & build for production |
| `npm run preview` | Preview the production build |

---

## GraphQL API (current demo)

The backend exposes a single endpoint — **`POST /graphql`** — with the following
schema (see `backG/src/lib/types.ts`):

```graphql
type Todo {
  id: ID!
  title: String!
  completed: Boolean!
}

type Query {
  getTodos: [Todo]
  getSpecificTodo(id: ID!): Todo
}
```

Resolvers proxy JSONPlaceholder, so this reads remote data and stores nothing yet.

### Example requests

**Get all todos**
```graphql
query {
  getTodos { id title completed }
}
```

**Get one todo (with a variable)**
```graphql
query GetOne($id: ID!) {
  getSpecificTodo(id: $id) { title completed }
}
```
```json
{ "id": 1 }
```

**curl**
```bash
curl http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query { getTodos { id title completed } }"}'
```

A GraphQL request is always a `POST` to `/graphql` with a JSON body containing a
`query` string (and optional `variables`). The response is shaped exactly like
the requested fields, under a top-level `data` key.

---

## How it fits together

```
┌─────────────┐    GraphQL over HTTP POST     ┌──────────────────────┐
│  React SPA  │ ───────────────────────────►  │  Express + Apollo     │
│  (app/)     │        /graphql                │  (backG/)             │
└─────────────┘ ◄───────────────────────────  │   typeDefs + resolvers│
                      JSON { data }            └──────────┬───────────┘
                                                          │
                              ┌─────────────┬──────────┼──────────┬─────────────┐
                              │ (today)     │ (decided) │ (decided)│ (planned)   │
                              ▼             ▼           ▼          ▼             ▼
                       JSONPlaceholder  PostgreSQL    Redis    Redis Pub/Sub   LLM
                       (demo todos)     (via Prisma:  (cache/  (streaming      (chat
                                         users/convos sessions/ replies)       replies)
                                         /messages)   rate-limit)
```

GraphQL is just the typed routing layer — it never touches storage itself. Each
resolver decides where data comes from: today that's an HTTP call; the target is
**Postgres (Prisma) for durable data, Redis for cache/sessions, Redis Pub/Sub for
streaming, and an LLM for replies.**

---

## Roadmap

- [ ] Set up **PostgreSQL + Prisma** with `User` / `Conversation` / `Message` models.
- [ ] Replace the Todo demo schema with **chat domain types** (`Conversation`, `Message`, `Role`).
- [ ] Add **mutations** (`sendMessage`, `createConversation`, `deleteConversation`).
- [ ] Add **DataLoader** to batch nested resolver lookups (avoid N+1).
- [ ] Integrate an **LLM provider** to generate assistant replies.
- [ ] Add **Redis** for caching, sessions, and rate limiting.
- [ ] **Streaming** assistant responses via **Redis Pub/Sub** (GraphQL subscriptions or SSE).
- [ ] Wire up **CORS** and connect the React frontend to the GraphQL API.
- [ ] Build the **chat UI** in `app/` (message list, composer, conversation sidebar).
- [ ] Auth (sessions backed by Redis).

---

## Notes / known cleanup

- `backG/PORT` is a stray Unix socket file (not source) and is safe to delete.
- `cors` is installed but not yet applied in `backG/src/index.ts`.

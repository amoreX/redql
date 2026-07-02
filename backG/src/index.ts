import express from "express";
import morgan from "morgan";
import { createServer } from "http";
import { ApolloServer } from "@apollo/server";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import bodyParser from "body-parser";
import { expressMiddleware } from "@as-integrations/express5";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/use/ws";
import { config } from "dotenv";
import router from "./routes/index.js";
import { verifyToken } from "./utils/jwt.js";
import { typeDefs, resolvers, type GqlContext } from "./lib/types.js";

config();
const PORT = process.env.PORT;

// One schema instance, shared by Apollo (HTTP queries/mutations) and graphql-ws
// (WS subscriptions).
const schema = makeExecutableSchema({ typeDefs, resolvers });

const app = express();
const httpServer = createServer(app); // wrap express so WS can share the port

// --- WebSocket server for subscriptions (graphql-ws), same /graphql path ---
const wsServer = new WebSocketServer({ server: httpServer, path: "/graphql" });
const serverCleanup = useServer(
  {
    schema,
    // WS auth: the real client sends the token in connectionParams (browsers
    // can't set WS headers). For easy testing we ALSO accept a handshake
    // `Authorization` header or a `?token=` query param. Same verifyToken as HTTP.
    context: async (ctx): Promise<GqlContext> => {
      const cp = ctx.connectionParams?.authorization;
      const req = ctx.extra?.request;
      const headerAuth = req?.headers?.authorization;

      let token: string | undefined;
      if (typeof cp === "string" && cp.startsWith("Bearer ")) {
        token = cp.slice(7);
      } else if (typeof headerAuth === "string" && headerAuth.startsWith("Bearer ")) {
        token = headerAuth.slice(7);
      } else if (req?.url) {
        token = new URL(req.url, "http://x").searchParams.get("token") ?? undefined;
      }

      if (!token) return { userId: null };
      try {
        return { userId: verifyToken(token).userId };
      } catch {
        return { userId: null };
      }
    },
  },
  wsServer,
);

const apserver = new ApolloServer<GqlContext>({
  schema,
  plugins: [
    // Clean shutdown: drain HTTP, then dispose the WS server.
    ApolloServerPluginDrainHttpServer({ httpServer }),
    {
      async serverWillStart() {
        return {
          async drainServer() {
            await serverCleanup.dispose();
          },
        };
      },
    },
  ],
});
await apserver.start();

app.use(morgan("dev"));
app.use(bodyParser.json());
app.use(
  "/graphql",
  expressMiddleware(apserver, {
    // HTTP auth: Bearer header → { userId } (queries + mutations).
    context: async ({ req }): Promise<GqlContext> => {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) return { userId: null };
      try {
        return { userId: verifyToken(header.slice(7)).userId };
      } catch {
        return { userId: null }; // bad/expired token → treated as logged-out
      }
    },
  }),
);
app.use("/api", router);
app.get("/", (_, res) => {
  res.send("Server alive twin");
});

httpServer.listen(PORT, () => {
  console.log("Server running at port:", PORT);
  console.log("HTTP  → POST /graphql   (queries + mutations)");
  console.log("WS    → /graphql        (subscriptions: tokenStream)");
});

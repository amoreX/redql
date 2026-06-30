import express from "express";
import morgan from "morgan";
import { ApolloServer } from "@apollo/server";
import bodyParser from "body-parser";
import { expressMiddleware } from "@as-integrations/express5";
import { config } from "dotenv";
import router from "./routes/index.js";

import { typeDefs, resolvers } from "./lib/types.js";

config();
const PORT = process.env.PORT;

const app = express();
const apserver = new ApolloServer({ typeDefs, resolvers });
await apserver.start();

app.use(morgan("dev"));
app.use(bodyParser.json());
app.use("/graphql", expressMiddleware(apserver));
app.use("/api", router);
app.get("/", (_, res) => {
  res.send("Server alive twin");
});

app.listen(PORT, () => {
  console.log("Server running at port:", PORT);
});

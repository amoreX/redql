// Dev "device" — stand-in for the future Swift app's bundled tool runner.
// Subscribes to toolDispatch for a session, runs each tool LOCALLY (on this
// machine, in this cwd), and submits the result back. Run this in one terminal,
// then sendMessage from Postman/Sandbox and watch tokenStream.
//
// Usage:  DEVICE_TOKEN=<jwt> node device-runner.mjs <sessionId>
// (or pass the token as the 2nd arg: node device-runner.mjs <sessionId> <jwt>)

import { createClient } from "graphql-ws";
import ws from "ws";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { execSync } from "child_process";

const sessionId = process.argv[2];
const token = process.env.DEVICE_TOKEN ?? process.argv[3];
if (!sessionId || !token) {
  console.error("usage: DEVICE_TOKEN=<jwt> node device-runner.mjs <sessionId>");
  process.exit(1);
}

const HTTP = "http://localhost:4000/graphql";
const gql = async (query, variables) => {
  const r = await fetch(HTTP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
};

// Execute a tool on THIS machine. Errors become the result string so the model
// can see and recover from them.
function runTool(name, argsJson) {
  const a = JSON.parse(argsJson || "{}");
  try {
    switch (name) {
      case "read":  return readFileSync(a.path, "utf8").slice(0, 8000);
      case "write": writeFileSync(a.path, a.content ?? ""); return `wrote ${a.path}`;
      case "ls":    return readdirSync(a.path || ".").join("\n");
      case "grep":  return execSync(`grep -rn ${JSON.stringify(a.pattern)} ${a.path || "."}`, { encoding: "utf8" }).slice(0, 8000);
      case "bash":  return execSync(a.command, { encoding: "utf8" }).slice(0, 8000);
      default:      return `unknown tool ${name}`;
    }
  } catch (e) {
    return `error: ${e.message}`;
  }
}

const client = createClient({
  url: `ws://localhost:4000/graphql?token=${token}`,
  webSocketImpl: ws,
});

console.log(`device-runner listening for tools on session ${sessionId} (cwd: ${process.cwd()})`);
client.subscribe(
  { query: `subscription($s:ID!){ toolDispatch(sessionId:$s){ toolCallId name arguments } }`, variables: { s: sessionId } },
  {
    next: async (m) => {
      const t = m.data.toolDispatch;
      console.log(`⚙️  ${t.name}(${t.arguments})`);
      const out = runTool(t.name, t.arguments);
      await gql(
        `mutation($s:ID!,$t:ID!,$c:String!){ submitToolResult(sessionId:$s,toolCallId:$t,content:$c) }`,
        { s: sessionId, t: t.toolCallId, c: out },
      );
      console.log(`   ↩︎ ${out.slice(0, 80).replace(/\n/g, " ")}`);
    },
    error: (e) => console.error("toolDispatch error:", e),
    complete: () => {},
  },
);

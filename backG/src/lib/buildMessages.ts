import OpenAI from "openai";
import type { Entry } from "../db/schema.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// A tool_call → the assistant message the API expects (one tool_call per message,
// matching how furnace/this store keeps one entry per call). Shared by both the
// DB→messages rebuild below AND the live agent loop, so the two can't drift.
export function toolCallMessage(d: {
  name: string;
  arguments: string;
  toolCallId: string;
}): Msg {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: d.toolCallId,
        type: "function",
        function: { name: d.name, arguments: d.arguments },
      },
    ],
  };
}

// A tool_result → a `tool` message keyed by the same tool_call_id.
export function toolResultMessage(d: {
  toolCallId: string;
  content: string;
}): Msg {
  return { role: "tool", tool_call_id: d.toolCallId, content: d.content };
}

// Turn an activePath (root→leaf entries) into the OpenAI message array:
// [ system, ...conversation ]. Tool entries reconstruct into the exact shape the
// API needs — a tool_call entry → an assistant message carrying tool_calls, and a
// tool_result entry → a `tool` message keyed by the same tool_call_id.
export function buildMessages(path: Entry[]): Msg[] {
  const messages: Msg[] = [{ role: "system", content: SYSTEM_PROMPT }];

  for (const e of path) {
    if (e.type === "message") {
      if (e.role === "user" || e.role === "assistant") {
        const content = (e.data as { content?: string })?.content ?? "";
        messages.push({ role: e.role, content });
      }
    } else if (e.type === "tool_call") {
      const d = e.data as { name: string; arguments: string; toolCallId: string };
      messages.push(toolCallMessage(d));
    } else if (e.type === "tool_result") {
      const d = e.data as { content: string; toolCallId: string };
      messages.push(toolResultMessage(d));
    }
  }

  return messages;
}

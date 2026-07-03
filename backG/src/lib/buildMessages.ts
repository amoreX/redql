import OpenAI from "openai";
import type { Entry } from "../db/schema.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

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
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: d.toolCallId,
            type: "function",
            function: { name: d.name, arguments: d.arguments },
          },
        ],
      });
    } else if (e.type === "tool_result") {
      const d = e.data as { content: string; toolCallId: string };
      messages.push({
        role: "tool",
        tool_call_id: d.toolCallId,
        content: d.content,
      });
    }
  }

  return messages;
}

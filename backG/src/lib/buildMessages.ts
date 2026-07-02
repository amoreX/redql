import type { Entry } from "../db/schema.js";
import type { LLMMessage } from "../services/llm.services.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

// Turn an activePath (root→leaf entries) into the message array the model sees:
// [ system, ...conversation ]. Only message entries with a user/assistant role
// map over; tool_call/tool_result etc are skipped for now (later topic).
export function buildMessages(path: Entry[]): LLMMessage[] {
  const messages: LLMMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const e of path) {
    if (e.type !== "message") continue;
    if (e.role !== "user" && e.role !== "assistant") continue;
    const content = (e.data as { content?: string })?.content ?? "";
    messages.push({ role: e.role, content });
  }
  return messages;
}

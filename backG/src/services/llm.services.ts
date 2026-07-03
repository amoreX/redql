import OpenAI from "openai";
import { TITLE_SYSTEM_PROMPT } from "../lib/systemPrompt.js";

// OpenRouter speaks the OpenAI API, so we reuse the OpenAI SDK with a different
// baseURL. Key + default model come from .env.
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseURL: "https://openrouter.ai/api/v1",
});

export const DEFAULT_MODEL =
  process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5";

// Cheap model just for titling (furnace default).
const TITLE_MODEL = process.env.OPENROUTER_TITLE_MODEL ?? "openai/gpt-4o-mini";

export type LLMMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// Non-streaming: one request → the full assistant text. Kept for title-gen etc.
export async function chat(
  messages: LLMMessage[],
  model: string = DEFAULT_MODEL,
  maxTokens?: number,
): Promise<string> {
  const res = await client.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
  });
  return res.choices[0]?.message?.content ?? "";
}

// Title generation — ported from furnace src/session/title.ts. Cheap model,
// tiny token budget, sanitize, fall back to the first few words on failure.
export async function generateTitle(firstUserPrompt: string): Promise<string> {
  try {
    const raw = await chat(
      [
        { role: "system", content: TITLE_SYSTEM_PROMPT },
        { role: "user", content: firstUserPrompt },
      ],
      TITLE_MODEL,
      24,
    );
    return sanitizeTitle(raw) || fallbackTitle(firstUserPrompt);
  } catch {
    return fallbackTitle(firstUserPrompt);
  }
}

function sanitizeTitle(title: string): string {
  return title
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function fallbackTitle(prompt: string): string {
  return sanitizeTitle(prompt.split(/\s+/).slice(0, 5).join(" ")) || "New Chat";
}

// A fully-assembled tool call the model asked for.
export type ToolCallOut = {
  toolCallId: string;
  name: string;
  arguments: string; // JSON string
};

// Events the agent stream emits: text deltas as they arrive, then (if any) the
// assembled tool calls at the end of the response.
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_calls"; calls: ToolCallOut[] };

// Streaming WITH tools. Yields text deltas live; streamed tool-call fragments are
// accumulated by index (id/name once, arguments concatenated) and emitted whole
// at the end.
export async function* streamAgent(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  model: string = DEFAULT_MODEL,
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
): AsyncGenerator<AgentEvent> {
  const stream = await client.chat.completions.create({
    model,
    messages,
    tools: tools.length ? tools : undefined,
    stream: true,
  });

  const acc = new Map<number, { id: string; name: string; args: string }>();
  let sawTools = false;

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) continue;
    const d = choice.delta;
    if (d?.content) yield { type: "text", delta: d.content };
    if (d?.tool_calls) {
      sawTools = true;
      for (const tc of d.tool_calls) {
        const cur = acc.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        acc.set(tc.index, cur);
      }
    }
  }

  if (sawTools) {
    yield {
      type: "tool_calls",
      calls: [...acc.values()].map((a) => ({
        toolCallId: a.id,
        name: a.name,
        arguments: a.args,
      })),
    };
  }
}

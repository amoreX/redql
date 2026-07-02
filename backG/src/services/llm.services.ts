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

// Streaming: async generator yielding text deltas as they arrive from the model.
export async function* chatStream(
  messages: LLMMessage[],
  model: string = DEFAULT_MODEL,
): AsyncGenerator<string> {
  const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true,
  });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

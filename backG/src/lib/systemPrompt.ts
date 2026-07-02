import { readFileSync } from "fs";
import { join } from "path";

// Prompts live as .md files (verbatim from furnace) and load at startup — avoids
// backtick-escaping a huge string, and matches how furnace itself loads them.
// NOTE: dev runs via tsx from src/, so these resolve fine. For a tsc build,
// copy src/prompts → dist/prompts (add to the build step later).
const promptsDir = join(import.meta.dirname, "..", "prompts");

// Backend-owned system prompt for the main agent. NOT client-editable.
export const SYSTEM_PROMPT = readFileSync(
  join(promptsDir, "base-system.md"),
  "utf8",
);

// System prompt for the cheap title-generation call.
export const TITLE_SYSTEM_PROMPT = readFileSync(
  join(promptsDir, "title-system.md"),
  "utf8",
);
